// Placeholder for the Call Analysis tab while GET /meetings/:id is in flight for
// an already-processed meeting. Mirrors CallAnalysisPanel section-for-section:
// the four overview tiles (MEDDICC / BANT / Signals / Objections, each with its
// progress bar), numbered section headers with a count pill, the two-column
// MEDDICC and BANT field-card grids, a signals section, and the "Analysis
// sections" rail — so nothing jumps when the real panel lands.
//
// Same low-cost approach as MeetingSummarySkeleton: static blocks under ONE
// opacity pulse on the wrapper, no blur/shadows, pulse dropped in Performance
// Mode / reduced-motion. Not used while a meeting is still processing.

import React from 'react';
import { usePerformanceMode } from '@/hooks';
import { Bar, SkeletonRail } from './MeetingSummarySkeleton';

const tile = (isLight: boolean) =>
    isLight ? 'border-slate-200 bg-white' : 'border-white/[0.07] bg-white/[0.02]';

const OverviewTileSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <div className={`rounded-xl border p-4 sm:p-5 ${tile(isLight)}`}>
        <Bar className="h-2.5 w-16" />
        <Bar className="mt-3 h-7 w-14" />
        <Bar className="mt-2.5 h-3 w-24" />
        <Bar className="mt-3 h-1.5 w-full rounded-full" />
    </div>
);

const SectionHeaderSkeleton: React.FC<{ titleW: string }> = ({ titleW }) => (
    <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
            <Bar className="h-6 w-6 shrink-0 rounded-md" />
            <Bar className="h-4 w-4 shrink-0" />
            <Bar className={`h-4 ${titleW}`} />
            <Bar className="hidden h-3 w-44 sm:block" />
        </div>
        <Bar className="h-6 w-24 shrink-0 rounded-full" />
    </div>
);

/** A BANT / MEDDICC field card: label + status pill, then a couple of body lines. */
const FieldCardSkeleton: React.FC<{ isLight: boolean; short?: boolean }> = ({ isLight, short }) => (
    <div className={`flex h-full flex-col rounded-xl border p-4 sm:p-5 ${tile(isLight)}`}>
        <div className="mb-3 flex items-center justify-between gap-3">
            <Bar className="h-4 w-28" />
            <Bar className="h-6 w-24 rounded-full" />
        </div>
        <div className="space-y-2">
            <Bar className="h-3.5 w-full" />
            <Bar className={`h-3.5 ${short ? 'w-1/3' : 'w-4/5'}`} />
        </div>
    </div>
);

const FieldGrid: React.FC<{ isLight: boolean; count: number }> = ({ isLight, count }) => (
    <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: count }).map((_, i) => (
            <FieldCardSkeleton key={i} isLight={isLight} short={i % 3 === 2} />
        ))}
    </div>
);

const ANALYSIS_NAV = ['w-20', 'w-24', 'w-14', 'w-28', 'w-24'];

const CallAnalysisSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => {
    const { isPerformanceMode } = usePerformanceMode();
    return (
        <div
            role="status"
            aria-label="Loading call analysis"
            className={isPerformanceMode ? '' : 'animate-pulse motion-reduce:animate-none'}
        >
            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,300px)]">
                <div className="min-w-0 space-y-10">
                    {/* Overview tiles */}
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        {Array.from({ length: 4 }).map((_, i) => (
                            <OverviewTileSkeleton key={i} isLight={isLight} />
                        ))}
                    </div>

                    {/* MEDDICC — seven criteria */}
                    <section>
                        <SectionHeaderSkeleton titleW="w-20" />
                        <FieldGrid isLight={isLight} count={6} />
                    </section>

                    {/* BANT — four qualifiers */}
                    <section>
                        <SectionHeaderSkeleton titleW="w-12" />
                        <FieldGrid isLight={isLight} count={4} />
                    </section>

                    {/* Buying signals */}
                    <section>
                        <SectionHeaderSkeleton titleW="w-32" />
                        <FieldGrid isLight={isLight} count={2} />
                    </section>
                </div>

                <SkeletonRail isLight={isLight} items={ANALYSIS_NAV} />
            </div>
        </div>
    );
};

export default CallAnalysisSkeleton;