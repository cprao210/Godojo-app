import React, { useState, useCallback, useRef, useEffect } from 'react';
import { X, RefreshCw, Shield, BarChart2, AlertTriangle, CheckSquare, Square, Zap, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface BANTField {
    emoji: '✅' | '⚠️' | '❌' | '';
    status: 'confirmed' | 'partial' | 'missing' | '';
    evidence: string;
}

interface MEDDICField {
    emoji: '✅' | '⚠️' | '❌' | '';
    status: 'confirmed' | 'partial' | 'missing' | '';
    evidence: string;
}

interface Objection {
    type: 'customer_question' | 'ae_deferral';
    quote: string;
    owner: 'customer' | 'ae';
    status: 'open' | 'deferred';
}

interface Signal {
    quote: string;
    signal_type: string[];
    ask_now: string;
}

interface LiveAnalysisData {
    bant: {
        budget: BANTField;
        authority: BANTField;
        need: BANTField;
        timeline: BANTField;
    };
    meddic: {
        metrics: MEDDICField;
        economic_buyer: MEDDICField;
        decision_criteria: MEDDICField;
        decision_process: MEDDICField;
        identify_pain: MEDDICField;
        champion: MEDDICField;
        competition: MEDDICField;
    };
    objections: Objection[];
    signals: Signal[];
}

interface LiveAnalysisOverlayProps {
    appearance: any;
    overlayPanelClass: string;
    onClose: () => void;
    transcriptRef: React.MutableRefObject<Array<{ speaker: string; text: string; timestamp: number }>>;
    meetingTitle?: string;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const statusDot = (status: string) => {
    if (status === 'confirmed') return 'bg-emerald-400';
    if (status === 'partial') return 'bg-amber-400';
    return 'bg-white/20';
};

const statusRing = (status: string) => {
    if (status === 'confirmed') return 'border-emerald-500/30 bg-emerald-500/5';
    if (status === 'partial') return 'border-amber-500/30 bg-amber-500/5';
    return 'border-white/[0.06] bg-white/[0.02]';
};

const emojiColor = (status: string) => {
    if (status === 'confirmed') return 'text-emerald-400';
    if (status === 'partial') return 'text-amber-400';
    return 'text-white/20';
};

const signalTypeColor = (type: string) => {
    const map: Record<string, string> = {
        urgency: 'bg-red-500/15 text-red-400 border-red-500/25',
        frustration: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
        buying_intent: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
        cost: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
        risk: 'bg-red-500/15 text-red-400 border-red-500/25',
        aspiration: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
    };
    return map[type] || 'bg-white/10 text-white/50 border-white/10';
};

// ─────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────

const SectionToggle: React.FC<{
    icon: React.ReactNode;
    title: string;
    badge?: string;
    badgeColor?: string;
    children: React.ReactNode;
    defaultOpen?: boolean;
}> = ({ icon, title, badge, badgeColor = 'bg-white/10 text-white/50', children, defaultOpen = true }) => {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="mb-1">
            <button
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-white/[0.03] transition-colors group"
            >
                <span className="text-white/40 group-hover:text-white/60 transition-colors">{icon}</span>
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/50 group-hover:text-white/70 transition-colors flex-1 text-left">
                    {title}
                </span>
                {badge && (
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeColor}`}>
                        {badge}
                    </span>
                )}
                <span className="text-white/20 group-hover:text-white/40 transition-colors">
                    {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </span>
            </button>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                    >
                        <div className="px-4 pb-4">
                            {children}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

const FieldRow: React.FC<{
    label: string;
    field: BANTField | MEDDICField;
}> = ({ label, field }) => (
    <div className={`rounded-xl border px-3.5 py-3 mb-2 last:mb-0 ${statusRing(field.status)}`}>
        <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">{label}</span>
            <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${statusDot(field.status)}`} />
                <span className={`text-[10px] font-bold capitalize ${emojiColor(field.status)}`}>
                    {field.status || 'missing'}
                </span>
            </div>
        </div>
        {field.evidence ? (
            <p className="text-[12px] text-white/65 leading-relaxed">{field.evidence}</p>
        ) : (
            <p className="text-[12px] text-white/20 italic">Not mentioned</p>
        )}
    </div>
);

// ─────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────

const LiveAnalysisOverlay: React.FC<LiveAnalysisOverlayProps> = ({
    appearance,
    overlayPanelClass,
    onClose,
    transcriptRef,
}) => {
    const [analysisData, setAnalysisData] = useState<LiveAnalysisData | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [checkedObjections, setCheckedObjections] = useState<Set<number>>(new Set());
    const [aiInsight, setAiInsight] = useState<string>('');
    const scrollRef = useRef<HTMLDivElement>(null);

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
        const transcript = transcriptRef.current;
        if (!transcript || transcript.length < 1) {
            setError(`Not enough transcript data yet (${transcript?.length ?? 0} segments). Keep talking!`);
            return;
        }
        setIsLoading(true);
        setError(null);

        try {
            const context = transcript
                .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()))
                .map(t => `${t.speaker === 'user' ? 'REP' : 'PROSPECT'}: ${t.text}`)
                .join('\n');

            const livePrompt = `You are an expert real-time sales intelligence engine analyzing a live sales call transcript. Your job is to extract structured insights across four areas: BANT, MEDDIC, Objections, and Buying Signals. Return ONLY valid JSON. No explanation, no markdown, no text outside the JSON object. 

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
${context}`;


            // Use chatWithGemini for the analysis
            const result = await window.electronAPI.chatWithGemini(livePrompt, undefined, undefined, true);

            if (result) {
                const jsonMatch = result.match(/```json\n([\s\S]*?)\n```/) || [null, result];
                const jsonStr = (jsonMatch[1] || result).trim();
                const parsed: LiveAnalysisData = JSON.parse(jsonStr);
                setAnalysisData(parsed);

                // Generate AI insight from top signal
                const topSignal = parsed.signals?.[0];
                if (topSignal) {
                    setAiInsight(topSignal.ask_now);
                } else if (parsed.meddic.competition.status === 'missing') {
                    setAiInsight("No competitor mentioned yet — ask if they're evaluating alternatives before the call ends.");
                } else if (parsed.bant.budget.status === 'partial') {
                    setAiInsight(`Budget is partial — push to confirm exact number and approval owner now.`);
                } else {
                    setAiInsight("Strong call signals detected. Review MEDDIC gaps below before closing.");
                }
            }
        } catch (e) {
            console.error('[LiveAnalysis] Error:', e);
            setError('Analysis failed. Please try again.');
        } finally {
            setIsLoading(false);
        }
    }, [transcriptRef]);

    // Auto-run on open
    useEffect(() => {
        if (!analysisData && !isLoading) {
            runAnalysis();
        }
    }, []);

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
                    <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3 }}
                    >
                        {/* ── AI Coach Insight ───────────────────── */}
                        {aiInsight && (
                            <div className="mx-4 mt-4 mb-1 p-3.5 rounded-xl bg-blue-500/8 border border-blue-500/20">
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Zap size={11} className="text-blue-400" />
                                    <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-blue-400">
                                        AI Coach Insight
                                    </span>
                                </div>
                                <p className="text-[13px] text-white/75 leading-relaxed italic">
                                    "{aiInsight}"
                                </p>
                            </div>
                        )}

                        {/* ── MEDDIC Details ─────────────────────── */}
                        <SectionToggle
                            icon={<Shield size={13} />}
                            title="MEDDICC Details"
                            badge={`${meddicFound}/7 Found`}
                            badgeColor={
                                meddicFound >= 5
                                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                                    : meddicFound >= 3
                                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/25'
                                        : 'bg-red-500/15 text-red-400 border border-red-500/25'
                            }
                        >
                            <div className="space-y-1.5 mt-1">
                                <FieldRow label="Metrics" field={analysisData.meddic.metrics} />
                                <FieldRow label="Economic Buyer" field={analysisData.meddic.economic_buyer} />
                                <FieldRow label="Decision Criteria" field={analysisData.meddic.decision_criteria} />
                                <FieldRow label="Decision Process" field={analysisData.meddic.decision_process} />
                                <FieldRow label="Identify Pain" field={analysisData.meddic.identify_pain} />
                                <FieldRow label="Champion" field={analysisData.meddic.champion} />
                                <FieldRow label="Competition" field={analysisData.meddic.competition} />
                            </div>
                        </SectionToggle>

                        <div className="h-px bg-white/[0.04] mx-4" />

                        {/* ── BANT Details ───────────────────────── */}
                        <SectionToggle
                            icon={<BarChart2 size={13} />}
                            title="BANT Details"
                            badge={`${bantPct}% Complete`}
                            badgeColor={
                                bantPct >= 75
                                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                                    : bantPct >= 50
                                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/25'
                                        : 'bg-red-500/15 text-red-400 border border-red-500/25'
                            }
                        >
                            <div className="space-y-1.5 mt-1">
                                <FieldRow label="Budget" field={analysisData.bant.budget} />
                                <FieldRow label="Authority" field={analysisData.bant.authority} />
                                <FieldRow label="Need" field={analysisData.bant.need} />
                                <FieldRow label="Timeline" field={analysisData.bant.timeline} />
                            </div>
                        </SectionToggle>

                        <div className="h-px bg-white/[0.04] mx-4" />

                        {/* ── What I'm Missing ───────────────────── */}
                        {missingSignals.length > 0 && (
                            <>
                                <SectionToggle
                                    icon={<AlertTriangle size={13} />}
                                    title="What I'm Missing"
                                    badgeColor=""
                                >
                                    <div className="space-y-2 mt-1">
                                        {missingSignals.map((signal, i) => (
                                            <motion.div
                                                key={i}
                                                initial={{ opacity: 0, x: -4 }}
                                                animate={{ opacity: 1, x: 0 }}
                                                transition={{ delay: i * 0.06 }}
                                                className={`rounded-xl border px-3.5 py-3 ${signal.icon === '!'
                                                    ? 'border-red-500/25 bg-red-500/5'
                                                    : 'border-white/[0.08] bg-white/[0.02]'
                                                    }`}
                                            >
                                                <div className="flex items-start gap-2.5">
                                                    <span className={`text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${signal.icon === '!'
                                                        ? 'bg-red-500/20 text-red-400'
                                                        : 'bg-white/10 text-white/40'
                                                        }`}>
                                                        {signal.icon}
                                                    </span>
                                                    <div>
                                                        <p className="text-[12px] font-semibold text-white/70 mb-0.5">{signal.title}</p>
                                                        <p className="text-[11px] text-white/40 leading-relaxed">{signal.desc}</p>
                                                    </div>
                                                </div>
                                            </motion.div>
                                        ))}
                                    </div>
                                </SectionToggle>

                                <div className="h-px bg-white/[0.04] mx-4" />
                            </>
                        )}

                        {/* ── Buying Signals ─────────────────────── */}
                        {analysisData.signals.length > 0 && (
                            <>
                                <SectionToggle
                                    icon={<Zap size={13} />}
                                    title="Buying Signals"
                                    badge={`${analysisData.signals.length}`}
                                    badgeColor="bg-blue-500/15 text-blue-400 border border-blue-500/25"
                                >
                                    <div className="space-y-2.5 mt-1">
                                        {analysisData.signals.map((signal, i) => (
                                            <motion.div
                                                key={i}
                                                initial={{ opacity: 0, y: 4 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ delay: i * 0.05 }}
                                                className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3"
                                            >
                                                <div className="flex flex-wrap gap-1 mb-2">
                                                    {signal.signal_type.map((type, j) => (
                                                        <span
                                                            key={j}
                                                            className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md border ${signalTypeColor(type)}`}
                                                        >
                                                            {type.replace('_', ' ')}
                                                        </span>
                                                    ))}
                                                </div>
                                                <p className="text-[12px] text-white/65 leading-relaxed mb-2 italic">
                                                    "{signal.quote}"
                                                </p>
                                                <div className="flex items-start gap-1.5 pt-2 border-t border-white/[0.05]">
                                                    <span className="text-[9px] font-bold text-blue-400/70 uppercase tracking-wider mt-0.5 shrink-0">Ask now</span>
                                                    <p className="text-[11px] text-blue-300/80 leading-relaxed">{signal.ask_now}</p>
                                                </div>
                                            </motion.div>
                                        ))}
                                    </div>
                                </SectionToggle>

                                <div className="h-px bg-white/[0.04] mx-4" />
                            </>
                        )}

                        {/* ── Objections ─────────────────────────── */}
                        {analysisData.objections.length > 0 && (
                            <SectionToggle
                                icon={<CheckSquare size={13} />}
                                title="Objections"
                                badge={`${analysisData.objections.length}`}
                                badgeColor="bg-white/10 text-white/40"
                            >
                                <div className="space-y-2 mt-1">
                                    {analysisData.objections.map((obj, i) => {
                                        const isChecked = checkedObjections.has(i);
                                        return (
                                            <motion.button
                                                key={i}
                                                initial={{ opacity: 0, x: -4 }}
                                                animate={{ opacity: 1, x: 0 }}
                                                transition={{ delay: i * 0.05 }}
                                                onClick={() => toggleObjection(i)}
                                                className={`w-full flex items-start gap-3 px-3.5 py-3 rounded-xl border text-left transition-all duration-200 ${isChecked
                                                    ? 'border-white/[0.04] bg-white/[0.01] opacity-50'
                                                    : obj.type === 'ae_deferral'
                                                        ? 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/8'
                                                        : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'
                                                    }`}
                                            >
                                                {/* Checkbox */}
                                                <div className={`mt-0.5 w-4 h-4 rounded shrink-0 flex items-center justify-center border transition-all ${isChecked
                                                    ? 'bg-emerald-500/80 border-emerald-500'
                                                    : 'border-white/20 bg-transparent'
                                                    }`}>
                                                    {isChecked && (
                                                        <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                                                            <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                                        </svg>
                                                    )}
                                                </div>

                                                <div className="flex-1 min-w-0">
                                                    <p className={`text-[12px] leading-relaxed transition-all ${isChecked ? 'line-through text-white/25' : 'text-white/65'
                                                        }`}>
                                                        {obj.quote}
                                                    </p>
                                                    <div className="flex items-center gap-1.5 mt-1">
                                                        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${obj.type === 'ae_deferral'
                                                            ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                                                            : 'text-white/30 bg-white/5 border-white/10'
                                                            }`}>
                                                            {obj.type === 'ae_deferral' ? 'Follow up' : 'Open question'}
                                                        </span>
                                                        <span className="text-[9px] text-white/20 capitalize">{obj.owner}</span>
                                                    </div>
                                                </div>
                                            </motion.button>
                                        );
                                    })}
                                </div>
                            </SectionToggle>
                        )}
                    </motion.div>
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