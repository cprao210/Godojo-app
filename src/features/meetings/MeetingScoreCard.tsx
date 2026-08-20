/**
 * MeetingScoreCard.tsx
 *
 * Renders the post-call scorecard: a single always-expanded card when the
 * meeting only produced one scorecard, or a per-meeting-type tab bar when
 * it produced several (e.g. a call that covered both discovery and demo).
 * All the visual sub-pieces (ring, category row, card) live in their own
 * files; the tab-switch state + accent/label lookups live in
 * `useMeetingScorecard`.
 */
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { TrendingUp } from 'lucide-react';
import type { MeetingScorecardPanelProps } from '@/types';
import { useResolvedTheme } from '@/hooks';
import { useMeetingScorecard, getTypeAccent } from '@/hooks';
import { ScorecardCard } from './ScorecardCard';

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
    const { activeType, setActiveType } = useMeetingScorecard();

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
                <motion.div key={currentType}>
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

export default MeetingScorecardPanel;