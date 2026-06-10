import { useState, useCallback, useRef, useEffect } from 'react';
import { LiveAnalysisData } from '../types/liveAnalysis';

// ─── Prompt builders ─────────────────────────────────────────────────────────
//
// Two distinct prompts:
//   1. getFirstRunPrompt  — used on the FIRST analysis only.
//      Receives the full prospect-only transcript and derives everything from scratch.
//
//   2. getRefreshPrompt   — used on every SUBSEQUENT analysis.
//      Receives:
//        • priorState  — the structured JSON output of the last run (~300 tokens).
//                        BANT/MEDDIC are updated incrementally from this base.
//        • deltaContext — only the NEW prospect turns since the last cursor position.
//                        SALES PERSON turns are excluded — they are scaffolding, not signal sources.
//      This keeps the prompt ~80% smaller than re-sending the full growing transcript,
//      preventing context-length failures on Groq and reducing latency/cost on all models.

// Serialise the BANT/MEDDIC state only — compact anchor for refresh runs.
const serializeBANTMEDDIC = (prior: LiveAnalysisData): string =>
  JSON.stringify({ bant: prior.bant, meddic: prior.meddic }, null, 2);

// Serialise objections + signals for the refresh preserve-and-append block.
// Cap at last 10 objections and 20 signals to prevent context bloat on long calls.
// The client-side merge guard will restore any dropped entries regardless.
const serializeObjectionsSignals = (prior: LiveAnalysisData): string =>
  JSON.stringify({
    objections: prior.objections.slice(-10),
    signals: prior.signals.slice(-20),
  }, null, 2);

// ── Urgent-signal trigger patterns (zero-cost regex check on new prospect turns) ──
// When any pattern matches a new transcript turn, runAnalysis fires immediately
// instead of waiting for the next timer tick. Gated by 60s cooldown + in-flight guard.
const URGENT_TRIGGER_PATTERNS = [
  /\bcompetitor\b|\bsalesforce\b|\bhubspot\b|\bmarketo\b|\boutreach\b|\bgong\b|\bchorus\b/i,
  /\blet'?s\s+move\s+forward\b|\bsend\s+(me\s+)?a?\s*proposal\b|\bready\s+to\s+sign\b/i,
  /\bcontract\s+expires?\b|\board\s+deadline\b|\blegal\s+(team\s+)?needs?\b/i,
  /\bnext\s+quarter\b|\bpausing\s+evaluations?\b|\bnot\s+in\s+a\s+rush\b/i,
  /\bbudget\s+(is\s+)?(approved|confirmed|allocated|set\s+aside)\b/i,
  /\bi\s+(can\s+)?approve\s+this\b|\bfinal\s+(call\s+)?is\s+mine\b/i,
];

const hasUrgentTrigger = (text: string): boolean =>
  URGENT_TRIGGER_PATTERNS.some(r => r.test(text));

