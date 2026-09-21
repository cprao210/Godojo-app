// uploadTranscriptParser.ts
// Pure parser for the Upload Transcript modal's raw text. Supports several
// speaker-label shapes, with or without a timestamp, plus multi-line
// messages: a line that does not start a new speaker label belongs to the
// previous segment until another valid label is detected.
//
// Supported line formats (see the regexes below for exact matching rules):
//   1. Alex: hello...                    — plain "LABEL: text"
//   2. [00:10] Alex: hello...            — bracketed timestamp, then label
//   3. Alex [00:10]: hello...            — label, then bracketed timestamp
//   4. Alex:                             — label alone; the message starts
//      hello...                            on the following line(s)
//   5. [00:00:10] [Alex]: hello...       — bracketed timestamp + bracketed label
//   6. [Alex] [00:00:10]: hello...       — bracketed label + bracketed timestamp
//   7. Alex (00:26): hello...            — label, then parenthesised timestamp
//   8. [00:26] [Alex]:                   — format 5/6 shape with the message
//      hello...                            starting on the following line(s)
// Timestamps accept H:MM:SS or MM:SS in any of the bracket/paren shapes above.
//
// Contract with MeetingPersistence.uploadTranscript:
//   • `speaker` is the internal role and it is assigned by APPEARANCE ORDER,
//     regardless of what the label says: the FIRST identifiable speaker is
//     always the sales person / microphone user ('user'); every subsequent
//     distinct speaker is client-side ('client'). So "Alex / Daniel",
//     "SALES PERSON / CLIENT" and "REP / CUSTOMER" all map identically — the
//     transcript opens with the rep's voice.
//   • `displayName` carries the ORIGINAL label exactly as it appeared
//     ("Alex", "SALES PERSON", "Speaker 2") — with any wrapping [] or ()
//     stripped — so the Transcript tab and the LLM prompts keep real
//     attribution instead of flattening everyone to "Other Party" (the
//     renderer's own fallback for segments with no label).
//   • Timestamps are NEVER invented. Segments without a parseable timestamp
//     get 0, and `durationMs` is null when the source had no usable
//     timestamps — the caller must not fake a duration from line counts.

export interface UploadedTranscriptSegment {
    speaker: 'user' | 'client';
    text: string;
    /** ms since call start; 0 when the source line carried no timestamp. */
    timestamp: number;
    final: true;
    /** The original speaker label from the transcript, when one was found. */
    displayName?: string;
}

export interface ParsedUploadTranscript {
    segments: UploadedTranscriptSegment[];
    /** Last bracketed timestamp (call length); null when none were usable. */
    durationMs: number | null;
}

// Known role keywords. These exist ONLY to recognise a label-shaped line
// (e.g. a lowercase "rep:"/"client:" that no case pattern would match) —
// they deliberately do NOT decide the role anymore: the first identifiable
// speaker is always the sales/mic user, see parseUploadTranscript.
const KNOWN_ROLE_LABELS = new Set([
    'REP', 'REPRESENTATIVE', 'ME', 'USER', 'YOU', 'SALES', 'SELLER',
    'SALES PERSON', 'SALESPERSON', 'SALES REP', 'SALESREP',
    'ACCOUNT EXECUTIVE', 'AE', 'SDR', 'BDR', 'AGENT',
    'CLIENT', 'CUSTOMER', 'BUYER', 'PROSPECT', 'THEM', 'LEAD', 'CPO', 'INTERVIEWER',
]);

// Formats 2, 5, 8 — "[00:00:12] LABEL: text" / "[00:12] LABEL: text", where
// LABEL may itself be bracketed ("[Alex]") and text may be empty (format 8,
// with the message continuing on the next line(s)). H:MM:SS or MM:SS.
const BRACKET_LINE = /^\[\s*(\d{1,2}(?::\d{1,2}){1,2})\s*\]\s*([^:\n]{1,60}):\s*(.*)$/;

