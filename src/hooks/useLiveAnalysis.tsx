import { useState, useCallback, useRef } from 'react';
import { LiveAnalysisData } from '../types/liveAnalysis';

// Serialise prior analysis state into a compact JSON block for the prompt.
const serializePriorState = (prior: LiveAnalysisData): string =>
  JSON.stringify({
    bant: prior.bant,
    meddic: prior.meddic,
    objections: prior.objections,
    signals: prior.signals,
  }, null, 2);

const getLiveAnalysisPrompt = (
  fullContext: string,
  deltaContext: string,
  priorState: LiveAnalysisData | null
) => `You are an expert real-time sales intelligence engine analyzing a live sales call transcript. Your job is to extract structured insights across four areas: BANT, MEDDIC, Objections, and Buying Signals. Return ONLY valid JSON. No explanation, no markdown, no text outside the JSON object.

    ═══════════════════════════════════════
    RULES
    ═══════════════════════════════════════

    OVERWRITE on every call (re-derive from the FULL TRANSCRIPT):
    → bant
    → meddic

    APPEND ONLY — never remove prior entries. Add new ones found in NEW TRANSCRIPT only:
    → objections
    → signals

${priorState ? `    ═══════════════════════════════════════
    PRIOR STATE (from previous analysis run)
    ═══════════════════════════════════════
    The fields below represent what was already captured. For objections and signals,
    copy them into your response EXACTLY AS-IS, then append any new ones found in the
    NEW TRANSCRIPT section. Do not modify, deduplicate, or remove prior entries.

${serializePriorState(priorState)}

` : ''}    ═══════════════════════════════════════
    SECTION 1: BANT
    ═══════════════════════════════════════

    Scan the FULL TRANSCRIPT for Budget, Authority, Need, and Timeline signals.

    For each field return:
    - emoji:    "✅" if clearly confirmed, "⚠️" if implied or partial, "❌" if not mentioned
    - status:   "confirmed" | "partial" | "missing"
    - evidence: One line — exact quote or closest paraphrase from the customer. If missing, return ""
    - suggested_question: ONLY when status is "missing" — one short, natural question the sales rep should ask RIGHT NOW to uncover this field (under 15 words, no filler). If status is confirmed or partial, return ""

    Budget    → Money mentioned, approval thresholds, "we have budget", "we're looking at X"
    Authority → Decision-maker named, approval chain mentioned, "I need sign-off from", "our CFO decides"
    Need      → Problem stated, current pain, why they're looking, "we need", "we're trying to"
    Timeline  → Deadlines, urgency, "we need this by", "our Q3 goal", "we're hoping to launch"

    ═══════════════════════════════════════
    SECTION 2: MEDDIC
    ═══════════════════════════════════════

    Scan the FULL TRANSCRIPT for MEDDIC signals.

    Same structure as BANT: emoji + status + evidence + suggested_question per field.

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

    Capture two types. APPEND new entries from NEW TRANSCRIPT — never remove existing ones.

    TYPE A — Customer Questions (open or unanswered)
    TYPE B — AE Deferrals (follow-up commitments made by the AE)

    For each objection return:
    - type:   "customer_question" | "ae_deferral"
    - quote:  Exact quote or tight one-line paraphrase
    - owner:  "customer" | "ae"
    - status: "open" | "deferred"

    ═══════════════════════════════════════
    SECTION 4: SIGNALS
    ═══════════════════════════════════════

    You are detecting EVERY meaningful signal in the conversation — positive buying signals,
    negative risk signals, and neutral informational signals that affect deal outcome.
    Cast a wide net. It is better to capture more signals than to miss important ones.
    APPEND new signals only from the NEW TRANSCRIPT section — never remove prior ones.

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

    ── INTENSITY ─────────────────────────────────────────────────────────────────────

    "high"   → Explicit, direct, clear statement. Requires immediate AE response.
    "medium" → Implied or indirect. Worth tracking.
    "low"    → Subtle background context.

    ── DETECTION RULES ───────────────────────────────────────────────────────────────

    1. Capture signals from BOTH speakers.
    2. Implied signals count — "We've been on our current tool for 5 years" → stall_signal + competitor_signal.
    3. One quote can carry MULTIPLE signal types.
    4. Short quotes are better than long ones.
    5. ask_now must be under 20 words, specific to THIS signal. Not generic.
    6. Prioritise high-intensity signals at the top of the array.
    7. APPEND ONLY — never remove or overwrite prior signals between analysis runs.

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

    ═══════════════════════════════════════
    FULL TRANSCRIPT (use for BANT + MEDDIC re-derivation):
    ═══════════════════════════════════════
${fullContext}
${deltaContext && deltaContext !== fullContext ? `
    ═══════════════════════════════════════
    NEW TRANSCRIPT (since last analysis — use for new objections + signals only):
    ═══════════════════════════════════════
