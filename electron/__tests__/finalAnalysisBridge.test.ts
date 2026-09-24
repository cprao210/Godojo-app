// Covers electron/utils/finalAnalysisBridge — main's half of the live analysis v2 end-of-call
// pass. MeetingPersistence awaits this before writing the summary, so every request must settle
// exactly once (answered, rejected, window closed, or timed out) and must never hang the save.

import { describe, it, expect, afterEach } from 'vitest';
import {
    FinalAnalysisBridgeError,
    handleFinalAnalysisV2Result,
    isFinalAnalysisV2Enabled,
    pendingFinalAnalysisCount,
    requestFinalAnalysisV2,
} from '../utils/finalAnalysisBridge';

const ANALYSIS: any = { bant: {}, meddic: {}, objections: [{ quote: 'too expensive' }], signals: [], source: 'v2_end' };

function makeWindow() {
    const sent: Array<{ channel: string; payload: any }> = [];
    const destroyedHandlers: Array<() => void> = [];
    return {
        sent,
        destroy: () => [...destroyedHandlers].forEach(h => h()),
        isDestroyed: () => false,
        webContents: {
            send: (channel: string, payload: any) => { sent.push({ channel, payload }); },
            once: (event: string, cb: () => void) => { if (event === 'destroyed') destroyedHandlers.push(cb); },
            removeListener: (event: string, cb: () => void) => {
                const i = destroyedHandlers.indexOf(cb);
                if (event === 'destroyed' && i >= 0) destroyedHandlers.splice(i, 1);
            },
        },
    };
}

const idOf = (win: ReturnType<typeof makeWindow>) => win.sent[0].payload.requestId as string;

describe('requestFinalAnalysisV2', () => {
    afterEach(() => expect(pendingFinalAnalysisCount()).toBe(0));

    it('asks the overlay and resolves with its analysis', async () => {
        const win = makeWindow();
        const p = requestFinalAnalysisV2(['negotiation'], { getWindow: () => win });
        expect(win.sent[0].channel).toBe('run-final-analysis-v2');
        expect(win.sent[0].payload.meetingTypes).toEqual(['negotiation']);
        handleFinalAnalysisV2Result({ requestId: idOf(win), ok: true, data: ANALYSIS });
        await expect(p).resolves.toEqual(ANALYSIS);
    });

    it('rejects on an error answer, a closed window, a timeout, or no window', async () => {
        const a = makeWindow();
        const pa = requestFinalAnalysisV2([], { getWindow: () => a });
        handleFinalAnalysisV2Result({ requestId: idOf(a), ok: false, error: 'no final analysis' });
        await expect(pa).rejects.toThrow('no final analysis');

        const b = makeWindow();
        const pb = requestFinalAnalysisV2([], { getWindow: () => b });
        b.destroy();
        await expect(pb).rejects.toBeInstanceOf(FinalAnalysisBridgeError);

        const c = makeWindow();
        await expect(requestFinalAnalysisV2([], { getWindow: () => c, timeoutMs: 5 })).rejects.toThrow('did not answer');

        await expect(requestFinalAnalysisV2([], { getWindow: () => null })).rejects.toThrow('no overlay window');
    });

    it('ignores unknown and repeated answers', async () => {
        const win = makeWindow();
        const p = requestFinalAnalysisV2([], { getWindow: () => win });
        handleFinalAnalysisV2Result({ requestId: 'someone-else', ok: true, data: null });
        handleFinalAnalysisV2Result({ requestId: idOf(win), ok: true, data: ANALYSIS });
        handleFinalAnalysisV2Result({ requestId: idOf(win), ok: false, error: 'late' });
        await expect(p).resolves.toEqual(ANALYSIS);
    });

    it('follows the same build flag as the renderer', () => {
        const prev = process.env.VITE_LIVE_ANALYSIS_V2;
        process.env.VITE_LIVE_ANALYSIS_V2 = 'true';
        expect(isFinalAnalysisV2Enabled()).toBe(true);
        process.env.VITE_LIVE_ANALYSIS_V2 = 'false';
        expect(isFinalAnalysisV2Enabled()).toBe(false);
        if (prev === undefined) delete process.env.VITE_LIVE_ANALYSIS_V2;
        else process.env.VITE_LIVE_ANALYSIS_V2 = prev;
    });
});
