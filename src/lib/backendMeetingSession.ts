// Owns the *backend* live-meeting session (POST /meetings/start → /transcript →
// /end), which is the server-side replacement for Electron's client-side
// MeetingPersistence.processAndSaveMeeting pipeline.
//
// Why a module singleton rather than a hook: the lifecycle is split across two
// unrelated hooks — start/end live in useMeetingSession, pause/resume in
// useGodojoInterface — and threading refs between them through App.tsx would be
// far more invasive than one owner both can call into.
//
// Rollout: gated on the `useBackendMeetingPipeline` localStorage flag, latched
// once at start() so flipping it mid-call can never split a meeting across both
// pipelines. When the flag is off, or when the backend path fails at any point,
// end() reports failure and the caller falls back to the Electron pipeline —
// which is left fully intact until this path has proven itself in production.

import { chatApi } from "@/api/chatApi";
import { meetingsApi } from "@/api/meetingsApi";
import { MeetingType, StartMeetingRequest, TranscriptSegmentInput, TranscriptSpeaker } from "@/types";

export const BACKEND_PIPELINE_FLAG = "useBackendMeetingPipeline";

/** How often buffered transcript segments are pushed to the backend. The
 *  backend summarizes from the `transcripts` table, not from the /end payload,
 *  so everything must land before /end — flushing as we go means a crash costs
 *  at most this window, instead of the whole call. */
const FLUSH_INTERVAL_MS = 10_000;

/** A transcript payload as broadcast by main.ts on `native-audio-transcript`. */
export interface NativeTranscriptPayload {
    speaker?: string;
    text?: string;
    timestamp?: number;
    final?: boolean;
    confidence?: number;
    retract?: boolean;
}

function flagEnabled(): boolean {
    try {
        return localStorage.getItem(BACKEND_PIPELINE_FLAG) === "true";
    } catch {
        // No localStorage (tests, or a hardened context) — stay on the old path.
        return false;
    }
}