// Formats 3, 6 — "LABEL [00:00:12]: text" / "[LABEL] [00:00:12]: text" —
// the timestamp bracket comes after the label instead of before it.
const LABEL_THEN_BRACKET_TS = /^(\[[^\]\n]{1,60}\]|[A-Za-z][A-Za-z0-9 .'\u2019\-]{0,59}?)\s*\[\s*(\d{1,2}(?::\d{1,2}){1,2})\s*\]\s*:\s*(.*)$/;

// Format 7 — "LABEL (00:26): text" — parenthesised timestamp after the label.
const LABEL_THEN_PAREN_TS = /^([A-Za-z][A-Za-z0-9 .'\u2019\-]{0,59}?)\s*\(\s*(\d{1,2}(?::\d{1,2}){1,2})\s*\)\s*:\s*(.*)$/;

// Format 1 — "LABEL: text" — label starts with a letter; a colon must be
// followed by whitespace so URLs ("https://x") and inline colons never look
// like labels.
const PLAIN_LINE = /^([A-Za-z][A-Za-z0-9 .'\u2019\-()]{0,59}?):\s+(.+)$/;

// Format 4 — "LABEL:" alone on its line, nothing (or only whitespace) after
// the colon — the message text starts on the following line(s).
const LABEL_ONLY_LINE = /^([A-Za-z][A-Za-z0-9 .'\u2019\-()]{0,59}?):\s*$/;

const normalizeLabel = (raw: string): string => raw.trim().replace(/\s+/g, ' ');

/** Strips a single layer of wrapping brackets/parens ("[Alex]" → "Alex"),
 * used for the label-bracket formats (5, 6, 8) where the capture group
 * includes the brackets themselves. Leaves unbracketed labels untouched. */
function stripLabelWrapping(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '[' && last === ']') || (first === '(' && last === ')')) {
            return trimmed.slice(1, -1).trim();
        }
    }
    return trimmed;
}

/** "[HH:MM:SS]" / "[MM:SS]" → ms; null when unparseable. */
function parseTimestamp(raw: string): number | null {
    const parts = raw.split(':').map(Number);
    if (parts.some(isNaN) || parts.length < 2 || parts.length > 3) return null;
    if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
    return ((parts[0] * 60) + parts[1]) * 1000;
}

/**
 * Heuristic that separates a genuine speaker label from prose that merely
 * contains a colon ("Note: ", a sentence fragment, etc.). A label passes
 * when it is a known role keyword, an ALL-CAPS label, or up to three
 * Title-case words ("Alex", "Daniel", "Mr Smith"). Anything longer or
 * lowercase is treated as message text (continuation).
 */
function isLikelySpeakerLabel(raw: string): boolean {
    const label = normalizeLabel(raw);
    if (!label) return false;
    if (KNOWN_ROLE_LABELS.has(label.toUpperCase())) return true;
    const words = label.split(' ');
    if (words.length > 3) return false;
    if (/^[A-Z][A-Z .'\-()0-9]*$/.test(label)) return true;                 // CLIENT, SALES PERSON, SPEAKER 2
    if (/^[A-Z][a-z0-9'\u2019\-]+(?: [A-Z][a-z0-9'\u2019\-]+){0,2}$/.test(label)) return true; // Alex, Daniel, Mr Smith
    return false;
}

export function parseUploadTranscript(rawText: string): ParsedUploadTranscript {
    const segments: UploadedTranscriptSegment[] = [];
    const timestampsSeen: number[] = [];
    // First identifiable speaker = sales/mic user; every later one = client side.
    let firstLabel: string | null = null;
    const roleForLabel = (label: string): 'user' | 'client' => {
        const key = label.toUpperCase();
        if (firstLabel === null) firstLabel = key;
        return key === firstLabel ? 'user' : 'client';
    };

    const push = (speaker: 'user' | 'client', text: string, timestamp: number, displayName?: string) => {
        const seg: UploadedTranscriptSegment = { speaker, text, timestamp, final: true };
        if (displayName) seg.displayName = displayName;
        segments.push(seg);
    };

    for (const rawLine of (rawText || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        // Formats 2, 5, 8 — "[TS] LABEL: text" (label may be bracketed;
        // text may be empty when the message continues on later lines).
        const bracketFirst = line.match(BRACKET_LINE);
        if (bracketFirst) {
            const ts = parseTimestamp(bracketFirst[1].trim()) ?? 0;
            if (ts > 0) timestampsSeen.push(ts);
            const label = normalizeLabel(stripLabelWrapping(bracketFirst[2]));
            const text = bracketFirst[3].trim();
            if (!label) {
                // Bracket + text but no recognisable label — keep the timestamp
                // (it still anchors this line) but leave the speaker unlabelled.
                push('client', text, ts);
            } else {
                push(roleForLabel(label), text, ts, label);
            }
            continue;
        }

        // Formats 3, 6 — "LABEL [TS]: text" / "[LABEL] [TS]: text".
        const labelBracketTs = line.match(LABEL_THEN_BRACKET_TS);
        if (labelBracketTs) {
            const label = normalizeLabel(stripLabelWrapping(labelBracketTs[1]));
            if (isLikelySpeakerLabel(label)) {
                const ts = parseTimestamp(labelBracketTs[2].trim()) ?? 0;
                if (ts > 0) timestampsSeen.push(ts);
                push(roleForLabel(label), labelBracketTs[3].trim(), ts, label);
                continue;
            }
        }

        // Format 7 — "LABEL (TS): text".
        const labelParenTs = line.match(LABEL_THEN_PAREN_TS);
        if (labelParenTs) {
            const label = normalizeLabel(labelParenTs[1]);
            if (isLikelySpeakerLabel(label)) {
                const ts = parseTimestamp(labelParenTs[2].trim()) ?? 0;
                if (ts > 0) timestampsSeen.push(ts);
                push(roleForLabel(label), labelParenTs[3].trim(), ts, label);
                continue;
            }
        }

        // Format 1 — "LABEL: text" on a single line.
        const plain = line.match(PLAIN_LINE);
        if (plain && isLikelySpeakerLabel(plain[1])) {
            const label = normalizeLabel(plain[1]);
            push(roleForLabel(label), plain[2].trim(), 0, label);
            continue;
        }

        // Format 4 — "LABEL:" alone; the message starts on the next line(s).
        const labelOnly = line.match(LABEL_ONLY_LINE);
        if (labelOnly && isLikelySpeakerLabel(labelOnly[1])) {
            const label = normalizeLabel(labelOnly[1]);
            push(roleForLabel(label), '', 0, label);
            continue;
        }

        // Continuation of the previous speaker's message (multi-line turns,
        // including formats 4 and 8 where the label line carried no text).
        const last = segments[segments.length - 1];
        if (last) {
            last.text = last.text ? `${last.text}\n${line}` : line;
        } else {
            // Transcript starts with unattributed text — no label to preserve,
            // so the renderer's "Other Party" fallback is the honest result.
            push('client', line, 0);
        }
    }

    let durationMs: number | null = null;
    if (timestampsSeen.length > 0) {
        // Duration = the last timestamp seen: a transcript ending at
        // [00:00:25] describes a ~25s call, even when the first labelled turn
        // starts at 00:00:12 (the 12s before it were still part of the call).
        const last = Math.max(...timestampsSeen);
        durationMs = last > 0 ? last : null;
    }

    return { segments, durationMs };
}