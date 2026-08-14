// Streaming wrappers over the FastAPI chat/RAG routes. Unlike apiClient's axios
// instance (which buffers the whole response as JSON), these endpoints stream
// Server-Sent Events — `event: token|source_ids|done` frames, each followed by
// a `data:` line — so we read the response body directly with `fetch` +
// ReadableStream. Auth/tenant headers mirror apiClient's axios interceptor via
// getAuthHeaders().

import { getAuthHeaders, API_BASE, ApiError, apiFetch } from "@/lib/apiClient";
import { ChatHistoryTurn, ChatSession, ChatStreamHandlers, LiveTranscriptSegment, RagAnswer, StreamHandle } from "@/types";

// Transient failures worth retrying automatically: network drops (fetch
// throws a TypeError, e.g. "Failed to fetch") and server-side/rate-limit
// errors (5xx, 429). Anything else (400/401/403/404, malformed request,
// etc.) is a client-side problem that will fail identically on retry, so
// don't waste time/attempts on it.
const MAX_STREAM_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 600;

function isRetryableStreamError(err: unknown): boolean {
    if (err instanceof ApiError) return err.status >= 500 || err.status === 429;
    // fetch() rejects with a plain TypeError for network-level failures
    // (offline, DNS, connection reset) — anything else thrown here (e.g. a
    // JSON.parse error while decoding a frame) is a bug, not a transient
    // network blip, so it shouldn't be retried.
    return err instanceof TypeError;
}

/**
 * POST `path` with `body` and parse the SSE response, dispatching frames to
 * `handlers` as they arrive. Fire-and-forget from the caller's point of view —
 * progress comes entirely through the handler callbacks.
 *
 * Automatically retries (with backoff) on transient failures — but ONLY while
 * nothing has streamed back to the user yet. The moment a token, rag_answer,
 * or sources frame arrives, retries are disabled for the rest of this call:
 * re-sending the request after partial content has already rendered would
 * duplicate or garble what's on screen, which is worse than just surfacing
 * the error and letting the person hit "try again" themselves.
 */
