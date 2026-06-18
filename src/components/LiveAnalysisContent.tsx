import React, { useState } from 'react';
import { Shield, BarChart2, AlertTriangle, Zap, CheckSquare, ChevronDown, ChevronUp, Calculator, TrendingUp, TrendingDown } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { LiveAnalysisData } from '../types/liveAnalysis';
import { useResolvedTheme } from '../hooks/useResolvedTheme';

// ─── Status helpers — overlay (dark glass) variants ────────────────────────
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

// ─── Status helpers — analysis tab (theme-aware) variants ──────────────────
const statusDotThemed = (status: string) => {
    if (status === 'confirmed') return 'bg-emerald-500';
    if (status === 'partial') return 'bg-amber-500';
    return 'bg-slate-300 dark:bg-slate-600';
};

const statusRingThemed = (status: string, isLight: boolean) => {
    if (status === 'confirmed') return isLight
        ? 'border-emerald-200 bg-emerald-50'
        : 'border-emerald-500/25 bg-emerald-500/5';
    if (status === 'partial') return isLight
        ? 'border-amber-200 bg-amber-50'
        : 'border-amber-500/25 bg-amber-500/5';
    return isLight
        ? 'border-slate-200 bg-slate-50'
        : 'border-white/[0.06] bg-white/[0.02]';
};

const emojiColorThemed = (status: string, isLight: boolean) => {
    if (status === 'confirmed') return isLight ? 'text-emerald-600' : 'text-emerald-400';
    if (status === 'partial') return isLight ? 'text-amber-600' : 'text-amber-400';
    return isLight ? 'text-slate-300' : 'text-white/20';
};

const signalTypeColor = (type: string) => {
    const map: Record<string, string> = {
        buying_intent: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
        aspiration: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
        engagement: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',
        validation_seeking: 'bg-violet-500/15 text-violet-400 border-violet-500/25',
        authority_signal: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
        frustration: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
        risk: 'bg-red-500/15 text-red-400 border-red-500/25',
        urgency: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
        competitor_signal: 'bg-red-500/15 text-red-300 border-red-500/20',
        stall_signal: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25',
        cost: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
        process_signal: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25',
        timeline: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
    };
    return map[type] || 'bg-white/10 text-white/50 border-white/10';
};

