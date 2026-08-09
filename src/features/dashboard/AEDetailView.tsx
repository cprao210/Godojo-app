/**
 * AeDetailView.tsx
 *
 * Full-performance drill-down for a single AE — opens when a row is clicked
 * in the "All AEs" table, or in the Top Performers / Needs Coaching lists on
 * the Manager Dashboard.
 *
 * Wired to the live backend: GET /tenants/:tenant_id/members/:user_id
 * (tenantsApi.getMember) supplies the dimension breakdown, strengths /
 * weakest area, and recent calls for whoever's selected. The caller only
 * needs to pass the tenant id + the selected AE's user id (plus the summary
 * fields already known from the dashboard, used as an instant-paint
 * placeholder while the detail request is in flight).
 *
 * All state + data-fetching lives in useAeDetail — this component only owns
 * rendering. Presentational pieces live in AeDetailWidgets.tsx / shared.tsx.
 */

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, Info } from 'lucide-react';
import { useResolvedTheme } from '@/hooks';
import { useAeDetail } from '@/hooks/useAeDetail';
import { MeetingDetails } from '@/features/meetings';
import { AeDetailViewProps } from '@/types';
import { avatarColorFor, initialsFor, AVATAR_PALETTE } from './shared';
import { DimensionGaugeSkeleton, RecentCallsSkeleton, DimensionGauge, StrengthsAndGapsList, RecentCallsList } from './AeDetailWidgets';

// ─── Main export ─────────────────────────────────────────────────────────────

export const AeDetailView: React.FC<AeDetailViewProps> = ({ ae, tenantId, onBack }) => {

    const isLight = useResolvedTheme() === 'light';
    const isOpen = ae !== null;

    const AeDetailsStates = useAeDetail({ ae, tenantId });

    const { isLoadingDetail, detailError, displayName, displayRole, displayCalls, displayScore } = AeDetailsStates;
    const { dimensions, strengthsAndGaps, recentCalls, selectedMeeting, setSelectedMeeting, handleSelectCall } = AeDetailsStates;

    const cardCls = isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle';
    const avatarColor = ae ? avatarColorFor(ae.name) : AVATAR_PALETTE[0];

    return (
        <AnimatePresence>
            {isOpen && ae && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className={`fixed inset-0 z-[60] mt-5 overflow-y-auto ${isLight ? 'bg-[#F8FAFC]' : 'bg-bg-main'}`}
                >
                    <div className="max-w-6xl mx-auto px-10 py-8">
                        {/* Back link */}
                        <button
                            onClick={selectedMeeting ? () => setSelectedMeeting(null) : onBack}
                            className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-400 hover:text-blue-300 transition-colors mb-4"
                        >
                            <ArrowLeft size={15} /> {selectedMeeting ? 'Back to AE overview' : 'Back to team'}
                        </button>

                        {selectedMeeting ? (
                            <MeetingDetails meeting={selectedMeeting} />
                        ) : (
                            <>
                                {detailError && (
                                    <div className={`rounded-2xl border px-6 py-4 mb-4 ${cardCls}`}>
                                        <p className="text-sm font-semibold text-red-400">{detailError}</p>
                                    </div>
                                )}

                                {/* Profile card */}
                                <div className={`rounded-2xl border px-6 py-5 flex items-center justify-between gap-6 mb-5 ${cardCls}`}>
                                    <div className="flex items-center gap-4 min-w-0">
                                        <div className={`w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold shrink-0 ${avatarColor.bg} ${avatarColor.text}`}>
                                            {initialsFor(displayName)}
                                        </div>
                                        <div className="min-w-0">
                                            <h2 className="text-lg font-bold text-text-primary truncate">{displayName}</h2>
                                            <p className="text-sm text-text-secondary truncate">
                                                {displayRole} · {displayCalls} calls this month
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-5 shrink-0">
                                        <div className="text-right">
                                            <p className="text-3xl font-bold text-text-primary tabular-nums leading-none">{displayScore}</p>
                                            <p className="text-xs text-text-tertiary mt-1">avg score</p>
                                        </div>
                                    </div>
                                </div>

                                {/* Tabs (Overview only, for now) */}
                                <div className="flex items-center gap-6 border-b border-border-subtle mb-5">
                                    <button className="pb-2.5 text-sm font-semibold text-text-primary border-b-2 border-blue-500">
                                        Overview
                                    </button>
                                </div>

                                {/* Dimension gauge + Strengths/gaps */}
                                <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-4 mb-4">
                                    <div className={`rounded-2xl border p-5 ${cardCls}`}>
                                        <div className="flex items-center gap-1.5 mb-1">
                                            <h3 className="text-sm font-bold text-text-primary">Sales performance by dimension</h3>
                                            <Info size={13} className="text-text-tertiary" />
                                        </div>
                                        <p className="text-xs text-text-tertiary mb-2">
                                            How {displayName.split(' ')[0] || 'this rep'} is performing across key sales dimensions
                                        </p>
                                        {isLoadingDetail ? (
                                            <DimensionGaugeSkeleton isLight={isLight} />
                                        ) : dimensions.length > 0 ? (
                                            <DimensionGauge
                                                dimensions={dimensions}
                                                overallScore={displayScore}
                                                isLight={isLight}
                                                isAboveTeamAverage={displayScore >= 70}
                                            />
                                        ) : (
                                            <p className="text-sm text-text-tertiary py-16 text-center">No dimension data yet.</p>
                                        )}
                                    </div>

                                    <div className={`rounded-2xl border p-5 ${cardCls}`}>
                                        <h3 className="text-sm font-bold text-text-primary mb-1">Strengths &amp; areas to focus</h3>
                                        <p className="text-xs text-text-tertiary mb-2">
                                            What {displayName.split(' ')[0] || 'this rep'} does well and where they can improve
                                        </p>
                                        {isLoadingDetail ? (
                                            <RecentCallsSkeleton isLight={isLight} />
                                        ) : (
                                            <StrengthsAndGapsList items={strengthsAndGaps} isLight={isLight} />
                                        )}
                                    </div>
                                </div>

                                {/* Recent calls */}
                                <div className={`rounded-2xl border p-5 ${cardCls}`}>
                                    <h3 className="text-sm font-bold text-text-primary mb-1">Recent calls</h3>
                                    <p className="text-xs text-text-tertiary mb-2">Click to open the post-call analysis</p>
                                    {isLoadingDetail ? (
                                        <p className="text-sm text-text-tertiary py-6 text-center">Loading…</p>
                                    ) : (
                                        <RecentCallsList
                                            calls={recentCalls}
                                            isLight={isLight}
                                            onSelectCall={handleSelectCall}
                                        />
                                    )}
                                </div>
                            </>)}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default AeDetailView;