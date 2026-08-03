import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, TrendingUp, Lightbulb, CheckCircle2, AlertCircle, Quote } from 'lucide-react';
import { ScoredCategory, MeetingType, RingProps, ScoreCardCategoryRowProps, ScorecardCardProps, MeetingScorecardPanelProps } from '@/types';
import { useResolvedTheme } from '@/hooks';

// ─── Accent palette per meeting type ─────────────────────────────────────────
const TYPE_ACCENT: Record<MeetingType, { color: string; glow: string; bg: string; border: string; label: string }> = {
    discovery: { color: '#a78bfa', glow: 'rgba(167,139,250,0.25)', bg: 'rgba(167,139,250,0.08)', border: 'rgba(167,139,250,0.22)', label: 'Discovery' },
    demo: { color: '#34d399', glow: 'rgba(52,211,153,0.25)', bg: 'rgba(52,211,153,0.07)', border: 'rgba(52,211,153,0.20)', label: 'Demo' },
    negotiation: { color: '#fbbf24', glow: 'rgba(251,191,36,0.25)', bg: 'rgba(251,191,36,0.07)', border: 'rgba(251,191,36,0.20)', label: 'Negotiation' },
};

// Fallback for meeting types outside the known union (e.g. a new/renamed type the
// LLM emits before this map is updated). The backend spreads the LLM's JSON output
// verbatim with no meetingType validation, so this lookup can't assume a hit.
// Mirrors the guard in MeetingDetails.tsx for the equivalent tab-pill lookup.
const DEFAULT_TYPE_ACCENT = { color: '#94a3b8', glow: 'rgba(148,163,184,0.25)', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.22)', label: '' };

const getTypeAccent = (type: string) => TYPE_ACCENT[type as MeetingType] ?? { ...DEFAULT_TYPE_ACCENT, label: type };

// ─── Score → semantic label ───────────────────────────────────────────────────
function scoreLabel(n: number) {
    if (n >= 80) return 'Excellent';
    if (n >= 65) return 'Strong';
    if (n >= 50) return 'Good';
    if (n >= 35) return 'Fair';
    return 'Needs Work';
}

// ─── Mini circular ring (compact, 48px) ──────────────────────────────────────
const ScoreRing: React.FC<RingProps> = ({ score, color, size = 48, strokeWidth = 3.5 }) => {
    const r = (size - strokeWidth * 2) / 2;
    const circ = 2 * Math.PI * r;
    const cx = size / 2;
    return (
        <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
                <circle cx={cx} cy={cx} r={r} fill="none" stroke={`${color}1e`} strokeWidth={strokeWidth} />
                <motion.circle
                    cx={cx} cy={cx} r={r} fill="none"
                    stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
                    strokeDasharray={circ}
                    initial={{ strokeDashoffset: circ }}
                    animate={{ strokeDashoffset: circ - (score / 100) * circ }}
                    transition={{ duration: 0.8, ease: [0.33, 1, 0.68, 1] }}
                    style={{ filter: `drop-shadow(0 0 3px ${color}88)` }}
                />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
                <span className="font-bold tabular-nums" style={{ fontSize: size * 0.27, color, lineHeight: 1 }}>{score}</span>
            </div>
        </div>
    );
};

