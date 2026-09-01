/**
 * Guards the backend live-meeting pipeline (src/lib/backendMeetingSession.ts).
 *
 * The invariants that matter here are the ones that cost money or lose data if
 * they break: never run both pipelines for one meeting, never call /end before
 * the transcript has landed, and never silently drop segments on a failed POST.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/meetingsApi', () => ({
    meetingsApi: {
        start: vi.fn(),
        submitTranscript: vi.fn(),
        end: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        chunk: vi.fn(),
    },
}));

vi.mock('@/api/chatApi', () => ({
    chatApi: { linkMeetingInteractions: vi.fn() },
}));

import { chatApi } from '@/api/chatApi';
import { meetingsApi } from '@/api/meetingsApi';
import { BACKEND_PIPELINE_FLAG, backendMeetingSession } from '@/lib/backendMeetingSession';

const api = meetingsApi as unknown as {
    start: ReturnType<typeof vi.fn>;
    submitTranscript: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    chunk: ReturnType<typeof vi.fn>;
};

const linkInteractions = (chatApi as unknown as {
    linkMeetingInteractions: ReturnType<typeof vi.fn>;
}).linkMeetingInteractions;

/** The suite runs in the `node` vitest environment — no DOM, no localStorage. */
function installLocalStorage(flag: string | null) {
    const store = new Map<string, string>();
    if (flag !== null) store.set(BACKEND_PIPELINE_FLAG, flag);
    (globalThis as any).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    };
}

function segment(text: string, over: Record<string, unknown> = {}) {
    return { speaker: 'client', text, timestamp: 1000, final: true, ...over };
}

async function startSession(id = 'backend-m1') {
    api.start.mockResolvedValue({ success: true, meeting_id: id, started_at: 1 });
    return backendMeetingSession.start({});
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    installLocalStorage('true');
    api.submitTranscript.mockResolvedValue({ accepted: 0 });
    api.end.mockResolvedValue({ success: true, meeting_id: 'backend-m1', duration_ms: 1000 });
    api.pause.mockResolvedValue({ success: true });
    api.resume.mockResolvedValue({ success: true });
    api.chunk.mockResolvedValue({});
    linkInteractions.mockResolvedValue(undefined);
});

afterEach(() => {
    backendMeetingSession.reset();
    vi.useRealTimers();
});

describe('feature flag', () => {
    it('does not open a session when the flag is off', async () => {
        installLocalStorage(null);
        const started = await backendMeetingSession.start({});
        expect(started).toBe(false);
        expect(api.start).not.toHaveBeenCalled();
        expect(backendMeetingSession.isActive()).toBe(false);
    });

    it('opens a session when the flag is on', async () => {
        const started = await startSession();
        expect(started).toBe(true);
        expect(backendMeetingSession.isActive()).toBe(true);
        expect(backendMeetingSession.getMeetingId()).toBe('backend-m1');
    });

    it('stays inactive when start fails, so the meeting runs on Electron', async () => {
        api.start.mockRejectedValue(new Error('503'));
        const started = await backendMeetingSession.start({});
        expect(started).toBe(false);
        expect(backendMeetingSession.isActive()).toBe(false);
    });

    it('flipping the flag mid-call cannot activate an unstarted session', async () => {
        installLocalStorage(null);
        await backendMeetingSession.start({});
        installLocalStorage('true');
        backendMeetingSession.captureSegment(segment('hello'));
        // end() must report "not mine" so the caller keeps the Electron pipeline.
        await expect(backendMeetingSession.end([])).resolves.toBeNull();
        expect(api.end).not.toHaveBeenCalled();
    });
});

describe('transcript buffering', () => {
    beforeEach(async () => {
        await startSession();
    });

    it('buffers finals and submits them on end', async () => {
        backendMeetingSession.captureSegment(segment('first'));
        backendMeetingSession.captureSegment(segment('second', { speaker: 'user' }));
        await backendMeetingSession.end([]);

        expect(api.submitTranscript).toHaveBeenCalledTimes(1);
        const [id, segs] = api.submitTranscript.mock.calls[0];
        expect(id).toBe('backend-m1');
        expect(segs).toEqual([
            { speaker: 'client', text: 'first', timestamp: 1000, final: true, confidence: undefined },
            { speaker: 'user', text: 'second', timestamp: 1000, final: true, confidence: undefined },
        ]);
    });

    it('drops interims, retractions and blank turns', async () => {
        backendMeetingSession.captureSegment(segment('partial', { final: false }));
        backendMeetingSession.captureSegment(segment('', { retract: true, final: false }));
        backendMeetingSession.captureSegment(segment('   '));
        await backendMeetingSession.end([]);

        expect(api.submitTranscript).not.toHaveBeenCalled();
    });

    it('ignores segments when no session is active', async () => {
        backendMeetingSession.reset();
        backendMeetingSession.captureSegment(segment('orphan'));
        await startSession();
        await backendMeetingSession.end([]);
        expect(api.submitTranscript).not.toHaveBeenCalled();
    });

    it('flushes periodically so a crash costs at most one window', async () => {
        backendMeetingSession.captureSegment(segment('early'));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.submitTranscript).toHaveBeenCalledTimes(1);
    });

    it('requeues segments when a flush fails, losing nothing', async () => {
        api.submitTranscript.mockRejectedValueOnce(new Error('network'));
        backendMeetingSession.captureSegment(segment('kept'));

        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.submitTranscript).toHaveBeenCalledTimes(1);

        // The failed batch is resent on the next flush rather than dropped.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.submitTranscript).toHaveBeenCalledTimes(2);
        expect(api.submitTranscript.mock.calls[1][1]).toEqual([
            { speaker: 'client', text: 'kept', timestamp: 1000, final: true, confidence: undefined },
        ]);
    });
});

