// The Intelligence panel's placeholder rule. The case that matters most is the
// one the user reported: countdown → loading skeleton → countdown again. Each
// test below is a step of a real call.

import { describe, expect, it } from 'vitest';

import { resolveIntelligenceView, IntelligenceViewInput } from '../intelligenceView';

/** Panel state a few seconds into a call: countdown armed, nothing back yet. */
const startup = (over: Partial<IntelligenceViewInput> = {}): IntelligenceViewInput => ({
    hasDisplayData: false,
    isLoading: false,
    isRefreshRun: false,
    hasError: false,
    noAnalysisCaptured: false,
    isCountdownActive: true,
    panelFirstOpenedAt: 1_700_000_000_000,
    autoRefreshInterval: 2,
    ...over,
});

describe('resolveIntelligenceView — meeting startup', () => {
    it('shows the countdown while the startup cycle is armed', () => {
        expect(resolveIntelligenceView(startup())).toBe('countdown');
    });

    it('shows the skeleton once the first analysis fires', () => {
        // The early trigger fired: the hook cleared the cycle and started the run.
        expect(resolveIntelligenceView(startup({ isCountdownActive: false, isLoading: true }))).toBe('skeleton');
    });

    it('does NOT return to the countdown when that first run comes back empty', () => {
        // THE BUG. Every BANT/MEDDIC field still `missing`, no signals yet, so the
        // panel has nothing to render — but the cycle is over and the ring must
        // not tick down against a deadline that no longer exists.
        expect(resolveIntelligenceView(startup({ isCountdownActive: false }))).toBe('waiting');
    });

    it('shows content as soon as the analysis has something in it', () => {
        expect(resolveIntelligenceView(startup({ isCountdownActive: false, hasDisplayData: true }))).toBe('content');
    });

    it('shows the no-analysis card when the countdown expired without enough transcript', () => {
        expect(resolveIntelligenceView(startup({ isCountdownActive: false, noAnalysisCaptured: true })))
            .toBe('no-analysis-captured');
    });
});

describe('resolveIntelligenceView — later in the call', () => {
    it('keeps content up during a background refresh instead of skeletoning', () => {
        expect(resolveIntelligenceView(startup({
            isCountdownActive: false,
            hasDisplayData: true,
            isLoading: true,
            isRefreshRun: true,
        }))).toBe('content');
    });

    it('keeps content up even if isRefreshRun has not landed in the same render', () => {
        expect(resolveIntelligenceView(startup({
            isCountdownActive: false,
            hasDisplayData: true,
            isLoading: true,
            isRefreshRun: false,
        }))).toBe('content');
    });

    it('never shows the ring again after an interval change mid-call', () => {
        // Changing the interval re-arms a cycle in the hook, but a result has
        // already landed there, so isCountdownActive stays false.
        expect(resolveIntelligenceView(startup({ isCountdownActive: false, autoRefreshInterval: 10 }))).toBe('waiting');
    });

    it('surfaces an error only when there is nothing to show', () => {
        expect(resolveIntelligenceView(startup({ isCountdownActive: false, hasError: true }))).toBe('error');
        expect(resolveIntelligenceView(startup({ isCountdownActive: false, hasError: true, hasDisplayData: true })))
            .toBe('content');
    });

    it('waits rather than counting down when auto-refresh is off or unanchored', () => {
        expect(resolveIntelligenceView(startup({ autoRefreshInterval: null }))).toBe('waiting');
        expect(resolveIntelligenceView(startup({ panelFirstOpenedAt: null }))).toBe('waiting');
    });
});

describe('resolveIntelligenceView — a second meeting in the same session', () => {
    it('runs the countdown once more after a session reset, then never again', () => {
        // session-reset: analysis cleared, sessionKey bumped, fresh cycle armed.
        const fresh = startup({ panelFirstOpenedAt: 1_700_000_600_000 });
        expect(resolveIntelligenceView(fresh)).toBe('countdown');

        // Early trigger → skeleton → empty result. Still no second ring.
        expect(resolveIntelligenceView({ ...fresh, isCountdownActive: false, isLoading: true })).toBe('skeleton');
        expect(resolveIntelligenceView({ ...fresh, isCountdownActive: false })).toBe('waiting');
    });
});
