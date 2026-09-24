// summaryReconciliation.ts
// ── BANT/MEDDIC reconciliation (summary side) ────────────────────────────────
// buildSummaryPrompt() TELLS the LLM live analysis is authoritative and to
// "copy these values directly" — but that's a prompt instruction, not a
// guarantee. The LLM can paraphrase evidence, misapply the status mapping,
// or re-derive a field from the transcript instead of trusting the supplied
// value, especially on a fallback-tier provider. This function makes that
// guarantee real: it overwrites summaryData.bant/meddicc in code, directly
// from liveAnalysisData, so the Summary tab and the Call Analysis tab can
// never disagree on BANT/MEDDIC status or evidence.

// salesCoachReview.whatIDidRight's BANT/MEDDICC-labelled items are reconciled
// the same way (see buildConfirmedWhatIDidRight below): the LLM was previously
// free to cherry-pick up to 6 "wins" from the transcript on its own judgment,
// which routinely disagreed with the Confirmed set shown in Call Analysis.
// Those items are now derived deterministically from the same
// liveAnalysis-backed bant/meddicc objects below, so "Sales Self-Analysis"
// can never show a different confirmed count than the live Call Analysis tab.
// Only fields that legitimately require transcript reasoning (overview,
// dealStatus, whatICouldHaveDoneBetter, whatIMissedCompletely,
// nextCallPlaybook, keyPoints, actionItems) are left for the LLM — EXCEPT
// that whatIMissedCompletely gets a deterministic fallback (see
// buildMissingWhatIMissed): the LLM is under a strict "only truly missed,
// do NOT pad" instruction and can legitimately return nothing, which used to
// hide the "Room to Improve" section entirely even while Call Analysis
// showed Missing/Partial fields. The fallback derives it from the same
// reconciled statuses so the two views can never disagree in the other
// direction either.

import { LiveAnalysisData } from '../src/types';
import { BANT_ORDER, MEDDICC_ORDER } from '../src/lib/bantMeddic';

const toComponentName = (camelKey: string): string => camelKey.charAt(0).toUpperCase() + camelKey.slice(1);

export function buildConfirmedWhatIDidRight(
    bant: Record<string, { status: string; detail: string }>,
    meddicc: Record<string, { status: string; detail: string }>,
): string[] {
    const meddiccItems = MEDDICC_ORDER
        .filter((key) => meddicc[key]?.status === 'Clear')
        .map((key) => `MEDDICC ${toComponentName(key)}: ${meddicc[key].detail}`);

    const bantItems = BANT_ORDER
        .filter((key) => bant[key]?.status === 'Clear')
        .map((key) => `BANT ${toComponentName(key)}: ${bant[key].detail}`);

    return [...meddiccItems, ...bantItems];
}

/**
 * True placeholder strings the summary LLM emits for "nothing to report"
 * (exact match only — a PREFIX match would swallow real content like
 * "Not able to identify the champion" or "No budget discussion happened").
 */
const PLACEHOLDER_CONTENT = new Set([
    'n/a', 'na', 'none', 'none.', '-', '—', 'unknown', 'not discussed',
    'not mentioned', 'not applicable', 'nothing', 'nothing.',
]);

export function isPlaceholderSummaryItem(content: string | undefined | null): boolean {
    if (!content) return true;
    const normalized = content.trim().toLowerCase().replace(/[.!?]+$/, '').trim();
    return normalized === '' || PLACEHOLDER_CONTENT.has(normalized);
}

/** Mirrors buildConfirmedWhatIDidRight for the gap side: every field the
 * reconciled statuses mark Missing becomes a "Room to Improve" item. The
 * default detail deliberately avoids placeholder-looking prefixes so the
 * renderer's filters can never swallow it. */
export function buildMissingWhatIMissed(
    bant: Record<string, { status: string; detail: string }>,
    meddicc: Record<string, { status: string; detail: string }>,
): string[] {
    const meddiccItems = MEDDICC_ORDER
        .filter((key) => meddicc[key]?.status === 'Missing')
        .map((key) => `MEDDICC ${toComponentName(key)}: ${meddicc[key]?.detail?.trim() || 'Never addressed in this call — follow up next time.'}`);

    const bantItems = BANT_ORDER
        .filter((key) => bant[key]?.status === 'Missing')
        .map((key) => `BANT ${toComponentName(key)}: ${bant[key]?.detail?.trim() || 'Never addressed in this call — follow up next time.'}`);

    return [...meddiccItems, ...bantItems];
}
export const STATUS_MAP: Record<string, string> = {
    confirmed: 'Clear',
    partial: 'Partial',
    missing: 'Missing',
    '': 'Missing',
};

export function reconcileBantMeddicWithLiveAnalysis(
    summaryData: any,
    liveAnalysis: LiveAnalysisData | null | undefined,
): any {

    if (!liveAnalysis) return summaryData; // nothing to reconcile against — leave LLM output as-is

    const field = (f: { status: string; evidence: string } | undefined) => ({
        status: STATUS_MAP[f?.status ?? ''] ?? 'Missing',
        detail: f?.evidence || '',
    });

    const reconciledBant = {
        budget: field(liveAnalysis.bant?.budget),
        authority: field(liveAnalysis.bant?.authority),
        need: field(liveAnalysis.bant?.need),
        timeline: field(liveAnalysis.bant?.timeline),
    };

    const reconciledMeddicc = {
        metrics: field(liveAnalysis.meddic?.metrics),
        economicBuyer: field(liveAnalysis.meddic?.economic_buyer),
        decisionCriteria: field(liveAnalysis.meddic?.decision_criteria),
        decisionProcess: field(liveAnalysis.meddic?.decision_process),
        identifyPain: field(liveAnalysis.meddic?.identify_pain),
        champion: field(liveAnalysis.meddic?.champion),
        competition: field(liveAnalysis.meddic?.competition),
        // gaps is genuinely a summarization task (which of the 7 fields
        // are weak) — keep the LLM's own list rather than recomputing it
        // here, but fall back to deriving it from the reconciled statuses
        // above if the LLM omitted it.
        gaps: summaryData?.meddicc?.gaps?.length
            ? summaryData.meddicc.gaps
            : (['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'competition'] as const)
                .filter((k) => (liveAnalysis.meddic as any)?.[k]?.status !== 'confirmed')
                .map((k) => k),
    };

    return {
        ...summaryData,
        bant: reconciledBant,
        meddicc: reconciledMeddicc,
        salesCoachReview: {
            ...summaryData?.salesCoachReview,
            whatIDidRight: buildConfirmedWhatIDidRight(reconciledBant, reconciledMeddicc),
            // LLM's own missed-items win when substantive; placeholder/empty
            // output falls back to the deterministic Missing-field list so
            // "Room to Improve" can't hide while Call Analysis shows gaps.
            whatIMissedCompletely: (summaryData?.salesCoachReview?.whatIMissedCompletely ?? [])
                .some((item: string) => !isPlaceholderSummaryItem(item))
                ? summaryData.salesCoachReview.whatIMissedCompletely
                : buildMissingWhatIMissed(reconciledBant, reconciledMeddicc),
        },
    };
}
