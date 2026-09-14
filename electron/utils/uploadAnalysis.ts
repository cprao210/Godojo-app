// electron/utils/uploadAnalysis.ts
// Local (uploaded-transcript) call analysis, aligned BEHAVIOURALLY with the
// FastAPI backend's live-analysis pipeline (app/agents/live_analysis +
// app/ml/objection_classifier) — but computed fully on-frontend: uploads never
// call the backend. Everything the backend guarantees after its validate
// chain is reproduced here deterministically:
//   • NO QUOTE = NO STATUS (confirmed/partial with empty evidence → missing)
//   • suggested_question only for missing/partial, '' for confirmed, generic
//     fallbacks so every open field has a next-best question
//   • objection enums + 10-category taxonomy (unknown → needs_review, like a
//     classifier miss) + sameQuote dedupe + stableId stamping
//   • signal_type filtered against the backend catalogue (empty → drop)
//   • dealOptimizer hard-gated on the negotiation flag (mirrors the backend's
//     `if not deal_optimizer: d["dealOptimizer"] = []`), triggers validated
//   • 300-char sentence-boundary clamps on evidence/quotes; objection quotes
//     deliberately unclamped (whole-thought quoting).
// The live path keeps consuming the backend endpoints untouched.

import { DealOptimizerAlert, LiveAnalysisData, Objection, Signal } from '../../src/types';
import { stableId } from '../../src/lib/objections';
import {
    clampEvidence,
    DEAL_TRIGGERS,
    EVIDENCE_MAX_CHARS,
    FALLBACK_SUGGESTED_QUESTIONS,
    OBJECTION_CATEGORY_LABELS,
    OBJECTION_REVIEW_THRESHOLD,
    sameQuote,
    signalCategoryForTypes,
    SIGNAL_TYPE_CATALOG,
    STATUS_EMOJI,
} from '../../src/lib/analysisTaxonomy';

type QualStatus = 'confirmed' | 'partial' | 'missing';

