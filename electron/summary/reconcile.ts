// electron/summary/reconcile.ts
//
// Extracted from MeetingPersistence so it is unit-testable: MeetingPersistence
// imports AppState from ./main, which pulls in the entire Electron app and makes
// the whole file unloadable under vitest's `environment: 'node'`. Nothing here
// touches Electron, the DB, or an LLM.

import type { LiveAnalysisData } from '../../src/types';
import { BANT_ORDER, MEDDICC_ORDER, STATUS_MAP } from '../../src/lib/bantMeddic';

// ── BANT/MEDDIC reconciliation ──────────────────────────────────────────────
// buildSummaryPrompt() TELLS the LLM live analysis is authoritative and to
// "copy these values directly" — but that's a prompt instruction, not a
// guarantee. The LLM can paraphrase evidence, misapply the status mapping,
// or re-derive a field from the transcript instead of trusting the supplied
// value, especially on a fallback-tier provider. This function makes that
// guarantee real: it overwrites summaryData.bant/meddicc in code, directly
// from liveAnalysisData, so the Summary tab and the Call Analysis tab can
// never disagree on BANT/MEDDIC status or evidence.

// salesCoachReview.whatIDidRight is FILTERED against the same reconciled
// bant/meddicc objects (see filterWhatIDidRightToConfirmed below), so the
// confirmed count can never disagree with the Call Analysis tab — but the item
// TEXT stays the LLM's transcript-grounded description of what the rep did.
// An earlier version synthesized the text from liveAnalysis.evidence, which is a
// prospect quote, so the section rendered the customer's words as the rep's
// achievements. Only fields that legitimately require transcript reasoning
// (overview, dealStatus, whatICouldHaveDoneBetter, whatIMissedCompletely,
// nextCallPlaybook, keyPoints, actionItems) are otherwise left to the LLM.

const toComponentName = (camelKey: string): string => camelKey.charAt(0).toUpperCase() + camelKey.slice(1);

/**
 * Filters the LLM's own "what I did right" items down to the components whose
 * reconciled status is Clear, and orders them MEDDICC-then-BANT.
 *
 * This used to SYNTHESIZE the items instead:
 *     `MEDDICC ${Component}: ${liveAnalysis.evidence}`
 * which had two problems. `evidence` is a PROSPECT quote, not a description of
 * anything the rep did — so "What I Did Right" rendered the customer's words as
 * the rep's achievements. And when nothing was Clear the array became empty,
 * silently violating the prompt's own "minimum 2" contract.
 *
 * Filtering keeps the count in agreement with the Call Analysis tab (the reason
 * the deterministic version existed) while leaving the TEXT as the
 * transcript-grounded description of rep behaviour that the LLM actually wrote.
 */
function filterWhatIDidRightToConfirmed(
    llmItems: unknown,
    bant: Record<string, { status: string; detail: string }>,
    meddicc: Record<string, { status: string; detail: string }>,
): string[] {
    const items = Array.isArray(llmItems)
        ? llmItems.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
        : [];

    const clearMeddicc = MEDDICC_ORDER.filter((key) => meddicc[key]?.status === 'Clear');
    const clearBant = BANT_ORDER.filter((key) => bant[key]?.status === 'Clear');

    // An item "belongs" to a component when it carries that component's label,
    // which the prompt mandates ("MEDDICC Metrics: ...", "BANT Budget: ...").
    const matches = (item: string, framework: 'MEDDICC' | 'BANT', key: string) => {
        const label = `${framework} ${toComponentName(key)}`.toLowerCase();
        return item.trim().toLowerCase().startsWith(label.toLowerCase());
    };

    const ordered: string[] = [];
    for (const key of clearMeddicc) {
        const hit = items.find((i) => matches(i, 'MEDDICC', key));
        if (hit) ordered.push(hit);
    }
    for (const key of clearBant) {
        const hit = items.find((i) => matches(i, 'BANT', key));
        if (hit) ordered.push(hit);
    }

    // If the LLM produced no labelled item for a Clear component we fall back to
    // naming the component without inventing rep behaviour for it. The evidence
    // quote is deliberately NOT used as the text.
    if (ordered.length === 0 && (clearMeddicc.length || clearBant.length)) {
        return [
            ...clearMeddicc.map((k) => `MEDDICC ${toComponentName(k)}: Confirmed during the call.`),
            ...clearBant.map((k) => `BANT ${toComponentName(k)}: Confirmed during the call.`),
        ];
    }

    return ordered;
}
// STATUS_MAP is imported, not redeclared — src/lib/bantMeddic.ts is the single
// source of truth and the frontend mirrors this exact mapping.

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
            whatIDidRight: filterWhatIDidRightToConfirmed(
                summaryData?.salesCoachReview?.whatIDidRight,
                reconciledBant,
                reconciledMeddicc,
            ),
        },
    };
}

