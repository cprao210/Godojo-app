// src/lib/analysisTaxonomy.ts
// Single source of truth for the intelligence vocabularies that BOTH the
// live analysis pipeline and the local (uploaded-transcript) analysis speak.
// These mirror the FastAPI backend exactly — app/agents/live_analysis/{schema,
// validators}.py and app/ml/objection_classifier/seed_data.py — so every
// surface (live overlay, post-call Analysis tab, scorecard grounding,
// dashboard grouping) sees identical enums regardless of how the analysis was
// produced. Pure constants + tiny helpers only; no runtime import of @/types
// (import type is erased), so Electron main can safely require() this file.

/**
 * Objection classifier taxonomy — id → display label, verbatim from
 * seed_data.py's CATEGORY_LABELS. The backend assigns these with an embedding
 * nearest-neighbour classifier; the local upload analysis assigns them with
 * the analysis model, and normalizeUploadAnalysis validates the id against
 * this map — an unknown id becomes '' + needs_review, exactly like a
 * classifier miss on the backend.
 */
export const OBJECTION_CATEGORY_LABELS: Record<string, string> = {
    budget_pricing: 'Budget / Pricing',
    timing: 'Timing',
    authority: 'Authority',
    competitor: 'Competitor',
    product_fit: 'Product Fit',
    trust_risk: 'Trust / Risk',
    contract_terms: 'Contract Terms',
    technical_integration: 'Technical / Integration',
    need_to_think: 'Need to Think',
    other: 'Other',
};

/** Similarity floor below which the backend classifier sets needs_review. */
export const OBJECTION_REVIEW_THRESHOLD = 0.55;

/**
 * Signal type catalogue — validators.py SIGNAL_TYPES. Anything outside this
 * set is stripped from signal_type, and a signal left with zero valid types
 * is dropped entirely.
 */
export const SIGNAL_TYPE_POSITIVE: readonly string[] = ['buying_intent', 'aspiration', 'engagement', 'validation_seeking', 'authority_signal'];
export const SIGNAL_TYPE_NEGATIVE: readonly string[] = ['frustration', 'risk', 'urgency', 'competitor_signal', 'stall_signal'];
export const SIGNAL_TYPE_NEUTRAL: readonly string[] = ['cost', 'process_signal', 'timeline'];
export const SIGNAL_TYPE_CATALOG: ReadonlySet<string> = new Set([
    ...SIGNAL_TYPE_POSITIVE,
    ...SIGNAL_TYPE_NEGATIVE,
    ...SIGNAL_TYPE_NEUTRAL,
]);

/** A signal's positive/negative/neutral category, derived from its types. */
export function signalCategoryForTypes(types: readonly string[]): 'positive' | 'negative' | 'neutral' {
    if (types.some(t => SIGNAL_TYPE_POSITIVE.includes(t))) return 'positive';
    if (types.some(t => SIGNAL_TYPE_NEGATIVE.includes(t))) return 'negative';
    return 'neutral';
}

/** Deal Optimizer trigger enum (live_analysis schema.py DealTrigger). */
export const DEAL_TRIGGERS: readonly string[] = [
    'pricing_objection',
    'discount_request',
    'competitor_comparison',
    'procurement_pressure',
    'budget_concern',
    'closing_signal',
];

/**
 * Generic per-field fallback questions — verbatim from the backend's
 * ensure_suggested_questions (validators.py). Applied whenever a partial or
 * missing field came back without a suggested_question, so the panel always
 * has a next-best question. Confirmed fields NEVER receive one.
 */
export const FALLBACK_SUGGESTED_QUESTIONS: Record<string, string> = {
    budget: 'Do you have a budget allocated for this initiative?',
    authority: 'Who has final sign-off on this decision?',
    need: "What's the main problem you're hoping to solve?",
    timeline: 'What timeline are you working toward for a solution?',
    metrics: 'What outcomes or metrics would define success here?',
    economic_buyer: 'Who owns the budget for this purchase?',
    decision_criteria: 'What criteria will you use to evaluate options?',
    decision_process: 'What does your decision process look like from here?',
    identify_pain: "What's the core problem driving this search?",
    champion: 'Who internally is championing this initiative?',
    competition: 'Are you evaluating any other tools alongside us?',
};

/** Status → display emoji, matching the backend's enforced mapping. */
export const STATUS_EMOJI: Record<'confirmed' | 'partial' | 'missing', '✅' | '⚠️' | '❌'> = {
    confirmed: '✅',
    partial: '⚠️',
    missing: '❌',
};

/** Sentence-boundary clamp length (backend EVIDENCE_MAX_CHARS). */
export const EVIDENCE_MAX_CHARS = 300;

/**
 * Clamp to EVIDENCE_MAX_CHARS at the last sentence boundary, falling back to
 * a hard cut (mirrors validators.clamp_evidence). Objection quotes are
 * deliberately NOT clamped by callers — the backend prompt requires one quote
 * spanning every sub-point of an enumerated burst.
 */
export function clampEvidence(text: string): string {
    if (!text || text.length <= EVIDENCE_MAX_CHARS) return text;
    const window = text.slice(0, EVIDENCE_MAX_CHARS);
    const boundary = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
    );
    return boundary > 100 ? window.slice(0, boundary + 1).trim() : `${window.trim()}…`;
}

/** same_quote equivalence (backend runner): case/whitespace-insensitive equality. */
export function sameQuote(a: string, b: string): boolean {
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return norm(a) === norm(b);
}