// ── Shared output format + signal catalogue (reused verbatim in both prompts) ──
const SHARED_SIGNAL_CATALOGUE = `
    ── SIGNAL TYPES (use ALL that apply per signal, can be multiple) ──────────────────

    POSITIVE SIGNALS (category: "positive"):

    buying_intent
    → Direct or indirect indicators the prospect wants to move forward.
    → Triggers: "let's do this", "how do we get started", "can you send a proposal",
      "I want to move forward", "we're ready", "let's schedule next steps",
      asking about contract/pricing/timeline to start, asking to include others
      in next call, referencing internal approval steps as if already decided,
      comparing your product favourably to alternatives.

    aspiration
    → Prospect expresses a goal, vision, or outcome they want to achieve.
    → Triggers: "we want to become", "our goal is to", "we're trying to achieve",
      "we need to scale", "we're building toward", "ideally we'd", "the dream is",
      referencing growth targets, headcount plans, product roadmap goals,
      competitive positioning they want to reach.

    engagement
    → Prospect is actively engaged, curious, and invested in the conversation.
    → Triggers: asking detailed follow-up questions, requesting demos or trials,
      asking to loop in colleagues, taking notes ("let me write that down"),
      referencing prior conversations accurately, spending more time than planned,
      asking about edge cases or advanced features — signals deep evaluation.

    validation_seeking
    → Prospect is looking for reassurance or social proof before committing.
    → Triggers: "do other companies like ours use this?", "what's the typical ROI?",
      "can you share case studies?", "have you worked with [competitor's client]?",
      "who else in our industry uses this?", asking for references or testimonials.
      This is a POSITIVE signal — they are doing pre-close due diligence.

    authority_signal
    → Prospect reveals or implies they have decision-making power.
    → Triggers: "I can approve this", "I'll take this to my team", "the final call is mine",
      "I've done this before at my last company", mentioning budget ownership,
      describing past purchasing decisions they made.

    NEGATIVE SIGNALS (category: "negative"):

    frustration
    → Prospect expresses dissatisfaction, impatience, or friction — about current tools,
      processes, vendors, or the sales conversation itself.
    → Triggers: "this is really painful", "we've been dealing with this for months",
      "our current tool doesn't", "I'm frustrated with", "we keep running into",
      "it's a mess", "nothing works the way we need it to", sighing or expressing
      exhaustion about current state, complaining about past vendor experiences.

    risk
    → Prospect raises concerns, doubts, or obstacles that could block or delay the deal.
    → Triggers: "I'm not sure if", "we're worried about", "our legal team will ask",
      "there could be pushback from", "we've had issues with implementations like this",
      "what if it doesn't work", "we had a bad experience with", mentioning
      security/compliance requirements, expressing concern about switching costs,
      data migration complexity, or organisational change management.

    urgency
    → External deadlines or pressure creating urgency that could stall or accelerate.
    → Triggers: "our contract with [vendor] expires", "we have a board deadline",
      "our team is blocked until we solve this", "we're already behind",
      "we need this yesterday", "leadership is asking about this weekly".

    competitor_signal
    → Prospect mentions alternative vendors, current tools, or is running a parallel evaluation.
    → Triggers: "we're also looking at", "we currently use", "we evaluated X",
      "how do you compare to", "X does this differently", "our board prefers X",
      naming any specific competitor or incumbent tool directly or by implication.
      CRITICAL: always capture this — it affects deal strategy immediately.

    stall_signal
    → Prospect is deprioritising, delaying, or showing low urgency in a way that risks deal loss.
    → Triggers: "let's revisit this next quarter", "we have a lot going on right now",
      "I need to check with more people", "we're not in a rush", "budget is uncertain",
      "we're pausing evaluations for now", vague next steps, non-committal language
      about timing or follow-up.

    NEUTRAL / INFORMATIONAL SIGNALS (category: "neutral"):

    cost
    → Any discussion of price, budget, ROI, cost comparison, or financial justification.

    process_signal
    → Prospect reveals internal decision-making process, stakeholders, or evaluation criteria.

    timeline
    → Any statement revealing when the prospect wants or needs to be live.

    ── DETECTION RULES ───────────────────────────────────────────────────────────────

    1. Source: prospect speech only. SALES PERSON lines are never signal sources.
    2. Quality bar: only capture a signal if the quote is specific enough that a sales
       rep could act on it RIGHT NOW. Ask yourself: would a sales manager say
       "I need to know about that"? Generic pleasantries, filler, or vague
       acknowledgment do NOT qualify. When in doubt, omit.
    3. Implied signals count when the implication is clear — "We've been on our current
       tool for 5 years" → stall_signal + competitor_signal (clear implication).
       But "sounds interesting" does NOT → engagement (too weak to act on).
    4. One quote can carry MULTIPLE signal_type values. Prefer 1–2 types per signal;
       use more only when each type is genuinely present in the same quote.
    5. Quote length: prefer the shortest fragment that still carries the meaning.
       Maximum 25 words. Truncate with "…" if necessary.
    6. ask_now must be under 20 words, directly triggered by THIS specific quote.
       BAD:  "Can you tell me more about your timeline?" (generic)
       BAD:  "What's your timeline for this decision?" (generic)
       GOOD: "When does your contract with Salesforce expire exactly?" (quote-grounded)
       GOOD: "Is Sarah the economic buyer, or does the CFO still need to sign off?" (grounded)
    7. Intensity calibration:
       "high"   → Explicit, named, unmistakable. Act on it this minute.
       "medium" → Implied but clear. Worth a targeted follow-up question.
       "low"    → Background context only. Only assign when "medium" clearly does not fit.
    8. Sort order: high-intensity signals first, then medium, then low.
    9. APPEND ONLY — never remove or overwrite prior signals between analysis runs.`;

const SHARED_BANT_MEDDIC_FIELD_RULES = `
    For each field return exactly four properties:

    - emoji:    "✅" confirmed | "⚠️" partial | "❌" missing
    - status:   "confirmed" | "partial" | "missing"
    - evidence: Exact quote or closest paraphrase. Maximum 120 characters.
                Prefer the fragment with the most specific signal (numbers, names, dates).
                Truncate with "…" if needed. Return "" if missing.
    - suggested_question: ONLY when status is "missing". Under 15 words. Must reference
                something specific from THIS call (a name, product, topic already mentioned).
                BAD: "What's your budget for this project?" (generic)
                GOOD: "What's the budget range for the Salesforce replacement?" (call-grounded)
                Return "" if status is confirmed or partial.

    STATUS DECISION RULE — apply in this order:
      "confirmed" → Prospect stated it directly, without qualification.
                    Example: "Our budget is $80k" / "I make the final call" / "We need this by Q3."
      "partial"   → Prospect implied it with enough specificity to be useful,
                    OR confirmed part of the field but not all.
                    Example: "We have budget set aside for this" (no number) → partial budget.
                    Example: "I'd need to loop in our CFO" (CFO confirmed, process implied) → partial authority.
      "missing"   → No meaningful signal exists. Do not assign partial out of optimism.`;