const signalTypeColorThemed = (type: string, isLight: boolean) => {
    const map: Record<string, [string, string]> = {
        buying_intent: ['bg-emerald-100 text-emerald-700 border-emerald-200', 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25'],
        aspiration: ['bg-blue-100 text-blue-700 border-blue-200', 'bg-blue-500/15 text-blue-400 border-blue-500/25'],
        engagement: ['bg-cyan-100 text-cyan-700 border-cyan-200', 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25'],
        validation_seeking: ['bg-violet-100 text-violet-700 border-violet-200', 'bg-violet-500/15 text-violet-400 border-violet-500/25'],
        authority_signal: ['bg-emerald-100 text-emerald-600 border-emerald-200', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'],
        frustration: ['bg-amber-100 text-amber-700 border-amber-200', 'bg-amber-500/15 text-amber-400 border-amber-500/25'],
        risk: ['bg-red-100 text-red-700 border-red-200', 'bg-red-500/15 text-red-400 border-red-500/25'],
        urgency: ['bg-orange-100 text-orange-700 border-orange-200', 'bg-orange-500/15 text-orange-400 border-orange-500/25'],
        competitor_signal: ['bg-red-100 text-red-600 border-red-200', 'bg-red-500/15 text-red-300 border-red-500/20'],
        stall_signal: ['bg-slate-100 text-slate-600 border-slate-200', 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25'],
        cost: ['bg-orange-100 text-orange-700 border-orange-200', 'bg-orange-500/15 text-orange-400 border-orange-500/25'],
        process_signal: ['bg-indigo-100 text-indigo-700 border-indigo-200', 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25'],
        timeline: ['bg-purple-100 text-purple-700 border-purple-200', 'bg-purple-500/15 text-purple-400 border-purple-500/25'],
    };
    const pair = map[type];
    if (!pair) return isLight ? 'bg-slate-100 text-slate-500 border-slate-200' : 'bg-white/10 text-white/50 border-white/10';
    return isLight ? pair[0] : pair[1];
};

// ─── SectionToggle ─────────────────────────────────────────────────────────

interface SectionToggleProps {
    icon: React.ReactNode;
    title: string;
    badge?: string;
    badgeColor?: string;
    children: React.ReactNode;
    defaultOpen?: boolean;
    themed?: boolean;
    isLight?: boolean;
}

const SectionToggle: React.FC<SectionToggleProps> = ({
    icon, title, badge, badgeColor = 'bg-white/10 text-white/50',
    children, defaultOpen = false, themed = false, isLight = false,
}) => {
    const [open, setOpen] = useState(defaultOpen);

    if (themed) {
        return (
            <div className="mb-1">
                <button
                    onClick={() => setOpen(v => !v)}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 transition-colors group rounded-lg ${isLight ? 'hover:bg-slate-100' : 'hover:bg-white/[0.03]'
                        }`}
                >
                    <span className={`transition-colors ${isLight ? 'text-slate-400 group-hover:text-slate-600' : 'text-white/40 group-hover:text-white/60'}`}>
                        {icon}
                    </span>
                    <span className={`text-[11px] font-bold uppercase tracking-[0.12em] flex-1 text-left transition-colors ${isLight ? 'text-slate-500 group-hover:text-slate-700' : 'text-white/50 group-hover:text-white/70'
                        }`}>
                        {title}
                    </span>
                    {badge && (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeColor}`}>
                            {badge}
                        </span>
                    )}
                    <span className={`transition-colors ${isLight ? 'text-slate-300 group-hover:text-slate-500' : 'text-white/20 group-hover:text-white/40'}`}>
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
                            <div className="px-4 pb-2">{children}</div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        );
    }

    // Original overlay variant
    return (
        <div className="mb-1">
            <button
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center gap-2.5 px-4 py-2 hover:bg-white/[0.03] transition-colors group"
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
                        <div className="px-4 pb-2">{children}</div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ─── FieldRow ──────────────────────────────────────────────────────────────

interface FieldRowProps {
    label: string;
    field: { status: string; evidence: string; emoji?: string; suggested_question?: string };
    themed?: boolean;
    isLight?: boolean;
}

const FieldRow: React.FC<FieldRowProps> = ({ label, field, themed = false, isLight = false }) => {
    if (themed) {
        return (
            <div className={`rounded-xl border px-3 py-2 mb-1.5 last:mb-0 ${statusRingThemed(field.status, isLight)}`}>
                <div className="flex items-center justify-between mb-0.5">
                    <span className={`text-[9px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-slate-400' : 'text-white/30'}`}>
                        {label}
                    </span>
                    <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${statusDotThemed(field.status)}`} />
                        <span className={`text-[10px] font-bold capitalize ${emojiColorThemed(field.status, isLight)}`}>
                            {field.status || 'missing'}
                        </span>
                    </div>
                </div>
                {field.evidence ? (
                    <p className={`text-[12px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-white/65'}`}>
                        {field.evidence}
                    </p>
                ) : field.suggested_question ? (
                    <div className="flex items-start gap-1.5">
                        <span className="text-[9px] font-bold text-blue-500 uppercase tracking-wider mt-[2px] shrink-0">Ask this</span>
                        <p className={`text-[11px] leading-relaxed ${isLight ? 'text-blue-600' : 'text-blue-300/80'}`}>
                            {field.suggested_question}
                        </p>
                    </div>
                ) : (
                    <p className={`text-[12px] italic ${isLight ? 'text-slate-400' : 'text-white/25'}`}>
                        Not yet captured — listen for clues
                    </p>
                )}
            </div>
        );
    }

    // Original overlay variant
    return (
        <div className={`rounded-xl border px-3 py-2 mb-1.5 last:mb-0 ${statusRing(field.status)}`}>
            <div className="flex items-center justify-between mb-0.5">
                <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">{label}</span>
                <div className="flex items-center gap-1.5">
                    <div className={`w-1.5 h-1.5 rounded-full ${statusDot(field.status)}`} />
                    <span className={`text-[10px] font-bold capitalize ${emojiColor(field.status)}`}>
                        {field.status || 'missing'}
                    </span>
                </div>
            </div>
            {field.evidence ? (
                <p className="text-[12px] text-white/65 leading-normal">{field.evidence}</p>
            ) : field.suggested_question ? (
                <div className="flex items-start gap-1.5">
                    <span className="text-[9px] font-bold text-blue-400/70 uppercase tracking-wider mt-[2px] shrink-0">Ask this</span>
                    <p className="text-[11px] text-blue-300/80 leading-relaxed">{field.suggested_question}</p>
                </div>
            ) : (
                <p className="text-[12px] text-white/25 italic">
                    Not yet captured
                </p>
            )}
        </div>
    );
};

// ─── Props ─────────────────────────────────────────────────────────────────

interface LiveAnalysisContentProps {
    analysisData: LiveAnalysisData;
    aiInsight?: string;
    hideBar?: 'MEDDICC Details' | 'BANT Details' | 'Missing Details' | 'Buying Signals' | 'Objections' | 'AI Insights' | null;
    /** Pass true when rendered inside the Call Analysis tab (MeetingDetails).
     *  Enables full theme awareness (light/dark). Overlay callers omit this. */
    calledFromAnalysisTab?: boolean;
    /** When set (overlay context), renders only the active tab section — fully expanded, no accordion. */
    activeTab?: 'meddicc' | 'bant' | 'signals' | 'objections';
}

// ─── Main component ────────────────────────────────────────────────────────

export const LiveAnalysisContent: React.FC<LiveAnalysisContentProps> = ({
    analysisData,
    // aiInsight,
    hideBar = null,
    calledFromAnalysisTab = false,
    activeTab,
}) => {
    // Only consume theme hook when rendered in analysis tab context.
    // Overlay callers always render dark-glass regardless of system theme.
    const resolvedTheme = useResolvedTheme();
    const isLight = calledFromAnalysisTab && resolvedTheme === 'light';

    const meddicFound = Object.values(analysisData.meddic).filter(f => f.status === 'confirmed').length;
    const bantConfirmed = Object.values(analysisData.bant).filter(f => f.status === 'confirmed').length;
    const bantPct = Math.round((bantConfirmed / 4) * 100);

    const missingSignals = [
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
    ];

    const [checkedObjections, setCheckedObjections] = useState<Set<string>>(new Set());
    const toggleObjection = (id: string) => {
        setCheckedObjections(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const [dismissedSignals, setDismissedSignals] = useState<Set<string>>(new Set());
    const dismissSignal = (id: string) => {
        setDismissedSignals(prev => { const n = new Set(prev); n.add(id); return n; });
    };

    const restoreSignal = (id: string) => {
        setDismissedSignals(prev => {
            const n = new Set(prev);
            n.delete(id);
            if (n.size === 0) setDismissedDrawerOpen(false);
            return n;
        });
    };

    const [dismissedDrawerOpen, setDismissedDrawerOpen] = useState(false);

    // ── Divider ──────────────────────────────────────────────────────────────
    const Divider = () => (
        <div className={`h-px mx-4 ${isLight ? 'bg-slate-200' : 'bg-white/[0.04]'}`} />
    );

    // ── Badge color helpers ──────────────────────────────────────────────────
    const meddicBadge = (found: number) => {
        if (found >= 5) return isLight
            ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
            : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25';
        if (found >= 3) return isLight
            ? 'bg-amber-100 text-amber-700 border border-amber-200'
            : 'bg-amber-500/15 text-amber-400 border border-amber-500/25';
        return isLight
            ? 'bg-red-100 text-red-700 border border-red-200'
            : 'bg-red-500/15 text-red-400 border border-red-500/25';
    };

    const bantBadge = (pct: number) => {
        if (pct >= 75) return isLight
            ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
            : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25';
        if (pct >= 50) return isLight
            ? 'bg-amber-100 text-amber-700 border border-amber-200'
            : 'bg-amber-500/15 text-amber-400 border border-amber-500/25';
        return isLight
            ? 'bg-red-100 text-red-700 border border-red-200'
            : 'bg-red-500/15 text-red-400 border border-red-500/25';
    };

    const signalsBadge = () => {
        if (analysisData.signals.some(s => s.category === 'negative' && s.intensity === 'high'))
            return isLight
                ? 'bg-red-100 text-red-700 border border-red-200'
                : 'bg-red-500/15 text-red-400 border border-red-500/25';
        if (analysisData.signals.some(s => s.category === 'positive'))
            return isLight
                ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25';
        return isLight
            ? 'bg-blue-100 text-blue-700 border border-blue-200'
            : 'bg-blue-500/15 text-blue-400 border border-blue-500/25';
    };

    const objectionsBadge = isLight
        ? 'bg-slate-100 text-slate-600 border border-slate-200'
        : 'bg-white/10 text-white/40';

    // ── Shared signal list renderer ───────────────────────────────────────────
    // Used in both the tabbed overlay (activeTab='signals') and the accordion
    // (calledFromAnalysisTab) so dismiss/restore state is shared.
    const renderSignalList = (paddingCls = 'pt-2 pb-2') => {
        const activeSignals = analysisData.signals.filter(s => !dismissedSignals.has(s.id ?? s.quote));
        const archivedSignals = analysisData.signals.filter(s => dismissedSignals.has(s.id ?? s.quote));

        const stripe = (cat: string, intensity: string) => {
            if (cat === 'negative' && intensity === 'high') return 'bg-red-500';
            if (cat === 'negative') return 'bg-amber-400';
            if (cat === 'positive') return 'bg-emerald-400';
            return 'bg-white/20';
        };
        const intensityDot = (cat: string, intensity: string) => {
            if (cat === 'negative' && intensity === 'high') return 'bg-red-500';
            if (cat === 'negative') return 'bg-amber-400';
            return 'bg-white/20';
        };

        return (
            <div className={paddingCls}>
                {/* ── Active signals ── */}
                {activeSignals.length === 0 && (
                    <p className="text-[12px] text-white/30 text-center py-10">No signals detected yet</p>
                )}

                <AnimatePresence initial={false}>
                    {activeSignals.map(signal => (
                        <motion.div
                            key={signal.id ?? signal.quote}
                            initial={{ opacity: 0, height: 'auto' }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
                            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                            className="border-b border-white/[0.04] last:border-b-0"
                        >
                            <div className="flex items-start gap-2 py-2.5 px-4 group">
                                <div className={`w-0.5 self-stretch rounded-full shrink-0 mt-0.5 ${stripe(signal.category, signal.intensity)}`} />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-1 mb-1">
                                        <div className="flex flex-wrap gap-1.5">
                                            {signal.signal_type.slice(0, 2).map((type, j) => (
                                                <span
                                                    key={j}
                                                    className={`text-[10px] font-bold uppercase tracking-wider px-1 py-0.5 rounded border ${calledFromAnalysisTab
                                                        ? signalTypeColorThemed(type, isLight)
                                                        : signalTypeColor(type)
                                                        }`}
                                                >
                                                    {type.replace(/_/g, ' ')}
                                                </span>
                                            ))}
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <div className={`w-1.5 h-1.5 rounded-full ${intensityDot(signal.category, signal.intensity)}`} />
                                            <span className={`text-[10px] capitalize ${calledFromAnalysisTab ? (isLight ? 'text-slate-400' : 'text-white/25') : 'text-white/25'}`}>
                                                {signal.intensity}
                                            </span>
                                            {/* Dismiss button — appears on hover */}
                                            <button
                                                onClick={() => dismissSignal(signal.id ?? signal.quote)}
                                                title="Dismiss signal"
                                                className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 w-4 h-4 rounded flex items-center justify-center hover:bg-white/10"
                                                style={{ color: 'rgba(255,255,255,0.25)' }}
                                            >
                                                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                                                    <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                    <p className={`text-[12px] italic ${calledFromAnalysisTab ? (isLight ? 'text-slate-600' : 'text-white/60') : 'text-white/60'}`}>
                                        "{signal.quote}"
                                    </p>
                                </div>
                            </div>
                            {/* Ask now — always visible */}
                            {signal.ask_now && (
                                <div className="flex items-start gap-1 pb-2.5 pl-5">
                                    <span className={`text-[8px] font-bold uppercase tracking-wider mt-0.5 shrink-0 ${calledFromAnalysisTab ? (isLight ? 'text-blue-500' : 'text-blue-400/60') : 'text-blue-400/60'}`}>
                                        Ask
                                    </span>
                                    <p className={`text-[10px] leading-snug ${calledFromAnalysisTab ? (isLight ? 'text-blue-600' : 'text-blue-300/70') : 'text-blue-300/70'}`}>
                                        {signal.ask_now}
                                    </p>
                                </div>
                            )}
                        </motion.div>
                    ))}
                </AnimatePresence>

                {/* ── Dismissed drawer ── */}
                {archivedSignals.length > 0 && (
                    <div className="mt-2 mx-3">
                        <button
                            onClick={() => setDismissedDrawerOpen(v => !v)}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors hover:bg-white/[0.04]"
                            style={{ border: '1px solid rgba(255,255,255,0.06)' }}
                        >
                            <span className="text-[10px] font-bold uppercase tracking-wider text-white/25 flex-1 text-left">
                                Dismissed
                            </span>
                            <span
                                className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                                style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }}
                            >
                                {archivedSignals.length}
                            </span>
                            <span className="text-white/20">
                                {dismissedDrawerOpen
                                    ? <ChevronUp size={11} />
                                    : <ChevronDown size={11} />}
                            </span>
                        </button>

                        <AnimatePresence initial={false}>
                            {dismissedDrawerOpen && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                                    className="overflow-hidden"
                                >
                                    <div className="pt-1 pb-2 space-y-0">
                                        {archivedSignals.map(signal => (
                                            <div
                                                key={signal.id ?? signal.quote}
                                                className="flex items-start gap-2 px-3 py-2 opacity-40 hover:opacity-70 transition-opacity"
                                            >
                                                <div className={`w-0.5 self-stretch rounded-full shrink-0 mt-0.5 ${stripe(signal.category, signal.intensity)}`} />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-[11px] italic text-white/50 line-clamp-1">
                                                        "{signal.quote}"
                                                    </p>
                                                    {signal.ask_now && (
                                                        <p className="text-[10px] text-blue-300/50 mt-0.5">{signal.ask_now}</p>
                                                    )}
                                                </div>
                                                {/* Restore button */}
                                                <button
                                                    onClick={() => restoreSignal(signal.id ?? signal.quote)}
                                                    title="Restore signal"
                                                    className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-white/30 hover:text-white/60 transition-colors px-1.5 py-1 rounded hover:bg-white/[0.06] mt-0.5"
                                                >
                                                    ↩
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                )}
            </div>
        );
    };

    // ── Tabbed overlay render (FloatingIntelligencePanel context) ─────────────
    // When activeTab is provided we render one section at a time, always fully
    // expanded — no accordion, no scrolling across sections.
    if (activeTab !== undefined) {
        const tabContent = () => {
            switch (activeTab) {
                case 'meddicc':
                    return (
                        <div className="px-3 pt-2 pb-4 space-y-1.5">
                            {(['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'competition'] as const).map(key => (
                                <FieldRow
                                    key={key}
                                    label={key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                    field={analysisData.meddic[key]}
                                    themed={false}
                                    isLight={false}
                                />
                            ))}
                        </div>
                    );
                case 'bant':
                    return (
                        <div className="px-3 pt-2 pb-4 space-y-1.5">
                            {(['budget', 'authority', 'need', 'timeline'] as const).map(key => (
                                <FieldRow
                                    key={key}
                                    label={key.charAt(0).toUpperCase() + key.slice(1)}
                                    field={analysisData.bant[key]}
                                    themed={false}
                                    isLight={false}
                                />
                            ))}
                        </div>
                    );
                case 'signals':
                    return renderSignalList('pt-2 pb-4');
                case 'objections':
                    if (analysisData.objections.length === 0) {
                        return (
                            <div className="flex flex-col items-center justify-center h-full py-16 gap-2">
                                <p className="text-[12px] text-white/30">No objections logged yet</p>
                            </div>
                        );
                    }
                    return (
                        <div className="px-3 pt-2 pb-4 space-y-1.5">
                            {analysisData.objections.map((obj) => {
                                const isChecked = checkedObjections.has(obj.id ?? obj.quote);
                                const cardClass = isChecked
                                    ? 'border-white/[0.04] bg-white/[0.01] opacity-50'
                                    : obj.type === 'ae_deferral'
                                        ? 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/8'
                                        : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]';
                                const checkboxClass = isChecked
                                    ? 'bg-emerald-500/80 border-emerald-500'
                                    : 'border-white/20 bg-transparent';
                                const quoteClass = isChecked ? 'line-through text-white/25' : 'text-white/65';
                                const tagClass = obj.type === 'ae_deferral'
                                    ? 'text-amber-600 bg-amber-50 border-amber-200'
                                    : 'text-white/30 bg-white/5 border-white/10';
                                return (
                                    <motion.button
                                        key={obj.id ?? obj.quote}
                                        initial={{ opacity: 0, x: -4 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ delay: 0 }}
                                        onClick={() => toggleObjection(obj.id ?? obj.quote)}
                                        className={`w-full flex items-start gap-2.5 px-3 py-2 rounded-xl border text-left transition-all duration-200 ${cardClass}`}
                                    >
                                        <div className={`mt-0.5 w-4 h-4 rounded shrink-0 flex items-center justify-center border transition-all ${checkboxClass}`}>
                                            {isChecked && (
                                                <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                                                    <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                                </svg>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className={`text-[12px] leading-relaxed transition-all ${quoteClass}`}>{obj.quote}</p>
                                            {!isChecked && obj.type === 'customer_question' && obj.suggested_answer && (
                                                <div className="flex items-start gap-1.5 rounded-md px-1 py-1.5">
                                                    <TrendingUp size={9} className="shrink-0 mt-0.5 text-blue-400/70" />
                                                    <p className="text-[10px] leading-snug text-blue-300/80">{obj.suggested_answer}</p>
                                                </div>
                                            )}
                                            <div className="flex items-center gap-1.5 mt-0.5">
                                                <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${tagClass}`}>
                                                    {obj.type === 'ae_deferral' ? 'Follow up' : 'Open question'}
                                                </span>
                                                <span className="text-[9px] capitalize text-white/20">{obj.owner}</span>
                                            </div>
                                        </div>
                                    </motion.button>
                                );
                            })}
                        </div>
                    );
            }
        };

        return (
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar no-drag">
                {tabContent()}
            </div>
        );
    }

    return (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar pb-6 no-drag">

            {/* ── MEDDICC ──────────────────────────────────────────────────── */}
            {hideBar !== 'MEDDICC Details' && (
                <>
                    <SectionToggle
                        icon={<Shield size={13} />}
                        title="MEDDICC Details"
                        badge={`${meddicFound}/7 Found`}
                        badgeColor={meddicBadge(meddicFound)}
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        <div className="space-y-1.5 mt-1">
                            {(['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'competition'] as const).map(key => (
                                <FieldRow
                                    key={key}
                                    label={key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                    field={analysisData.meddic[key]}
                                    themed={calledFromAnalysisTab}
                                    isLight={isLight}
                                />
                            ))}
                        </div>
                    </SectionToggle>
                    <Divider />
                </>
            )}

            {/* ── BANT ─────────────────────────────────────────────────────── */}
            {hideBar !== 'BANT Details' && (
                <>
                    <SectionToggle
                        icon={<BarChart2 size={13} />}
                        title="BANT Details"
                        badge={`${bantConfirmed}/4 Found`}
                        badgeColor={bantBadge(bantPct)}
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        <div className="space-y-1.5 mt-1">
                            {(['budget', 'authority', 'need', 'timeline'] as const).map(key => (
                                <FieldRow
                                    key={key}
                                    label={key.charAt(0).toUpperCase() + key.slice(1)}
                                    field={analysisData.bant[key]}
                                    themed={calledFromAnalysisTab}
                                    isLight={isLight}
                                />
                            ))}
                        </div>
                    </SectionToggle>
                    <Divider />
                </>
            )}

            {/* ── Missing Signals ───────────────────────────────────────────── */}
            {missingSignals.length > 0 && hideBar !== 'Missing Details' && (
                <>
                    <Divider />
                    <SectionToggle
                        icon={<AlertTriangle size={13} />}
                        title="What I'm Missing"
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        <div className="space-y-1.5 mt-1">
                            {missingSignals.map((signal, i) => {
                                const cardClass = calledFromAnalysisTab
                                    ? signal.icon === '!'
                                        ? isLight
                                            ? 'border-red-200 bg-red-50'
                                            : 'border-red-500/25 bg-red-500/5'
                                        : isLight
                                            ? 'border-slate-200 bg-slate-50'
                                            : 'border-white/[0.08] bg-white/[0.02]'
                                    : signal.icon === '!'
                                        ? 'border-red-500/25 bg-red-500/5'
                                        : 'border-white/[0.08] bg-white/[0.02]';

                                const iconClass = calledFromAnalysisTab
                                    ? signal.icon === '!'
                                        ? 'bg-red-100 text-red-600'
                                        : isLight ? 'bg-slate-200 text-slate-500' : 'bg-white/10 text-white/40'
                                    : signal.icon === '!'
                                        ? 'bg-red-500/20 text-red-400'
                                        : 'bg-white/10 text-white/40';

                                return (
                                    <motion.div
                                        key={i}
                                        initial={{ opacity: 0, x: -4 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ delay: i * 0.06 }}
                                        className={`rounded-xl border px-3.5 py-3 ${cardClass}`}
                                    >
                                        <div className="flex items-start gap-2.5">
                                            <span className={`text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${iconClass}`}>
                                                {signal.icon}
                                            </span>
                                            <div>
                                                <p className={`text-[12px] font-semibold mb-0.5 ${calledFromAnalysisTab ? (isLight ? 'text-slate-700' : 'text-white/70') : 'text-white/70'}`}>
                                                    {signal.title}
                                                </p>
                                                <p className={`text-[11px] leading-relaxed ${calledFromAnalysisTab ? (isLight ? 'text-slate-500' : 'text-white/40') : 'text-white/40'}`}>
                                                    {signal.desc}
                                                </p>
                                            </div>
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </div>
                    </SectionToggle>
                    <Divider />
                </>
            )}

            {/* ── Buying Signals ────────────────────────────────────────────── */}
            {analysisData.signals.length > 0 && hideBar !== 'Buying Signals' && (
                <>
                    <SectionToggle
                        icon={<Zap size={13} />}
                        title="Buying Signals"
                        badge={`${Math.max(0, analysisData.signals.length - dismissedSignals.size)}`}
                        badgeColor={signalsBadge()}
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        {renderSignalList('mt-1 -mx-4')}
                    </SectionToggle>
                    <Divider />
                </>
            )}

            {/* ── Objections ────────────────────────────────────────────────── */}
            {analysisData.objections.length > 0 && hideBar !== 'Objections' && (
                <>
                    <SectionToggle
                        icon={<CheckSquare size={13} />}
                        title="Objections"
                        badge={`${analysisData.objections.length}`}
                        badgeColor={objectionsBadge}
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        <div className="space-y-2 mt-1">
                            {analysisData.objections.map((obj, i) => {
                                const isChecked = checkedObjections.has(obj.id ?? obj.quote);

                                const cardClass = calledFromAnalysisTab
                                    ? isChecked
                                        ? isLight ? 'border-slate-100 bg-slate-50 opacity-50' : 'border-white/[0.04] bg-white/[0.01] opacity-50'
                                        : obj.type === 'ae_deferral'
                                            ? isLight ? 'border-amber-200 bg-amber-50 hover:bg-amber-100' : 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/8'
                                            : isLight ? 'border-slate-200 bg-white hover:bg-slate-50' : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'
                                    : isChecked
                                        ? 'border-white/[0.04] bg-white/[0.01] opacity-50'
                                        : obj.type === 'ae_deferral'
                                            ? 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/8'
                                            : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]';

                                const checkboxClass = isChecked
                                    ? 'bg-emerald-500/80 border-emerald-500'
                                    : calledFromAnalysisTab
                                        ? isLight ? 'border-slate-300 bg-transparent' : 'border-white/20 bg-transparent'
                                        : 'border-white/20 bg-transparent';

                                const quoteClass = isChecked
                                    ? calledFromAnalysisTab
                                        ? isLight ? 'line-through text-slate-300' : 'line-through text-white/25'
                                        : 'line-through text-white/25'
                                    : calledFromAnalysisTab
                                        ? isLight ? 'text-slate-700' : 'text-white/65'
                                        : 'text-white/65';

                                const tagClass = obj.type === 'ae_deferral'
                                    ? 'text-amber-600 bg-amber-50 border-amber-200'
                                    : calledFromAnalysisTab
                                        ? isLight ? 'text-slate-500 bg-slate-50 border-slate-200' : 'text-white/30 bg-white/5 border-white/10'
                                        : 'text-white/30 bg-white/5 border-white/10';

                                const ownerClass = calledFromAnalysisTab
                                    ? isLight ? 'text-slate-400' : 'text-white/20'
                                    : 'text-white/20';

                                return (
                                    <motion.button
                                        key={obj.id ?? obj.quote}
                                        initial={{ opacity: 0, x: -4 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ delay: 0 }}
                                        onClick={() => toggleObjection(obj.id ?? obj.quote)}
                                        className={`w-full flex items-start gap-2.5 px-3 py-2 rounded-xl border text-left transition-all duration-200 ${cardClass}`}
                                    >
                                        <div className={`mt-0.5 w-4 h-4 rounded shrink-0 flex items-center justify-center border transition-all ${checkboxClass}`}>
                                            {isChecked && (
                                                <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                                                    <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                                </svg>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className={`text-[12px] leading-relaxed transition-all ${quoteClass}`}>
                                                {obj.quote}
                                            </p>
                                            {/* Suggested answer — only for customer questions */}
                                            {!isChecked && obj.type === 'customer_question' && obj.suggested_answer && (
                                                <div className={`flex items-start gap-1.5 rounded-md px-1 py-1.5`}>
                                                    <TrendingUp size={9} className={`shrink-0 mt-0.5 ${calledFromAnalysisTab ? (isLight ? 'text-blue-500' : 'text-blue-400/70') : 'text-blue-400/70'
                                                        }`} />
                                                    <p className={`text-[10px] leading-snug ${calledFromAnalysisTab ? (isLight ? 'text-blue-700' : 'text-blue-300/80') : 'text-blue-300/80'
                                                        }`}>
                                                        {obj.suggested_answer}
                                                    </p>
                                                </div>
                                            )}
                                            <div className="flex items-center gap-1.5 mt-1">
                                                <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${tagClass}`}>
                                                    {obj.type === 'ae_deferral' ? 'Follow up' : 'Open question'}
                                                </span>
                                                <span className={`text-[9px] capitalize ${ownerClass}`}>{obj.owner}</span>
                                            </div>
                                        </div>
                                    </motion.button>
                                );
                            })}
                        </div>
                    </SectionToggle>
                    <Divider />
                </>
            )}
        </div>
    );
};