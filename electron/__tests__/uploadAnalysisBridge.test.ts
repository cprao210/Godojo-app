// Covers electron/utils/uploadAnalysisBridge — main's half of the
// uploaded-transcript analysis, which asks a renderer window to call the
// live-analysis API and waits for the answer.
//
// What is pinned here is the part that can strand a meeting in "Processing…":
// every request must settle exactly once, whether it is answered, rejected,
// orphaned by a closing window or left unanswered past the ceiling — and a
// late or unknown answer must never settle something else.
//
// The window is a fake, so nothing here touches Electron.

import { describe, it, expect, afterEach } from 'vitest';
import {
    handleUploadAnalysisResult,
    isLocalUploadAnalysisForced,
    pendingUploadAnalysisCount,
    requestUploadAnalysis,
    UploadAnalysisBridgeError,
} from '../utils/uploadAnalysisBridge';

const ANALYSIS: any = { bant: {}, meddic: {}, objections: [], signals: [], dealOptimizer: [] };
const TURNS = [{ speaker: 'user', text: 'hi' }, { speaker: 'client', text: 'hello' }];

function makeWindow() {
    const sent: Array<{ channel: string; payload: any }> = [];
    const destroyedHandlers: Array<() => void> = [];
    return {
        sent,
        destroyedHandlers,
        destroy: () => [...destroyedHandlers].forEach(h => h()),
        isDestroyed: () => false,
        webContents: {
            send: (channel: string, payload: any) => { sent.push({ channel, payload }); },
            once: (event: string, cb: () => void) => { if (event === 'destroyed') destroyedHandlers.push(cb); },
            removeListener: (event: string, cb: () => void) => {
                if (event !== 'destroyed') return;
                const i = destroyedHandlers.indexOf(cb);
                if (i >= 0) destroyedHandlers.splice(i, 1);
            },
        },
    };
}

/** The requestId main generated for the only request it has sent. */
const sentRequestId = (win: ReturnType<typeof makeWindow>) => win.sent[0].payload.requestId as string;

