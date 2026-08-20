import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, CheckCircle2, AlertCircle, Quote } from 'lucide-react';
import type { ScoreCardCategoryRowProps } from '@/types';

// ─── Category row (compact, expandable) ───────────────────────────────────────
export const ScorecardCategoryRow: React.FC<ScoreCardCategoryRowProps> = ({ cat, accent, index, isLight }) => {
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

export default ScorecardCategoryRow;