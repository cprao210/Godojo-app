// callAnalysis.ts
//
// One place that decides how a meeting WITHOUT a live analysis gets its Call Analysis
// (BANT / MEDDIC / objections / buying signals). Two callers share it:
//
//   - MeetingPersistence.processAndSaveMeeting, for uploads and recovered meetings;
//   - MeetingPersistence.regenerateSummary, which used to rebuild only the summary and
//     so left a meeting whose first analysis failed without a Call Analysis for good.
//
// Order: the backend producer first (asked through the renderer — see
// ./uploadAnalysisBridge; it is the live analysis v2 end-of-call pass), then the local one-shot
// analyser in ./uploadAnalysis. GODOJO_UPLOAD_ANALYSIS_LOCAL=1 skips the backend.
// Nothing here throws: a failed producer is logged and the next one runs, and null
// means neither produced an analysis.

import { LiveAnalysisData } from '../../src/types';
import { UploadAnalysisTurn } from './uploadAnalysisBridge';

export type MeetingTypeHint = 'discovery' | 'demo' | 'negotiation';

const MEETING_TYPES: readonly MeetingTypeHint[] = ['discovery', 'demo', 'negotiation'];

export interface CallAnalysisDeps {
    /** Backend producer through the renderer. Rejects when it is unavailable. */
    requestBackend: (turns: UploadAnalysisTurn[], meetingTypes: MeetingTypeHint[]) => Promise<LiveAnalysisData | null>;
    /** Local one-shot analyser over the whole transcript. */
    runLocal: (isNegotiation: boolean) => Promise<LiveAnalysisData | null>;
    /** GODOJO_UPLOAD_ANALYSIS_LOCAL=1 — never ask the backend. */
    forceLocal?: boolean;
    warn?: (message: string) => void;
}

export interface CallAnalysisResult {
    analysis: LiveAnalysisData | null;
    producer: 'backend' | 'local' | null;
}

/** Needs at least this many human turns — the same bar the upload path always used. */
export const MIN_TURNS_FOR_CALL_ANALYSIS = 3;

/**
 * Backend ceiling when regenerating: the rep is watching a spinner, unlike the background
 * upload path (10 min). The v2 end pass answers well inside this.
 */
export const REGENERATE_ANALYSIS_TIMEOUT_MS = 3 * 60_000;

export async function generateCallAnalysis(
    turns: UploadAnalysisTurn[],
    meetingTypes: MeetingTypeHint[],
    deps: CallAnalysisDeps,
): Promise<CallAnalysisResult> {
    const warn = deps.warn ?? ((m: string) => console.warn(m));
    if (turns.length < MIN_TURNS_FOR_CALL_ANALYSIS) return { analysis: null, producer: null };

    if (!deps.forceLocal) {
        try {
            const analysis = await deps.requestBackend(turns, meetingTypes);
            if (analysis) return { analysis, producer: 'backend' };
        } catch (e: any) {
            // Non-fatal by design: the local analyser sees the whole transcript, so a
            // backend outage costs grounding quality, never the analysis itself.
            warn(`[CallAnalysis] Backend call analysis unavailable: ${e?.message ?? e} — falling back to local analysis.`);
        }
    }

    try {
        const analysis = await deps.runLocal(meetingTypes.includes('negotiation'));
        if (analysis) return { analysis, producer: 'local' };
    } catch (e: any) {
        warn(`[CallAnalysis] Local call analysis failed: ${e?.message ?? e}`);
    }
    return { analysis: null, producer: null };
}

/**
 * Meeting-type hints for a meeting being regenerated. The rep's choice is not stored on
 * the row, so use what the scorecard detected; unknown values are dropped.
 */
export function meetingTypesForRegenerate(...sources: Array<unknown>): MeetingTypeHint[] {
    for (const source of sources) {
        if (!Array.isArray(source)) continue;
        const types = source.filter((t): t is MeetingTypeHint => MEETING_TYPES.includes(t as MeetingTypeHint));
        if (types.length) return Array.from(new Set(types));
    }
    return [];
}

/** True when a stored analysis has something to show (not just an empty shell). */
export function hasUsableCallAnalysis(analysis: unknown): analysis is LiveAnalysisData {
    const a = analysis as LiveAnalysisData | null | undefined;
    return !!a && typeof a === 'object' && !!a.bant && !!a.meddic;
}