describe('requestUploadAnalysis', () => {
    afterEach(() => {
        expect(pendingUploadAnalysisCount()).toBe(0);
    });

    it('sends the turns and meeting types to the renderer', async () => {
        const win = makeWindow();
        const p = requestUploadAnalysis(TURNS, ['discovery', 'negotiation'], { getWindow: () => win });

        expect(win.sent).toHaveLength(1);
        expect(win.sent[0].channel).toBe('run-upload-analysis');
        expect(win.sent[0].payload.turns).toEqual(TURNS);
        expect(win.sent[0].payload.meetingTypes).toEqual(['discovery', 'negotiation']);

        handleUploadAnalysisResult({ requestId: sentRequestId(win), ok: true, data: ANALYSIS });
        await expect(p).resolves.toEqual(ANALYSIS);
    });

    it('resolves null when the renderer found nothing analysable', async () => {
        const win = makeWindow();
        const p = requestUploadAnalysis(TURNS, [], { getWindow: () => win });
        handleUploadAnalysisResult({ requestId: sentRequestId(win), ok: true, data: null });
        await expect(p).resolves.toBeNull();
    });

    it('rejects with the renderer\'s own error', async () => {
        const win = makeWindow();
        const p = requestUploadAnalysis(TURNS, [], { getWindow: () => win });
        handleUploadAnalysisResult({ requestId: sentRequestId(win), ok: false, error: 'Not signed in' });
        await expect(p).rejects.toThrow('Not signed in');
    });

    it('short-circuits an empty transcript without touching a window', async () => {
        const win = makeWindow();
        await expect(requestUploadAnalysis([], [], { getWindow: () => win })).resolves.toBeNull();
        expect(win.sent).toHaveLength(0);
    });

    it('rejects when no window can answer', async () => {
        await expect(
            requestUploadAnalysis(TURNS, [], { getWindow: () => null }),
        ).rejects.toThrow(UploadAnalysisBridgeError);
        await expect(
            requestUploadAnalysis(TURNS, [], { getWindow: () => ({ isDestroyed: () => true, webContents: {} }) }),
        ).rejects.toThrow(/no renderer window/i);
    });

    it('rejects immediately when the window goes away mid-run', async () => {
        const win = makeWindow();
        const p = requestUploadAnalysis(TURNS, [], { getWindow: () => win });
        win.destroy();
        await expect(p).rejects.toThrow(/destroyed/i);
    });

    it('rejects when the renderer never answers', async () => {
        const win = makeWindow();
        await expect(
            requestUploadAnalysis(TURNS, [], { getWindow: () => win, timeoutMs: 5 }),
        ).rejects.toThrow(/did not answer/i);
    });

    it('drops an answer to a request that already settled', async () => {
        const win = makeWindow();
        const p = requestUploadAnalysis(TURNS, [], { getWindow: () => win, timeoutMs: 5 });
        const requestId = sentRequestId(win);
        await expect(p).rejects.toThrow(/did not answer/i);

        // The late answer must not throw, resolve anything, or resurrect state.
        expect(() => handleUploadAnalysisResult({ requestId, ok: true, data: ANALYSIS })).not.toThrow();
        expect(pendingUploadAnalysisCount()).toBe(0);
    });

    it('leaves no window listener behind, however a request settles', async () => {
        // One long-lived launcher window serves every upload, so a listener kept
        // per request would pile up for the life of the app.
        const win = makeWindow();

        const answered = requestUploadAnalysis(TURNS, [], { getWindow: () => win });
        handleUploadAnalysisResult({ requestId: sentRequestId(win), ok: true, data: ANALYSIS });
        await answered;
        expect(win.destroyedHandlers).toHaveLength(0);

        win.sent.length = 0;
        const failed = requestUploadAnalysis(TURNS, [], { getWindow: () => win });
        handleUploadAnalysisResult({ requestId: sentRequestId(win), ok: false, error: 'nope' });
        await expect(failed).rejects.toThrow('nope');
        expect(win.destroyedHandlers).toHaveLength(0);

        win.sent.length = 0;
        await expect(
            requestUploadAnalysis(TURNS, [], { getWindow: () => win, timeoutMs: 5 }),
        ).rejects.toThrow(/did not answer/i);
        expect(win.destroyedHandlers).toHaveLength(0);
    });

    it('ignores an unknown or malformed answer', () => {
        expect(() => handleUploadAnalysisResult({ requestId: 'never-issued', ok: true })).not.toThrow();
        expect(() => handleUploadAnalysisResult({} as any)).not.toThrow();
    });

    it('keeps concurrent requests apart', async () => {
        const a = makeWindow();
        const b = makeWindow();
        const pa = requestUploadAnalysis(TURNS, [], { getWindow: () => a });
        const pb = requestUploadAnalysis(TURNS, [], { getWindow: () => b });
        expect(pendingUploadAnalysisCount()).toBe(2);

        handleUploadAnalysisResult({ requestId: sentRequestId(b), ok: true, data: ANALYSIS });
        await expect(pb).resolves.toEqual(ANALYSIS);
        expect(pendingUploadAnalysisCount()).toBe(1);

        handleUploadAnalysisResult({ requestId: sentRequestId(a), ok: false, error: 'a failed' });
        await expect(pa).rejects.toThrow('a failed');
    });
});

describe('isLocalUploadAnalysisForced', () => {
    afterEach(() => { delete process.env.GODOJO_UPLOAD_ANALYSIS_LOCAL; delete process.env.NATIVELY_UPLOAD_ANALYSIS_LOCAL; });

    it('is off by default — uploads use the live-analysis API', () => {
        expect(isLocalUploadAnalysisForced()).toBe(false);
    });

    it('is read at call time, not at import time', () => {
        process.env.GODOJO_UPLOAD_ANALYSIS_LOCAL = '1';
        expect(isLocalUploadAnalysisForced()).toBe(true);
    });

    it('only the exact opt-in value counts', () => {
        process.env.GODOJO_UPLOAD_ANALYSIS_LOCAL = 'true';
        expect(isLocalUploadAnalysisForced()).toBe(false);
    });
});
