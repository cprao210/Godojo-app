// electron/summary/transcript.ts
//
// THE single canonical transcript formatter.
//
// Before this module there were four divergent builders — the live path emitted
// `Me:`/`Them:` (or a calendar-derived `Chandrapal Rao:`/`Salesforce:`), upload
// and recovery emitted `REP:`/`PROSPECT:`, regenerate emitted
// `SALES PERSON (Me):`/`PROSPECT (Client):`, and a dead `context` field emitted
// `[ME]:`/`[CLIENT]:`. So regenerating a summary produced systematically
// different output from the same transcript.
//
// Worse, none of those variants told the model WHICH SIDE IS THE SELLER, while
// ScoreCardLLM's anti-fabrication rule ("cite a CLIENT quote, not a REP
// question") and the follow-up email prompt both assert `REP:`/`CLIENT:` labels
// that were never actually emitted. Quotes got misattributed and the scorecard
// graded rep questions as client confirmations.
//
// The fix: always emit an unambiguous role token, with the human name in
// parentheses when known:
//     [02:14] REP (Chandra): ...
//     [02:31] PROSPECT (Speaker 2): ...
//
// Pure and dependency-free so it is unit-testable under `environment: 'node'`.

/** Minimal shape this module needs — structurally compatible with TranscriptSegment. */
export interface FormattableSegment {
    speaker: string;
    text: string;
    timestamp: number;
    speakerIndex?: number;
    source?: 'stt' | 'chat' | 'manual';
}

export interface SpeakerNames {
    user: string;
    client: string;
}

export interface CanonicalTranscriptOptions {
    speakerNames?: SpeakerNames | null;
    /** Epoch summaries recovered from SessionTracker compaction, oldest first. */
    epochSummaries?: string[];
    /** Include `[mm:ss]` prefixes. Default true. */
    includeTimestamps?: boolean;
    /** Hard character cap (used by the title path). 0/undefined = no cap. */
    maxChars?: number;
}

export interface CanonicalTranscript {
    /** The formatted text handed to the LLM. */
    text: string;
    /** Turns actually included, in speech order, after filtering. */
    turns: CanonicalTurn[];
    /** True when 2+ distinct far-end diarized speakers were seen. */
    multiClientSpeakers: boolean;
    /** True when epoch summaries were prepended (i.e. the head was compacted away). */
    hasEpochSummaries: boolean;
    /** True when maxChars forced truncation. */
    truncated: boolean;
}

export interface CanonicalTurn {
    role: 'rep' | 'prospect';
    label: string;
    text: string;
    timestamp: number;
    /** Milliseconds from the first included turn. */
    offsetMs: number;
    speakerIndex?: number;
}

/** Speakers that are never part of the human conversation. */
const EXCLUDED_SPEAKERS = new Set(['system', 'ai', 'assistant', 'model']);

/** Default names — deliberately NOT used as the role token, only as the parenthetical. */
const GENERIC_NAMES = new Set(['me', 'them', 'you', 'user', 'client', 'rep', 'prospect', '']);

export function isRepSpeaker(speaker: string): boolean {
    const s = (speaker || '').toLowerCase();
    return s === 'user' || s === 'me' || s === 'rep' || s === 'sales' || s === 'seller';
}

/** `mm:ss`, or `h:mm:ss` past an hour. */
export function formatOffset(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Builds the label for one turn: a fixed role token plus the human name when it
 * adds information, plus the diarized speaker index when several far-end
 * speakers were present.
 */
function buildLabel(
    role: 'rep' | 'prospect',
    names: SpeakerNames | null | undefined,
    speakerIndex: number | undefined,
    multiClientSpeakers: boolean,
): string {
    const token = role === 'rep' ? 'REP' : 'PROSPECT';
    const raw = role === 'rep' ? names?.user : names?.client;
    const name = (raw || '').trim();

    const parts: string[] = [];
    if (name && !GENERIC_NAMES.has(name.toLowerCase())) parts.push(name);
    if (role === 'prospect' && multiClientSpeakers && speakerIndex !== undefined) {
        parts.push(`Speaker ${speakerIndex + 1}`);
    }

    return parts.length ? `${token} (${parts.join(', ')})` : token;
}

/**
 * Canonicalizes a raw transcript into the one format every prompt in the app
 * should see.
 *
 * Turns are sorted by timestamp: STT finals arrive out of order (client finals
 * lag behind mic finals), so arrival order routinely places a rep reply BEFORE
 * the client turn it answered, destroying the Q→A adjacency that every
 * cause-and-effect claim in the summary depends on.
 */
export function buildCanonicalTranscript(
    segments: FormattableSegment[],
    options: CanonicalTranscriptOptions = {},
): CanonicalTranscript {
    const {
        speakerNames,
        epochSummaries = [],
        includeTimestamps = true,
        maxChars = 0,
    } = options;

    const usable = (segments || [])
        .filter(s => s && typeof s.text === 'string' && s.text.trim().length > 0)
        .filter(s => !EXCLUDED_SPEAKERS.has((s.speaker || '').toLowerCase()))
        .filter(s => s.source !== 'chat')
        .slice()
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const clientIndices = new Set(
        usable
            .filter(s => !isRepSpeaker(s.speaker) && s.speakerIndex !== undefined)
            .map(s => s.speakerIndex as number),
    );
    const multiClientSpeakers = clientIndices.size >= 2;

    const baseTs = usable.length ? (usable[0].timestamp || 0) : 0;

    const turns: CanonicalTurn[] = usable.map(s => {
        const role: 'rep' | 'prospect' = isRepSpeaker(s.speaker) ? 'rep' : 'prospect';
        return {
            role,
            label: buildLabel(role, speakerNames, s.speakerIndex, multiClientSpeakers),
            text: s.text.trim(),
            timestamp: s.timestamp || 0,
            offsetMs: Math.max(0, (s.timestamp || 0) - baseTs),
            speakerIndex: s.speakerIndex,
        };
    });

    const renderTurn = (t: CanonicalTurn) =>
        includeTimestamps ? `[${formatOffset(t.offsetMs)}] ${t.label}: ${t.text}` : `${t.label}: ${t.text}`;

    const hasEpochSummaries = epochSummaries.length > 0;
    const header = hasEpochSummaries
        ? [
            '<earlier_call_summary>',
            'The opening of this call was compacted to save memory. These are',
            'summaries of what was said before the verbatim transcript below.',
            ...epochSummaries.map((s, i) => `[Epoch ${i + 1}] ${s}`),
            '</earlier_call_summary>',
            '',
        ].join('\n')
        : '';

    let body = turns.map(renderTurn).join('\n');
    let truncated = false;
    if (maxChars > 0 && header.length + body.length > maxChars) {
        body = body.substring(0, Math.max(0, maxChars - header.length));
        truncated = true;
    }

    return {
        text: header + body,
        turns,
        multiClientSpeakers,
        hasEpochSummaries,
        truncated,
    };
}

/**
 * The role-label contract, to be stated in every prompt that consumes a
 * canonical transcript. Keeps prompt and formatter from drifting apart.
 */
export const TRANSCRIPT_FORMAT_CONTRACT = `TRANSCRIPT FORMAT
Each line is: [mm:ss] ROLE (name): text
  • REP      = the salesperson (our side). Their questions are NOT evidence.
  • PROSPECT = the customer. Only PROSPECT statements count as customer evidence.
When several customer participants were detected, PROSPECT lines carry a
"Speaker n" marker so you can attribute statements to the right person.`;
