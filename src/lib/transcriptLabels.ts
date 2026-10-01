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
 * times); uploaded transcripts carry RELATIVE ms since the call start ("12s", "1:15").
 */
export const formatTranscriptTimestamp = (ms: number, relative: boolean): string => {
    if (!relative) return formatTime(ms);
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
};

/** Epoch ms is ~1.7e12, so any positive timestamp far below that means the transcript is relative. */
export const transcriptTimesAreRelative = (transcript?: { timestamp: number }[]): boolean =>
    (transcript || []).some(t => t.timestamp > 0 && t.timestamp < 1e11);

/** Rows the Transcript tab never shows (system / AI turns). */
export const isHiddenSpeaker = (speaker?: string): boolean =>
    ['system', 'ai', 'assistant', 'model'].includes((speaker || '').toLowerCase());

/** The label + time string for one row, exactly as the Transcript tab renders it. */
export const formatTranscriptTime = (timestamp: number, relative: boolean): string =>
    timestamp ? formatTranscriptTimestamp(timestamp, relative) : '0:00';

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