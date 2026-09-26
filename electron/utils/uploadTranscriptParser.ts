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
//   • `speaker` is the internal role: exactly ONE label is the sales person /
//     microphone user ('user'), every other speaker is client-side ('client').
//     The rep label is resolved once every speaker is known (resolveRepSpeaker):
//       1. `repLabel` — the speaker the rep picked in the upload modal;
//       2. a unique match against the signed-in user's name / email;
//       3. otherwise the FIRST identifiable speaker, regardless of what the
//          label says ("SALES PERSON / CLIENT" and "CLIENT / SALES PERSON"
//          both make the first one the rep).
//     Step 3 alone got real uploads backwards whenever the prospect spoke
//     first — and the v2 analysis grades only the prospect side, so a swapped
//     call scores 0 BANT/MEDDIC.
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
    /** Distinct speaker labels in order of first appearance (first casing seen). */
    speakers: string[];
    /** The label mapped to 'user'; null when the transcript had no labels. */
    repSpeaker: string | null;
    /** Which rule chose repSpeaker — see resolveRepSpeaker. */
    repSource: RepSpeakerSource | null;
}

export type RepSpeakerSource = 'picked' | 'name' | 'first';

export interface ParseUploadOptions {
    /** Label the rep picked in the upload modal (case-insensitive). Ignored when no speaker has it. */
    repLabel?: string | null;
    /** The signed-in user's display name and/or email, for guessing the rep when nothing was picked. */
    repNameHints?: Array<string | null | undefined>;
}

// Known role keywords. These exist ONLY to recognise a label-shaped line
// (e.g. a lowercase "rep:"/"client:" that no case pattern would match) —
// they deliberately do NOT decide the role, see resolveRepSpeaker.
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
 * Title-case words optionally followed by a number ("Alex", "Daniel",
 * "Mr Smith", "Speaker 2", "Participant 10"). A word may also be a bare
 * single-letter initial ("Bharathraj A", "Priya S."). Anything longer or
 * lowercase is treated as message text (continuation).
 *
 * The trailing-number allowance matters because it's the ONLY thing that
 * used to make mixed-case numbered labels ("Speaker 1" / "Speaker 2" — a
 * very common shape from Zoom/Teams/Otter-style exports) work: bracket-
 * timestamp-first lines ("[00:10] Speaker 1: ...", formats 2/5/8) never run
 * this check at all, so they always accepted them, while every other format
 * (1, 3, 4, 6, 7) rejected "Speaker 2" as prose and silently merged that
 * turn into the previous speaker — leaving those formats with only ONE
 * detected speaker and no "Which speaker is you?" picker.
 *
 * The single-letter-initial allowance fixes the same class of bug for a
 * different common shape: a label like "Bharathraj A" (first name + middle
 * or last initial) has a second "word" that's just one capital letter,
 * which the plain Title-case word pattern (capital + one-or-more lowercase)
 * could never match — so the whole label was rejected and that speaker's
 * lines were silently merged into whoever spoke before them.
 */
function isLikelySpeakerLabel(raw: string): boolean {
    const label = normalizeLabel(raw);
    if (!label) return false;
    if (KNOWN_ROLE_LABELS.has(label.toUpperCase())) return true;
    const words = label.split(' ');
    if (words.length > 3) return false;
    if (/^[A-Z][A-Z .'\-()0-9]*$/.test(label)) return true;                 // CLIENT, SALES PERSON, SPEAKER 2
    // Each word is either a full Title-case word ("Alex", "Parulekar") or a
    // bare single-letter initial ("A", "A."); the whole label may end in a
    // number ("Speaker 2").
    const TITLE_WORD = String.raw`(?:[A-Z][a-z0-9'\u2019\-]+|[A-Z]\.?)`;
    if (new RegExp(`^${TITLE_WORD}(?: ${TITLE_WORD}){0,2}(?: \\d+)?$`).test(label)) return true; // Alex, Mr Smith, Bharathraj A, Speaker 2
    return false;
}

const labelKey = (label: string): string => normalizeLabel(label).toUpperCase();

/** Lowercase name tokens: "Sourish Kundu" / "sourish.kundu@x.com" → ['sourish', 'kundu']. */
function nameTokens(raw: string): string[] {
    const local = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
    return local.toLowerCase().split(/[^a-z\u00c0-\u024f]+/).filter(t => t.length >= 2);
}

/**
 * The label that is the rep ('user'). A picked label wins when a speaker has it; then a label
 * whose every name token belongs to the signed-in user ("Sourish", "sourish kundu" for
 * "Sourish Kundu") — only when exactly ONE label matches, since a shared first name is no
 * evidence; then the first speaker. Role keywords never match a name ("SALES PERSON" has no
 * name tokens in common with a person), so the fallback still covers labelled transcripts.
 */
export function resolveRepSpeaker(
    speakers: string[],
    opts: ParseUploadOptions = {},
): { label: string; source: RepSpeakerSource } | null {
    if (!speakers.length) return null;
    const picked = opts.repLabel ? labelKey(opts.repLabel) : null;
    if (picked) {
        const hit = speakers.find(s => labelKey(s) === picked);
        if (hit) return { label: hit, source: 'picked' };
    }
    const hintTokens = new Set((opts.repNameHints ?? []).flatMap(h => (h ? nameTokens(h) : [])));
    if (hintTokens.size) {
        const matches = speakers.filter(s => {
            const tokens = nameTokens(s);
            return tokens.length > 0 && tokens.every(t => t.length >= 3 && hintTokens.has(t));
        });
        if (matches.length === 1) return { label: matches[0], source: 'name' };
    }
    return { label: speakers[0], source: 'first' };
}

export function parseUploadTranscript(rawText: string, opts: ParseUploadOptions = {}): ParsedUploadTranscript {
    const segments: UploadedTranscriptSegment[] = [];
    const timestampsSeen: number[] = [];
    // Roles are assigned after the loop, once every speaker is known — see resolveRepSpeaker.
    const speakers: string[] = [];
    const seenKeys = new Set<string>();
    const roleForLabel = (label: string): 'client' => {
        const key = labelKey(label);
        if (!seenKeys.has(key)) {
            seenKeys.add(key);
            speakers.push(label);
        }
        return 'client';
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

    const rep = resolveRepSpeaker(speakers, opts);
    if (rep) {
        const repKey = labelKey(rep.label);
        for (const seg of segments) {
            if (seg.displayName && labelKey(seg.displayName) === repKey) seg.speaker = 'user';
        }
    }

    return { segments, durationMs, speakers, repSpeaker: rep?.label ?? null, repSource: rep?.source ?? null };
}