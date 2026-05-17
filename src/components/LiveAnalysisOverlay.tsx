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

    Budget    → Money mentioned, approval thresholds, "we have budget", "we're looking at X"
    Authority → Decision-maker named, approval chain mentioned, "I need sign-off from", "our CFO decides"
    Need      → Problem stated, current pain, why they're looking, "we need", "we're trying to"
    Timeline  → Deadlines, urgency, "we need this by", "our Q3 goal", "we're hoping to launch"

    ═══════════════════════════════════════
    SECTION 2: MEDDIC
    ═══════════════════════════════════════

    Scan the transcript for MEDDIC signals.

    Same structure as BANT: emoji + status + evidence per field.

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

    Detect buying signals. For each signal return:
    - quote:       Exact quote or tight one-line paraphrase from the customer
    - signal_type: Array of: frustration | urgency | cost | risk | aspiration | buying_intent
    - ask_now:     The single follow-up question the AE should ask (natural, specific, under 20 words)

    ═══════════════════════════════════════
    OUTPUT FORMAT
    ═══════════════════════════════════════

    {
        "bant": {
            "budget":    { "emoji": "", "status": "", "evidence": "" },
            "authority": { "emoji": "", "status": "", "evidence": "" },
            "need":      { "emoji": "", "status": "", "evidence": "" },
            "timeline":  { "emoji": "", "status": "", "evidence": "" }
        },
        "meddic": {
            "metrics":           { "emoji": "", "status": "", "evidence": "" },
            "economic_buyer":    { "emoji": "", "status": "", "evidence": "" },
            "decision_criteria": { "emoji": "", "status": "", "evidence": "" },
            "decision_process":  { "emoji": "", "status": "", "evidence": "" },
            "identify_pain":     { "emoji": "", "status": "", "evidence": "" },
            "champion":          { "emoji": "", "status": "", "evidence": "" },
            "competition":       { "emoji": "", "status": "", "evidence": "" }
        },
        "objections": [
            { "type": "", "quote": "", "owner": "", "status": "" }
        ],
        "signals": [
            { "quote": "", "signal_type": [], "ask_now": "" }
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
    const [checkedObjections, setCheckedObjections] = useState<Set<number>>(new Set());
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
            setCheckedObjections(new Set());
            setAiInsight('');
            // Don't auto-run - wait for user to click Regenerate
        }

        prevTranscriptLengthRef.current = currentLength;
    }, [transcriptRef.current?.length]);

    // Count confirmed MEDDIC fields
    const meddicFound = analysisData
        ? Object.values(analysisData.meddic).filter(f => f.status === 'confirmed').length
        : 0;

    // Count BANT completion
    const bantConfirmed = analysisData
        ? Object.values(analysisData.bant).filter(f => f.status === 'confirmed').length
        : 0;
    const bantPct = Math.round((bantConfirmed / 4) * 100);

    // Build missing signals from MEDDIC + signals array
    const missingSignals = analysisData ? [
        ...(analysisData.meddic.competition.status === 'missing'
            ? [{ title: 'Competitor Presence', desc: 'No direct confirmation on other vendors.', icon: '!' }]
            : []),
        ...(analysisData.meddic.champion.status !== 'confirmed'
            ? [{ title: 'Internal Champion', desc: analysisData.meddic.champion.evidence || 'Champion not confirmed — need internal sponsor.', icon: '?' }]
            : []),
        ...(analysisData.meddic.decision_process.status === 'missing'
            ? [{ title: 'Decision Process', desc: 'Buying process not mapped — need legal/procurement timeline.', icon: '!' }]
            : []),
        ...(analysisData.meddic.metrics.status === 'missing'
            ? [{ title: 'Quantified Metrics', desc: 'No ROI or KPIs established yet.', icon: '?' }]
            : []),
        ...analysisData.signals
            .filter(s => s.signal_type.includes('risk') || s.signal_type.includes('frustration'))
            .map(s => ({ title: 'Risk Signal', desc: s.ask_now, icon: '⚠' })),
    ] : [];

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

    const toggleObjection = (index: number) => {
        setCheckedObjections(prev => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

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
                    <button
                        onClick={runAnalysis}
                        disabled={isLoading}
                        title="Regenerate analysis"
                        className="p-2 rounded-xl hover:bg-white/[0.06] text-white/40 hover:text-white/70 disabled:opacity-30 disabled:cursor-not-allowed transition-all group"
                    >
                        <RefreshCw
                            size={14}
                            className={`transition-transform ${isLoading ? 'animate-spin' : 'group-hover:rotate-180 duration-500'}`}
                        />
                    </button>
                    {/* Close */}
                    <button
                        onClick={onClose}
                        className="p-2 rounded-xl hover:bg-white/[0.06] text-white/40 hover:text-red-400 hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.4)] transition-all duration-300 group"
                    >
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
                    <LiveAnalysisContent analysisData={analysisData} aiInsight={aiInsight} />
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
                <button
                    onClick={runAnalysis}
                    disabled={isLoading}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/25 hover:border-blue-500/40 text-[13px] font-semibold text-blue-300 hover:text-blue-200 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
                >
                    <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
                    {isLoading ? 'Analysing...' : 'Regenerate Live Analysis'}
                </button>
            </div>
        </div>
    )

};

export default LiveAnalysisOverlay;