function streamSSE(path: string, body: unknown, handlers: ChatStreamHandlers): StreamHandle {
    const controller = new AbortController();
    let hasStreamedContent = false;

    // Wrap onToken/onRagAnswer/onSources so we can flip the retry gate the
    // instant real content starts arriving, without touching every call site
    // below.
    const guardedHandlers: ChatStreamHandlers = {
        ...handlers,
        onToken: (chunk) => { hasStreamedContent = true; handlers.onToken(chunk); },
        onRagAnswer: (answer) => { hasStreamedContent = true; handlers.onRagAnswer?.(answer); },
        onSources: (sources) => { hasStreamedContent = true; handlers.onSources?.(sources); },
    };

    (async () => {
        for (let attempt = 0; ; attempt++) {
            try {
                const authHeaders = await getAuthHeaders();
                const res = await fetch(`${API_BASE}${path}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...authHeaders },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });

                if (!res.ok || !res.body) {
                    const errBody = (await res.json().catch(() => undefined)) as
                        | { error?: { code?: string; message?: string } }
                        | undefined;
                    throw new ApiError(
                        res.status,
                        errBody?.error?.code ?? "error",
                        errBody?.error?.message ?? res.statusText,
                    );
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });

                    // SSE frames are separated by a blank line.
                    let sep: number;
                    while ((sep = buffer.indexOf("\n\n")) !== -1) {
                        dispatchFrame(buffer.slice(0, sep), guardedHandlers);
                        buffer = buffer.slice(sep + 2);
                    }
                }
                if (buffer.trim()) dispatchFrame(buffer, guardedHandlers); // trailing frame, no closing blank line

                handlers.onDone?.();
                return; // success — stop the retry loop
            } catch (err) {
                if (controller.signal.aborted) return; // caller cancelled — not a failure

                const canRetry = !hasStreamedContent
                    && attempt < MAX_STREAM_RETRIES
                    && isRetryableStreamError(err);

                if (canRetry) {
                    const nextAttempt = attempt + 1;
                    console.warn(`[chatApi] stream failed (${path}), retrying ${nextAttempt}/${MAX_STREAM_RETRIES}:`, err);
                    handlers.onRetry?.(nextAttempt, MAX_STREAM_RETRIES);
                    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }

                console.error(`[chatApi] stream failed (${path}):`, err);
                handlers.onError(
                    err instanceof ApiError ? err.message : "Couldn't get a response. Please try again.",
                );
                return;
            }
        }
    })();

    return { abort: () => controller.abort() };
}

function dispatchFrame(frame: string, handlers: ChatStreamHandlers): void {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;

    switch (event) {
        case "token": {
            const parsed = JSON.parse(data) as { chunk: string };
            handlers.onToken(parsed.chunk);
            break;
        }
        case "status": {
            const parsed = JSON.parse(data) as { status: string };
            handlers.onStatus?.(parsed.status);
            break;
        }
        case "source_ids": {
            const parsed = JSON.parse(data) as {
                sources?: { id: string; title: string; type: string }[];
            };
            const all = parsed.sources ?? [];
            handlers.onSources?.({
                meetings: all
                    .filter((s) => s.type === "meeting")
                    .map(({ id, title }) => ({ id, title })),
                assets: all
                    .filter((s) => s.type !== "meeting")
                    .map(({ id, title }) => ({ id, title })),
            });
            break;
        }
        case "rag_answer": {
            const parsed = JSON.parse(data) as RagAnswer;
            handlers.onRagAnswer?.(parsed);
            break;
        }
        case "interaction_id": {
            const parsed = JSON.parse(data) as { interaction_id: number };
            handlers.onInteractionId?.(parsed.interaction_id);
            break;
        }
        case "session_created": {
            const parsed = JSON.parse(data) as { session_id: string };
            handlers.onSessionCreated?.(parsed.session_id);
            break;
        }
        case "title_updated": {
            const parsed = JSON.parse(data) as { title: string };
            handlers.onTitleUpdated?.(parsed.title);
            break;
        }
        case "error": {
            const parsed = JSON.parse(data) as { error?: string };
            handlers.onError(parsed.error ?? "Something went wrong.");
            break;
        }
        case "done":
            // `{}` — no payload to act on. The stream closing (handled in
            // streamSSE's read loop) is what actually drives onDone().
            break;
        default:
            break;
    }
}

/** Maps a raw `status` frame value to the label shown in the UI while the
 * assistant is working. Applied identically across GlobalChatOverlay,
 * MeetingChatOverlay, and FloatingChatPanel so status text reads the same
 * everywhere. Unknown/future status values fall back to a generic label
 * rather than showing nothing. */
export function statusLabel(status: string): string {
    switch (status) {
        case "connected":
            return "Connecting…";
        case "searching":
            return "Searching meetings…";
        case "generating":
            return "Generating response…";
        default:
            return "Thinking…";
    }
}

export const chatApi = {
    /** Header search bar — TopSearchPill → GlobalChatOverlay.
     * `sessionId` — pass the stored session id to resume a chat, or `null` to
     * start a new one (backend auto-creates and returns it via the
     * `session_created` frame). `history` is a fallback ONLY used when
     * `sessionId` is null; once a session exists the backend loads the last
     * 20 turns from `ai_interactions` itself, so pass `[]` on resumed chats.
      */
    queryGlobal: (
        query: string,
        sessionId: string | null,
        history: ChatHistoryTurn[],
        handlers: ChatStreamHandlers,
    ): StreamHandle =>
        streamSSE("/chat/rag/query/global", { query, session_id: sessionId, history }, handlers),

    /** Post-meeting chat — MeetingChatOverlay. Same session_id/history contract as queryGlobal. */
    queryMeeting: (
        meetingId: string,
        query: string,
        sessionId: string | null,
        history: ChatHistoryTurn[],
        handlers: ChatStreamHandlers,
    ): StreamHandle =>
        streamSSE(`/chat/rag/query/meeting/${meetingId}`, { query, session_id: sessionId, history }, handlers),

    /** In-call chat — FloatingChatPanel. Needs the live transcript + prior turns. */
    queryLive: (
        query: string,
        history: ChatHistoryTurn[],
        transcript: LiveTranscriptSegment[],
        handlers: ChatStreamHandlers,
    ): StreamHandle =>
        streamSSE("/chat/live", { query, history, transcript }, handlers),

    /**
     * Called once, after the call ends, with every interaction_id collected
     * from /chat/live responses during the call. The live endpoint has no
     * real meeting id to attach to at query time (the meeting isn't
     * persisted yet), so each turn is logged against just its interaction_id;
     * this retroactively links that whole batch to the now-final meeting_id
     * so meeting history / MeetingChatOverlay can retrieve them.
     */
    linkMeetingInteractions: (meetingId: string, interactionIds: number[]): Promise<void> =>
        apiFetch<void>("/live/link-meeting", {
            method: "POST",
            body: JSON.stringify({ interaction_ids: interactionIds, meeting_id: meetingId }),
        }),

    // ── Session management (REST, not SSE) ──────────────────────────────────

    /** Pre-create a session before the first message. Optional — every chat
     * endpoint auto-creates one — but lets the sidebar show "New Chat"
     * immediately instead of waiting for the first `session_created` frame. */
    createSession: (): Promise<ChatSession> =>
        apiFetch<ChatSession>("/chat/sessions", { method: "POST" }),

    /** Sidebar list. Sorted newest-first by the backend, capped at 30. */
    listSessions: (): Promise<ChatSession[]> =>
        apiFetch<{ sessions: ChatSession[] }>("/chat/sessions").then((r) => r.sessions),

    /** Full turn history for resuming a chat (last 20 messages, chronological). */
    getSessionMessages: (sessionId: string): Promise<ChatHistoryTurn[]> =>
        apiFetch<{ session_id: string; messages: ChatHistoryTurn[] }>(
            `/chat/sessions/${sessionId}/messages`,
        ).then((r) => r.messages),

    /** Deletes a session + its turn history. Idempotent from the caller's
     * perspective — the sidebar removes it optimistically regardless. */
    deleteSession: (sessionId: string): Promise<void> =>
        apiFetch<void>(`/chat/sessions/${sessionId}`, { method: "DELETE" }),

};