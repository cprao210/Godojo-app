import type { LiveTranscriptEntry } from '@/types';

/**
 * Copy the live-analysis v2 transcript-quality fields from a `native-audio-transcript` event onto
 * a liveTranscriptRef entry. Only defined values are copied, so interims and events from an older
 * main process leave the entry exactly as before.
 */
export function qualityFields(t: {
    textOriginal?: string; turnId?: string; lang?: string; asrSuspect?: boolean;
    suspectReason?: string; arrivalMs?: number;
}): Partial<LiveTranscriptEntry> {
    const out: Partial<LiveTranscriptEntry> = {};
    if (t.textOriginal !== undefined) out.textOriginal = t.textOriginal;
    if (t.turnId !== undefined) out.turnId = t.turnId;
    if (t.lang !== undefined) out.lang = t.lang;
    if (t.asrSuspect !== undefined) out.asrSuspect = t.asrSuspect;
    if (t.suspectReason !== undefined) out.suspectReason = t.suspectReason;
    if (t.arrivalMs !== undefined) out.arrivalMs = t.arrivalMs;
    return out;
}
