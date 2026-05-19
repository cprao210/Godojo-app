import React, { useState, useCallback, useRef, useEffect } from 'react';
import { X, RefreshCw, Shield } from 'lucide-react';
import { LiveAnalysisContent } from './LiveAnalysisContent';
import { LiveAnalysisData } from '../types/liveAnalysis';

interface LiveAnalysisOverlayProps {
    appearance: any;
    overlayPanelClass: string;
    onClose: () => void;
    transcriptRef: React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>;
    meetingTitle?: string;
    isMeetingPaused?: boolean;
}

// ─────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────

const getLiveAnalysisPrompt = (context: string) => `You are an expert real-time sales intelligence engine analyzing a live sales call transcript. Your job is to extract structured insights across four areas: BANT, MEDDIC, Objections, and Buying Signals. Return ONLY valid JSON. No explanation, no markdown, no text outside the JSON object. 

    ═══════════════════════════════════════
    RULES
    ═══════════════════════════════════════

    OVERWRITE on every call:
    → bant
    → meddic

    APPEND ONLY (never remove prior entries) on every call:
    → objections
    → signals

    ═══════════════════════════════════════
    SECTION 1: BANT
    ═══════════════════════════════════════

    Scan the transcript for Budget, Authority, Need, and Timeline signals.

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

    Scan the transcript for MEDDIC signals.

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

    Capture two types. APPEND new entries — never remove existing ones.

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
    APPEND new signals only — never remove prior ones.

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

    urgency (negative pressure)
    → External deadlines or pressure creating urgency that could stall or accelerate.
    → Triggers: "our contract with [vendor] expires", "we have a board deadline",
      "our team is blocked until we solve this", "we're already behind",
      "we need this yesterday", "leadership is asking about this weekly".
      NOTE: capture both positive urgency (accelerates deal) and negative urgency
      (pressure that may cause hasty objections or budget freezes).

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
    → Triggers: asking about pricing tiers, asking about ROI calculations,
      referencing a specific budget number, asking about cost vs. competitors,
      mentioning TCO (total cost of ownership), asking about implementation costs,
      payment terms, discounts, or multi-year deals. Neutral — needs context to determine
      if it's a positive (budget confirmed) or friction (price too high) signal.

    process_signal
    → Prospect reveals internal decision-making process, stakeholders, or evaluation criteria.
    → Triggers: "we have a security review", "procurement will need to sign off",
      "we do a 30-day POC", "legal reviews all contracts", "our IT team will need to test",
      describing an internal committee or approval chain, mentioning a specific
      evaluation scorecard or criteria they're using.

    timeline
    → Any statement revealing when the prospect wants or needs to be live.
    → Triggers: mentioning a specific date, quarter, or milestone for go-live,
      tying the purchase to a business event (launch, fiscal year, hiring cycle),
      asking about implementation time, mentioning internal deadlines or commitments.

    ── INTENSITY ─────────────────────────────────────────────────────────────────────

    Score each signal:
    "high"   → Explicit, direct, clear statement. Quote is verbatim or near-verbatim.
               Requires immediate AE response or action.
    "medium" → Implied or indirect. Requires some interpretation. Worth tracking.
    "low"    → Subtle, background context. May be relevant later but not urgent now.

    ── DETECTION RULES ───────────────────────────────────────────────────────────────

    1. Capture signals from BOTH speakers — what the PROSPECT says AND how the AE responds
       (AE responses can reveal competitor mentions, risk acknowledgements, or stalls).
    2. Do NOT require the signal to be explicit — implied signals count.
       "We've been on our current tool for 5 years" → implied stall_signal + competitor_signal.
    3. One quote can carry MULTIPLE signal types — use all that apply.
    4. Short quotes are better than long ones — tightest excerpt that captures the signal.
    5. The ask_now must be a precise, natural follow-up question the AE should ask
       immediately in response to THIS specific signal. Under 20 words.
       NOT generic ("Can you tell me more?") — specific to what was said.
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

    TRANSCRIPT:
    ${context}
`;