// ─── Category row (compact) ───────────────────────────────────────────────────
const CategoryRow: React.FC<ScoreCardCategoryRowProps> = ({ cat, accent, index, isLight }) => {
    const [open, setOpen] = useState(false);
    const pct = cat.maxScore > 0 ? Math.round((cat.score / cat.maxScore) * 100) : 0;
    const hasDetail = cat.transcriptEvidence.length > 0 || cat.strengths.length > 0 || cat.improvementAreas.length > 0;

    return (
        <div className={`rounded-lg border transition-colors duration-150 ${isLight ? 'border-slate-100 bg-white' : 'border-white/[0.05] bg-white/[0.02]'} ${hasDetail ? 'cursor-pointer' : ''}`}
            onClick={() => hasDetail && setOpen(o => !o)}>
            {/* Main row */}
            <div className="flex items-center gap-3 px-1 py-2.5">
                {/* Score badge */}
                <span className="text-[10px] font-bold tabular-nums shrink-0 w-8 text-right" style={{ color: accent }}>
                    {pct}%
                </span>

                {/* Name + bar */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                        <span className={`text-[11px] font-medium truncate ${isLight ? 'text-slate-700' : 'text-white/70'}`}>
                            {cat.categoryName}
                        </span>
                        <span className={`text-[9.5px] ml-2 shrink-0 ${isLight ? 'text-slate-400' : 'text-white/25'}`}>
                            {cat.weight} pts
                        </span>
                    </div>
                    <div className={`h-1 rounded-full overflow-hidden ${isLight ? 'bg-slate-100' : 'bg-white/[0.06]'}`}>
                        <motion.div
                            className="h-full rounded-full"
                            style={{ background: accent }}
                            initial={{ width: 0 }}
                            animate={{ width: `${pct}%` }}
                            transition={{ duration: 0.6, delay: index * 0.03, ease: [0.33, 1, 0.68, 1] }}
                        />
                    </div>
                </div>

                {hasDetail && (
                    <div className={`shrink-0 ${isLight ? 'text-slate-300' : 'text-white/20'}`}>
                        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </div>
                )}
            </div>

            {/* ── Expandable detail (enhanced) ── */}
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                        className="overflow-hidden"
                    >
                        <div className={`border-t ${isLight ? 'border-slate-100' : 'border-white/[0.04]'}`}>

                            {/* Reasoning */}
                            {cat.reasoning && (
                                <div className={`px-3 py-1 ${isLight ? 'bg-slate-50/80' : 'bg-white/[0.02]'}`}>
                                    <p className={`text-[10.5px] leading-relaxed ${isLight ? 'text-slate-500' : 'text-white/40'}`}>
                                        {cat.reasoning}
                                    </p>
                                </div>
                            )}

                            {/* Strengths + Gaps — two labelled columns with divider */}
                            {(cat.strengths.length > 0 || cat.improvementAreas.length > 0) && (
                                <div className={`grid grid-cols-2 divide-x ${isLight ? 'divide-slate-100' : 'divide-white/[0.04]'}`}>
                                    <div className="px-3 py-2 space-y-1">
                                        <div className="flex items-center gap-1 mb-1.5">
                                            <CheckCircle2 size={9} className="text-emerald-400 shrink-0" />
                                            <span className={`text-[9px] font-bold uppercase tracking-wider ${isLight ? 'text-emerald-600/80' : 'text-emerald-400/60'}`}>
                                                What Worked
                                            </span>
                                        </div>
                                        {cat.strengths.length > 0 ? cat.strengths.slice(0, 3).map((s, i) => (
                                            <div key={i} className="flex gap-1.5 items-start">
                                                <span className="text-emerald-400 shrink-0 mt-px text-[9px] font-bold">✓</span>
                                                <span className={`text-[10px] leading-snug ${isLight ? 'text-slate-600' : 'text-white/45'}`}>{s}</span>
                                            </div>
                                        )) : (
                                            <p className={`text-[9.5px] italic ${isLight ? 'text-slate-300' : 'text-white/20'}`}>None noted</p>
                                        )}
                                    </div>
                                    <div className="px-3 py-2 space-y-1">
                                        <div className="flex items-center gap-1 mb-1.5">
                                            <AlertCircle size={9} className="text-amber-400 shrink-0" />
                                            <span className={`text-[9px] font-bold uppercase tracking-wider ${isLight ? 'text-amber-600/80' : 'text-amber-400/60'}`}>
                                                To Improve
                                            </span>
                                        </div>
                                        {cat.improvementAreas.length > 0 ? cat.improvementAreas.slice(0, 3).map((a, i) => (
                                            <div key={i} className="flex gap-1.5 items-start">
                                                <span className="text-amber-400 shrink-0 mt-px text-[9px] font-bold">↑</span>
                                                <span className={`text-[10px] leading-snug ${isLight ? 'text-slate-600' : 'text-white/45'}`}>{a}</span>
                                            </div>
                                        )) : (
                                            <p className={`text-[9.5px] italic ${isLight ? 'text-slate-300' : 'text-white/20'}`}>None noted</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Transcript evidence */}
                            {cat.transcriptEvidence.length > 0 && (
                                <div className={`px-2 py-2 space-y-1 border-t ${isLight ? 'border-slate-100 bg-slate-50/50' : 'border-white/[0.04] bg-white/[0.015]'}`}>
                                    <div className="flex items-center gap-1 mb-1.5">
                                        <Quote size={8} className={`shrink-0 ${isLight ? 'text-slate-400' : 'text-white/25'}`} />
                                        <span className={`text-[9px] font-bold uppercase tracking-wider ${isLight ? 'text-slate-400' : 'text-white/25'}`}>
                                            From the call
                                        </span>
                                    </div>
                                    {cat.transcriptEvidence.slice(0, 2).map((q, i) => (
                                        <div key={i} className={`pl-2 border-l-2 ${isLight ? 'border-slate-300 text-slate-500' : 'border-white/15 text-white/35'}`}>
                                            <p className="text-[10px] leading-relaxed italic">{q}</p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ─── Single scorecard card (always expanded — no accordion) ───────────────────
const ScorecardCard: React.FC<ScorecardCardProps> = ({ scorecard, isLight }) => {
    const accent = getTypeAccent(scorecard.meetingType);
    const categories: ScoredCategory[] = Array.isArray(scorecard.categoryBreakdown)
        ? scorecard.categoryBreakdown
        : Object.values(scorecard.categoryBreakdown as Record<string, ScoredCategory>);

    // Split into two columns
    const col1 = categories.filter((_, i) => i % 2 === 0);
    const col2 = categories.filter((_, i) => i % 2 === 1);

    return (
        <div className={`rounded-xl border overflow-hidden ${isLight ? 'border-slate-200 bg-slate-50/60' : 'border-white/[0.07] bg-white/[0.015]'}`}>
            {/* Header — always visible, no toggle */}
            <div className={`flex items-center gap-3 px-4 py-3`}>
                <ScoreRing score={scorecard.overallScore} color={accent.color} size={44} />

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                        <span
                            className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{ color: accent.color, background: accent.bg }}
                        >
                            {accent.label}
                        </span>
                        <span className={`text-[10px] ${isLight ? 'text-slate-400' : 'text-white/25'}`}>
                            {scorecard.confidenceScore}% confidence
                        </span>
                    </div>
                    <p className={`text-[11px] leading-snug truncate ${isLight ? 'text-slate-500' : 'text-white/35'}`}>
                        {scorecard.detectedReason}
                    </p>
                </div>

                <span className={`text-[11px] font-semibold shrink-0 ${isLight ? 'text-slate-600' : 'text-white/50'}`}>
                    {scoreLabel(scorecard.overallScore)}
                </span>
            </div>

            {/* Body — always rendered, no AnimatePresence wrapper */}
            <div className={`border-t px-3 pt-3 pb-4 ${isLight ? 'border-slate-200' : 'border-white/[0.05]'}`}>
                {/* 2-column category grid */}
                <div className="grid grid-cols-2 gap-1 mb-3">
                    <div className="space-y-1">
                        {col1.map((cat, i) => (
                            <CategoryRow key={cat.categoryName} cat={cat} accent={accent.color} index={i * 2} isLight={isLight} />
                        ))}
                    </div>
                    <div className="space-y-1">
                        {col2.map((cat, i) => (
                            <CategoryRow key={cat.categoryName} cat={cat} accent={accent.color} index={i * 2 + 1} isLight={isLight} />
                        ))}
                    </div>
                </div>

                {/* Strengths + coaching in 2 columns */}
                {(scorecard.topStrengths.length > 0 || scorecard.coachingRecommendations.length > 0) && (
                    <div className={`grid grid-cols-2 gap-3 pt-3 border-t ${isLight ? 'border-slate-100' : 'border-white/[0.04]'}`}>
                        {scorecard.topStrengths.length > 0 && (
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <TrendingUp size={10} className="text-emerald-400" />
                                    <span className={`text-[9.5px] font-bold uppercase tracking-wider ${isLight ? 'text-slate-400' : 'text-white/25'}`}>
                                        Strengths
                                    </span>
                                </div>
                                <ul className="space-y-1">
                                    {scorecard.topStrengths.slice(0, 3).map((s, i) => (
                                        <li key={i} className={`flex gap-1.5 items-start text-[10.5px] leading-snug ${isLight ? 'text-slate-600' : 'text-white/50'}`}>
                                            <span className="text-emerald-400 mt-0.5 shrink-0">·</span>
                                            {s}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {scorecard.coachingRecommendations.length > 0 && (
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Lightbulb size={10} className="text-amber-400" />
                                    <span className={`text-[9.5px] font-bold uppercase tracking-wider ${isLight ? 'text-slate-400' : 'text-white/25'}`}>
                                        Coaching
                                    </span>
                                </div>
                                <ul className="space-y-1">
                                    {scorecard.coachingRecommendations.slice(0, 3).map((r, i) => (
                                        <li key={i} className={`flex gap-1.5 items-start text-[10.5px] leading-snug ${isLight ? 'text-slate-600' : 'text-white/50'}`}>
                                            <span className="text-amber-400 mt-0.5 shrink-0">·</span>
                                            {r}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// ─── Skeleton ─────────────────────────────────────────────────────────────────
const ScorecardSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <div className="space-y-2 animate-pulse">
        {[0, 1].map(i => (
            <div key={i} className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${isLight ? 'border-slate-200' : 'border-white/[0.07]'}`}>
                <div className="w-11 h-11 rounded-full shrink-0" style={{ background: 'rgba(128,128,128,0.1)' }} />
                <div className="flex-1 space-y-2">
                    <div className="h-2.5 rounded w-24" style={{ background: 'rgba(128,128,128,0.1)' }} />
                    <div className="h-2 rounded w-3/5" style={{ background: 'rgba(128,128,128,0.07)' }} />
                </div>
            </div>
        ))}
    </div>
);

// ─── Main export ──────────────────────────────────────────────────────────────
export const MeetingScorecardPanel: React.FC<MeetingScorecardPanelProps> = ({
    result,
    isLoading,
    compact = false,
}) => {
    const isLight = useResolvedTheme() === 'light';
    const [activeType, setActiveType] = useState<MeetingType | null>(null);

    if (isLoading) return <ScorecardSkeleton isLight={isLight} />;

    if (!result || result.scorecards.length === 0) {
        return (
            <div className={`flex items-center gap-3 py-4 px-4 rounded-xl border border-dashed ${isLight ? 'border-slate-200 text-slate-400' : 'border-white/[0.06] text-white/20'}`}>
                <TrendingUp size={14} strokeWidth={1.5} />
                <p className="text-[11.5px]">No scorecard generated for this meeting yet.</p>
            </div>
        );
    }

    // Single scorecard — no tabs needed, render directly (existing behaviour)
    if (result.scorecards.length === 1) {
        return (
            <div className="space-y-2">
                <ScorecardCard
                    scorecard={result.scorecards[0]}
                    isLight={isLight}
                    defaultOpen={!compact}
                />
            </div>
        );
    }

    // Multiple scorecards — render with per-type tabs
    const currentType = activeType ?? result.scorecards[0].meetingType;
    const activeScorecard = result.scorecards.find(sc => sc.meetingType === currentType) ?? result.scorecards[0];

    return (
        <div>
            {/* ── Tab bar ── */}
            <div className={`flex gap-1 mb-3 p-1 rounded-xl ${isLight ? 'bg-slate-100' : 'bg-white/[0.04]'}`}>
                {result.scorecards.map(sc => {
                    const accent = getTypeAccent(sc.meetingType);
                    const isActive = sc.meetingType === currentType;
                    return (
                        <button
                            key={sc.meetingType}
                            onClick={() => setActiveType(sc.meetingType)}
                            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all duration-150 ${isActive
                                ? isLight
                                    ? 'bg-white shadow-sm'
                                    : 'bg-white/[0.08]'
                                : isLight
                                    ? 'text-slate-400 hover:text-slate-600'
                                    : 'text-white/30 hover:text-white/50'
                                }`}
                            style={isActive ? { color: accent.color } : undefined}
                        >
                            <span
                                className="w-1.5 h-1.5 rounded-full shrink-0"
                                style={{ background: isActive ? accent.color : 'currentColor', opacity: isActive ? 1 : 0.4 }}
                            />
                            {accent.label}
                            <span
                                className="ml-0.5 text-[9px] tabular-nums font-bold px-1 py-0.5 rounded"
                                style={{
                                    color: isActive ? accent.color : undefined,
                                    background: isActive ? accent.bg : undefined,
                                    opacity: isActive ? 1 : 0.5,
                                }}
                            >
                                {sc.overallScore}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* ── Active scorecard ── */}
            <AnimatePresence mode="wait">
                <motion.div
                    key={currentType}
                // initial={{ opacity: 0, y: 4 }}
                // animate={{ opacity: 1, y: 0 }}
                // exit={{ opacity: 0, y: -4 }}
                // transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                >
                    <ScorecardCard
                        scorecard={activeScorecard}
                        isLight={isLight}
                        defaultOpen={!compact}
                    />
                </motion.div>
            </AnimatePresence>
        </div>
    );
};