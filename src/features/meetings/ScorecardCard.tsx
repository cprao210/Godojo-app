import React from 'react';
import { TrendingUp, Lightbulb } from 'lucide-react';
import type { ScorecardCardProps, ScoredCategory } from '@/types';
import { getTypeAccent, scoreLabel } from '@/hooks';
import { ScoreRing } from './ScoreRing';
import { ScorecardCategoryRow } from './ScorecardCategoryRow';

// ─── Single scorecard card (always expanded — no accordion) ───────────────────
export const ScorecardCard: React.FC<ScorecardCardProps> = ({ scorecard, isLight }) => {
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
                            <ScorecardCategoryRow key={cat.categoryName} cat={cat} accent={accent.color} index={i * 2} isLight={isLight} />
                        ))}
                    </div>
                    <div className="space-y-1">
                        {col2.map((cat, i) => (
                            <ScorecardCategoryRow key={cat.categoryName} cat={cat} accent={accent.color} index={i * 2 + 1} isLight={isLight} />
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

export default ScorecardCard;