${deltaContext}` : ''}
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
// Even with the prior-state prompt, a model switch or truncation could drop
// previously captured entries. This ensures we never lose objections or signals
// that were already in state, regardless of what the LLM returns.
const isSimilar = (a: string, b: string): boolean => {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const ca = clean(a);
  const cb = clean(b);
  if (ca === cb) return true;
  // One is a substring of the other (covers paraphrasing)
  if (ca.length > 10 && (ca.includes(cb.substring(0, 20)) || cb.includes(ca.substring(0, 20)))) return true;
  return false;
};

const mergeWithPrior = (
  incoming: LiveAnalysisData,
  prior: LiveAnalysisData | null
): LiveAnalysisData => {
  if (!prior) return incoming;

  // Merge objections: keep all prior, add any new ones not already present
  const mergedObjections = [...prior.objections];
  for (const obj of incoming.objections) {
    const alreadyPresent = mergedObjections.some(p => isSimilar(p.quote, obj.quote));
    if (!alreadyPresent) mergedObjections.push(obj);
  }

  // Merge signals: keep all prior, add any new ones not already present
  const mergedSignals = [...prior.signals];
  for (const sig of incoming.signals) {
    const alreadyPresent = mergedSignals.some(p => isSimilar(p.quote, sig.quote));
    if (!alreadyPresent) mergedSignals.push(sig);
  }

  return {
    bant: incoming.bant,       // always overwrite — re-derived from full transcript
    meddic: incoming.meddic,   // always overwrite — re-derived from full transcript
    objections: mergedObjections,
    signals: mergedSignals,
  };
};

export const useLiveAnalysis = (
  transcriptRef: React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>,
  isMeetingPaused: boolean
) => {
  const [analysisData, setAnalysisData] = useState<LiveAnalysisData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref-based in-flight guard — avoids stale closure issues that a state-based check would have.
  const isLoadingRef = useRef(false);
  // Cursor: index of the last transcript entry that was part of the FULL context sent on
  // the previous run. On refresh runs we send only the delta (new turns since then),
  // paired with the previous analysis as prior state. First run always sends everything.
  const lastAnalyzedIndexRef = useRef<number>(0);
  // Mirror of analysisData in a ref so the merge helper inside runAnalysis can read it
  // without a stale closure (useCallback deps would force re-creating on every render).
  const analysisDataRef = useRef<LiveAnalysisData | null>(null);

  // Keep ref in sync with state so the runAnalysis closure always sees the latest value.
  const setAnalysisDataAndRef = useCallback((data: LiveAnalysisData | null) => {
    analysisDataRef.current = data;
    setAnalysisData(data);
  }, []);

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
    const deltaStartIndex = priorState ? lastAnalyzedIndexRef.current : 0;
    const currentEndIndex = transcript.length;

    try {
      // ── Build transcript strings ─────────────────────────────────────
      // Each turn is formatted as: "SPEAKER_LABEL (DisplayName): text"
      // Using displayName gives the LLM real speaker identity for accurate
      // attribution of objections, champion detection, and authority signals.
      const formatTurn = (t: { speaker: string; displayName?: string; text: string }) => {
        const role = t.speaker === 'user' ? 'REP' : 'PROSPECT';
        const name = t.displayName ? ` (${t.displayName})` : '';
        return `${role}${name}: ${t.text}`;
      };

      const humanTurns = transcript.filter(
        t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase())
      );

      // Full transcript — always sent, used for BANT + MEDDIC re-derivation
      const fullContext = humanTurns.map(formatTurn).join('\n');

      // Delta transcript — only turns since the last analysis run
      // Used for new objections + signals detection only
      const deltaTurns = humanTurns.slice(deltaStartIndex);
      const deltaContext = deltaTurns.length > 0 ? deltaTurns.map(formatTurn).join('\n') : fullContext;

      const livePrompt = getLiveAnalysisPrompt(fullContext, deltaContext, priorState);

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

        setAnalysisDataAndRef(merged);
        window.electronAPI?.updateLiveAnalysis?.(merged).catch((err: any) =>
          console.error('[useLiveAnalysis] Failed to persist analysis:', err)
        );
      } else {
        // ── Anthropic API fallback (web / dev environment) ────────────
        const parsed = await runAnalysisViaAnthropicAPI(livePrompt);
        const merged = mergeWithPrior(parsed, priorState);
        lastAnalyzedIndexRef.current = currentEndIndex;
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

  const resetAnalysis = useCallback(() => {
    analysisDataRef.current = null;
    lastAnalyzedIndexRef.current = 0;
    setAnalysisData(null);
    setError(null);
  }, []);

  return { analysisData, isLoading, error, runAnalysis, resetAnalysis };
};