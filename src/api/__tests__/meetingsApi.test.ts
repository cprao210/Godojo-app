import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/apiClient', () => ({
    apiFetch: vi.fn().mockResolvedValue({}),
}));

import { apiFetch } from '@/lib/apiClient';
import { meetingsApi } from '@/api';

const mockedApiFetch = vi.mocked(apiFetch);

const bodyOfCall = (i = 0) =>
    JSON.parse((mockedApiFetch.mock.calls[i][1] as RequestInit).body as string);

describe('meetingsApi.list', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('maps raw rows to Meetings', async () => {
        mockedApiFetch.mockResolvedValueOnce([
            { id: '1', title: 'Call one', created_at: '2024-01-01', duration_ms: 65_000, is_processed: 1 },
        ]);
        const result = await meetingsApi.list();
        expect(mockedApiFetch).toHaveBeenCalledWith('/meetings');
        expect(result).toEqual([
            expect.objectContaining({
                id: '1',
                title: 'Call one',
                date: '2024-01-01',
                duration: '1:05',
                durationMs: 65_000,
                isProcessed: true,
                transcript: [],
                usage: [],
            }),
        ]);
    });

    it('dedupes rows with the same id, keeping the first occurrence', async () => {
        mockedApiFetch.mockResolvedValueOnce([
            { id: 'dup', title: 'First', created_at: '2024-01-01' },
            { id: 'dup', title: 'Second', created_at: '2024-01-02' },
            { id: 'unique', title: 'Third', created_at: '2024-01-03' },
        ]);
        const result = await meetingsApi.list();
        expect(result).toHaveLength(2);
        expect(result[0].title).toBe('First');
        expect(result[1].id).toBe('unique');
    });

    it('returns an empty array when apiFetch resolves with a nullish value', async () => {
        mockedApiFetch.mockResolvedValueOnce(null as unknown as any[]);
        await expect(meetingsApi.list()).resolves.toEqual([]);
    });
});

describe('meetingsApi.get', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('fetches by id and maps the detail payload, including transcript/usage', async () => {
        mockedApiFetch.mockResolvedValueOnce({
            id: '1',
            title: 'Call one',
            created_at: '2024-01-01',
            duration_ms: 5_000,
            transcript: [{ speaker: 'user', text: 'hi', timestamp: 0 }],
            usage: [{ type: 'qa', timestamp: 1, question: 'q', answer: 'a' }],
        });
        const result = await meetingsApi.get('1');
        expect(mockedApiFetch).toHaveBeenCalledWith('/meetings/1');
        expect(result.transcript).toEqual([{ speaker: 'user', text: 'hi', timestamp: 0 }]);
        expect(result.usage).toEqual([
            { type: 'qa', timestamp: 1, question: 'q', answer: 'a', items: undefined },
        ]);
    });
});

describe('meetingsApi.getAiInteractions', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('hits the ai-interactions sub-route', async () => {
        await meetingsApi.getAiInteractions('m1');
        expect(mockedApiFetch).toHaveBeenCalledWith('/meetings/m1/ai-interactions');
    });
});

describe('meetingsApi.updateTitle', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('PATCHes the new title', async () => {
        await meetingsApi.updateTitle('m1', 'New title');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/m1/title');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
        expect(bodyOfCall()).toEqual({ title: 'New title' });
    });
});

describe('meetingsApi.updateSummary', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('wraps the partial summary in an `updates` envelope', async () => {
        await meetingsApi.updateSummary('m1', { keyPoints: ['a'] });
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/m1/summary');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
        expect(bodyOfCall()).toEqual({ updates: { keyPoints: ['a'] } });
    });
});

describe('meetingsApi.remove', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('DELETEs the meeting by id', async () => {
        await meetingsApi.remove('m1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/m1');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
    });
});

describe('meetingsApi.start', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs an empty body by default', async () => {
        await meetingsApi.start();
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/start');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
        expect(bodyOfCall()).toEqual({});
    });

    it('forwards the provided request body', async () => {
        await meetingsApi.start({ title: 'Sync' } as any);
        expect(bodyOfCall()).toEqual({ title: 'Sync' });
    });
});

describe('meetingsApi.pause / resume', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('pause sends meeting_id in the body', async () => {
        await meetingsApi.pause('m1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/pause');
        expect(bodyOfCall()).toEqual({ meeting_id: 'm1' });
    });

    it('resume sends meeting_id in the body', async () => {
        await meetingsApi.resume('m1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/resume');
        expect(bodyOfCall()).toEqual({ meeting_id: 'm1' });
    });
});

describe('meetingsApi.getState', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('sends meeting_id as a query param', async () => {
        await meetingsApi.getState('m1');
        expect(mockedApiFetch).toHaveBeenCalledWith('/meetings/state?meeting_id=m1');
    });

    it('URL-encodes the meeting id', async () => {
        await meetingsApi.getState('m/1 x');
        expect(mockedApiFetch).toHaveBeenCalledWith('/meetings/state?meeting_id=m%2F1%20x');
    });
});

describe('meetingsApi.submitTranscript', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('sends meeting_id and segments', async () => {
        const segments = [{ speaker: 'user', text: 'hi', timestamp: 0 }] as any;
        await meetingsApi.submitTranscript('m1', segments);
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/transcript');
        expect(bodyOfCall()).toEqual({ meeting_id: 'm1', segments });
    });
});

describe('meetingsApi.end', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('defaults meeting_types to an empty array', async () => {
        await meetingsApi.end('m1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/end');
        expect(bodyOfCall()).toEqual({ meeting_id: 'm1', meeting_types: [] });
    });

    it('forwards the provided meeting types', async () => {
        await meetingsApi.end('m1', ['discovery', 'negotiation']);
        expect(bodyOfCall()).toEqual({ meeting_id: 'm1', meeting_types: ['discovery', 'negotiation'] });
    });
});

describe('meetingsApi.chunk', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs to the chunking sub-route', async () => {
        await meetingsApi.chunk('m1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/m1/chunking');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
    });
});

describe('meetingsApi.uploadTranscript', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('sends title and transcript in that order', async () => {
        await meetingsApi.uploadTranscript('My title', 'full transcript text');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/meetings/upload-transcript');
        expect(bodyOfCall()).toEqual({ title: 'My title', transcript: 'full transcript text' });
    });
});