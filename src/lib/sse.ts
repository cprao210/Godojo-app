// src/lib/sse.ts
//
// Generic Server-Sent-Events over a POST request (EventSource can't POST or send an auth header).
// Used by live analysis v2 (`/intelligence/live-analysis/v2`), whose ticks stream `ack`,
// `signals_update`, `qualification_update`, `questions_update`, `degraded` and `done` events.
//
// Differences from the chat client's private reader (src/api/chatApi.ts): typed events, CRLF
// tolerance, comment-line (": ping") skipping, a client-side deadline, and one token-refresh retry
// on a 401 before any event has been delivered.

import { API_BASE, ApiError, getAuthHeaders } from '@/lib/apiClient';
import { getFirebaseAuth } from '@/lib/firebase';

export interface SSEEvent<T = unknown> {
    event: string;
    data: T;
}

/** Incremental SSE frame parser. Feed decoded text chunks; get complete events back. */
export class SSEParser {
    private buffer = '';

    push(chunk: string): SSEEvent[] {
        this.buffer += chunk.replace(/\r\n/g, '\n');
        const out: SSEEvent[] = [];
        let sep: number;
        while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
            const frame = this.buffer.slice(0, sep);
            this.buffer = this.buffer.slice(sep + 2);
            const ev = parseFrame(frame);
            if (ev) out.push(ev);
        }
        return out;
    }

    /** Parse whatever is left once the stream has closed (a final frame with no blank line). */
    flush(): SSEEvent[] {
        const rest = this.buffer.trim();
        this.buffer = '';
        const ev = rest ? parseFrame(rest) : null;
        return ev ? [ev] : [];
    }
}

export function parseFrame(frame: string): SSEEvent | null {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue; // comment / heartbeat
        const idx = line.indexOf(':');
        const field = idx === -1 ? line : line.slice(0, idx);
        const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
    }
    if (data.length === 0) return null;
    const raw = data.join('\n');
    try {
        return { event, data: JSON.parse(raw) };
    } catch {
        return { event, data: raw };
    }
}

export interface PostSSEOptions {
    onEvent: (ev: SSEEvent) => void;
    signal?: AbortSignal;
    /** Abort the whole request after this long (ms). */
    timeoutMs?: number;
}

async function authHeaders(forceRefresh: boolean): Promise<Record<string, string>> {
    if (!forceRefresh) return getAuthHeaders();
    const user = getFirebaseAuth().currentUser;
    if (!user) throw new ApiError(401, 'unauthorized', 'Not signed in');
    await user.getIdToken(true);
    return getAuthHeaders();
}

/**
 * POST `body` to `${API_BASE}${path}` and deliver each SSE event as it arrives. Resolves once the
 * stream ends; rejects with ApiError on HTTP errors, timeouts (504 client_timeout) or aborts
 * (499 request_aborted).
 */
export async function postSSE(path: string, body: unknown, opts: PostSSEOptions): Promise<void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);
    let timedOut = false;
    const timer = opts.timeoutMs
        ? setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs)
        : undefined;
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            let res: Response;
            try {
                res = await fetch(`${API_BASE}${path}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'text/event-stream',
                        ...(await authHeaders(attempt > 0)),
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
            } catch (err) {
                if (timedOut) throw new ApiError(504, 'client_timeout', 'Live analysis timed out');
                if (controller.signal.aborted) throw new ApiError(499, 'request_aborted', 'Request aborted');
                throw new ApiError(503, 'service_unavailable', err instanceof Error ? err.message : 'Network error');
            }
            if (res.status === 401 && attempt === 0) continue;
            if (!res.ok || !res.body) {
                const errBody = (await res.json().catch(() => undefined)) as
                    | { error?: { code?: string; message?: string } }
                    | undefined;
                throw new ApiError(res.status, errBody?.error?.code ?? 'error', errBody?.error?.message ?? res.statusText);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const parser = new SSEParser();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
                        opts.onEvent(ev);
                    }
                }
            } catch (err) {
                if (timedOut) throw new ApiError(504, 'client_timeout', 'Live analysis timed out');
                if (controller.signal.aborted) throw new ApiError(499, 'request_aborted', 'Request aborted');
                throw err;
            }
            for (const ev of parser.flush()) {
                opts.onEvent(ev);
            }
            return;
        }
        throw new ApiError(401, 'unauthorized', 'Session expired');
    } finally {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
    }
}
