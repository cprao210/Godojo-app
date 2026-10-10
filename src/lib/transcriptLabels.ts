/**
 * Single source of truth for how a transcript row is LABELLED (speaker name + timestamp).
 *
 * Used by the Meeting Details → Transcript tab (via useMeetingDetails) and by the PDF export
 * (utils/pdfGenerator.ts). Keep it pure (no React, no window) so both can share it — the PDF used
 * to print the raw role ("user" / "client") and a wall-clock time with seconds, which drifted from
 * the tab.
 */

export interface TranscriptLabelSegment {
    speaker: string;
    displayName?: string;
    speakerIndex?: number | null;
    timestamp: number;
}

export interface SpeakerNames {
    user?: string;
    client?: string;
    clientDiarized?: string;
}

export const formatTime = (ms: number) => {
    const date = new Date(ms);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();
};

/**
 * Transcript row timestamp. Live-call segments carry absolute epoch ms (formatted as wall-clock
 * times); uploaded transcripts carry RELATIVE ms since the call start, written with unit letters
 * ("12s", "3m 13s", "1h 2m 5s") so they can't be mistaken for a clock time like "3:13".
 */
export const formatTranscriptTimestamp = (ms: number, relative: boolean): string => {
    if (!relative) return formatTime(ms);
    return formatDurationHuman(undefined, ms) || '0s';
};

/** Epoch ms is ~1.7e12, so any positive timestamp far below that means the transcript is relative. */
export const transcriptTimesAreRelative = (transcript?: { timestamp: number }[]): boolean =>
    (transcript || []).some(t => t.timestamp > 0 && t.timestamp < 1e11);

/** Rows the Transcript tab never shows (system / AI turns). */
export const isHiddenSpeaker = (speaker?: string): boolean =>
    ['system', 'ai', 'assistant', 'model'].includes((speaker || '').toLowerCase());

/** The label + time string for one row, exactly as the Transcript tab renders it. */
export const formatTranscriptTime = (timestamp: number, relative: boolean): string =>
    timestamp ? formatTranscriptTimestamp(timestamp, relative) : (relative ? '0s' : '0:00');

// "Morgan (Raksham)" style labels embed the company in parentheses — the diarized base is the
// company part alone, matching SessionTracker's clientDiarized rule.
const companyFromLabel = (label?: string): string | undefined => {
    if (!label) return undefined;
    const m = label.match(/\(([^)]+)\)\s*$/);
    return m?.[1]?.trim() || undefined;
};

export type SpeakerLabeler = (speaker: string, displayName?: string, speakerIndex?: number | null) => string;

