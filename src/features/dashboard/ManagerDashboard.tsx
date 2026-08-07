/**
 * ManagerDashboard.tsx
 *
 * "Manager Dashboard" — wired to the live backend.
 * Shows team-level rep performance: active reps, call volume, average score,
 * a rolling team score trend, top objections raised on calls, and two ranked
 * rep lists (top performers / reps who need coaching).
 *
 * All state + data-fetching lives in useManagerDashboard (mirrors the
 * loading/error pattern used in UserRolesPermissionsTab):
 *   1. GET /tenants/me on open — if [] the user hasn't created a tenant yet
 *      (nothing to show). Otherwise take the first tenant and check
 *      tenant.owner_id === current uid to know if this user is the admin.
 *   2. Only admins call GET /dashboard?tenant_id=...&period=... — this single
 *      endpoint backs every card below except "All AEs".
 *
 * This component only owns rendering — all presentational pieces live in
 * ManagerDashboardWidgets.tsx / shared.tsx.
 */

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Users, Phone, Target, Calendar, ChevronDown, Trophy, AlertTriangle, X } from 'lucide-react';
import { useResolvedTheme, useManagerDashboard, PERIOD_OPTIONS } from '@/hooks';
import AeDetailView from './AEDetailView';
import { ManagerDashboardProps } from '@/types';
import { StatCard, StatCardSkeleton, ChartSkeleton, ListSkeleton, TableSkeleton, TeamScoreChart } from './ManagerDashboardWidgets';
import { TopObjectionsList, RankedRepList, AllAEsTable, SectionCard } from './ManagerDashboardWidgets';

// ─── Main export ─────────────────────────────────────────────────────────────