const SHARED_OUTPUT_FORMAT = `
    ═══════════════════════════════════════
    OUTPUT FORMAT
    ═══════════════════════════════════════

    {
        "bant": {
            "budget":    { "emoji": "", "status": "", "evidence": "", "suggested_question": "" },
            "authority": { "emoji": "", "status": "", "evidence": "", "suggested_question": "" },
            "need":      { "emoji": "", "status": "", "evidence": "", "suggested_question": "" },
            "timeline":  { "emoji": "", "status": "", "evidence": "", "suggested_question": "" }
        },
        "meddic": {
            "metrics":           { "emoji": "", "status": "", "evidence": "", "suggested_question": "" },
            "economic_buyer":    { "emoji": "", "status": "", "evidence": "", "suggested_question": "" },
            "decision_criteria": { "emoji": "", "status": "", "evidence": "", "suggested_question": "" },
            "decision_process":  { "emoji": "", "status": "", "evidence": "", "suggested_question": "" },
            "identify_pain":     { "emoji": "", "status": "", "evidence": "", "suggested_question": "" },
            "champion":          { "emoji": "", "status": "", "evidence": "", "suggested_question": "" },
            "competition":       { "emoji": "", "status": "", "evidence": "", "suggested_question": "" }
        },
        "objections": [
            { "type": "", "quote": "", "owner": "", "status": "" }
        ],
        "signals": [
            { "quote": "", "signal_type": [], "ask_now": "", "intensity": "", "category": "" }
        ]
    }

    ── FINAL CHECK BEFORE OUTPUT ──────────────────────────────────────────────────
    Valid JSON only. No prose, no markdown, no code fences.
    All four top-level keys must be present: bant, meddic, objections, signals.
    Every BANT and MEDDIC field must have: emoji, status, evidence, suggested_question.
    Every signal must have: quote, signal_type (array), ask_now, intensity, category.
    Every objection must have: type, quote, owner, status.`;

// ── PROMPT 1: First run — full transcript, derive everything from scratch ──────
const getFirstRunPrompt = (fullProspectContext: string): string =>
  `You are an expert real-time sales intelligence engine analyzing a live sales call transcript. Your job is to extract structured insights across four areas: BANT, MEDDIC, Objections, and Buying Signals. Return ONLY valid JSON. No explanation, no markdown, no text outside the JSON object.

    ═══════════════════════════════════════
    RULES
    ═══════════════════════════════════════

    Derive ALL fields from the CLIENT TRANSCRIPT below:
    → bant        — scan every client turn for Budget, Authority, Need, Timeline signals
    → meddic      — scan every client turn for MEDDIC signals
    → objections  — capture customer questions and AE deferrals
    → signals     — only capture signals where the quote is specific enough that a sales rep could act on it RIGHT NOW

    ═══════════════════════════════════════
    SECTION 1: BANT
    ═══════════════════════════════════════
${SHARED_BANT_MEDDIC_FIELD_RULES}

    Budget    → Money mentioned, approval thresholds, "we have budget", "we're looking at X"
    Authority → Decision-maker named, approval chain mentioned, "I need sign-off from", "our CFO decides"
    Need      → Problem stated, current pain, why they're looking, "we need", "we're trying to"
    Timeline  → Deadlines, urgency, "we need this by", "our Q3 goal", "we're hoping to launch"

    ═══════════════════════════════════════
    SECTION 2: MEDDIC
    ═══════════════════════════════════════

    Same structure as BANT: emoji + status + evidence + suggested_question per field.
    Apply the same STATUS DECISION RULE above.

    Metrics          → Quantified outcomes, ROI, KPIs, "reduce by X%", "save X hours", "increase revenue"
    Economic Buyer   → Who owns the budget/final yes, "our CFO", "VP of Finance signs off"
    Decision Criteria→ What they're evaluating on, "we need it to integrate with", "most important to us is"
    Decision Process → How they decide, "we do a POC", "we need legal review", "committee votes"
    Identify Pain    → Core problem driving the search, inefficiency, risk, or cost they're trying to fix
    Champion         → Internal sponsor, "I've been pushing for this", "I'm going to present this to"
    Competition      → Other vendors mentioned, "we're also looking at", "our current tool", "compared to"

    ═══════════════════════════════════════
    SECTION 3: OBJECTIONS
    ═══════════════════════════════════════

    Two types only:

    TYPE A — Customer Questions (open or unanswered)
    Capture questions the customer asked that were not fully resolved in the call so far.
    Minimum bar: the question must be specific enough that knowing the answer would affect
    the deal. Omit clarifying small-talk ("what time zone are you in?").

    TYPE B — AE Deferrals (follow-up commitments made by the AE)
    Capture ONLY when the AE commits to a SPECIFIC deliverable:
      CAPTURE: "I'll get you the security questionnaire response by Friday"
      CAPTURE: "I'll set up a call with our solutions engineer for the integration walkthrough"
      SKIP:    "I'll send that over" — no identifiable item
      SKIP:    "Let me follow up on that" — filler
    Test: could a sales manager read this and know exactly what needs to be done? If no, skip it.

    For each objection:
    - type:   "customer_question" | "ae_deferral"
    - quote:  Exact quote or tight one-line paraphrase (max 120 chars)
    - owner:  "customer" | "ae"
    - status: "open" | "deferred"

    ═══════════════════════════════════════
    SECTION 4: SIGNALS
    ═══════════════════════════════════════

    Detect meaningful signals in the conversation — positive buying signals,
    negative risk signals, and neutral informational signals that affect deal outcome.
    Apply the quality bar: only capture what a sales rep could act on RIGHT NOW.
${SHARED_SIGNAL_CATALOGUE}
${SHARED_OUTPUT_FORMAT}

    ═══════════════════════════════════════
    CLIENT TRANSCRIPT (client turns only — full call so far):
    ═══════════════════════════════════════
${fullProspectContext}
`;