describe('end', () => {
    beforeEach(async () => {
        await startSession();
    });

    it('submits the transcript before calling /end', async () => {
        const order: string[] = [];
        api.submitTranscript.mockImplementation(async () => void order.push('transcript'));
        api.end.mockImplementation(async () => {
            order.push('end');
            return { success: true, meeting_id: 'backend-m1', duration_ms: 1 };
        });

        backendMeetingSession.captureSegment(segment('hi'));
        await backendMeetingSession.end(['discovery']);

        // The backend summarizes from the transcripts table, so /end must be last.
        expect(order).toEqual(['transcript', 'end']);
        expect(api.end).toHaveBeenCalledWith('backend-m1', ['discovery']);
    });

    it('returns the meeting id on success', async () => {
        await expect(backendMeetingSession.end([])).resolves.toBe('backend-m1');
    });

    it('does not chunk — useLauncher owns that once the meeting is processed', async () => {
        await backendMeetingSession.end([]);
        expect(api.chunk).not.toHaveBeenCalled();
    });

    it('falls back to Electron when the transcript cannot be delivered', async () => {
        api.submitTranscript.mockRejectedValue(new Error('network'));
        backendMeetingSession.captureSegment(segment('undelivered'));

        // Null tells the caller to let Electron summarize instead of finalizing
        // the meeting against a half-written transcript.
        await expect(backendMeetingSession.end([])).resolves.toBeNull();
        expect(api.end).not.toHaveBeenCalled();
    });

    it('falls back to Electron when /end itself fails', async () => {
        api.end.mockRejectedValue(new Error('500'));
        await expect(backendMeetingSession.end([])).resolves.toBeNull();
    });

    it('links Ask-Dojo interactions before /end, not after', async () => {
        const order: string[] = [];
        linkInteractions.mockImplementation(async () => void order.push('link'));
        api.end.mockImplementation(async () => {
            order.push('end');
            return { success: true, meeting_id: 'backend-m1', duration_ms: 1 };
        });

        backendMeetingSession.recordInteractionId(42);
        backendMeetingSession.recordInteractionId(43);
        await backendMeetingSession.end([]);

        // The background summariser reads ai_interactions as soon as /end
        // returns — linking afterwards would silently drop the Q&A context.
        expect(order).toEqual(['link', 'end']);
        expect(linkInteractions).toHaveBeenCalledWith('backend-m1', [42, 43]);
    });

    it('skips linking when there were no interactions', async () => {
        await backendMeetingSession.end([]);
        expect(linkInteractions).not.toHaveBeenCalled();
    });

    it('still finalizes the meeting when linking fails', async () => {
        linkInteractions.mockRejectedValue(new Error('500'));
        backendMeetingSession.recordInteractionId(1);
        await expect(backendMeetingSession.end([])).resolves.toBe('backend-m1');
        expect(api.end).toHaveBeenCalled();
    });

    it('ignores interaction ids recorded with no active session', async () => {
        backendMeetingSession.reset();
        backendMeetingSession.recordInteractionId(99);
        await startSession();
        await backendMeetingSession.end([]);
        expect(linkInteractions).not.toHaveBeenCalled();
    });

    it('deactivates the session so a second end is a no-op', async () => {
        await backendMeetingSession.end([]);
        expect(backendMeetingSession.isActive()).toBe(false);

        api.end.mockClear();
        await expect(backendMeetingSession.end([])).resolves.toBeNull();
        expect(api.end).not.toHaveBeenCalled();
    });

    it('stops the flush timer so no POSTs fire after the meeting ends', async () => {
        await backendMeetingSession.end([]);
        api.submitTranscript.mockClear();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(api.submitTranscript).not.toHaveBeenCalled();
    });
});

describe('pause / resume', () => {
    beforeEach(async () => {
        await startSession();
    });

    it('flushes before pausing — the backend drops segments while paused', async () => {
        const order: string[] = [];
        api.submitTranscript.mockImplementation(async () => void order.push('transcript'));
        api.pause.mockImplementation(async () => {
            order.push('pause');
            return { success: true };
        });

        backendMeetingSession.captureSegment(segment('before pause'));
        await backendMeetingSession.pause();

        expect(order).toEqual(['transcript', 'pause']);
    });

    it('discards segments captured while paused', async () => {
        await backendMeetingSession.pause();
        api.submitTranscript.mockClear();

        backendMeetingSession.captureSegment(segment('while paused'));
        await backendMeetingSession.end([]);

        expect(api.submitTranscript).not.toHaveBeenCalled();
    });

    it('captures again after resume', async () => {
        await backendMeetingSession.pause();
        await backendMeetingSession.resume();
        api.submitTranscript.mockClear();

        backendMeetingSession.captureSegment(segment('after resume'));
        await backendMeetingSession.end([]);

        expect(api.submitTranscript).toHaveBeenCalledTimes(1);
        expect(api.submitTranscript.mock.calls[0][1][0].text).toBe('after resume');
    });

    it('does not touch the backend when no session is active', async () => {
        backendMeetingSession.reset();
        await backendMeetingSession.pause();
        await backendMeetingSession.resume();
        expect(api.pause).not.toHaveBeenCalled();
        expect(api.resume).not.toHaveBeenCalled();
    });

    it('survives a failing pause call', async () => {
        api.pause.mockRejectedValue(new Error('500'));
        await expect(backendMeetingSession.pause()).resolves.toBeUndefined();
        expect(backendMeetingSession.isActive()).toBe(true);
    });
});
