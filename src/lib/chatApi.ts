
// Streaming wrappers over the FastAPI chat/RAG routes. Unlike apiClient's axios
// instance (which buffers the whole response as JSON), these endpoints stream
// Server-Sent Events — `event: token|source_ids|done` frames, each followed by
// a `data:` line — so we read the response body directly with `fetch` +
// ReadableStream. Auth/tenant headers mirror apiClient's axios interceptor via
// getAuthHeaders().

import { getAuthHeaders, API_BASE, ApiError } from "./apiClient";

/** Emitted once via the `source_ids` SSE event — lets the UI show "Sources". */
export interface ChatSources {
    sourceIds: string[];
    assetIds: string[];
}

export interface ChatStreamHandlers {
    /** Fired for every `token` frame — `chunk` is the incremental text to append. */
    onToken: (chunk: string) => void;
    /** Fired once, usually before the first token, with the retrieved chunk ids. */
    onSources?: (sources: ChatSources) => void;
    /** Fired once the stream has fully closed (after the `done` frame). */
    onDone?: () => void;
    onError: (error: string) => void;
}

export type ChatRole = "user" | "assistant";
export interface ChatHistoryTurn {
    role: ChatRole;
    content: string;
}

export interface LiveTranscriptSegment {
    text: string;
    speaker: string;
    timestamp: number;
    meeting_id: string;
    chunk_index: number;
}

export interface StreamHandle {
    /** Cancel the in-flight request — call on overlay close / component unmount. */
    abort: () => void;
}

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
        case "source_ids": {
            const parsed = JSON.parse(data) as { ids: string[]; asset_ids: string[] };
            handlers.onSources?.({ sourceIds: parsed.ids ?? [], assetIds: parsed.asset_ids ?? [] });
            break;
        }
        case "error": {
            const parsed = JSON.parse(data) as { error?: string };
            handlers.onError(parsed.error ?? "Something went wrong.");
            break;
        }
        case "done":
            // No payload to act on — the stream closing (handled in streamSSE's
            // read loop) is what actually drives onDone().
            break;
        default:
            break;
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
        meetingId: string,
        history: ChatHistoryTurn[],
        transcript: LiveTranscriptSegment[],
        handlers: ChatStreamHandlers,
    ): StreamHandle =>
        streamSSE("/chat/live", { query, meeting_id: meetingId, history, transcript }, handlers),
};