class BackendMeetingSession {
    private meetingId: string | null = null;
    private buffer: TranscriptSegmentInput[] = [];
    /** Ask-Dojo interaction ids logged during this call — see recordInteractionId. */
    private interactionIds: number[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    /** Serializes flushes so two in-flight POSTs can't interleave and reorder. */
    private inFlight: Promise<void> = Promise.resolve();
    private paused = false;
    /** Set when the backend session is unrecoverable (e.g. the server restarted
     *  and lost the in-memory session). Ends the call on the Electron path. */
    private failed = false;

    /** True once start() has successfully opened a backend session. */
    isActive(): boolean {
        return this.meetingId !== null && !this.failed;
    }

    getMeetingId(): string | null {
        return this.isActive() ? this.meetingId : null;
    }

    /** Opens a backend session. No-ops (returns false) when the flag is off, so
     *  callers can invoke it unconditionally. */
    async start(body: StartMeetingRequest): Promise<boolean> {
        if (!flagEnabled()) return false;

        this.reset();
        try {
            const res = await meetingsApi.start(body);
            this.meetingId = res.meeting_id;
            this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
            console.log("[backendMeetingSession] started", res.meeting_id);
            return true;
        } catch (err) {
            // Leave meetingId null — isActive() stays false and the whole call
            // runs on the Electron pipeline exactly as before.
            console.error("[backendMeetingSession] start failed, using Electron pipeline:", err);
            this.reset();
            return false;
        }
    }

    /** Buffers one transcript turn. Interims, retractions and blank turns are
     *  dropped: main.ts emits ~10/sec and only finals reach SessionTracker, so
     *  buffering anything else would both bloat the POST and duplicate text.
     *  Echo-filtered turns never reach the renderer at all (main.ts returns
     *  before the broadcast), so no echo handling is needed here. */
    captureSegment(payload: NativeTranscriptPayload): void {
        if (!this.isActive() || this.paused) return;
        if (!payload?.final || payload.retract) return;

        const text = (payload.text ?? "").trim();
        if (!text) return;

        this.buffer.push({
            speaker: (payload.speaker as TranscriptSpeaker) || "client",
            text,
            timestamp: payload.timestamp ?? Date.now(),
            final: true,
            confidence: payload.confidence,
        });
    }

    /** Records an Ask-Dojo interaction so end() can attach it to this meeting.
     *
     *  The Electron pipeline links these lazily (useLauncher polls until the
     *  meeting row appears in the backend) because at call-end no such row
     *  exists yet. On this pipeline POST /meetings/start created the row up
     *  front, so we can — and must — link before /end: the background job reads
     *  `ai_interactions` the moment /end returns, and anything linked later
     *  simply won't be in the summary. */
    recordInteractionId(interactionId: number): void {
        if (!this.isActive()) return;
        this.interactionIds.push(interactionId);
    }

    /** Pushes buffered segments. Segments are put back on failure so a transient
     *  network blip doesn't silently drop part of the transcript. */
    private flush(): Promise<void> {
        this.inFlight = this.inFlight.then(async () => {
            if (!this.isActive() || this.buffer.length === 0) return;

            const batch = this.buffer.splice(0, this.buffer.length);
            const id = this.meetingId!;
            try {
                await meetingsApi.submitTranscript(id, batch);
            } catch (err) {
                this.buffer.unshift(...batch);
                console.error(`[backendMeetingSession] flush failed (${batch.length} segments requeued):`, err);
                throw err;
            }
        }).catch(() => {
            // Swallow so one failure doesn't poison every later flush in the chain.
        });
        return this.inFlight;
    }

    async pause(): Promise<void> {
        if (!this.isActive()) return;
        // Flush first: the backend drops segments submitted while paused, so
        // anything still buffered has to land before the pause takes effect.
        await this.flush();
        this.paused = true;
        try {
            await meetingsApi.pause(this.meetingId!);
        } catch (err) {
            console.error("[backendMeetingSession] pause failed:", err);
        }
    }

    async resume(): Promise<void> {
        if (!this.isActive()) return;
        this.paused = false;
        try {
            await meetingsApi.resume(this.meetingId!);
        } catch (err) {
            console.error("[backendMeetingSession] resume failed:", err);
        }
    }

    /** Flushes the remainder and finalizes the meeting server-side.
     *
     *  Returns the backend meeting id on success, or null if this call should
     *  fall back to the Electron pipeline. The fallback is the reason /end is
     *  only reached after the transcript is confirmed delivered: a meeting
     *  finalized with a half-written transcript would be summarized from
     *  partial data, which is worse than letting Electron handle it. */
    async end(meetingTypes: MeetingType[] = []): Promise<string | null> {
        if (!this.isActive()) {
            this.reset();
            return null;
        }

        const id = this.meetingId!;
        this.stopTimer();
        this.paused = false;

        // One retry — the flush path requeues on failure, so a second attempt
        // sends the same segments rather than a truncated set.
        await this.flush();
        if (this.buffer.length > 0) await this.flush();
        if (this.buffer.length > 0) {
            console.error(
                `[backendMeetingSession] ${this.buffer.length} segments undelivered — ` +
                "falling back to the Electron pipeline for this meeting.",
            );
            this.reset();
            return null;
        }

        // Attach in-call Q&A before /end, not after — see recordInteractionId.
        // Non-fatal: a summary missing its Ask-Dojo context is worse than one
        // with it, but far better than discarding the meeting entirely.
        if (this.interactionIds.length > 0) {
            try {
                await chatApi.linkMeetingInteractions(id, this.interactionIds);
            } catch (err) {
                console.error("[backendMeetingSession] linking interactions failed:", err);
            }
        }

        try {
            await meetingsApi.end(id, meetingTypes);
        } catch (err) {
            console.error("[backendMeetingSession] end failed, falling back to Electron pipeline:", err);
            this.reset();
            return null;
        }

        // NB: no chunk() call here. useLauncher already fires /chunking when the
        // meeting flips to isProcessed — i.e. once the summary actually exists.
        // Chunking here would race that and ingest an unprocessed meeting.

        this.reset();
        return id;
    }

    /** Drops local session state without touching the backend. */
    reset(): void {
        this.stopTimer();
        this.meetingId = null;
        this.buffer = [];
        this.interactionIds = [];
        this.paused = false;
        this.failed = false;
        this.inFlight = Promise.resolve();
    }

    private stopTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

export const backendMeetingSession = new BackendMeetingSession();
