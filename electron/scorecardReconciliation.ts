// ─── Meeting Score ⇄ Live Analysis reconciliation ─────────────────────────────
// The Meeting Score used to be a SECOND, independent LLM judgement of the same
// frameworks the Call Analysis tab already shows. `buildScorecardPrompt` only
// ever received the transcript, so discovery's MEDDIC (40) / BANT (30) /
// Objection Handling (30) and demo's Buying Intent Signals / Objection Handling
// were re-derived from scratch — while the Summary tab was already being
// deterministically reconciled against live analysis (see
// `reconcileBantMeddicWithLiveAnalysis` in MeetingPersistence.ts). The score,
// its reasoning, its coaching points and its quotes could therefore contradict
// the very panel the user reads them next to.
//
// Live/Call Analysis is the single source of truth. The scorecard prompt now
// receives it as grounding, but — for exactly the reason the summary path
// already documents — a prompt instruction is not a guarantee. So for the
// framework categories we recognise we re-derive everything the user can
// visibly compare: score, reasoning, strengths, improvement areas and quotes.
//
// Categories we do NOT recognise are returned untouched: a user's custom rubric
// must never be silently re-scored against a framework it isn't measuring.
// Recognition is deliberately limited to the category KEY and LABEL — never
// checkpoint text, because negotiation's "Preparation" checkpoints mention
// budget/timeline/decision maker and must not be hijacked as BANT.

import type {
    LiveAnalysisData,
    MeetingScorecard,
    MeetingScorecardResult,
    Objection,
    ScoredCategory,
    Signal,
} from '../src/types';

export type FrameworkKind = 'meddic' | 'bant' | 'objection_handling' | 'buying_signals';

/** Live-analysis status → fraction of a component's credit. Mirrors the prompt's
 *  own SCORING SCALE ("Full marks … clearly confirmed by the CLIENT's own
 *  words" / "Partial" / "Zero: Not raised"), so this applies the existing
 *  rubric rather than inventing one. */
const STATUS_CREDIT: Record<string, number> = { confirmed: 1, partial: 0.5, missing: 0, '': 0 };

/** Positive buying signals needed for full marks on a signal-scored category.
 *  Explicit and deterministic so the number can always be traced back to the
 *  Signals list the user sees in Call Analysis. */
export const SIGNALS_FOR_FULL_MARKS = 3;

const BANT_FIELDS: [keyof LiveAnalysisData['bant'], string][] = [
    ['budget', 'Budget'],
    ['authority', 'Authority'],
    ['need', 'Need'],
    ['timeline', 'Timeline'],
];

const MEDDIC_FIELDS: [keyof LiveAnalysisData['meddic'], string][] = [
    ['metrics', 'Metrics'],
    ['economic_buyer', 'Economic Buyer'],
    ['decision_criteria', 'Decision Criteria'],
    ['decision_process', 'Decision Process'],
    ['identify_pain', 'Identify Pain'],
    ['champion', 'Champion'],
    ['competition', 'Competition'],
];

