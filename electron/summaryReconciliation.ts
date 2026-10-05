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

// salesCoachReview.whatIDidRight is NOT reconciled from the framework fields:
// it holds the LLM's film-review highlight objects (time/skill/moment/why)
// about the rep's own behavior, and framework coverage is Call Analysis's
// job. Only fields that legitimately require transcript reasoning (overview,
// dealStatus, whatIDidRight, whatICouldHaveDoneBetter, nextCallPlaybook,
// keyPoints, actionItems) are left for the LLM — EXCEPT
// that whatIMissedCompletely gets a deterministic fallback (see
// buildMissingWhatIMissed): the LLM is under a strict "only truly missed,
// do NOT pad" instruction and can legitimately return nothing, so the
// fallback derives it from the reconciled statuses to keep the two views
// consistent in that direction.

import { LiveAnalysisData } from '../src/types';
import { BANT_ORDER, MEDDICC_ORDER, fieldText, type EvidenceBearing } from '../src/lib/bantMeddic';

const toComponentName = (camelKey: string): string => camelKey.charAt(0).toUpperCase() + camelKey.slice(1);

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

/** Gap-side derivation: every field the
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

/**
 * Open loops = the customer's still-unresolved questions/concerns/objections,
 * taken straight from the live analysis's objection list. The live analysis is
 * the source of truth here (not the LLM's summary output): entries the rep
 * resolved during the call — `resolved`, or graded `handled: 'resolved'` by
 * the v2 end pass — are excluded, as are placeholder concerns. `suggestedAnswer`
 * rides along from the analysis's own suggested_answer when present.
 */
export function deriveOpenLoopsFromLiveAnalysis(
    liveAnalysis: LiveAnalysisData,
): Array<{ concern: string; suggestedAnswer?: string }> {
    return (liveAnalysis.objections ?? [])
        .filter((o) => !o.resolved && o.handled !== 'resolved')
        .map((o): { concern: string; suggestedAnswer?: string } | null => {
            const concern = (o.quote ?? '').trim();
            if (!concern || isPlaceholderSummaryItem(concern)) return null;
            const answer = (o.suggested_answer ?? '').trim();
            return answer && !isPlaceholderSummaryItem(answer)
                ? { concern, suggestedAnswer: answer }
                : { concern };
        })
        .filter((l): l is { concern: string; suggestedAnswer?: string } => l !== null);
}

export function reconcileBantMeddicWithLiveAnalysis(
    summaryData: any,
    liveAnalysis: LiveAnalysisData | null | undefined,
): any {

    if (!liveAnalysis) return summaryData; // nothing to reconcile against — leave LLM output as-is

    // `detail` is the one line read by people (Summary tab, PDF, exports), so
    // it takes the backend's own assessment of the field — see fieldText. This
    // must stay identical to toCanonicalField in src/lib/bantMeddic: it is the
    // same mapping, mirrored here for the main process.
    const field = (f: ({ status: string } & EvidenceBearing) | undefined) => ({
        status: STATUS_MAP[f?.status ?? ''] ?? 'Missing',
        detail: fieldText(f),
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

    // openLoops are derived deterministically from the live analysis's
    // unresolved objections (see deriveOpenLoopsFromLiveAnalysis) — the LLM's
    // own openLoops output, if any, is replaced so the summary can never
    // disagree with the objection list it is grounded on. When every objection
    // was resolved, the key is removed rather than left holding fabricated
    // entries. Everything else about the merge stays additive: fields the
    // reconciler doesn't own (nextCallPlaybook, promises, demoReview,
    // stakeholders, negotiation, keyPoints, actionItems, unknown props) pass
    // through the spread untouched.
    const { openLoops: _llmOpenLoops, ...rest } = summaryData ?? {};
    const openLoops = deriveOpenLoopsFromLiveAnalysis(liveAnalysis);

    return {
        ...rest,
        ...(openLoops.length ? { openLoops } : {}),
        bant: reconciledBant,
        meddicc: reconciledMeddicc,
        salesCoachReview: {
            ...summaryData?.salesCoachReview,
            // whatIDidRight is NOT overwritten: it holds the LLM's film-review
            // highlight objects (time/skill/moment/why) about the rep's own
            // behavior. Framework coverage belongs to bant/meddicc above and
            // the Call Analysis tab — deriving "wins" from Confirmed fields
            // here produced framework-labelled deal facts, exactly what the
            // Coach's notes column was redesigned away from.
            // LLM's own missed-items win when substantive; placeholder/empty
            // output falls back to the deterministic Missing-field list so
            // gaps can't hide while Call Analysis shows them.
            whatIMissedCompletely: (summaryData?.salesCoachReview?.whatIMissedCompletely ?? [])
                .some((item: string) => !isPlaceholderSummaryItem(item))
                ? summaryData.salesCoachReview.whatIMissedCompletely
                : buildMissingWhatIMissed(reconciledBant, reconciledMeddicc),
        },
    };
}
