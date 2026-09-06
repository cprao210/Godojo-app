import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// chatApi talks to the backend via raw `fetch` (for streaming), not apiFetch —
// mock the pieces of apiClient it actually uses.
// chatApi talks to the backend via raw `fetch` (for streaming) for the SSE
// endpoints, but linkMeetingInteractions is a plain POST via apiFetch — mock
// both surfaces.
vi.mock('@/lib/apiClient', async () => {
    const actual = await vi.importActual<typeof import('@/lib/apiClient')>('@/lib/apiClient');
    return {
        ...actual,
        API_BASE: 'http://test-api/api/v1',
        getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'Bearer test-token' }),
        apiFetch: vi.fn().mockResolvedValue(undefined),
    };
});

import { chatApi, statusLabel } from '@/api';
import { getAuthHeaders, apiFetch } from '@/lib/apiClient';

const mockedGetAuthHeaders = vi.mocked(getAuthHeaders);
const mockedApiFetch = vi.mocked(apiFetch);

// Mirrors chatApi.ts's private MAX_STREAM_RETRIES (not exported — a 5xx/429
// response is retried this many times before the stream gives up and calls
// onError). Kept in sync manually; if chatApi.ts's retry count changes,
// update this too.
const MAX_STREAM_RETRIES = 3;

/** Builds a fetch-compatible Response whose body streams the given SSE frames,
 * each already formatted as `event: ...\ndata: ...`. Frames are joined with a
 * blank-line separator, matching the real wire format, and emitted as a single
 * chunk (dispatchFrame is exercised the same way regardless of chunk boundaries). */
function sseResponse(frames: string[], opts: { ok?: boolean; status?: number } = {}): Response {
    const body = frames.join('\n\n') + '\n\n';
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
        },
    });
    return new Response(stream, { status: opts.status ?? 200 });
}

function errorResponse(status: number, code: string, message: string): Response {
    return new Response(JSON.stringify({ error: { code, message } }), { status });
}

/** Waits until either onDone or onError fires, collecting everything dispatched
 * along the way. The stream loop inside chatApi runs detached (fire-and-forget),
 * so tests await this rather than the (synchronous) return value of the chatApi call. */
function collectHandlers() {
    const tokens: string[] = [];
    const statuses: string[] = [];
    let sources: unknown;
    let ragAnswer: unknown;
    let error: string | undefined;
    let done = false;
    let resets = 0;

    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
    });

    const handlers = {
        onToken: (chunk: string) => tokens.push(chunk),
        onStatus: (status: string) => statuses.push(status),
        onSources: (s: unknown) => {
            sources = s;
        },
        onRagAnswer: (r: unknown) => {
            ragAnswer = r;
        },
        onReset: () => {
            resets += 1;
            // Mirror what every real consumer does: throw away what has
            // rendered so far, so `tokens` ends up holding only the answer the
            // user is actually left looking at.
            tokens.length = 0;
        },
        onError: (msg: string) => {
            error = msg;
            resolveSettled();
        },
        onDone: () => {
            done = true;
            resolveSettled();
        },
    };

    return { handlers, settled, tokens, statuses, get sources() { return sources; }, get ragAnswer() { return ragAnswer; }, get error() { return error; }, get done() { return done; }, get resets() { return resets; } };
}

describe('statusLabel', () => {
    it('maps known status values to their labels', () => {
        expect(statusLabel('connected')).toBe('Connecting…');
        expect(statusLabel('searching')).toBe('Searching meetings…');
        expect(statusLabel('generating')).toBe('Generating response…');
    });

    it('maps the live-call statuses', () => {
        // "Searching meetings…" would be wrong mid-call: the source is the
        // conversation in progress, not the archive.
        expect(statusLabel('searching_transcript')).toBe('Reading the call…');
        expect(statusLabel('coaching')).toBe('Checking their objections…');
    });

    it('falls back to a generic label for unknown statuses', () => {
        expect(statusLabel('anything-else')).toBe('Thinking…');
        expect(statusLabel('')).toBe('Thinking…');
    });
});

