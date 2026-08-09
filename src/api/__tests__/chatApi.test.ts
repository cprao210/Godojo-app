import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        onError: (msg: string) => {
            error = msg;
            resolveSettled();
        },
        onDone: () => {
            done = true;
            resolveSettled();
        },
    };

    return { handlers, settled, tokens, statuses, get sources() { return sources; }, get ragAnswer() { return ragAnswer; }, get error() { return error; }, get done() { return done; } };
}

describe('statusLabel', () => {
    it('maps known status values to their labels', () => {
        expect(statusLabel('connected')).toBe('Connecting…');
        expect(statusLabel('searching')).toBe('Searching meetings…');
        expect(statusLabel('generating')).toBe('Generating response…');
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

    it('POSTs to the global RAG query route with auth headers and the query body', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['event: done\ndata: {}']));
        const { handlers, settled } = collectHandlers();

        chatApi.queryGlobal('what changed last quarter?', handlers);
        await settled;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://test-api/api/v1/chat/rag/query/global');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
        expect(JSON.parse(init.body)).toEqual({ query: 'what changed last quarter?' });
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

        chatApi.queryGlobal('hi', result.handlers);
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

    it('calls onError with the backend error envelope message on a non-ok response', async () => {
        fetchMock.mockResolvedValueOnce(errorResponse(500, 'internal_error', 'Something broke'));
        const result = collectHandlers();

        chatApi.queryGlobal('hi', result.handlers);
        await result.settled;

        expect(result.error).toBe('Something broke');
    });

    it('calls onError with a generic message on a network failure', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const result = collectHandlers();

        chatApi.queryGlobal('hi', result.handlers);
        await result.settled;

        expect(result.error).toBe("Couldn't get a response. Please try again.");
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

        const handle = chatApi.queryGlobal('hi', { ...handlers, onError });
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

    it('POSTs to the per-meeting RAG route with the meeting id in the path', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['event: done\ndata: {}']));
        const { handlers, settled } = collectHandlers();

        chatApi.queryMeeting('m1', 'what was decided?', handlers);
        await settled;

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://test-api/api/v1/chat/rag/query/meeting/m1');
        expect(JSON.parse(init.body)).toEqual({ query: 'what was decided?' });
    });
});

describe('chatApi.queryLive', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    it('POSTs the query, history, and transcript to /chat/live', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['event: done\ndata: {}']));
        const { handlers, settled } = collectHandlers();
        const history = [{ role: 'user', content: 'earlier question' }] as any;
        const transcript = [{ speaker: 'user', text: 'live line' }] as any;

        chatApi.queryLive('follow up', history, transcript, handlers);
        await settled;

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://test-api/api/v1/chat/live');
        expect(JSON.parse(init.body)).toEqual({ query: 'follow up', history, transcript });
    });

    it('fires onInteractionId for an interaction_id frame', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'event: interaction_id\ndata: {"interaction_id": 441}',
            'event: done\ndata: {}',
        ]));
        const { handlers, settled } = collectHandlers();
        const onInteractionId = vi.fn();

        chatApi.queryLive('follow up', [], [], { ...handlers, onInteractionId });
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