const LiveAnalysisOverlay: React.FC<LiveAnalysisOverlayProps> = ({
    appearance,
    overlayPanelClass,
    onClose,
    transcriptRef,
    isMeetingPaused = false
}) => {
    const [analysisData, setAnalysisData] = useState<LiveAnalysisData | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [aiInsight, setAiInsight] = useState<string>('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const prevTranscriptLengthRef = useRef<number>(0); // Track previous length to detect transcript reset

    useEffect(() => {
        if (analysisData) {
            window.electronAPI?.updateLiveAnalysis?.(analysisData).catch((err) =>
                console.error('[LiveAnalysis] Failed to persist analysis data:', err)
            );
        }
    }, [analysisData]);

    // Reset analysis when transcript is cleared (new meeting)
    useEffect(() => {
        const currentLength = transcriptRef.current?.length || 0;

        // If length decreased significantly (transcript was cleared)
        if (currentLength < prevTranscriptLengthRef.current) {
            console.log('[LiveAnalysis] Transcript reset detected, clearing analysis');
            setAnalysisData(null);
            setError(null);
            setAiInsight('');
            // Don't auto-run - wait for user to click Regenerate
        }

        prevTranscriptLengthRef.current = currentLength;
    }, [transcriptRef.current?.length]);


    const runAnalysis = useCallback(async () => {

        if (isMeetingPaused) {
            console.log('[LiveAnalysis] Skipping analysis — meeting is paused.');
            return;
        }

        const transcript = transcriptRef.current;
        console.log('[LiveAnalysis] Starting analysis with transcript length:', transcript?.length);
        if (!transcript || transcript.length < 1) {
            setError(`Not enough transcript data yet (${transcript?.length ?? 0} segments). Keep talking!`);
            return;
        }
        setIsLoading(true);
        setError(null);

        // Setup temporary listeners for this analysis session
        let resultCleanup: (() => void) | undefined;
        let errorCleanup: (() => void) | undefined;

        try {
            const context = transcript
                .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()))
                .map(t => `${t.speaker === 'user' ? 'REP' : 'PROSPECT'}: ${t.text}`)
                .join('\n');


            const livePrompt = getLiveAnalysisPrompt(context);

            const analysisPromise = new Promise<LiveAnalysisData>((resolve, reject) => {
                let timeoutId: NodeJS.Timeout;

                resultCleanup = window.electronAPI?.onLiveAnalysisResult?.((result: string) => {
                    clearTimeout(timeoutId);
                    try {
                        // Parse the JSON result
                        let jsonStr = result.trim();
                        const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                        if (jsonMatch) {
                            jsonStr = jsonMatch[1];
                        }
                        const parsed: LiveAnalysisData = JSON.parse(jsonStr);
                        resolve(parsed);
                    } catch (parseError) {
                        reject(new Error('Failed to parse analysis result'));
                    }
                });

                errorCleanup = window.electronAPI?.onLiveAnalysisError?.((error: string) => {
                    clearTimeout(timeoutId);
                    reject(new Error(error));
                });

                // Set timeout for analysis (60 seconds)
                timeoutId = setTimeout(() => {
                    reject(new Error('Analysis timed out after 60 seconds'));
                }, 60000);
            });

            // Start the analysis
            await window.electronAPI?.startLiveAnalysis?.(livePrompt);

            // Wait for the result
            const parsed = await analysisPromise;

            setAnalysisData(parsed);

            // Generate AI insight from top signal
            const topSignal = parsed.signals?.[0];
            if (topSignal) {
                setAiInsight(topSignal.ask_now);
            } else if (parsed.meddic?.competition?.status === 'missing') {
                setAiInsight("No competitor mentioned yet — ask if they're evaluating alternatives before the call ends.");
            } else if (parsed.bant?.budget?.status === 'partial') {
                setAiInsight(`Budget is partial — push to confirm exact number and approval owner now.`);
            } else {
                setAiInsight("Strong call signals detected. Review MEDDIC gaps below before closing.");
            }


        } catch (e) {
            console.error('[LiveAnalysis] Error:', e);
            setError('Analysis failed. Please try again.');
        } finally {
            setIsLoading(false);
            // Cleanup listeners
            resultCleanup?.();
            errorCleanup?.();
        }
    }, [transcriptRef, isMeetingPaused]);

    // Auto-run on open - ONLY if there's transcript data
    useEffect(() => {
        // Only run if:
        // 1. No analysis data yet
        // 2. Not currently loading
        // 3. There's transcript data (meeting has started)
        // 4. No error (don't auto-run after error)
        if (!analysisData && !isLoading && !error && !isMeetingPaused && transcriptRef.current?.length > 0) {
            console.log('[LiveAnalysis] Auto-running analysis on open with', transcriptRef.current.length, 'segments');
            runAnalysis();
        }
    }, [analysisData, isLoading, error, isMeetingPaused, transcriptRef.current?.length]);

    return (
        <div className={`relative w-[560px] max-w-full backdrop-blur-2xl border rounded-[24px] overflow-hidden flex flex-col draggable-area min-h-0 overlay-shell-surface ${overlayPanelClass}`}
            style={{ ...appearance.shellStyle, height: '650px' }}
        >
            {/* ── Header ─────────────────────────────────────── */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle shrink-0">
                <div className="flex items-center gap-2.5">
                    {/* Live pulse dot */}
                    <div className="relative flex items-center justify-center w-5 h-5">
                        <span className="absolute inline-flex w-3 h-3 rounded-full bg-blue-500/30 animate-ping" />
                        <span className="relative w-2 h-2 rounded-full bg-blue-400" />
                    </div>
                    <div>
                        <span className="text-[13px] font-semibold text-white/80">Call Intelligence</span>
                        <span className="ml-2 text-[9px] font-bold uppercase tracking-widest text-blue-400 bg-blue-500/15 border border-blue-500/25 px-1.5 py-0.5 rounded-full">
                            Live Analysis
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-1">
                    {/* Regenerate */}
                    <button onClick={runAnalysis} disabled={isLoading} title="Regenerate analysis" className="p-2 rounded-xl hover:bg-white/[0.06] text-white/40 hover:text-white/70 disabled:opacity-30 disabled:cursor-not-allowed transition-all group">
                        <RefreshCw size={14} className={`transition-transform ${isLoading ? 'animate-spin' : 'group-hover:rotate-180 duration-500'}`} />
                    </button>
                    {/* Close */}
                    <button onClick={onClose} className="p-2 rounded-xl hover:bg-white/[0.06] text-white/40 hover:text-red-400 hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.4)] transition-all duration-300 group">
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* ── Scrollable Body ────────────────────────────── */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar pb-6 no-drag">
                {/* Loading state */}
                {isLoading && (
                    <div className="flex flex-col items-center justify-center h-48 gap-4">
                        <div className="relative">
                            <div className="w-10 h-10 border-2 border-white/[0.06] border-t-blue-500 rounded-full animate-spin" />
                            <div className="absolute inset-0 flex items-center justify-center">
                                <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                            </div>
                        </div>
                        <p className="text-[12px] text-white/30 animate-pulse">Analyzing transcript...</p>
                    </div>
                )}

                {/* Error state */}
                {!isLoading && error && (
                    <div className="mx-4 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-[12px] text-red-400">
                        {error}
                    </div>
                )}

                {/* Analysis content */}
                {!isLoading && analysisData && (
                    <LiveAnalysisContent analysisData={analysisData} aiInsight={aiInsight} hideBar="Missing Details" />
                )}

                {/* Empty state */}
                {!isLoading && !error && !analysisData && (
                    <div className="flex flex-col items-center justify-center h-48 gap-3">
                        <Shield size={24} className="text-white/10" />
                        <p className="text-[12px] text-white/25 text-center px-8">
                            Start the call and click Regenerate to analyse the transcript.
                        </p>
                    </div>
                )}
            </div>

            {/* ── Footer ─────────────────────────────────────── */}
            <div className="shrink-0 px-4 py-4 border-t border-border-subtle">
                <button onClick={runAnalysis} disabled={isLoading} className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/25 hover:border-blue-500/40 text-[13px] font-semibold text-blue-300 hover:text-blue-200 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200">
                    <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
                    {isLoading ? 'Analysing...' : 'Regenerate Live Analysis'}
                </button>
            </div>
        </div>
    )

};

export default LiveAnalysisOverlay;