describe('chatApi.queryGlobal', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        mockedGetAuthHeaders.mockClear();
    });

    // The two retry tests below swap in fake timers to skip chatApi's backoff.
    // No-op for every other test in this block, which never installs them.
    afterEach(() => {
        vi.useRealTimers();
    });

    it('POSTs to the global RAG query route with auth headers, session_id, and history', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['event: done\ndata: {}']));
        const { handlers, settled } = collectHandlers();

        chatApi.queryGlobal('what changed last quarter?', null, [], handlers);
        await settled;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://test-api/api/v1/chat/rag/query/global');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
        expect(JSON.parse(init.body)).toEqual({
            query: 'what changed last quarter?',
            session_id: null,
            history: [],
        });
    });

    it('sends the stored session_id and omits history on a resumed chat', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['event: done\ndata: {}']));
        const { handlers, settled } = collectHandlers();

        chatApi.queryGlobal('follow-up question', 'session-abc', [], handlers);
        await settled;

        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(init.body)).toEqual({
            query: 'follow-up question',
            session_id: 'session-abc',
            history: [],
        });
    });

    it('dispatches token, status, source_ids, and rag_answer frames to the matching handlers', async () => {
        fetchMock.mockResolvedValueOnce(
            sseResponse([
                'event: status\ndata: {"status":"searching"}',
                'event: token\ndata: {"chunk":"Hel"}',
                'event: token\ndata: {"chunk":"lo"}',
                'event: source_ids\ndata: {"sources":[{"id":"m1","title":"Call A","type":"meeting"},{"id":"a1","title":"Doc A","type":"asset"}]}',
                'event: rag_answer\ndata: {"answer":"Hello there"}',
                'event: done\ndata: {}',
            ]),
        );
        const result = collectHandlers();

        chatApi.queryGlobal('hi', null, [], result.handlers);
        await result.settled;

        expect(result.statuses).toEqual(['searching']);
        expect(result.tokens).toEqual(['Hel', 'lo']);
        expect(result.sources).toEqual({
            meetings: [{ id: 'm1', title: 'Call A' }],
            assets: [{ id: 'a1', title: 'Doc A' }],
        });
        expect(result.ragAnswer).toEqual({ answer: 'Hello there' });
        expect(result.done).toBe(true);
    });

    it('dispatches session_created and title_updated frames to the matching handlers', async () => {
        fetchMock.mockResolvedValueOnce(
            sseResponse([
                'event: session_created\ndata: {"session_id":"new-session-id"}',
                'event: token\ndata: {"chunk":"Hi"}',
                'event: title_updated\ndata: {"title":"Pricing Follow-up"}',
                'event: done\ndata: {}',
            ]),
        );
        const result = collectHandlers();
        const onSessionCreated = vi.fn();
        const onTitleUpdated = vi.fn();

        chatApi.queryGlobal('hi', null, [], { ...result.handlers, onSessionCreated, onTitleUpdated });
        await result.settled;

        expect(onSessionCreated).toHaveBeenCalledWith('new-session-id');
        expect(onTitleUpdated).toHaveBeenCalledWith('Pricing Follow-up');
    });

    it('calls onError with the backend error envelope message on a non-ok response', async () => {
        // A 500 is retried by chatApi (up to MAX_STREAM_RETRIES) before giving
        // up. Each retry does its own `fetch` call and reads `.json()` on
        // whatever Response comes back — and a real Response body can only be
        // read ONCE. `mockResolvedValue` (no "Once") hands back the exact same
        // Response instance for every call, so attempt 2+ would try to
        // `.json()` an already-consumed body and silently fall back to
        // `res.statusText` (empty string here) instead of the real envelope
        // message — masking the assertion below. Use `mockImplementation` so
        // every attempt gets its own fresh, unread Response, matching what a
        // real backend returning the same 500 on every retry would look like.
        fetchMock.mockImplementation(() =>
            Promise.resolve(errorResponse(500, 'internal_error', 'Something broke')),
        );
        // chatApi sleeps 600ms/1.2s/2.4s between attempts — 4.2s of real waiting
        // for a test that asserts nothing about timing. The stream loop runs
        // detached, so pump the fake clock instead of only awaiting `settled`;
        // runAllTimersAsync flushes microtasks between timers, letting each
        // retry's fetch rejection schedule the next backoff.
        vi.useFakeTimers();
        const result = collectHandlers();

        chatApi.queryGlobal('hi', null, [], result.handlers);
        await vi.runAllTimersAsync();
        await result.settled;

        expect(result.error).toBe('Something broke');
        expect(fetchMock).toHaveBeenCalledTimes(MAX_STREAM_RETRIES + 1);
    });

    it('calls onError with a generic message on a network failure', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        vi.useFakeTimers(); // same 4.2s of retry backoff as the test above
        const result = collectHandlers();

        chatApi.queryGlobal('hi', null, [], result.handlers);
        await vi.runAllTimersAsync();
        await result.settled;

        expect(result.error).toBe("Couldn't get a response. Please try again.");
        expect(fetchMock).toHaveBeenCalledTimes(MAX_STREAM_RETRIES + 1);
    });

    it('does not call onError when the request was aborted by the caller', async () => {
        // Simulate fetch rejecting because the caller's AbortController fired.
        fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                    const abortErr = new Error('aborted');
                    abortErr.name = 'AbortError';
                    reject(abortErr);
                });
            });
        });
        const { handlers } = collectHandlers();
        const onError = vi.fn();

        const handle = chatApi.queryGlobal('hi', null, [], { ...handlers, onError });
        handle.abort();

        // Give the rejected promise's catch block a tick to run.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onError).not.toHaveBeenCalled();
    });
});

