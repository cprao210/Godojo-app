/**
 * meetingLifecycle.ts
 *
 * The two decisions in the meeting lifecycle that are easy to get wrong and
 * hard to test in place, extracted as pure functions:
 *
 *  1. `decideFinalAnalysis` — should ending a call trigger one more analysis
 *     run? Exactly once, never twice, never zero times when the call was never
 *     analyzed at all.
 *  2. `deriveProcessingStage` — what is a meeting actually doing right now?
 *     Every stage here maps to a real, observable piece of persisted state, not
 *     to a timer. There is deliberately no stage the UI can show that isn't
 *     backed by something main has really finished.
 */

// ─── Final analysis at end of call ──────────────────────────────────────────

export type FinalAnalysisAction =
    /** Nothing has been analyzed yet, or new turns arrived — run once now. */
    | 'run'
    /** A run is already in flight; its result IS the final analysis. Await it. */
    | 'wait'
    /** The current analysis already covers the whole transcript, or there isn't
     *  enough transcript to analyze. Ending must not stall on a pointless run. */
    | 'skip';

export interface FinalAnalysisInput {
    /** Has the end-of-call analysis already been requested for this session? */
    alreadyRequested: boolean;
    /** Is an analysis run in flight right now? */
    isLoading: boolean;
    /** Has any analysis result been produced during this call? */
    hasAnalysis: boolean;
    /** Cursor: how many human turns the last completed run consumed. */
    lastAnalyzedTurnIndex: number;
    /** Human turns currently in the transcript. */
    humanTurnCount: number;
    /** Does the transcript clear the minimum-prospect-turns bar? */
    hasEnoughTranscript: boolean;
}

export interface FinalAnalysisDecision {
    action: FinalAnalysisAction;
    /** Why — logged, and the thing tests assert on when behaviour changes. */
    reason: string;
}

/**
 * Ending a call is the last chance to analyze the complete transcript. It must
 * happen exactly once: refreshes, repeated End Call clicks, and the meeting-end
 * broadcast all funnel through here, and a duplicate run would both cost a
 * second LLM call and race the first one's write.
 */
export function decideFinalAnalysis(input: FinalAnalysisInput): FinalAnalysisDecision {
    if (input.alreadyRequested) {
        return { action: 'skip', reason: 'final analysis already requested for this call' };
    }
    if (!input.hasEnoughTranscript) {
        return { action: 'skip', reason: 'not enough prospect transcript to analyze' };
    }
    // A run is already going. It started from a transcript at least as complete
    // as the cursor, and runAnalysis rejects concurrent runs anyway — so the
    // honest move is to wait for it rather than pretend to start another.
    if (input.isLoading) {
        return { action: 'wait', reason: 'an analysis run is already in flight' };
    }
    if (!input.hasAnalysis) {
        return { action: 'run', reason: 'call was never analyzed' };
    }
    if (input.lastAnalyzedTurnIndex < input.humanTurnCount) {
        const fresh = input.humanTurnCount - input.lastAnalyzedTurnIndex;
        return { action: 'run', reason: `${fresh} turn(s) arrived after the last analysis` };
    }
    return { action: 'skip', reason: 'existing analysis already covers the full transcript' };
}

/**
 * How long to hold the End Call button while the final analysis lands. Long
 * enough that a normal single LLM round-trip wins (so the analysis is part of
 * the snapshot the summary is generated from), short enough that a hung
 * provider can never trap the user in a call they asked to end. On timeout the
 * call ends anyway and main patches the result into the saved row instead.
 */
export const FINAL_ANALYSIS_MAX_WAIT_MS = 10_000;

// ─── Post-meeting processing stages ─────────────────────────────────────────

export type ProcessingStage = 'analyzing' | 'validating' | 'finalizing' | 'ready' | 'stalled';

export interface ProcessingStageInput {
    /** Row exists but `is_processed = 0` — background processing is running. */
    isProcessing: boolean;
    /** A row landed in `meeting_scorecards`. Written as soon as scoring finishes. */
    hasScorecard: boolean;
    /** Has the meeting-detail read actually completed (not just "not loading")? */
    isDetailResolved: boolean;
    /** Processing has been running far longer than it ever legitimately takes. */
    isStalled: boolean;
}

