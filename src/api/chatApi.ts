// Streaming wrappers over the FastAPI chat/RAG routes. Unlike apiClient's axios
// instance (which buffers the whole response as JSON), these endpoints stream
// Server-Sent Events — `event: token|source_ids|done` frames, each followed by
// a `data:` line — so we read the response body directly with `fetch` +
// ReadableStream. Auth/tenant headers mirror apiClient's axios interceptor via
// getAuthHeaders().

import { getAuthHeaders, API_BASE, ApiError, apiFetch } from "@/lib/apiClient";
import { ChatHistoryTurn, ChatStreamHandlers, LiveTranscriptSegment, RagAnswer, StreamHandle } from "@/types";

/**
 * POST `path` with `body` and parse the SSE response, dispatching frames to
 * `handlers` as they arrive. Fire-and-forget from the caller's point of view —
 * progress comes entirely through the handler callbacks.
 */
function streamSSE(path: string, body: unknown, handlers: ChatStreamHandlers): StreamHandle {
    const controller = new AbortController();

    (async () => {
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
                    dispatchFrame(buffer.slice(0, sep), handlers);
                    buffer = buffer.slice(sep + 2);
                }
            }
            if (buffer.trim()) dispatchFrame(buffer, handlers); // trailing frame, no closing blank line

            handlers.onDone?.();
        } catch (err) {
            if (controller.signal.aborted) return; // caller cancelled — not a failure
            console.error(`[chatApi] stream failed (${path}):`, err);
            handlers.onError(
                err instanceof ApiError ? err.message : "Couldn't get a response. Please try again.",
            );
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
    /** Header search bar — TopSearchPill → GlobalChatOverlay. */
    queryGlobal: (query: string, handlers: ChatStreamHandlers): StreamHandle =>
        streamSSE("/chat/rag/query/global", { query }, handlers),

    /** Post-meeting chat — MeetingChatOverlay. */
    queryMeeting: (meetingId: string, query: string, handlers: ChatStreamHandlers): StreamHandle =>
        streamSSE(`/chat/rag/query/meeting/${meetingId}`, { query }, handlers),

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
};