// ── PROMPT 2: Refresh run — prior state + new prospect delta only ─────────────
const getRefreshPrompt = (
  priorState: LiveAnalysisData,
  newProspectDelta: string
): string =>
  `You are an expert real-time sales intelligence engine updating a live analysis mid-call. Return ONLY valid JSON. No explanation, no markdown, no text outside the JSON object.

    ═══════════════════════════════════════
    TASK
    ═══════════════════════════════════════

    You have:
      (A) NEW CLIENT TURNS — new prospect speech since the last analysis (your primary input).
      (B) PRIOR ANALYSIS   — the structured baseline to update from. Must be preserved exactly.

    ═══════════════════════════════════════
    (A) NEW CLIENT TURNS (process these first):
    ═══════════════════════════════════════
${newProspectDelta || '(no new prospect turns since last analysis)'}

    ═══════════════════════════════════════
    WHAT TO DO WITH EACH SECTION:
    ═══════════════════════════════════════

    BANT + MEDDIC — UPDATE INCREMENTALLY:
    → Use (B) PRIOR ANALYSIS values as your baseline.
    → Scan NEW CLIENT TURNS for evidence that changes a field.
    → Upgrade status if new turns confirm or extend a partial/missing field.
    → Update evidence if new turns contain a better, more specific quote (max 120 chars).
    → Do NOT downgrade a confirmed field unless the prospect explicitly retracts it.
    → If no new evidence for a field, copy it EXACTLY from PRIOR ANALYSIS unchanged.

    OBJECTIONS — MANDATORY COPY-THEN-APPEND:
    Step 1: Copy the ENTIRE prior objections array below VERBATIM into your output.
    Step 2: Append NEW objections found only in NEW CLIENT TURNS.
    DO NOT regenerate, deduplicate, or summarize prior objections. Copy them as-is.
    If your output has fewer objections than ${priorState.objections.length} (prior count), it is WRONG.

    SIGNALS — MANDATORY COPY-THEN-APPEND:
    Step 1: Copy the ENTIRE prior signals array below VERBATIM into your output.
    Step 2: Append NEW signals found only in NEW CLIENT TURNS. Apply the quality bar.
    DO NOT regenerate, deduplicate, or summarize prior signals. Copy them as-is.
    If your output has fewer signals than ${priorState.signals.slice(-20).length} (prior count), it is WRONG.

    ═══════════════════════════════════════
    (B) PRIOR ANALYSIS — BANT + MEDDIC BASELINE (update from this):
    ═══════════════════════════════════════
${serializeBANTMEDDIC(priorState)}

    ═══════════════════════════════════════
    (B) PRIOR ANALYSIS — OBJECTIONS + SIGNALS (copy verbatim first, then append new):
    ═══════════════════════════════════════
${serializeObjectionsSignals(priorState)}

    ═══════════════════════════════════════
    BANT + MEDDIC field rules:
    ═══════════════════════════════════════
${SHARED_BANT_MEDDIC_FIELD_RULES}

    ═══════════════════════════════════════
    SIGNAL reference:
    ═══════════════════════════════════════
${SHARED_SIGNAL_CATALOGUE}
${SHARED_OUTPUT_FORMAT}
`;