export function createSpeakerLabeler(
    transcript: TranscriptLabelSegment[] | undefined,
    speakerNames: SpeakerNames | undefined,
): SpeakerLabeler {
    // Diarization: suffix far-end labels only when 2+ distinct speaker indices were recorded.
    const seen = new Set<number>();
    for (const seg of transcript || []) {
        const idx = seg.speakerIndex;
        if (idx !== undefined && idx !== null && seg.speaker !== 'user') seen.add(idx);
    }
    const hasMultipleClientSpeakers = seen.size >= 2;

    // First non-generic live-resolved name per role (base name, "· Speaker N" suffix stripped) so
    // aggregate views (Speaking Balance) agree with the rows.
    let liveUser: string | undefined;
    let liveClient: string | undefined;
    for (const seg of transcript || []) {
        const raw = seg.displayName;
        if (!raw || raw === 'Me' || raw === 'Them') continue;
        const suffixIdx = raw.indexOf(' · Speaker ');
        const name = suffixIdx === -1 ? raw : raw.slice(0, suffixIdx);
        if (seg.speaker === 'user' && !liveUser) liveUser = name;
        if ((seg.speaker === 'client' || seg.speaker === 'interviewer') && !liveClient) liveClient = name;
        if (liveUser && liveClient) break;
    }

    return (speaker, displayName, speakerIndex) => {
        // Legacy "Me"/"Them" stamps render as "You" / "Other Party" like new meetings.
        if (displayName === 'Me' || displayName === 'Them') displayName = undefined;

        // Diarization first for far-end turns; a manual rename (clientDiarized) still wins.
        if (
            (speaker === 'client' || speaker === 'interviewer') &&
            hasMultipleClientSpeakers &&
            speakerIndex !== undefined &&
            speakerIndex !== null &&
            !displayName?.includes(' · Speaker ')
        ) {
            const diarizedBase = speakerNames?.clientDiarized || companyFromLabel(displayName) || 'Other Party';
            return `${diarizedBase} · Speaker ${speakerIndex + 1}`;
        }
        // 1. Explicit per-segment displayName is the ground truth for that turn.
        if (displayName) return displayName;
        // 2. Live-resolved name used elsewhere in the transcript.
        if (speaker === 'user' && liveUser) return liveUser;
        if ((speaker === 'client' || speaker === 'interviewer') && liveClient) return liveClient;
        // 3. Calendar-resolved names saved on the summary, else generic wording.
        if (speaker === 'user') return speakerNames?.user || 'You';
        if (speaker === 'client' || speaker === 'interviewer') return speakerNames?.client || 'Other Party';
        if (speaker === 'assistant') return 'Assistant';
        return speaker;
    };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Copy-to-clipboard format
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// "Copy transcript" must produce text the Upload Transcript parser reads back unchanged
// (electron/utils/uploadTranscriptParser.ts, format 7):
//
//     Alex (00:00): hello...
//     Danieal (00:10): hi...
//
// Rules, identical for uploaded and live-call transcripts:
//   • The timestamp is ALWAYS relative to the call start — MM:SS, or HH:MM:SS from one hour on.
//     Uploaded rows already carry relative ms. Live rows carry absolute epoch ms, so they are
//     rebased onto the first spoken row (the previous output printed wall-clock "[05:00 am]",
//     which neither parser nor humans could treat as an offset; it also printed uploaded rows'
//     relative ms as bogus clock times).
//   • Timestamps are never invented: a transcript with no usable timestamps is copied as plain
//     "Alex: hello..." (format 1).
//   • The speaker label is the same one the Transcript tab and PDF show.

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** ms offset from call start → "MM:SS" (or "HH:MM:SS" once the call passes an hour). */
export const formatCopyTimestamp = (offsetMs: number): string => {
    const totalSec = Math.max(0, Math.floor((offsetMs || 0) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
};

// A colon followed by whitespace/end would end the label early when the text is pasted back in.
const sanitizeCopyLabel = (label: string): string =>
    label.replace(/:(?=\s|$)/g, '').replace(/\s+/g, ' ').trim() || 'Other Party';

export interface CopyTranscriptSegment extends TranscriptLabelSegment {
    text: string;
}

/**
 * The whole transcript as "Label (MM:SS): text" lines — round-trips through the upload parser.
 * System / AI rows and empty rows are left out, matching the Transcript tab.
 */
export function formatTranscriptForCopy(
    transcript: CopyTranscriptSegment[] | undefined,
    speakerNames: SpeakerNames | undefined,
): string {
    const all = transcript || [];
    const rows = all.filter(t => !isHiddenSpeaker(t.speaker) && (t.text || '').trim());
    if (!rows.length) return '';

    const labelFor = createSpeakerLabeler(all, speakerNames);
    const relative = transcriptTimesAreRelative(all);
    const positive = rows.map(t => t.timestamp).filter(ts => ts > 0);
    const hasTimes = positive.length > 0;
    // Live rows: offset from the first spoken row. Uploaded rows: already offsets.
    const base = relative || !hasTimes ? 0 : Math.min(...positive);

    return rows
        .map(t => {
            const label = sanitizeCopyLabel(labelFor(t.speaker, t.displayName, t.speakerIndex));
            const text = t.text.trim();
            if (!hasTimes) return `${label}: ${text}`;
            const offset = t.timestamp > 0 ? t.timestamp - base : 0;
            return `${label} (${formatCopyTimestamp(offset)}): ${text}`;
        })
        .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Human-readable call duration
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A call's LENGTH, written with unit letters — "1s", "1m 4s", "40m 5s", "1h 2m 5s" — so it can't be
 * mistaken for a clock-style position in the call such as "03:22".
 * Prefers the raw `durationMs`; otherwise parses the stored "m:ss" / "h:mm:ss" string. An
 * unparseable value (legacy text, "—") is returned unchanged.
 */
export function formatDurationHuman(duration?: string | null, durationMs?: number | null): string {
    let totalSec: number | null = null;
    if (typeof durationMs === 'number' && durationMs > 0) {
        totalSec = Math.floor(durationMs / 1000);
    } else if (duration && /^\d+(:\d{1,2}){1,2}$/.test(duration.trim())) {
        const p = duration.trim().split(':').map(Number);
        totalSec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    }
    if (totalSec === null) return duration ?? '';

    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}