// ── Runtime normalization of LiveAnalysisData ───────────────────────────────
// liveAnalysis crosses the IPC boundary as whatever the remote backend returned,
// cast straight to LiveAnalysisData with no validation. A renamed key or a null
// where an array was expected then blew up somewhere far downstream — inside the
// summary prompt builder, whose TypeError was swallowed into an empty summary.
// Normalizing once at the boundary means every consumer can rely on the shape.

const BANT_KEYS = ['budget', 'authority', 'need', 'timeline'] as const;
const MEDDIC_KEYS = [
    'metrics', 'economic_buyer', 'decision_criteria', 'decision_process',
    'identify_pain', 'champion', 'competition',
] as const;

const VALID_STATUS = new Set(['confirmed', 'partial', 'missing', '']);

function normalizeField(raw: any): { emoji: string; status: string; evidence: string; suggested_question?: string } {
    const status = typeof raw?.status === 'string' ? raw.status.trim().toLowerCase() : '';
    return {
        emoji: typeof raw?.emoji === 'string' ? raw.emoji : '',
        status: VALID_STATUS.has(status) ? status : '',
        evidence: typeof raw?.evidence === 'string' ? raw.evidence : '',
        ...(typeof raw?.suggested_question === 'string' ? { suggested_question: raw.suggested_question } : {}),
    };
}

/**
 * Coerces an arbitrary payload into a structurally-valid LiveAnalysisData.
 * Returns null only when there is nothing usable at all, so callers can keep
 * treating "no live analysis" as a distinct case from "malformed live analysis".
 */
export function normalizeLiveAnalysisData(raw: any): LiveAnalysisData | null {
    if (!raw || typeof raw !== 'object') return null;

    const bant: any = {};
    for (const k of BANT_KEYS) bant[k] = normalizeField(raw.bant?.[k]);

    const meddic: any = {};
    for (const k of MEDDIC_KEYS) meddic[k] = normalizeField(raw.meddic?.[k]);

    const objections = Array.isArray(raw.objections)
        ? raw.objections.filter((o: any) => o && typeof o === 'object').map((o: any) => ({
            type: o.type === 'ae_deferral' ? 'ae_deferral' : 'customer_question',
            quote: typeof o.quote === 'string' ? o.quote : '',
            owner: o.owner === 'ae' ? 'ae' : 'customer',
            status: o.status === 'deferred' ? 'deferred' : 'open',
            ...(typeof o.suggested_answer === 'string' ? { suggested_answer: o.suggested_answer } : {}),
            ...(typeof o.id === 'string' ? { id: o.id } : {}),
        }))
        : [];

    const signals = Array.isArray(raw.signals)
        ? raw.signals.filter((s: any) => s && typeof s === 'object').map((s: any) => ({
            quote: typeof s.quote === 'string' ? s.quote : '',
            // signal_type is documented as an array but arrives as a bare string often enough to matter.
            signal_type: Array.isArray(s.signal_type)
                ? s.signal_type.filter((t: any) => typeof t === 'string')
                : (typeof s.signal_type === 'string' ? [s.signal_type] : []),
            ask_now: typeof s.ask_now === 'string' ? s.ask_now : '',
            intensity: ['high', 'medium', 'low'].includes(s.intensity) ? s.intensity : 'low',
            category: ['positive', 'negative', 'neutral'].includes(s.category) ? s.category : 'neutral',
            ...(typeof s.id === 'string' ? { id: s.id } : {}),
        }))
        : [];

    const dealOptimizer = Array.isArray(raw.dealOptimizer)
        ? raw.dealOptimizer.filter((a: any) => a && typeof a === 'object').map((a: any) => ({
            trigger: typeof a.trigger === 'string' ? a.trigger : 'closing_signal',
            quote: typeof a.quote === 'string' ? a.quote : '',
            headline: typeof a.headline === 'string' ? a.headline : '',
            moves: Array.isArray(a.moves) ? a.moves.filter((m: any) => typeof m === 'string') : [],
            ...(typeof a.anchor === 'string' ? { anchor: a.anchor } : {}),
            intensity: ['high', 'medium', 'low'].includes(a.intensity) ? a.intensity : 'low',
            ...(typeof a.id === 'string' ? { id: a.id } : {}),
        }))
        : [];

    return { bant, meddic, objections, signals, dealOptimizer } as LiveAnalysisData;
}