describe('chatApi.queryMeeting', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    it('POSTs to the per-meeting RAG route with the meeting id in the path, session_id, and history', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['event: done\ndata: {}']));
        const { handlers, settled } = collectHandlers();

        chatApi.queryMeeting('m1', 'what was decided?', null, [], handlers);
        await settled;

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://test-api/api/v1/chat/rag/query/meeting/m1');
        expect(JSON.parse(init.body)).toEqual({
            query: 'what was decided?',
            session_id: null,
            history: [],
        });
    });
});

describe('chatApi.queryLive', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    it('POSTs the query, history, transcript, and calendar metadata to /chat/live', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['event: done\ndata: {}']));
        const { handlers, settled } = collectHandlers();
        const history = [{ role: 'user', content: 'earlier question' }] as any;
        const transcript = [{ speaker: 'user', text: 'live line' }] as any;
        const calendarMetadata = [{ id: 'evt1', title: 'Demo call', startTime: '2026-01-01T10:00:00Z', endTime: '2026-01-01T10:30:00Z' }] as any;

        chatApi.queryLive('follow up', history, transcript, calendarMetadata, handlers);
        await settled;

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://test-api/api/v1/chat/live');
        expect(JSON.parse(init.body)).toEqual({ query: 'follow up', history, transcript, calendar_metadata: calendarMetadata });
    });

    it('sends an empty calendar_metadata array when no calendar event is available', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['event: done\ndata: {}']));
        const { handlers, settled } = collectHandlers();

        chatApi.queryLive('follow up', [], [], undefined, handlers);
        await settled;

        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(init.body).calendar_metadata).toEqual([]);
    });

    it('fires onInteractionId for an interaction_id frame', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'event: interaction_id\ndata: {"interaction_id": 441}',
            'event: done\ndata: {}',
        ]));
        const { handlers, settled } = collectHandlers();
        const onInteractionId = vi.fn();

        chatApi.queryLive('follow up', [], [], undefined, { ...handlers, onInteractionId });
        await settled;

        expect(onInteractionId).toHaveBeenCalledWith(441);
    });
});