export interface ProcessingStageView {
    stage: ProcessingStage;
    label: string;
    detail: string;
}

/**
 * Map observable state onto a stage.
 *
 * The real order of events in MeetingPersistence.processAndSaveMeeting is:
 * placeholder row saved (with the full transcript) → scorecard and title/summary
 * generation start concurrently → the scorecard row is persisted as soon as it
 * is ready → the summary runs a generate → verify → regenerate loop → the final
 * save flips `is_processed` to 1.
 *
 * So the scorecard row appearing while `is_processed` is still 0 is a genuine
 * signal that the remaining wait is the summary's verification loop. That is
 * the entire basis for splitting "analyzing" from "validating" — there is no
 * per-attempt progress event from main, and inventing one would be exactly the
 * fake animation state this is meant to avoid.
 */
export function deriveProcessingStage(input: ProcessingStageInput): ProcessingStageView {
    if (input.isStalled) {
        return {
            stage: 'stalled',
            label: "Processing didn't finish",
            detail: 'The summary was never completed for this call. You can regenerate it.',
        };
    }
    if (input.isProcessing) {
        return input.hasScorecard
            ? {
                stage: 'validating',
                label: 'Validating summary',
                detail: 'Checking every claim against the transcript.',
            }
            : {
                stage: 'analyzing',
                label: 'Analyzing transcript',
                detail: 'Scoring the call and drafting the summary.',
            };
    }
    if (!input.isDetailResolved) {
        return {
            stage: 'finalizing',
            label: 'Finalizing',
            detail: 'Loading the completed summary.',
        };
    }
    return { stage: 'ready', label: 'Ready', detail: '' };
}

/**
 * Processing that hasn't finished in this long has failed — main crashed, the
 * LLM provider never answered, or the app was killed mid-run. Past it the UI
 * stops promising a summary that isn't coming and offers a regenerate instead
 * of spinning forever.
 */
export const PROCESSING_STALL_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Is there a generated summary to paint yet? ─────────────────────────────

/**
 * Does this meeting hold summary prose the Summary tab can actually render?
 *
 * Deliberately NOT the inverse of `isSummaryEmpty`. That predicate answers a
 * different question — "does this meeting have any content worth showing
 * anywhere" — and correctly reports "not empty" for a meeting carrying only
 * `liveAnalysis`, because its Analysis tab does have content. But a list row
 * looks exactly like that before the detail read resolves: liveAnalysis
 * present, every summary field still missing. Gating the Summary tab on
 * `!isSummaryEmpty` therefore opened the tab, painted the score, and left every
 * summary section blank until the slower read landed — the "score first,
 * summary later" flicker.
 *
 * It checks the same fields `isSummaryEmpty` does, minus that liveAnalysis
 * short-circuit, so `!hasGeneratedSummary(ds)` is exactly "there is nothing for
 * the Summary tab to draw" and can safely drive its empty state.
 *
 * Takes the summary object rather than the Meeting so this stays free of any
 * runtime dependency and testable on its own.
 */
export function hasGeneratedSummary(
    ds:
        | {
            overview?: string;
            keyPoints?: string[];
            actionItems?: string[];
            dealStatus?: { stage?: string; summary?: string };
            salesCoachReview?: {
                whatIDidRight?: string[];
                whatICouldHaveDoneBetter?: string[];
                whatIMissedCompletely?: string[];
            };
            nextCallPlaybook?: { openingRecap?: string; questionsToAsk?: string[] };
        }
        | null
        | undefined,
): boolean {
    if (!ds) return false;
    const filled = (arr?: string[]) => Array.isArray(arr) && arr.some((s) => s?.trim());
    return (
        !!ds.overview?.trim() ||
        filled(ds.keyPoints) ||
        filled(ds.actionItems) ||
        !!ds.dealStatus?.stage?.trim() ||
        !!ds.dealStatus?.summary?.trim() ||
        filled(ds.salesCoachReview?.whatIDidRight) ||
        filled(ds.salesCoachReview?.whatICouldHaveDoneBetter) ||
        filled(ds.salesCoachReview?.whatIMissedCompletely) ||
        !!ds.nextCallPlaybook?.openingRecap?.trim() ||
        filled(ds.nextCallPlaybook?.questionsToAsk)
    );
}
