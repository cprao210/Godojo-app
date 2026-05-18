import React, { useState } from 'react';
import { Shield, BarChart2, AlertTriangle, Zap, CheckSquare, ChevronDown, ChevronUp } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { LiveAnalysisData } from '../types/liveAnalysis';

// Helper functions (copied from LiveAnalysisOverlay)
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
        // Positive
        buying_intent: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
        aspiration: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
        engagement: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',
        validation_seeking: 'bg-violet-500/15 text-violet-400 border-violet-500/25',
        authority_signal: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
        // Negative
        frustration: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
        risk: 'bg-red-500/15 text-red-400 border-red-500/25',
        urgency: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
        competitor_signal: 'bg-red-500/15 text-red-300 border-red-500/20',
        stall_signal: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25',
        // Neutral
        cost: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
        process_signal: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25',
        timeline: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
    };
    return map[type] || 'bg-white/10 text-white/50 border-white/10';
};

const SectionToggle: React.FC<{
    icon: React.ReactNode;
    title: string;
    badge?: string;
    badgeColor?: string;
    children: React.ReactNode;
    defaultOpen?: boolean;
}> = ({ icon, title, badge, badgeColor = 'bg-white/10 text-white/50', children, defaultOpen = false }) => {
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
    field: { status: string; evidence: string; emoji?: string; suggested_question?: string };
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
        ) : field.suggested_question ? (
            <div className="flex items-start gap-1.5">
                <span className="text-[9px] font-bold text-blue-400/70 uppercase tracking-wider mt-[2px] shrink-0">Ask this</span>
                <p className="text-[11px] text-blue-300/80 leading-relaxed">{field.suggested_question}</p>
            </div>
        ) : (
            <p className="text-[12px] text-white/20 italic">Not mentioned</p>
        )}
    </div>
);

interface LiveAnalysisContentProps {
    analysisData: LiveAnalysisData;
    aiInsight?: string;
    hideBar?: "MEDDICC Details" | "BANT Details" | "Missing Details" | "Buying Signals" | "Objections" | "AI Insights" | null;
}

export const LiveAnalysisContent: React.FC<LiveAnalysisContentProps> = ({ analysisData, hideBar = null }) => {
    const meddicFound = Object.values(analysisData.meddic).filter(f => f.status === 'confirmed').length;
    const bantConfirmed = Object.values(analysisData.bant).filter(f => f.status === 'confirmed').length;
    const bantPct = Math.round((bantConfirmed / 4) * 100);

    // Build missing signals array
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

    const [checkedObjections, setCheckedObjections] = useState<Set<number>>(new Set());

    const toggleObjection = (index: number) => {
        setCheckedObjections(prev => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    return (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar pb-6 no-drag">
            {/* {aiInsight && hideBar !== "AI Insights" && (
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
            )} */}

            {hideBar !== "MEDDICC Details" && (
                <>
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
                </>
            )}

            {hideBar !== "BANT Details" && (
                <>
                    <SectionToggle
                        icon={<BarChart2 size={13} />}
                        title="BANT Details"
                        badge={`${bantConfirmed}/4 Found`}
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
                </>
            )}

            {missingSignals.length > 0 && hideBar !== "Missing Details" && (
                <>
                    <div className="h-px bg-white/[0.04] mx-4" />
                    <SectionToggle icon={<AlertTriangle size={13} />} title="What I'm Missing">
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

            {analysisData.signals.length > 0 && hideBar !== "Buying Signals" && (
                <>
                    <SectionToggle
                        icon={<Zap size={13} />}
                        title="Buying Signals"
                        badge={`${analysisData.signals.length}`}
                        badgeColor={
                            analysisData.signals.some(s => s.category === 'negative' && s.intensity === 'high')
                                ? 'bg-red-500/15 text-red-400 border border-red-500/25'
                                : analysisData.signals.some(s => s.category === 'positive')
                                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                                    : 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                        }
                    >
                        <div className="space-y-2.5 mt-1">
                            {analysisData.signals.map((signal, i) => {

                                const cardBorder =
                                    signal.category === 'negative' && signal.intensity === 'high'
                                        ? 'border-red-500/20 bg-red-500/[0.03]'
                                        : signal.category === 'negative'
                                            ? 'border-amber-500/15 bg-amber-500/[0.02]'
                                            : signal.category === 'positive'
                                                ? 'border-emerald-500/15 bg-emerald-500/[0.02]'
                                                : 'border-white/[0.07] bg-white/[0.02]';

                                const intensityDot =
                                    signal.intensity === 'high' ? 'bg-red-400' :
                                        signal.intensity === 'medium' ? 'bg-amber-400' :
                                            'bg-white/20';

                                return (
                                    <motion.div
                                        key={i}
                                        initial={{ opacity: 0, y: 4 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: i * 0.05 }}
                                        className={`rounded-xl border px-3.5 py-3 ${cardBorder}`}
                                    >
                                        {/* Header row: tags + intensity */}
                                        <div className="flex items-start justify-between gap-2 mb-2">
                                            <div className="flex flex-wrap gap-1">
                                                {signal.signal_type.map((type, j) => (
                                                    <span
                                                        key={j}
                                                        className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md border ${signalTypeColor(type)}`}
                                                    >
                                                        {type.replace(/_/g, ' ')}
                                                    </span>
                                                ))}
                                            </div>
                                            {signal.intensity && (
                                                <div className="flex items-center gap-1 shrink-0">
                                                    <div className={`w-1.5 h-1.5 rounded-full ${intensityDot}`} />
                                                    <span className="text-[9px] text-white/25 capitalize">{signal.intensity}</span>
                                                </div>
                                            )}
                                        </div>

                                        {/* Quote */}
                                        <p className="text-[12px] text-white/65 leading-relaxed mb-2 italic">
                                            "{signal.quote}"
                                        </p>

                                        {/* Ask now */}
                                        <div className="flex items-start gap-1.5 pt-2 border-t border-white/[0.05]">
                                            <span className="text-[9px] font-bold text-blue-400/70 uppercase tracking-wider mt-0.5 shrink-0">Ask now</span>
                                            <p className="text-[11px] text-blue-300/80 leading-relaxed">{signal.ask_now}</p>
                                        </div>
                                    </motion.div>
                                );

                            })}
                        </div>
                    </SectionToggle>
                    <div className="h-px bg-white/[0.04] mx-4" />
                </>
            )}

            {analysisData.objections.length > 0 && hideBar !== "Objections" && (
                <>
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
                    <div className="h-px bg-white/[0.04] mx-4" />
                </>
            )}

        </div>
    );
};