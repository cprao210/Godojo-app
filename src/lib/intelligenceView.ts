// ─── Which placeholder the Intelligence panel shows ───────────────────────────
// Extracted from FloatingIntelligencePanel's render so the rule is testable.
// The bug this exists to prevent: the countdown ring reappearing after the
// loading skeleton. The first analysis of a call fires early (as soon as the
// prospect has spoken twice) and often returns nothing usable yet — every
// BANT/MEDDIC field still `missing`, no signals. That leaves the panel with no
// data to show once the skeleton clears, and the old branch chain fell straight
// back to the countdown, which then ticked down against a deadline the hook had
// already cleared. `isCountdownActive` is the hook's answer to "is the single
// startup cycle still armed, with nothing back from analysis yet" — it is the
// only thing that may put the ring on screen.

export type IntelligenceView =
    | 'content'
    | 'skeleton'
    | 'error'
    | 'no-analysis-captured'
    | 'countdown'
    | 'waiting';

export interface IntelligenceViewInput {
    /** Panel has something worth rendering (objections, signals, or any non-missing field). */
    hasDisplayData: boolean;
    isLoading: boolean;
    /** Delta run rather than the first run of the session — keeps content up instead of skeletoning. */
    isRefreshRun: boolean;
    hasError: boolean;
    /** Countdown reached zero without enough transcript to analyse. */
    noAnalysisCaptured: boolean;
    /** The one startup countdown cycle is still armed AND no result has landed. */
    isCountdownActive: boolean;
    panelFirstOpenedAt: number | null;
    autoRefreshInterval: number | null;
}

export function resolveIntelligenceView(input: IntelligenceViewInput): IntelligenceView {
    // Data wins over everything. isRefreshRun is meant to keep existing content
    // visible during a forced re-run (e.g. checking "Negotiation" calls
    // runAnalysis(true) so Deal Alert populates without waiting for the next
    // tick), but it's a second piece of state that has to land in the same
    // render as isLoading to work. Leading with the data check makes that
    // timing irrelevant: content never drops back to a skeleton or a placeholder.
    if (input.hasDisplayData) return 'content';

    if (input.isLoading && !input.isRefreshRun) return 'skeleton';
    if (input.hasError) return 'error';
    if (input.noAnalysisCaptured) return 'no-analysis-captured';

    // Only while the cycle is genuinely armed — see the file header.
    if (input.isCountdownActive && !!input.panelFirstOpenedAt && !!input.autoRefreshInterval) {
        return 'countdown';
    }

    return 'waiting';
}
