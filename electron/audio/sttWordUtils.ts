/**
 * sttWordUtils — pure helpers for word-level STT metadata.
 *
 * Two jobs:
 *
 * 1. Stream-time → wall-time conversion. Deepgram word timestamps are in
 *    seconds of AUDIO SENT on that websocket, which diverges from wall time
 *    (handshake buffering flushes bursts; the native layer suppresses silent
 *    stretches; reconnects reset the stream clock). Each provider records
 *    anchors {streamSec, wallMs} in its send path; conversion projects a word
 *    time back from the earliest anchor at-or-after it, which bounds the error
 *    to intra-anchor jitter instead of gap length.
 *
 * 2. Speaker splitting. With diarize=true, a committed (is_final) window can
 *    contain words from multiple far-end speakers. Finals are split into
 *    contiguous same-speaker runs; single-speaker windows keep the verbatim
 *    transcript string (smart_format punctuation intact).
 *
 * Everything here is pure and covered by vitest — no sockets, no timers.
 */

/** One transcribed word with wall-clock times (ms since epoch). */
export interface SttWord {
    text: string;
    /** Deepgram punctuated_word when present — preferred for display. */
    punctuated?: string;
    startMs: number;
    endMs: number;
    /** Diarization speaker index (per-connection, resets on reconnect). */
    speaker?: number;
    confidence?: number;
}

/** Maps a websocket's audio clock to wall time at one send instant. */
export interface TimeAnchor {
    /** Seconds of audio sent on this connection (bytesSent / bytesPerSecond). */
    streamSec: number;
    /** Date.now() when that byte count had just been sent. */
    wallMs: number;
}

/**
 * Sends closer together (in wall time) than this extend the current anchor;
 * a larger jump means bytes stopped flowing (suppression gap, reconnect pause)
 * and starts a new continuity segment.
 */
const ANCHOR_EXTEND_WINDOW_MS = 500;
const ANCHOR_CAP = 120;

/**
 * Record an anchor after a send. Mutates `anchors` in place (the provider owns
 * the array).
 *
 * Each anchor marks the END of a continuity segment — a stretch of sends with
 * no wall-time gap. Contiguous sends EXTEND the last anchor instead of
 * stacking new ones; this is what makes handshake burst flushes project
 * correctly: a burst collapses into one trailing anchor, and since buffered
 * audio is a real-time recording, back-projection from the burst end recovers
 * each word's true capture time. A wall-time jump ≥ ANCHOR_EXTEND_WINDOW_MS
 * starts a new anchor, which is what bounds cross-gap projection error to one
 * segment span instead of the gap length.
 */
export function appendAnchor(anchors: TimeAnchor[], streamSec: number, wallMs: number): void {
    const last = anchors[anchors.length - 1];
    if (last && wallMs - last.wallMs < ANCHOR_EXTEND_WINDOW_MS) {
        if (streamSec > last.streamSec) last.streamSec = streamSec;
        if (wallMs > last.wallMs) last.wallMs = wallMs;
        return;
    }
    anchors.push({ streamSec, wallMs });
    while (anchors.length > ANCHOR_CAP) anchors.shift();
}

/**
 * Convert a stream-audio timestamp (seconds) to wall-clock ms.
 *
 * Uses the EARLIEST anchor with streamSec >= target and projects back assuming
 * 1× real-time audio between the word and that anchor. Because anchors are at
 * most ~0.5 s of stream time apart, suppression gaps inside that span are the
 * only error source — bounded by anchor spacing, not by gap length. Words past
 * the last anchor extrapolate forward from it.
 *
 * Returns null when no anchors exist (nothing sent yet — should not happen for
 * a received transcript, but callers must not crash).
 */
export function convertStreamSecToWallMs(
    anchors: readonly TimeAnchor[],
    streamSec: number
): number | null {
    if (anchors.length === 0) return null;

    // Binary search: first anchor with anchor.streamSec >= streamSec.
    let lo = 0;
    let hi = anchors.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (anchors[mid].streamSec >= streamSec) {
            found = mid;
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }

    if (found === -1) {
        // Word beyond the last anchor — extrapolate forward.
        const last = anchors[anchors.length - 1];
        return Math.round(last.wallMs + (streamSec - last.streamSec) * 1000);
    }
    const a = anchors[found];
    return Math.round(a.wallMs - (a.streamSec - streamSec) * 1000);
}

/** Lowercase and strip everything but letters/digits — cross-stream matching key. */
export function normalizeWordText(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface SpeakerSegment {
    text: string;
    /** Present only when diarization attributed the run to a speaker. */
    speakerIndex?: number;
    words: SttWord[];
}

/**
 * Split a committed final window into contiguous same-speaker runs.
 *
 * - No words / no speaker data → one segment with the verbatim transcript.
 * - One distinct speaker → one segment, verbatim transcript, that speaker.
 * - Multiple speakers → one segment per run; text is reconstructed from
 *   `punctuated ?? text` (the verbatim string cannot be split reliably).
 */
export function splitFinalBySpeaker(words: SttWord[], transcript: string): SpeakerSegment[] {
    const speakered = words.filter(w => w.speaker !== undefined);
    if (words.length === 0 || speakered.length === 0) {
        return [{ text: transcript, words }];
    }

    const distinct = new Set(speakered.map(w => w.speaker));
    if (distinct.size <= 1) {
        return [{ text: transcript, speakerIndex: speakered[0].speaker, words }];
    }

    const segments: SpeakerSegment[] = [];
    let run: SttWord[] = [];
    let runSpeaker: number | undefined;

    const flush = () => {
        if (run.length === 0) return;
        segments.push({
            text: run.map(w => w.punctuated ?? w.text).join(' '),
            speakerIndex: runSpeaker,
            words: run,
        });
        run = [];
    };

    for (const w of words) {
        // Words missing a speaker inherit the current run (they are rare —
        // fillers the diarizer skipped — and splitting on them causes churn).
        const sp = w.speaker ?? runSpeaker;
        if (run.length > 0 && sp !== runSpeaker) flush();
        if (run.length === 0) runSpeaker = sp;
        run.push(w);
    }
    flush();

    return segments;
}