const BANT_KEYS = ['budget', 'authority', 'need', 'timeline'] as const;
const MEDDIC_KEYS = ['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'competition'] as const;

// ── Prompt ───────────────────────────────────────────────────────────────────

/**
 * System prompt for one-shot analysis of a full uploaded transcript.
 * `negotiation` mirrors the backend route exactly: the dealOptimizer section
 * is physically excluded from the prompt unless the call is flagged as a
 * negotiation (the modal's meeting-type chips), and the output contract has
 * no dealOptimizer key at all otherwise.
 */
export function buildUploadAnalysisPrompt(negotiation: boolean): string {
    const dealSection = negotiation
        ? `
SECTION 4: DEAL OPTIMIZER — negotiation intelligence. Populate "dealOptimizer" ONLY when you detect one or more of these triggers in PROSPECT speech; otherwise return an empty list.
TRIGGERS:
  pricing_objection     — pushes back on price, calls it "too expensive", challenges value-to-cost.
  discount_request      — explicitly asks for a discount / lower price / better deal, or cites a cheaper alternative.
  competitor_comparison — a competitor is cheaper or has better pricing/terms; implies leverage via alternatives.
  procurement_pressure  — procurement/legal/finance friction, vendor-comparison processes, formal RFP dynamics.
  budget_concern        — budget is tight, constrained, not yet approved, or less than the price discussed.
  closing_signal        — ready to move forward but a final price/term objection stands in the way.
RULES:
- NEVER recommend a discount as the first move. Explore value, differentiation, and leverage before ANY price concession.
- Any concession must be a mutually beneficial TRADE-OFF (longer contract, faster close, referral) — never a gift.
- moves: 1-3 concrete actions, ordered best-first, each under 20 words.
- anchor: one sentence the AE can say RIGHT NOW to reframe value, under 25 words; "" if not applicable.
- quote: the VERBATIM prospect sentence that triggered this — the narrowest span carrying the trigger, under 45 words, no speaker label.
- headline: one-line summary of what's happening, under 15 words. intensity: "high" | "medium" | "low".`
        : '';

    const dealField = negotiation
        ? `,
  "dealOptimizer": [
    { "trigger": "pricing_objection|discount_request|competitor_comparison|procurement_pressure|budget_concern|closing_signal", "quote": "verbatim prospect sentence", "headline": "under 15 words", "moves": ["1-3 actions, best-first"], "anchor": "optional reframe or empty string", "intensity": "high|medium|low" }
  ]`
        : '';

    return `You are an expert B2B sales analyst. A complete sales call transcript follows. Analyze it and return ONLY a valid JSON object — no markdown, no fences, no commentary.

SPEAKERS: the transcript may begin with a SPEAKER IDENTITY MAP naming each participant. The person marked as the sales representative is the "REP"; every other named speaker is PROSPECT speech. Rules below about "prospect speech" mean anything the prospect(s) said, never the REP.

{
  "bant": {
    "budget":    { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" },
    "authority": { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" },
    "need":      { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" },
    "timeline":  { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" }
  },
  "meddic": {
    "metrics":           { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" },
    "economic_buyer":    { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" },
    "decision_criteria": { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" },
    "decision_process":  { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" },
    "identify_pain":     { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" },
    "champion":          { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" },
    "competition":       { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "verbatim quote or empty string", "suggested_question": "string" }
  },
  "objections": [
    { "type": "customer_question|ae_deferral", "quote": "verbatim prospect (or AE) speech spanning the whole concern, no speaker label", "owner": "customer|ae", "status": "open|deferred", "suggested_answer": "rebuttal for customer_question, else empty string", "category": "budget_pricing|timing|authority|competitor|product_fit|trust_risk|contract_terms|technical_integration|need_to_think|other", "confidence": 0.0, "resolved": false }
  ],
  "signals": [
    { "quote": "verbatim prospect sentence", "signal_type": ["buying_intent|aspiration|engagement|validation_seeking|authority_signal|frustration|risk|urgency|competitor_signal|stall_signal|cost|process_signal|timeline"], "ask_now": "under 20 words", "intensity": "high|medium|low", "category": "positive|negative|neutral" }
  ]${dealField}
}

SECTION 1: BANT + MEDDIC
- "confirmed" = explicit, quotable evidence; "partial" = mentioned but incomplete; "missing" = no evidence.
- NO QUOTE = NO STATUS: a field may only be confirmed/partial if its "evidence" is a VERBATIM span from the transcript (narrowest span that proves it, under 45 words, no speaker label). Never paraphrase or fix grammar inside evidence.
- Each field gets its OWN evidence span. A sentence that proves one field does not become evidence for related fields; with no sentence specific to a field, that field stays "missing".
- Budget means money allocated/available to spend. A discount or price negotiation is NOT budget evidence.
- A named internal person who will drive or coordinate the rollout counts as "champion" at least "partial", even without explicit advocacy.
- suggested_question: populate for BOTH "missing" AND "partial", under 15 words, referencing something specific from this call — for "missing" a question that surfaces the signal from scratch; for "partial" a question that CONFIRMS or upgrades it by pinning down the exact missing detail (a number, a name, a date). "" ONLY when status is "confirmed": never ask for information the transcript already establishes.

SECTION 2: OBJECTIONS
- "customer_question" = any unresolved customer pushback, phrased as a question OR a statement — a question mark is NOT required. Covers: specific unresolved questions, stated concerns/doubts/risks, price/value pushback, timing/priority pushback, disagreement with the premise. A flat statement of doubt IS an objection. Skip small talk.
- "ae_deferral" = ONLY when the REP commits to a specific deliverable (not vague "I'll send that over"); owner "ae", status "deferred", suggested_answer "".
- owner is "customer" for customer_question; "status": "open" unless an ae_deferral.
- suggested_answer: only for customer_question — a direct, confident 1-2 sentence rebuttal specific to this call, under 40 words. Never generic filler ("integrates seamlessly", "we understand your concern").
- ONE ENTRY PER CONCERN: a concern reworded or re-argued later is the SAME objection — do not duplicate it; quote the WHOLE thought (one entry spanning all sub-points of one enumerated burst).
- category: choose exactly one of the 10 ids above that best captures the substance of the concern. confidence: your own certainty 0.0-1.0. resolved: true ONLY when the transcript later answers or moots that same concern.

SECTION 3: SIGNALS
- Only from prospect speech. signal_type values ONLY from the catalogue in the schema above (use an array; usually 1-2 values).
- category: "positive" for buying_intent/aspiration/engagement/validation_seeking/authority_signal, "negative" for frustration/risk/urgency/competitor_signal/stall_signal, "neutral" for cost/process_signal/timeline.
- intensity: high = explicit, act now | medium = implied but clear | low = background only. ask_now: the best next question/action for this exact moment, under 20 words. Order signals most-recently-detected first.${dealSection}

Return raw JSON only.`;
}

// ── Normalization ────────────────────────────────────────────────────────────

function normalizeQual(raw: any, key: string): LiveAnalysisData['bant']['budget'] {
    let status: QualStatus = raw?.status === 'confirmed' || raw?.status === 'partial' ? raw.status : 'missing';
    const evidence = typeof raw?.evidence === 'string' ? raw.evidence.trim() : '';
    // NO QUOTE = NO STATUS (mirror of require_evidence): an unevidenced claim
    // collapses to missing — the same way the backend downgrades it.
    if (status !== 'missing' && !evidence) status = 'missing';
    let question = typeof raw?.suggested_question === 'string' ? raw.suggested_question.trim() : '';
    // A confirmed metric never carries an ask-this recommendation.
    if (status === 'confirmed') question = '';
    // …and every still-open field always does (ensure_suggested_questions).
    else if (!question) question = FALLBACK_SUGGESTED_QUESTIONS[key] ?? '';
    return {
        emoji: STATUS_EMOJI[status],
        status,
        evidence: clampEvidence(evidence),
        suggested_question: question,
    };
}

function normalizeObjection(raw: any): Objection | null {
    const quote = typeof raw?.quote === 'string' ? raw.quote.trim() : '';
    if (!quote) return null;
    const type = raw?.type === 'ae_deferral' ? 'ae_deferral' : 'customer_question';
    // Only ae_deferral may be AE-owned; every customer_question is customer-owned.
    const owner: 'customer' | 'ae' = type === 'ae_deferral' && raw?.owner === 'ae' ? 'ae' : 'customer';
    const status = raw?.status === 'deferred' ? 'deferred' : 'open';
    const suggested_answer = type === 'customer_question' && typeof raw?.suggested_answer === 'string'
        ? raw.suggested_answer.trim()
        : '';
    // Classifier-miss semantics: an unknown category id → '' + needs_review,
    // exactly like the backend's 0.55 threshold path.
    const category = typeof raw?.category === 'string' ? raw.category.trim().toLowerCase() : '';
    const known = Object.prototype.hasOwnProperty.call(OBJECTION_CATEGORY_LABELS, category);
    let confidence = Number(raw?.confidence);
    if (!Number.isFinite(confidence) || confidence < 0) confidence = 0;
    else if (confidence > 1) confidence = 1;
    return {
        type,
        quote,
        owner,
        status,
        suggested_answer,
        id: stableId(quote),
        category: known ? category : '',
        category_label: known ? OBJECTION_CATEGORY_LABELS[category] : '',
        confidence: known ? confidence : 0,
        needs_review: !known || confidence < OBJECTION_REVIEW_THRESHOLD,
        resolved: raw?.resolved === true,
    };
}

function normalizeSignal(raw: any): Signal | null {
    const quote = typeof raw?.quote === 'string' ? raw.quote.trim() : '';
    if (!quote) return null;
    const requested: string[] = Array.isArray(raw?.signal_type)
        ? raw.signal_type.map((t: any) => String(t).trim().toLowerCase())
        : [];
    const types = [...new Set(requested.filter((t: string) => SIGNAL_TYPE_CATALOG.has(t)))];
    if (types.length === 0) return null;
    const intensity = raw?.intensity === 'high' || raw?.intensity === 'low' ? raw.intensity : 'medium';
    return {
        quote: clampEvidence(quote),
        signal_type: types,
        ask_now: typeof raw?.ask_now === 'string' ? raw.ask_now.trim() : '',
        intensity,
        category: signalCategoryForTypes(types),
        id: stableId(quote),
    };
}

function normalizeDealAlert(raw: any): DealOptimizerAlert | null {
    const quote = typeof raw?.quote === 'string' ? raw.quote.trim() : '';
    if (!quote || !DEAL_TRIGGERS.includes(raw?.trigger)) return null;
    const moves = Array.isArray(raw?.moves)
        ? raw.moves.map((m: any) => String(m).trim()).filter(Boolean).slice(0, 3)
        : [];
    return {
        trigger: raw.trigger,
        quote: clampEvidence(quote),
        headline: typeof raw?.headline === 'string' ? raw.headline.trim() : '',
        moves,
        anchor: typeof raw?.anchor === 'string' ? raw.anchor.trim() : '',
        intensity: raw?.intensity === 'high' || raw?.intensity === 'low' ? raw.intensity : 'medium',
        id: stableId(quote),
    };
}

/**
 * Deterministically coerce raw model JSON into the exact shape the backend
 * would have emitted after its validate chain. Safe to call on any parsed
 * object; missing keys degrade to backend defaults rather than throwing.
 * `negotiation` is the hard gate for dealOptimizer — an alert-free contract
 * even if the model hallucinates the key, mirroring the server-side gate.
 */
export function normalizeUploadAnalysis(raw: any, negotiation: boolean): LiveAnalysisData {
    const bant: any = {};
    for (const key of BANT_KEYS) bant[key] = normalizeQual(raw?.bant?.[key], key);
    const meddic: any = {};
    for (const key of MEDDIC_KEYS) meddic[key] = normalizeQual(raw?.meddic?.[key], key);

    // Dedupe by same_quote (case/whitespace-insensitive), first occurrence wins.
    const objections: Objection[] = [];
    for (const entry of Array.isArray(raw?.objections) ? raw.objections : []) {
        const o = normalizeObjection(entry);
        if (!o) continue;
        if (objections.some(existing => sameQuote(existing.quote, o.quote))) continue;
        objections.push(o);
    }

    const signals: Signal[] = [];
    for (const entry of Array.isArray(raw?.signals) ? raw.signals : []) {
        const s = normalizeSignal(entry);
        if (!s) continue;
        if (signals.some(existing => sameQuote(existing.quote, s.quote))) continue;
        signals.push(s);
    }

    const dealOptimizer: DealOptimizerAlert[] = [];
    if (negotiation) {
        for (const entry of Array.isArray(raw?.dealOptimizer) ? raw.dealOptimizer : []) {
            const d = normalizeDealAlert(entry);
            if (!d) continue;
            if (dealOptimizer.some(existing => sameQuote(existing.quote, d.quote))) continue;
            dealOptimizer.push(d);
        }
    }

    return { bant, meddic, objections, signals, dealOptimizer };
}