const norm = (value: string | undefined | null): string =>
    (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Which live-analysis framework (if any) a scorecard category is measuring.
 * Matches on key and label only — see the file header for why checkpoints are
 * deliberately excluded. Returns null for anything unrecognised.
 */
export function classifyFrameworkCategory(
    key: string | undefined | null,
    label: string | undefined | null
): FrameworkKind | null {
    const candidates = [norm(key), norm(label)];
    const has = (needle: string) => candidates.some(c => c.includes(needle));

    if (has('meddic') || has('meddpicc')) return 'meddic';
    if (has('bant')) return 'bant';
    if (has('objection')) return 'objection_handling';
    if (has('buyingintent') || has('buyingsignal') || has('intentsignal')) return 'buying_signals';
    return null;
}

/** The parts of a scored category that live analysis owns. */
type Derived = Pick<ScoredCategory, 'score' | 'reasoning' | 'transcriptEvidence' | 'strengths' | 'improvementAreas'>;

const clampScore = (raw: number, maxScore: number): number => {
    if (!Number.isFinite(maxScore) || maxScore <= 0) return 0;
    return Math.max(0, Math.min(maxScore, Math.round(raw)));
};

const trimmed = (value: string | undefined | null): string => (value ?? '').trim();

/**
 * MEDDIC / BANT: score every component the Call Analysis tab renders, so the
 * percentage can be checked against the ✅/⚠️/❌ rows one tab over. All seven
 * MEDDIC components are counted (not just the configured checkpoints) precisely
 * because all seven are displayed — a category showing 100% while Competition
 * shows ❌ is the contradiction this is here to prevent.
 */
function deriveFromFields(
    fields: { label: string; status: string; evidence: string }[],
    frameworkName: string,
    maxScore: number
): Derived {
    const confirmed = fields.filter(f => f.status === 'confirmed');
    const partial = fields.filter(f => f.status === 'partial');
    const missing = fields.filter(f => f.status !== 'confirmed' && f.status !== 'partial');
    const credit = fields.reduce((sum, f) => sum + (STATUS_CREDIT[f.status] ?? 0), 0);

    return {
        score: fields.length > 0 ? clampScore((credit / fields.length) * maxScore, maxScore) : 0,
        reasoning:
            `From the call analysis ${frameworkName} assessment: ${confirmed.length} of ${fields.length} ` +
            `components confirmed by the client, ${partial.length} partial, ${missing.length} not established.`,
        transcriptEvidence: [...confirmed, ...partial]
            .filter(f => f.evidence.length > 0)
            .map(f => `${f.label}: ${f.evidence}`),
        strengths: confirmed.map(f =>
            f.evidence ? `${f.label} confirmed — ${f.evidence}` : `${f.label} confirmed by the client.`
        ),
        improvementAreas: [
            ...partial.map(f => `${f.label} is only partially established — get the client to confirm it explicitly.`),
            ...missing.map(f => `${f.label} was never established on this call.`),
        ],
    };
}

/**
 * Objection handling: scored from the objections the live watcher actually
 * tracked. An empty list is a real 0 — it is what the Objections tab shows, and
 * it is what the prompt's own rubric already says ("Zero: Not raised").
 */
function deriveFromObjections(objections: Objection[] | undefined, maxScore: number): Derived {
    const list = Array.isArray(objections) ? objections : [];

    if (list.length === 0) {
        return {
            score: 0,
            reasoning: 'No objections were tracked on this call, so there was no objection handling to score.',
            transcriptEvidence: [],
            strengths: [],
            improvementAreas: [
                'No objections surfaced — probe for concerns during the call so they surface with you, not after.',
            ],
        };
    }

    const resolved = list.filter(o => o.resolved === true);
    const deferred = list.filter(o => o.resolved !== true && o.status === 'deferred');
    const open = list.filter(o => o.resolved !== true && o.status !== 'deferred');
    const credit = resolved.length + deferred.length * 0.5;
    const describe = (o: Objection) => trimmed(o.category_label) || trimmed(o.type).replace(/_/g, ' ') || 'Objection';

    return {
        score: clampScore((credit / list.length) * maxScore, maxScore),
        reasoning:
            `From the call analysis objections list: ${list.length} objection(s) tracked — ` +
            `${resolved.length} resolved, ${deferred.length} deferred with a plan, ${open.length} left open.`,
        transcriptEvidence: list
            .filter(o => trimmed(o.quote).length > 0)
            .map(o => `${o.resolved === true ? 'Resolved' : o.status === 'deferred' ? 'Deferred' : 'Open'}: ${trimmed(o.quote)}`),
        strengths: resolved.map(o => `Resolved the ${describe(o)} objection on the call.`),
        improvementAreas: [
            ...deferred.map(o => `The ${describe(o)} objection was deferred — close the loop with the promised follow-up.`),
            ...open.map(o => `The ${describe(o)} objection was never addressed on the call.`),
        ],
    };
}

/**
 * Buying-intent categories: scored from the live-analysis signals list, so the
 * percentage can never claim intent the Signals tab doesn't show (or miss
 * intent it does).
 */
function deriveFromSignals(signals: Signal[] | undefined, maxScore: number): Derived {
    const list = Array.isArray(signals) ? signals : [];
    const positive = list.filter(s => s.category === 'positive');
    const negative = list.filter(s => s.category === 'negative');
    const quoteOf = (s: Signal) => trimmed(s.quote);

    return {
        score: clampScore((Math.min(1, positive.length / SIGNALS_FOR_FULL_MARKS)) * maxScore, maxScore),
        reasoning:
            `From the call analysis signals list: ${positive.length} positive buying signal(s) and ` +
            `${negative.length} negative signal(s) captured` +
            (positive.length === 0 ? ' — no buying intent was expressed by the client.' : '.'),
        transcriptEvidence: positive.map(quoteOf).filter(q => q.length > 0),
        strengths: positive
            .filter(s => quoteOf(s).length > 0)
            .map(s => `Buying signal surfaced — ${quoteOf(s)}`),
        improvementAreas:
            positive.length === 0
                ? ['No buying signals were captured — test for intent directly (next steps, timing, who else needs to see this).']
                : negative
                    .filter(s => quoteOf(s).length > 0)
                    .map(s => `Negative signal left unaddressed — ${quoteOf(s)}`),
    };
}

function deriveForKind(kind: FrameworkKind, live: LiveAnalysisData, maxScore: number): Derived {
    switch (kind) {
        case 'meddic':
            return deriveFromFields(
                MEDDIC_FIELDS.map(([key, label]) => ({
                    label,
                    status: live.meddic?.[key]?.status ?? '',
                    evidence: trimmed(live.meddic?.[key]?.evidence),
                })),
                'MEDDIC',
                maxScore
            );
        case 'bant':
            return deriveFromFields(
                BANT_FIELDS.map(([key, label]) => ({
                    label,
                    status: live.bant?.[key]?.status ?? '',
                    evidence: trimmed(live.bant?.[key]?.evidence),
                })),
                'BANT',
                maxScore
            );
        case 'objection_handling':
            return deriveFromObjections(live.objections, maxScore);
        case 'buying_signals':
            return deriveFromSignals(live.signals, maxScore);
    }
}

/** `overallScore = Σ (score / maxScore * weight)` — the formula the prompt
 *  itself documents. Recomputed after reconciliation so the headline number and
 *  the category rows below it can't disagree. */
function recomputeOverallScore(categories: ScoredCategory[], fallback: number): number {
    const scorable = categories.filter(c => Number(c.maxScore) > 0 && Number.isFinite(Number(c.weight)));
    if (scorable.length === 0) return fallback;
    const total = scorable.reduce((sum, c) => sum + (Number(c.score) / Number(c.maxScore)) * Number(c.weight), 0);
    return Math.max(0, Math.min(100, Math.round(total)));
}

/** Mean of the per-type overall scores — same shape as the merge step in
 *  MeetingPersistence.generateAndPersistScorecard, so both paths agree. */
function recomputeCrossTypeScore(scorecards: MeetingScorecard[], fallback: number): number {
    const scores = scorecards.map(sc => Number(sc.overallScore)).filter(n => Number.isFinite(n));
    if (scores.length === 0) return fallback;
    return Math.round(scores.reduce((sum, n) => sum + n, 0) / scores.length);
}

/**
 * Rewrites every recognised framework category in a scorecard so its score and
 * narrative come from live analysis instead of a second opinion. Unrecognised
 * categories, and every scorecard with no recognised category, are returned
 * byte-for-byte unchanged. A missing/failed live analysis is a no-op: an
 * ungrounded score is still better than a blank one.
 */
export function reconcileScorecardWithLiveAnalysis(
    result: MeetingScorecardResult,
    liveAnalysis: LiveAnalysisData | null | undefined
): MeetingScorecardResult {
    if (!liveAnalysis || !result || !Array.isArray(result.scorecards) || result.scorecards.length === 0) {
        return result;
    }

    let anyChanged = false;

    const scorecards = result.scorecards.map((sc): MeetingScorecard => {
        const breakdown = Array.isArray(sc?.categoryBreakdown) ? sc.categoryBreakdown : [];
        let changed = false;

        const categoryBreakdown = breakdown.map((cat): ScoredCategory => {
            const kind = classifyFrameworkCategory(cat?.key, cat?.categoryName);
            if (!kind) return cat;
            const maxScore = Number(cat.maxScore) > 0 ? Number(cat.maxScore) : Number(cat.weight) || 0;
            changed = true;
            return { ...cat, ...deriveForKind(kind, liveAnalysis, maxScore) };
        });

        if (!changed) return sc;
        anyChanged = true;
        return {
            ...sc,
            categoryBreakdown,
            overallScore: recomputeOverallScore(categoryBreakdown, Number(sc.overallScore) || 0),
        };
    });

    if (!anyChanged) return result;

    return {
        ...result,
        scorecards,
        overallWeightedScore: recomputeCrossTypeScore(scorecards, Number(result.overallWeightedScore) || 0),
    };
}
