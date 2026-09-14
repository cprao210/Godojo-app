// uploadTranscriptParser.ts
// Pure parser for the Upload Transcript modal's raw text. Supports both
// timestamped (`[HH:MM:SS] SALES PERSON: Hello`) and plain
// (`Alex: Hello`) speaker-label formats, plus multi-line messages:
// a line that does not start a new speaker label belongs to the previous
// segment until another valid label is detected.
//
// Contract with MeetingPersistence.uploadTranscript:
//   • `speaker` is the internal role and it is assigned by APPEARANCE ORDER,
//     regardless of what the label says: the FIRST identifiable speaker is
//     always the sales person / microphone user ('user'); every subsequent
//     distinct speaker is client-side ('client'). So "Alex / Daniel",
//     "SALES PERSON / CLIENT" and "REP / CUSTOMER" all map identically — the
//     transcript opens with the rep's voice.
//   • `displayName` carries the ORIGINAL label exactly as it appeared
//     ("Alex", "SALES PERSON", "Speaker 2") so the Transcript tab and the
//     LLM prompts keep real attribution instead of flattening everyone to
//     "Other Party" (the renderer's own fallback for segments with no label).
//   • Timestamps are NEVER invented. Segments without a bracketed timestamp
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

// "[00:00:12] LABEL: text" / "[00:12] LABEL: text" — H:MM:SS or MM:SS.
const BRACKET_LINE = /^\[\s*(\d{1,2}(?::\d{1,2}){1,2})\s*\]\s*([^:\n]{1,60}):\s*(.*)$/;
// "LABEL: text" — label starts with a letter; a colon must be followed by
// whitespace so URLs ("https://x") and inline colons never look like labels.
const PLAIN_LINE = /^([A-Za-z][A-Za-z0-9 .'\u2019\-()]{0,59}?):\s+(.+)$/;

const normalizeLabel = (raw: string): string => raw.trim().replace(/\s+/g, ' ');

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

        const bracketed = line.match(BRACKET_LINE);
        if (bracketed) {
            const ts = parseTimestamp(bracketed[1].trim()) ?? 0;
            if (ts > 0) timestampsSeen.push(ts);
            const label = normalizeLabel(bracketed[2]);
            const text = bracketed[3].trim();
            if (!label) {
                // Bracket + text but no recognisable label — keep the timestamp
                // (it still anchors this line) but leave the speaker unlabelled.
                push('client', text, ts);
            } else {
                push(roleForLabel(label), text, ts, label);
            }
            continue;
        }

        const plain = line.match(PLAIN_LINE);
        if (plain && isLikelySpeakerLabel(plain[1])) {
            const label = normalizeLabel(plain[1]);
            push(roleForLabel(label), plain[2].trim(), 0, label);
            continue;
        }

        // Continuation of the previous speaker's message (multi-line turns).
        const last = segments[segments.length - 1];
        if (last) {
            last.text += `\n${line}`;
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