describe('chatApi.linkMeetingInteractions', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs collected interaction_ids with the final meeting_id to /live/link-meeting', async () => {
        await chatApi.linkMeetingInteractions('meeting-123', [423, 434]);

        expect(mockedApiFetch.mock.calls[0][0]).toBe('/live/link-meeting');
        const init = mockedApiFetch.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ interaction_ids: [423, 434], meeting_id: 'meeting-123' });
    });
});

describe('chatApi.createSession / listSessions / getSessionMessages', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs to /chat/sessions to pre-create a session', async () => {
        mockedApiFetch.mockResolvedValueOnce({ session_id: 'new-id', title: 'New Chat' } as any);

        const session = await chatApi.createSession();

        expect(mockedApiFetch.mock.calls[0][0]).toBe('/chat/sessions');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
        expect(session).toEqual({ session_id: 'new-id', title: 'New Chat' });
    });

    it('GETs /chat/sessions and unwraps the sessions array', async () => {
        const sessions = [
            { id: 's1', title: 'Lisa Pricing Discussion', created_at: '2026-08-13T10:30:00Z', updated_at: '2026-08-13T10:35:00Z' },
        ];
        mockedApiFetch.mockResolvedValueOnce({ sessions } as any);

        const result = await chatApi.listSessions();

        expect(mockedApiFetch.mock.calls[0][0]).toBe('/chat/sessions');
        expect(result).toEqual(sessions);
    });

    it('GETs /chat/sessions/{id}/messages and unwraps the messages array', async () => {
        const messages = [
            { role: 'user', content: 'What did Lisa say about pricing?' },
            { role: 'assistant', content: 'Lisa mentioned the budget is $50K...' },
        ];
        mockedApiFetch.mockResolvedValueOnce({ session_id: 's1', messages } as any);

        const result = await chatApi.getSessionMessages('s1');

        expect(mockedApiFetch.mock.calls[0][0]).toBe('/chat/sessions/s1/messages');
        expect(result).toEqual(messages);
    });

    it('DELETEs /chat/sessions/{id}', async () => {
        mockedApiFetch.mockResolvedValueOnce(undefined as any);

        await chatApi.deleteSession('s1');

        expect(mockedApiFetch.mock.calls[0][0]).toBe('/chat/sessions/s1');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
    });

});

describe('reset frame', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    it('tells the consumer to discard a partial answer before the replacement streams', async () => {
        // What a dropped upstream looks like on the wire: the backend had
        // already sent half a sentence, gave up, told the client to clear, and
        // streamed the answer again.
        fetchMock.mockResolvedValueOnce(sseResponse([
            'event: token\ndata: {"chunk": "The main concern they raised was pri"}',
            'event: reset\ndata: {"reason": "stream_error"}',
            'event: token\ndata: {"chunk": "Linda\'s concern is the repetitive follow-up work."}',
            'event: done\ndata: {}',
        ]));
        // Keep the object: `resets` is a getter, so destructuring it here would
        // snapshot 0 before the stream ever runs.
        const result = collectHandlers();

        chatApi.queryLive('what is her concern', [], [], undefined, result.handlers);
        await result.settled;

        expect(result.resets).toBe(1);
        // The half sentence must not survive into what the rep reads.
        expect(result.tokens.join('')).toBe("Linda's concern is the repetitive follow-up work.");
        expect(result.tokens.join('')).not.toContain('was pri');
    });

    it('is harmless when it arrives before any token', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'event: reset\ndata: {"reason": "refusal"}',
            'event: token\ndata: {"chunk": "A grounded answer."}',
            'event: done\ndata: {}',
        ]));
        const result = collectHandlers();

        chatApi.queryLive('help me', [], [], undefined, result.handlers);
        await result.settled;

        expect(result.resets).toBe(1);
        expect(result.tokens.join('')).toBe('A grounded answer.');
    });

    it('does not fire on a clean stream', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'event: token\ndata: {"chunk": "All good."}',
            'event: done\ndata: {}',
        ]));
        const result = collectHandlers();

        chatApi.queryLive('anything', [], [], undefined, result.handlers);
        await result.settled;

        expect(result.resets).toBe(0);
    });
});