export const ManagerDashboard: React.FC<ManagerDashboardProps> = ({ isOpen }) => {

    const isLight = useResolvedTheme() === 'light';

    const managerDashboardStates = useManagerDashboard({ isOpen });

    const { tenant, isLoadingTenant, tenantError, isAdmin, hasTenant, period, setPeriod, periodLabel } = managerDashboardStates;
    const { isPeriodMenuOpen, setIsPeriodMenuOpen, isLoadingDashboard, dashboardError, activeReps, totalCalls } = managerDashboardStates;
    const { teamAvgScore, teamScoreTrend, objections, topPerformers, needsCoaching, allAeRows, selectedAe, setSelectedAe } = managerDashboardStates;
    const { openAeFromRep, openAeFromRow, selectedObjection, setSelectedObjection } = managerDashboardStates;

    const cardCls = isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle';
    const pillBtnCls = isLight
        ? 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
        : 'bg-bg-input border-border-subtle text-text-primary hover:bg-bg-elevated';

    return (
        <>
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className={`fixed inset-0 z-50 my-4 overflow-y-auto ${isLight ? 'bg-[#F8FAFC]' : 'bg-bg-main'}`}
                    >
                        <div className="max-w-6xl mx-auto px-10 py-10">
                            {/* Header */}
                            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                                <div>
                                    <div className="flex items-center gap-2 mb-1">
                                        <h2 className="text-xl font-bold text-text-primary">Manager Dashboard</h2>
                                    </div>
                                    <p className="text-sm text-text-secondary">
                                        Track team performance, spot opportunities and coach your team to win more deals.
                                    </p>
                                </div>
                                <div className="flex items-center gap-2.5 relative">
                                    <button
                                        onClick={() => setIsPeriodMenuOpen((o) => !o)}
                                        className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors ${pillBtnCls}`}
                                    >
                                        <Calendar size={14} />
                                        {periodLabel}
                                        <ChevronDown size={14} className="text-text-tertiary" />
                                    </button>
                                    {isPeriodMenuOpen && (
                                        <div className={`absolute right-0 top-full mt-1 z-10 w-44 rounded-lg border shadow-lg overflow-hidden ${cardCls}`}>
                                            {PERIOD_OPTIONS.map((opt) => (
                                                <button
                                                    key={opt.value}
                                                    onClick={() => {
                                                        setPeriod(opt.value);
                                                        setIsPeriodMenuOpen(false);
                                                    }}
                                                    className={`w-full text-left px-3 py-2 text-sm transition-colors ${opt.value === period ? 'font-semibold text-text-primary' : 'text-text-secondary'} ${isLight ? 'hover:bg-slate-50' : 'hover:bg-white/[0.03]'}`}
                                                >
                                                    {opt.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {!hasTenant && !isLoadingTenant && !tenantError && (
                                <div className={`rounded-2xl border px-6 py-10 text-center ${cardCls}`}>
                                    <p className="text-sm font-semibold text-text-primary">No team yet</p>
                                    <p className="text-sm text-text-secondary mt-1">
                                        Create a team from Settings → Roles &amp; Permissions to unlock the dashboard.
                                    </p>
                                </div>
                            )}

                            {hasTenant && !isAdmin && (
                                <div className={`rounded-2xl border px-6 py-10 text-center ${cardCls}`}>
                                    <p className="text-sm font-semibold text-text-primary">Admins only</p>
                                    <p className="text-sm text-text-secondary mt-1">
                                        Only the team owner can view the Manager Dashboard.
                                    </p>
                                </div>
                            )}

                            {tenantError && (
                                <div className={`rounded-2xl border px-6 py-10 text-center ${cardCls}`}>
                                    <p className="text-sm font-semibold text-red-400">{tenantError}</p>
                                </div>
                            )}

                            {hasTenant && isAdmin && (
                                <>
                                    {dashboardError && (
                                        <div className={`rounded-2xl border px-6 py-4 mb-4 ${cardCls}`}>
                                            <p className="text-sm font-semibold text-red-400">{dashboardError}</p>
                                        </div>
                                    )}

                                    {/* Stat cards */}
                                    <div className="flex items-stretch gap-4 mb-4 flex-wrap">
                                        {isLoadingDashboard ? (
                                            <>
                                                <StatCardSkeleton cardCls={cardCls} isLight={isLight} icon={<Users size={18} className="text-violet-400" />} iconBg="bg-violet-500/15" label="Active AEs" />
                                                <StatCardSkeleton cardCls={cardCls} isLight={isLight} icon={<Phone size={18} className="text-blue-400" />} iconBg="bg-blue-500/15" label="Total Calls" />
                                                <StatCardSkeleton cardCls={cardCls} isLight={isLight} icon={<Target size={18} className="text-emerald-400" />} iconBg="bg-emerald-500/15" label="Team Average Score" />
                                            </>
                                        ) : (
                                            <>
                                                <StatCard
                                                    cardCls={cardCls}
                                                    icon={<Users size={18} className="text-violet-400" />}
                                                    iconBg="bg-violet-500/15"
                                                    label="Active AEs"
                                                    value={activeReps}
                                                />
                                                <StatCard
                                                    cardCls={cardCls}
                                                    icon={<Phone size={18} className="text-blue-400" />}
                                                    iconBg="bg-blue-500/15"
                                                    label="Total Calls"
                                                    value={totalCalls}
                                                />
                                                <StatCard
                                                    cardCls={cardCls}
                                                    icon={<Target size={18} className="text-emerald-400" />}
                                                    iconBg="bg-emerald-500/15"
                                                    label="Team Average Score"
                                                    value={teamAvgScore}
                                                />
                                            </>
                                        )}
                                    </div>

                                    {/* Team score trend + Top objections */}
                                    <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4 mb-4">
                                        <SectionCard
                                            title={`Team Score – ${periodLabel}`}
                                            subtitle="Rolling average score across all reps"
                                            cardCls={cardCls}
                                        >
                                            {isLoadingDashboard ? (
                                                <ChartSkeleton isLight={isLight} />
                                            ) : teamScoreTrend.length > 0 ? (
                                                <TeamScoreChart data={teamScoreTrend} isLight={isLight} />
                                            ) : (
                                                <p className="text-sm text-text-tertiary py-8 text-center">
                                                    No trend data for this period.
                                                </p>
                                            )}
                                        </SectionCard>

                                        <SectionCard
                                            title="Top Objections"
                                            subtitle="Based on calls in selected time period"
                                            cardCls={cardCls}
                                        >
                                            {isLoadingDashboard ? (
                                                <ListSkeleton isLight={isLight} rows={4} />
                                            ) : objections.length > 0 ? (
                                                <TopObjectionsList objections={objections} isLight={isLight} onSelect={setSelectedObjection} />
                                            ) : (
                                                <p className="text-sm text-text-tertiary py-8 text-center">
                                                    No objections recorded for this period.
                                                </p>
                                            )}
                                        </SectionCard>
                                    </div>

                                    {/* Top performers + Needs coaching */}
                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        <SectionCard
                                            title="Top Performers"
                                            icon={<Trophy size={15} className="text-emerald-400" />}
                                            cardCls={cardCls}
                                        >
                                            {isLoadingDashboard ? (
                                                <ListSkeleton isLight={isLight} rows={4} />
                                            ) : topPerformers.length > 0 ? (
                                                <RankedRepList reps={topPerformers} rankTheme="positive" isLight={isLight} onSelectRep={openAeFromRep} />
                                            ) : (
                                                <p className="text-sm text-text-tertiary py-8 text-center">
                                                    No performers to show yet.
                                                </p>
                                            )}
                                        </SectionCard>

                                        <SectionCard
                                            title="Needs Coaching"
                                            icon={<AlertTriangle size={15} className="text-red-400" />}
                                            cardCls={cardCls}
                                        >
                                            {isLoadingDashboard ? (
                                                <ListSkeleton isLight={isLight} rows={4} />
                                            ) : needsCoaching.length > 0 ? (
                                                <RankedRepList reps={needsCoaching} rankTheme="attention" isLight={isLight} onSelectRep={openAeFromRep} />
                                            ) : (
                                                <p className="text-sm text-text-tertiary py-8 text-center">
                                                    No one needs coaching right now.
                                                </p>
                                            )}
                                        </SectionCard>
                                    </div>

                                    {/* All AEs */}
                                    <div className="mt-4">
                                        <SectionCard
                                            title="All AEs"
                                            subtitle="Click any row to view full performance + create coaching"
                                            cardCls={cardCls}
                                        >
                                            {dashboardError ? (
                                                <p className="text-sm font-semibold text-red-400 py-4 text-center">{dashboardError}</p>
                                            ) : isLoadingDashboard ? (
                                                <TableSkeleton isLight={isLight} rows={6} />
                                            ) : allAeRows.length > 0 ? (
                                                <AllAEsTable
                                                    aes={allAeRows}
                                                    isLight={isLight}
                                                    onSelectAe={openAeFromRow}
                                                />
                                            ) : (
                                                <p className="text-sm text-text-tertiary py-8 text-center">
                                                    No AEs found.
                                                </p>
                                            )}
                                        </SectionCard>
                                    </div>
                                </>
                            )}
                        </div>
                    </motion.div>
                )}
                {isOpen && <AeDetailView ae={selectedAe} tenantId={tenant?.id ?? null} onBack={() => setSelectedAe(null)} />}
            </AnimatePresence>
            <AnimatePresence>
                {isOpen && selectedObjection && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
                        onClick={() => setSelectedObjection(null)}
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.96, y: 8 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.96, y: 8 }}
                            onClick={(e) => e.stopPropagation()}
                            className={`w-full max-w-md rounded-xl border p-5 shadow-xl ${isLight ? 'bg-white border-slate-200' : 'bg-bg-main border-white/10'
                                }`}
                        >
                            <div className="flex items-start justify-between gap-4 mb-3">
                                <h3 className="text-sm font-semibold text-text-primary capitalize">
                                    {selectedObjection.label.replace(/_/g, ' ')}
                                </h3>
                                <button
                                    type="button"
                                    onClick={() => setSelectedObjection(null)}
                                    className="text-text-tertiary hover:text-text-primary transition-colors"
                                    aria-label="Close"
                                >
                                    <X size={18} />
                                </button>
                            </div>
                            <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
                                {selectedObjection.latest.map((q, i) => (
                                    <div
                                        key={i}
                                        className={`rounded-lg p-3 text-sm ${isLight ? 'bg-slate-50' : 'bg-white/5'
                                            }`}
                                    >
                                        <p className="text-text-primary italic">"{q.quote}"</p>
                                        <p className="text-xs text-text-tertiary mt-2">
                                            {q.owner} · {q.status} ·{' '}
                                            {new Date(q.meeting_date).toLocaleDateString()}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
};

export default ManagerDashboard;