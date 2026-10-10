// Placeholder for the Summary tab while GET /meetings/:id is in flight for an
// already-processed meeting. Mirrors the real layout section-for-section — the
// same two-column grid (content + 260–300px "Coach sections" rail), the Call
// Summary card with its bullets and icon slot, then the stacked section cards —
// so the page doesn't jump when real content lands.
//
// Intentionally NOT used for meetings that are still processing (those get
// PostMeetingProcessingLoader). Cheap on low-end machines: static blocks under
// ONE opacity pulse on the wrapper (not one animation per block), no blur, no
// shadows; the pulse is dropped in Performance Mode / reduced-motion.

import React from 'react';
import { usePerformanceMode } from '@/hooks';

export const Bar: React.FC<{ className?: string }> = ({ className = '' }) => (
    <div className={`rounded-md ${className}`} style={{ background: 'rgba(128,128,128,0.14)' }} />
);

export const Card: React.FC<{ isLight: boolean; className?: string; children: React.ReactNode }> = ({ isLight, className = '', children }) => (
    <div
        className={`w-full overflow-hidden rounded-2xl border ${isLight ? 'border-slate-200/80 bg-white' : 'border-white/[0.06] bg-white/[0.025]'} ${className}`}
    >
        {children}
    </div>
);

/** One Call-Summary-style bullet: dot + a full line and a shorter one. */
const BulletRow: React.FC<{ w: string }> = ({ w }) => (
    <div className="flex items-start gap-3">
        <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'rgba(128,128,128,0.3)' }} />
        <div className="flex-1 space-y-2">
            <Bar className="h-3.5 w-full" />
            <Bar className={`h-3.5 ${w}`} />
        </div>
    </div>
);

/** Section header (icon + title) over a card, like Game Plan / Coach's notes. */
const SectionCard: React.FC<{ isLight: boolean; rows: number; titleW: string }> = ({ isLight, rows, titleW }) => (
    <section className="mb-10">
        <Card isLight={isLight}>
            <div className="p-6 sm:p-7">
                <div className="flex items-center gap-2.5 mb-5">
                    <Bar className="h-5 w-5 rounded-md" />
                    <Bar className={`h-5 ${titleW}`} />
                </div>
                <div className="space-y-4">
                    {Array.from({ length: rows }).map((_, i) => (
                        <div key={i} className="space-y-2">
                            <Bar className="h-3.5 w-full" />
                            <Bar className={`h-3.5 ${i % 2 === 0 ? 'w-4/5' : 'w-3/5'}`} />
                        </div>
                    ))}
                </div>
            </div>
        </Card>
    </section>
);

export const NAV_ITEMS = ['w-24', 'w-32', 'w-28', 'w-20', 'w-24', 'w-16'];

/** The sticky section-navigation rail beside the content (Coach / Analysis sections). */
export const SkeletonRail: React.FC<{ isLight: boolean; items?: string[] }> = ({ isLight, items = NAV_ITEMS }) => (
    <aside className="hidden lg:block">
        <Card isLight={isLight}>
            <div className="p-5">
                <Bar className="h-3 w-28 mb-5" />
                <div className="space-y-4">
                    {items.map((w, i) => (
                        <div key={i} className="flex items-center gap-3">
                            <Bar className="h-2 w-2 rounded-full" />
                            <Bar className={`h-3 ${w}`} />
                        </div>
                    ))}
                </div>
            </div>
        </Card>
    </aside>
);


const MeetingSummarySkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => {
    const { isPerformanceMode } = usePerformanceMode();
    return (
        <div
            role="status"
            aria-label="Loading meeting summary"
            className={isPerformanceMode ? '' : 'animate-pulse motion-reduce:animate-none'}
        >
            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,300px)]">
                <div className="min-w-0">
                    {/* Call Summary card */}
                    <section className="mb-10">
                        <Card isLight={isLight}>
                            <div className="flex items-center gap-6 p-7 sm:p-8">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2.5">
                                        <Bar className="h-5 w-5 rounded-md" />
                                        <Bar className="h-[19px] w-36" />
                                    </div>
                                    <div className="mt-4 space-y-3">
                                        <BulletRow w="w-4/5" />
                                        <BulletRow w="w-2/3" />
                                        <BulletRow w="w-3/4" />
                                        <BulletRow w="w-1/2" />
                                    </div>
                                </div>
                                {/* The notepad icon slot */}
                                <div className="hidden sm:flex h-[140px] w-[140px] shrink-0 items-center justify-center">
                                    <Bar className="h-[88px] w-[78px] rounded-xl" />
                                </div>
                            </div>
                        </Card>
                    </section>

                    <SectionCard isLight={isLight} rows={3} titleW="w-44" />
                    <SectionCard isLight={isLight} rows={4} titleW="w-36" />
                    <SectionCard isLight={isLight} rows={2} titleW="w-28" />
                </div>

                <SkeletonRail isLight={isLight} />
            </div>
        </div>
    );
};

export default MeetingSummarySkeleton;