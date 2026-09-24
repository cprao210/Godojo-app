import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiClient', async () => {
    const actual = await vi.importActual<typeof import('@/lib/apiClient')>('@/lib/apiClient');
    return {
        ...actual,
        API_BASE: 'http://test-api/api/v1',
        getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'Bearer test-token' }),
        apiFetch: vi.fn().mockResolvedValue({ ok: true, recorded: true }),
    };
});
vi.mock('@/lib/firebase', () => ({
    getFirebaseAuth: () => ({ currentUser: { getIdToken: vi.fn().mockResolvedValue('fresh') } }),
}));

import { intelligenceApi } from '@/api/intelligenceApi';
import { apiFetch } from '@/lib/apiClient';

function sse(frames: string[], status = 200): Response {
    const body = frames.join('\n\n') + '\n\n';
    return new Response(
        new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new TextEncoder().encode(body));
                c.close();
            },
        }),
        { status },
    );
}

const tick = {
    session_id: 's1',
    tick_id: 'k1',
    state: null,
    state_sig: null,
    meeting_types: [],
    turns: [{ turn_id: 't1', role: 'prospect' as const, text: 'we lose deals' }],
};

describe('streamLiveAnalysisV2', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('POSTs the tick and delivers events in order', async () => {
        fetchMock.mockResolvedValueOnce(sse([
            'event: ack\ndata: {"tick_id":"k1"}',
            ': ping',
            'event: done\ndata: {"version":1,"state":{"v":2},"state_sig":"v2:x","state_trusted":true,"trace_id":"tr"}',
        ]));
        const events: string[] = [];
        await intelligenceApi.streamLiveAnalysisV2(tick, ev => events.push(ev.event));
        expect(events).toEqual(['ack', 'done']);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://test-api/api/v1/intelligence/live-analysis/v2');
        expect(JSON.parse(init.body).turns[0].turn_id).toBe('t1');
        expect(init.headers.Authorization).toBe('Bearer test-token');
    });

    it('retries once on 401, then surfaces HTTP errors as ApiError', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response('{}', { status: 401 }))
            .mockResolvedValueOnce(sse(['event: done\ndata: {"version":1}']));
        const events: string[] = [];
        await intelligenceApi.streamLiveAnalysisV2(tick, ev => events.push(ev.event));
        expect(events).toEqual(['done']);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'validation_error', message: 'bad' } }), { status: 422 }));
        await expect(intelligenceApi.streamLiveAnalysisV2(tick, () => { })).rejects.toMatchObject({ status: 422, code: 'validation_error' });
    });

    it('maps a network failure to service_unavailable', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(intelligenceApi.streamLiveAnalysisV2(tick, () => { })).rejects.toMatchObject({ code: 'service_unavailable' });
    });
});

describe('feedback + deal alerts', () => {
    it('posts feedback with the trace id', async () => {
        await intelligenceApi.sendLiveAnalysisFeedback({ traceId: 'tr', sessionId: 's1', target: 'meddic.metrics', value: -1 });
        const [path, init] = vi.mocked(apiFetch).mock.calls.at(-1)!;
        expect(path).toBe('/intelligence/live-analysis/v2/feedback');
        expect(JSON.parse(init!.body as string)).toMatchObject({ trace_id: 'tr', target: 'meddic.metrics', value: -1 });
    });

    it('posts a labeled window to the deal optimizer', async () => {
        await intelligenceApi.detectDealAlerts(
            [{ speaker: 'user', text: 'our price is 60 per user' }, { speaker: 'client', text: 'too expensive' }],
            ['negotiation'],
            ['old quote'],
        );
        const [path, init] = vi.mocked(apiFetch).mock.calls.at(-1)!;
        expect(path).toBe('/intelligence/deal-optimizer');
        const body = JSON.parse(init!.body as string);
        expect(body.transcript).toBe('SALES PERSON: our price is 60 per user\nPROSPECT: too expensive');
        expect(body.meeting_types).toEqual(['negotiation']);
        expect(body.open_quotes).toEqual(['old quote']);
    });
});

describe('endLiveAnalysisV2', () => {
    it('posts the whole call to /v2/end with a long timeout', async () => {
        vi.mocked(apiFetch).mockResolvedValueOnce({ analysis: { signals: [], objections: [] }, degraded: [] } as any);
        const body = {
            session_id: 's1', state: null, state_sig: null, meeting_types: ['demo'],
            turns: [{ turn_id: 't1', role: 'prospect' as const, text: 'too expensive' }],
        };
        const res = await intelligenceApi.endLiveAnalysisV2(body);
        expect(res.degraded).toEqual([]);
        const [path, init] = vi.mocked(apiFetch).mock.calls.at(-1)!;
        expect(path).toBe('/intelligence/live-analysis/v2/end');
        expect(init!.method).toBe('POST');
        expect(init!.timeoutMs).toBeGreaterThanOrEqual(60_000);
        expect(JSON.parse(init!.body as string)).toEqual(body);
    });
});