// ─── Anthropic API fallback (used when electronAPI is not available) ─────────
const runAnalysisViaAnthropicAPI = async (livePrompt: string): Promise<LiveAnalysisData> => {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: livePrompt }],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const rawText: string = (data.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('');

  let jsonStr = rawText.trim();
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) jsonStr = jsonMatch[1];
  return JSON.parse(jsonStr) as LiveAnalysisData;
};

// ─── Client-side merge guard ──────────────────────────────────────────────────
// Protects against two failure modes regardless of which prompt was used:
//   1. Objections/signals dropped by the LLM under token pressure (append guard).
//   2. BANT/MEDDIC status regressed to "missing" when the LLM had no new evidence
//      and hallucinated a downgrade instead of copying from prior state (status guard).
const isSimilar = (a: string, b: string): boolean => {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const ca = clean(a);
  const cb = clean(b);
  if (ca === cb) return true;
  // One is a substring of the other (covers paraphrasing)
  if (ca.length > 10 && (ca.includes(cb.substring(0, 20)) || cb.includes(ca.substring(0, 20)))) return true;
  return false;
};

// Status rank: higher index = stronger confirmation. Never allow a merge to move left.
const STATUS_RANK: Record<string, number> = { missing: 0, partial: 1, confirmed: 2 };

const guardBANTField = (
  incoming: import('../types/liveAnalysis').BANTField,
  prior: import('../types/liveAnalysis').BANTField
): import('../types/liveAnalysis').BANTField => {
  const incomingRank = STATUS_RANK[incoming.status] ?? 0;
  const priorRank = STATUS_RANK[prior.status] ?? 0;
  // If the new result regressed (e.g. confirmed → missing), restore prior
  if (incomingRank < priorRank) return prior;
  return incoming;
};

const guardMEDDICField = (
  incoming: import('../types/liveAnalysis').MEDDICField,
  prior: import('../types/liveAnalysis').MEDDICField
): import('../types/liveAnalysis').MEDDICField => {
  const incomingRank = STATUS_RANK[incoming.status] ?? 0;
  const priorRank = STATUS_RANK[prior.status] ?? 0;
  if (incomingRank < priorRank) return prior;
  return incoming;
};

const mergeWithPrior = (
  incoming: LiveAnalysisData,
  prior: LiveAnalysisData | null
): LiveAnalysisData => {
  if (!prior) return incoming;

  // ── BANT/MEDDIC: apply status regression guard ────────────────────────────
  // On a refresh run the LLM was asked to copy unchanged fields from priorState.
  // If it regressed a field (confirmed → missing) due to low confidence or
  // truncation, restore the prior value. This is a safety net — the prompt
  // should handle this in the vast majority of cases.
  const bant = {
    budget: guardBANTField(incoming.bant.budget, prior.bant.budget),
    authority: guardBANTField(incoming.bant.authority, prior.bant.authority),
    need: guardBANTField(incoming.bant.need, prior.bant.need),
    timeline: guardBANTField(incoming.bant.timeline, prior.bant.timeline),
  };

  const meddic = {
    metrics: guardMEDDICField(incoming.meddic.metrics, prior.meddic.metrics),
    economic_buyer: guardMEDDICField(incoming.meddic.economic_buyer, prior.meddic.economic_buyer),
    decision_criteria: guardMEDDICField(incoming.meddic.decision_criteria, prior.meddic.decision_criteria),
    decision_process: guardMEDDICField(incoming.meddic.decision_process, prior.meddic.decision_process),
    identify_pain: guardMEDDICField(incoming.meddic.identify_pain, prior.meddic.identify_pain),
    champion: guardMEDDICField(incoming.meddic.champion, prior.meddic.champion),
    competition: guardMEDDICField(incoming.meddic.competition, prior.meddic.competition),
  };

  // ── Objections/Signals: preserve-and-append guard ─────────────────────────
  // Even with explicit prompt instructions, a model switch or token pressure
  // can cause prior entries to be dropped. This is the final safety net.
  const mergedObjections = [...prior.objections];
  for (const obj of incoming.objections) {
    const alreadyPresent = mergedObjections.some(p => isSimilar(p.quote, obj.quote));
    if (!alreadyPresent) mergedObjections.push(obj);
  }

  const mergedSignals = [...prior.signals];
  for (const sig of incoming.signals) {
    const alreadyPresent = mergedSignals.some(p => isSimilar(p.quote, sig.quote));
    if (!alreadyPresent) mergedSignals.push(sig);
  }

  return {
    bant,
    meddic,
    objections: mergedObjections,
    signals: mergedSignals,
  };
};

export const useLiveAnalysis = (
  transcriptRef: React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>,
  isMeetingPaused: boolean,
  companyIntel?: Record<string, any> | null
) => {
  const [analysisData, setAnalysisData] = useState<LiveAnalysisData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the currently in-flight (or most recent) run was a refresh run.
  // Used by the UI to show "Refreshing…" vs "Analysing…" in the header.
  const [isRefreshRun, setIsRefreshRun] = useState(false);
  // Ref-based in-flight guard — avoids stale closure issues that a state-based check would have.
  const isLoadingRef = useRef(false);
  // Cursor: index into the FILTERED humanTurns array (system/ai/assistant/model excluded)
  // of the last entry included in the previous analysis run.
  // IMPORTANT: this must track humanTurns indices, NOT raw transcript.length, because
  // humanTurns is a filtered subset and slicing it with a raw-transcript cursor skips
  // all new turns (deltaStartIndex >= humanTurns.length), producing an empty delta and
  // stale live analysis on every refresh run.
  const lastAnalyzedIndexRef = useRef<number>(0);
  // Mirror of analysisData in a ref so the merge helper inside runAnalysis can read it
  // without a stale closure (useCallback deps would force re-creating on every render).
  const analysisDataRef = useRef<LiveAnalysisData | null>(null);
  // Timestamp of last completed analysis — used by the urgent-trigger cooldown.
  const lastAnalysisTimeRef = useRef<number>(0);
  // Cursor for urgent-trigger scanning — avoids re-scanning already-checked turns.
  const lastTriggerScanIndexRef = useRef<number>(0);

  const companyIntelRef = useRef<Record<string, any> | null | undefined>(companyIntel);
  useEffect(() => {
    companyIntelRef.current = companyIntel;
  }, [companyIntel]);

  // Keep ref in sync with state so the runAnalysis closure always sees the latest value.
  const setAnalysisDataAndRef = useCallback((data: LiveAnalysisData | null) => {
    analysisDataRef.current = data;
    setAnalysisData(data);
  }, []);

  const buildCompanyBlock = (intel: Record<string, any> | null | undefined): string => {
    if (!intel) return '';
    const v = (x: any) => x && x !== 'null' && x !== 'N/A' ? x : null;
    const lines = [
      '═══════════════════════════════════════',
      'CLIENT COMPANY CONTEXT (from pre-call research)',
      '═══════════════════════════════════════',
    ];
    if (v(intel.companyName)) lines.push(`Company: ${intel.companyName}`);
    if (v(intel.industry)) lines.push(`Industry: ${intel.industry}`);
    if (v(intel.businessModel)) lines.push(`Business Model: ${intel.businessModel}`);
    if (v(intel.employeeCount)) lines.push(`Employees: ${intel.employeeCount}`);
    if (intel.keyProducts?.length) lines.push(`Products: ${intel.keyProducts.slice(0, 4).join(', ')}`);
    if (intel.competitors?.length) lines.push(`Competitors (known): ${intel.competitors.slice(0, 4).join(', ')}`);
    if (intel.topCustomers?.length) lines.push(`Top Customers: ${intel.topCustomers.slice(0, 3).join(', ')}`);
    if (intel.recentNews?.length) lines.push(`Recent News: ${intel.recentNews[0].headline}`);
    lines.push('Use this context to enrich signal detection — e.g. recognise known competitors, validate product fit, identify relevant pain points.');
    lines.push('═══════════════════════════════════════');
    return lines.join('\n');
  };

  const runAnalysis = useCallback(async (force = false) => {
    const transcript = transcriptRef.current;
    if (!transcript?.length || (!force && isMeetingPaused)) return;

    if (isLoadingRef.current) {
      console.warn('[useLiveAnalysis] Analysis already in-flight, skipping duplicate call.');
      return;
    }

    isLoadingRef.current = true;
    setIsLoading(true);
    setError(null);

    let resultCleanup: (() => void) | undefined;
    let errorCleanup: (() => void) | undefined;

    // Snapshot cursor and prior state at call time to avoid stale closures
    const priorState = analysisDataRef.current;

    try {
      // ── Build transcript strings ─────────────────────────────────────
      // Format a prospect turn for the prompt.
      // displayName gives the LLM real speaker identity for accurate signal attribution.
      const formatProspectTurn = (t: { speaker: string; displayName?: string; text: string }) => {
        const name = t.displayName && t.displayName !== "Them" ? ` (${t.displayName})` : '';
        return `CLIENT${name}: ${t.text}`;
      };

      // Exclude internal system/AI turns from all paths.
      // NOTE: deltaStartIndex and currentEndIndex are computed AFTER humanTurns is built so
      // both the cursor and the slice operate on the same filtered array — using transcript.length
      // as the cursor end-index would cause humanTurns.slice(deltaStartIndex) to return an
      // empty array on every refresh run (cursor ≥ humanTurns.length).
      const humanTurns = transcript.filter(
        t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase())
      );

      const deltaStartIndex = priorState ? lastAnalyzedIndexRef.current : 0;
      const currentEndIndex = humanTurns.length;

      // Guard: if the cursor is ahead of the current transcript length,
      // the transcript was reset mid-session — treat this as a first run.
      if (priorState && lastAnalyzedIndexRef.current > humanTurns.length) {
        console.warn('[useLiveAnalysis] Cursor ahead of transcript length — resetting to first-run mode.');
        lastAnalyzedIndexRef.current = 0;
      }
      const adjustedDeltaStartIndex = priorState ? lastAnalyzedIndexRef.current : 0;

      let livePrompt: string;

      if (!priorState) {
        setIsRefreshRun(false);
        // ── FIRST RUN: full CLIENT-only transcript, derive everything from scratch ──
        // We still include SALES PERSON turns as labelled lines so the LLM has call context
        // for objection/AE-deferral detection, but BANT/MEDDIC signal extraction
        // is scoped to prospect lines via the prompt instruction.
        //
        // For long calls (>30 min), older turns are compressed to their first 80 characters
        // to prevent context overflow on providers with smaller context windows (Groq).
        const COMPRESSION_CUTOFF_MS = 30 * 60 * 1000;
        const now = Date.now();
        const prospectTurns = humanTurns.filter(t => t.speaker !== 'user');

        let firstRunContext: string;
        const hasOldTurns = prospectTurns.some(t => (now - t.timestamp) > COMPRESSION_CUTOFF_MS);
        if (hasOldTurns) {
          const recentTurns = prospectTurns.filter(t => (now - t.timestamp) <= COMPRESSION_CUTOFF_MS);
          const olderTurns = prospectTurns.filter(t => (now - t.timestamp) > COMPRESSION_CUTOFF_MS);
          const olderBlock = olderTurns.length > 0
            ? `[EARLIER CALL CONTEXT — ${olderTurns.length} prospect turns]\n` +
            olderTurns.map(t => {
              const name = t.displayName && t.displayName !== "Them" ? ` (${t.displayName})` : '';
              return `CLIENT${name}: ${t.text.substring(0, 80)}${t.text.length > 80 ? '…' : ''}`;
            }).join('\n')
            : '';
          const recentBlock = recentTurns.map(t => {
            const role = 'CLIENT';
            const name = t.displayName && t.displayName !== "Them" ? ` (${t.displayName})` : '';
            return `${role}${name}: ${t.text}`;
          }).join('\n');
          firstRunContext = olderBlock ? `${olderBlock}\n\n[RECENT TURNS — full fidelity]\n${recentBlock}` : recentBlock;
        } else {
          firstRunContext = humanTurns.filter(t => t.speaker !== 'user').map(t => {
            const role = t.speaker === 'user' ? 'SALES PERSON (Me)' : 'PROSPECT (Client)';
            const name = t.displayName && t.displayName !== "Them" && t.displayName !== "Me" ? ` (${t.displayName})` : '';
            return `${role}${name}: ${t.text}`;
          }).join('\n');
        }

        const companyBlock = buildCompanyBlock(companyIntel);
        livePrompt = companyBlock
          ? `${companyBlock}\n\n${getFirstRunPrompt(firstRunContext)}`
          : getFirstRunPrompt(firstRunContext);
        console.log(`[useLiveAnalysis] First run — sending ${humanTurns.length} turns (${firstRunContext.length} chars), compressed: ${hasOldTurns}`);
      } else {
        setIsRefreshRun(true);
        // ── REFRESH RUN: prior state + new CLIENT turns only ────────────────────
        // SALES PERSON turns are excluded from the delta — they are scaffolding context,
        // not signal sources. BANT/MEDDIC are updated incrementally from priorState.
        // This keeps the prompt ~80% smaller than re-sending the full transcript.
        const newTurns = humanTurns.slice(adjustedDeltaStartIndex);
        const prospectDelta = newTurns
          .filter(t => t.speaker !== 'user')   // prospect turns only
          .map(formatProspectTurn)
          .join('\n');

        const companyBlock = buildCompanyBlock(companyIntel);
        livePrompt = companyBlock
          ? `${companyBlock}\n\n${getRefreshPrompt(priorState, prospectDelta)}`
          : getRefreshPrompt(priorState, prospectDelta);
        console.log(`[useLiveAnalysis] Refresh run — ${newTurns.length} new turns, ${prospectDelta.length} chars of prospect delta`);
      }

      // ── Electron path ────────────────────────────────────────────────
      if (window.electronAPI?.startLiveAnalysis) {
        const analysisPromise = new Promise<LiveAnalysisData>((resolve, reject) => {
          const timeoutId = setTimeout(() => reject(new Error('Analysis timed out')), 60000);

          resultCleanup = window.electronAPI?.onLiveAnalysisResult?.((result: string) => {
            clearTimeout(timeoutId);
            try {
              let jsonStr = result.trim();
              const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
              if (jsonMatch) jsonStr = jsonMatch[1];
              resolve(JSON.parse(jsonStr));
            } catch {
              reject(new Error('Failed to parse analysis result'));
            }
          });

          errorCleanup = window.electronAPI?.onLiveAnalysisError?.((err: string) => {
            clearTimeout(timeoutId);
            reject(new Error(err));
          });
        });

        await window.electronAPI.startLiveAnalysis(livePrompt);
        const parsed = await analysisPromise;

        // Client-side merge: ensures prior objections/signals are never lost even if
        // the LLM dropped them (model switch, context truncation, etc.)
        const merged = mergeWithPrior(parsed, priorState);

        // Advance cursor so next delta run only processes new turns
        lastAnalyzedIndexRef.current = currentEndIndex;
        lastAnalysisTimeRef.current = Date.now();
        lastTriggerScanIndexRef.current = currentEndIndex;

        setAnalysisDataAndRef(merged);
        window.electronAPI?.updateLiveAnalysis?.(merged).catch((err: any) =>
          console.error('[useLiveAnalysis] Failed to persist analysis:', err)
        );
      } else {
        // ── Anthropic API fallback (web / dev environment) ────────────
        const parsed = await runAnalysisViaAnthropicAPI(livePrompt);
        const merged = mergeWithPrior(parsed, priorState);
        lastAnalyzedIndexRef.current = currentEndIndex;
        lastAnalysisTimeRef.current = Date.now();
        lastTriggerScanIndexRef.current = currentEndIndex;
        setAnalysisDataAndRef(merged);
        window.electronAPI?.updateLiveAnalysis?.(merged).catch((err: any) =>
          console.error('[useLiveAnalysis] Failed to persist analysis:', err)
        );
      }
    } catch (e: any) {
      setError(e?.message || 'Analysis failed');
    } finally {
      isLoadingRef.current = false;
      setIsLoading(false);
      resultCleanup?.();
      errorCleanup?.();
    }
  }, [transcriptRef, isMeetingPaused, setAnalysisDataAndRef]);

  // ── Urgent-signal trigger ──────────────────────────────────────────────────
  // Scans new prospect turns for high-value signal patterns (competitor mentions,
  // buying intent, stall signals, etc.). Fires runAnalysis() immediately when
  // a pattern hits, instead of waiting for the timer. Zero LLM cost — pure regex.
  // Gated by: 60-second cooldown since last analysis + not already in-flight.
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript?.length || isMeetingPaused || isLoadingRef.current) return;

    const humanTurns = transcript.filter(
      t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase())
    );
    const prospectTurns = humanTurns.filter(t => t.speaker !== 'user');
    const newTurns = prospectTurns.slice(lastTriggerScanIndexRef.current);
    if (!newTurns.length) return;

    const COOLDOWN_MS = 60_000;
    const cooldownElapsed = Date.now() - lastAnalysisTimeRef.current > COOLDOWN_MS;
    if (!cooldownElapsed) return;

    const triggered = newTurns.some(t => hasUrgentTrigger(t.text));
    if (triggered) {
      console.log('[useLiveAnalysis] Urgent signal detected — triggering immediate analysis');
      runAnalysis(true);
    }

    lastTriggerScanIndexRef.current = prospectTurns.length;
  }, [transcriptRef, isMeetingPaused, runAnalysis]);

  const resetAnalysis = useCallback(() => {
    analysisDataRef.current = null;
    lastAnalyzedIndexRef.current = 0;
    lastAnalysisTimeRef.current = 0;
    lastTriggerScanIndexRef.current = 0;
    setAnalysisData(null);
    setError(null);
  }, []);

  return { analysisData, isLoading, error, runAnalysis, resetAnalysis, isRefreshRun };
};
