/**
 * ManagerDashboard.tsx
 *
 * "Manager Dashboard" — wired to the live backend.
 * Shows team-level rep performance: active reps, call volume, average score,
 * a rolling team score trend, top objections raised on calls, and two ranked
 * rep lists (top performers / reps who need coaching).
 *
 * Data flow (mirrors the loading/error pattern used in UserRolesPermissionsTab):
 *   1. GET /tenants/me on open — if [] the user hasn't created a tenant yet
 *      (nothing to show). Otherwise take the first tenant and check
 *      tenant.owner_id === current uid to know if this user is the admin.
 *   2. Only admins call GET /dashboard?tenant_id=...&period=... — this single
 *      endpoint backs every card below except "All AEs".
 *   3. "All AEs" is a separate call: GET /tenants/:tenant_id/members?role=admin&page=1&limit=8
 */

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Users, Phone, Target, Calendar, ChevronDown, Trophy, AlertTriangle, X, ChevronRight } from 'lucide-react';
import { useResolvedTheme } from '@/hooks';
import AeDetailView from './AEDetailView';
import { tenantsApi, dashboardApi } from '@/api';
import { ApiError } from '@/lib/apiClient';
import { getFirebaseAuth } from '@/lib/firebase';
import { AeEntry, AeSummary, Tenant, AllAEsTableProps, RankedRepListProps, RepEntry, SectionCardProps } from '@/types';
import { StatCardProps, TopObjectionsListProps, DashboardActiveMember, DashboardPeriod, DashboardResponse } from '@/types';
import { TeamScoreChartProps, ObjectionType, ManagerDashboardProps } from '@/types';

// ─── Period options for the date-range pill ─────────────────────────────────
// Backend enum: last_1_day, last_5_days, last_week, last_2_weeks,
// last_30_days, last_quarter, last_year.
const PERIOD_OPTIONS: { value: DashboardPeriod; label: string }[] = [
    { value: 'last_1_day', label: 'Last 1 day' },
    { value: 'last_5_days', label: 'Last 5 days' },
    { value: 'last_week', label: 'Last week' },
    { value: 'last_2_weeks', label: 'Last 2 weeks' },
    { value: 'last_30_days', label: 'Last 30 days' },
    { value: 'last_quarter', label: 'Last quarter' },
    { value: 'last_year', label: 'Last year' },
];

/**
 * Same ownership check used in UserRolesPermissionsTab.tsx — the tenant's
 * owner_id is the source of truth for "is this user an admin". This is a UX
 * affordance only; the backend independently rejects non-admins on
 * GET /dashboard.
 */
function useIsTenantOwner(tenant: Tenant | null): boolean {
    const [uid, setUid] = useState<string | null>(() => getFirebaseAuth().currentUser?.uid ?? null);

    useEffect(() => {
        const unsubscribe = getFirebaseAuth().onAuthStateChanged((user) => {
            setUid(user?.uid ?? null);
        });
        return unsubscribe;
    }, []);

    if (!tenant || !uid) return false;
    return tenant.owner_id === uid;
}

// ─── Small shared bits ───────────────────────────────────────────────────────

const AVATAR_PALETTE = [
    { bg: 'bg-blue-500/15', text: 'text-blue-400' },
    { bg: 'bg-violet-500/15', text: 'text-violet-400' },
    { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
    { bg: 'bg-amber-500/15', text: 'text-amber-400' },
    { bg: 'bg-pink-500/15', text: 'text-pink-400' },
    { bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
];

function avatarColorFor(key: string) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function initialsFor(name: string) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

// ─── Stat card ────────────────────────────────────────────────────────────────

const StatCard: React.FC<StatCardProps> = ({ icon, iconBg, label, value, cardCls }) => (
    <div className={`flex-1 rounded-2xl border px-5 py-4 flex items-center gap-3.5 ${cardCls}`}>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>
            {icon}
        </div>
        <div className="min-w-0">
            <p className="text-sm text-text-secondary truncate">{label}</p>
            <p className="text-2xl font-bold text-text-primary tabular-nums leading-tight">{value}</p>
        </div>
    </div>
);

// ─── Skeleton loaders ────────────────────────────────────────────────────────
// Shown in place of "No data" / '—' copy while isLoadingDashboard is true, so
// the dashboard reads as "still fetching" rather than "there's nothing here".

export const Skeleton: React.FC<{ className?: string; isLight: boolean; style?: React.CSSProperties }> = ({ className = '', isLight, style }) => (
    <div
        className={`animate-pulse rounded-md ${isLight ? 'bg-slate-200' : 'bg-white/10'} ${className}`}
        style={style}
    />
);

const StatCardSkeleton: React.FC<{ icon: React.ReactNode; iconBg: string; label: string; cardCls: string; isLight: boolean }> = ({ icon, iconBg, label, cardCls, isLight }) => (
    <div className={`flex-1 rounded-2xl border px-5 py-4 flex items-center gap-3.5 ${cardCls}`}>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${iconBg} opacity-60`}>
            {icon}
        </div>
        <div className="min-w-0 flex-1">
            <p className="text-sm text-text-secondary truncate">{label}</p>
            <Skeleton isLight={isLight} className="h-6 w-16 mt-1" />
        </div>
    </div>
);

const ChartSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <div className="flex items-end gap-2 h-[180px] py-2">
        {[45, 70, 55, 85, 60, 95, 50].map((h, i) => (
            <Skeleton key={i} isLight={isLight} className="flex-1" style={{ height: `${h}%` } as React.CSSProperties} />
        ))}
    </div>
);

const ListSkeleton: React.FC<{ isLight: boolean; rows?: number }> = ({ isLight, rows = 4 }) => (
    <div className="space-y-3 py-1">
        {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
                <Skeleton isLight={isLight} className="w-8 h-8 rounded-full shrink-0" />
                <div className="flex-1 min-w-0 space-y-1.5">
                    <Skeleton isLight={isLight} className="h-3 w-2/3" />
                    <Skeleton isLight={isLight} className="h-2.5 w-1/3" />
                </div>
            </div>
        ))}
    </div>
);

const TableSkeleton: React.FC<{ isLight: boolean; rows?: number }> = ({ isLight, rows = 6 }) => (
    <div className="space-y-2.5 py-1">
        {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
                <Skeleton isLight={isLight} className="w-7 h-7 rounded-full shrink-0" />
                <Skeleton isLight={isLight} className="h-3 flex-1" />
                <Skeleton isLight={isLight} className="h-3 w-12 shrink-0" />
                <Skeleton isLight={isLight} className="h-3 w-12 shrink-0" />
            </div>
        ))}
    </div>
);

// ─── Team score line chart (lightweight inline SVG, no chart dependency) ────

const TeamScoreChart: React.FC<TeamScoreChartProps> = ({ data, isLight }) => {
    const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
    const width = 560;
    const height = 220;
    const padL = 34;
    const padR = 12;
    const padT = 12;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const scores = data.map((d) => d.score);
    const dataMin = scores.length ? Math.min(...scores) : 50;
    const dataMax = scores.length ? Math.max(...scores) : 100;
    const yMin = Math.max(0, Math.floor(Math.min(50, dataMin) / 10) * 10);
    const yMax = Math.min(100, Math.ceil(Math.max(100, dataMax) / 10) * 10);
    const yTicks = Array.from({ length: (yMax - yMin) / 10 + 1 }, (_, i) => yMin + i * 10);

    const xFor = (i: number) => (data.length <= 1 ? padL : padL + (i / (data.length - 1)) * plotW);
    const yFor = (score: number) => padT + (1 - (score - yMin) / (yMax - yMin)) * plotH;

    const linePoints = data.map((d, i) => `${xFor(i)},${yFor(d.score)}`).join(' ');
    const areaPoints = `${padL},${padT + plotH} ${linePoints} ${padL + plotW},${padT + plotH}`;

    const gridColor = isLight ? 'rgba(15,23,42,0.08)' : 'rgba(255,255,255,0.06)';
    const axisTextColor = isLight ? '#94a3b8' : 'rgba(255,255,255,0.35)';
    const lineColor = '#8b5cf6'; // violet-500, matches the reference screenshot
    const areaFillId = 'team-score-area-fill';
    const hovered = hoveredIndex !== null ? data[hoveredIndex] : null;
    const tooltipFill = isLight ? '#ffffff' : '#0b0e13';
    const tooltipBorder = isLight ? 'rgba(15,23,42,0.12)' : lineColor;
    const tooltipLabelColor = isLight ? '#64748b' : axisTextColor;
    const tooltipValueColor = isLight ? '#0f172a' : '#ffffff';

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="Team score trend over the last 7 weeks">
            <defs>
                <linearGradient id={areaFillId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity="0.35" />
                    <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
                </linearGradient>
            </defs>

            {/* Horizontal gridlines + y-axis labels */}
            {yTicks.map((t) => (
                <g key={t}>
                    <line
                        x1={padL}
                        x2={width - padR}
                        y1={yFor(t)}
                        y2={yFor(t)}
                        stroke={gridColor}
                        strokeWidth={1}
                        strokeDasharray="3 4"
                    />
                    <text x={padL - 8} y={yFor(t)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={axisTextColor}>
                        {t}
                    </text>
                </g>
            ))}

            {/* Area under the line */}
            <polygon points={areaPoints} fill={`url(#${areaFillId})`} />

            {/* Line */}
            <polyline points={linePoints} fill="none" stroke={lineColor} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

            {/* Points */}
            {data.map((d, i) => (
                <circle
                    key={d.label}
                    cx={xFor(i)}
                    cy={yFor(d.score)}
                    r={hoveredIndex === i ? 5 : 3.5}
                    fill={lineColor}
                    stroke={isLight ? '#fff' : '#141820'}
                    strokeWidth={1.5}
                    style={{ transition: 'r 100ms ease' }}
                />
            ))}

            {/* Invisible hit-targets — wider than the visible dots so hover is
                easy to trigger without needing pixel-perfect aim */}
            {data.map((d, i) => (
                <circle
                    key={`hit-${d.label}`}
                    cx={xFor(i)}
                    cy={yFor(d.score)}
                    r={12}
                    fill="transparent"
                    onMouseEnter={() => setHoveredIndex(i)}
                    onMouseLeave={() => setHoveredIndex((cur) => (cur === i ? null : cur))}
                    style={{ cursor: 'pointer' }}
                />
            ))}

            {/* Vertical guide line under the hovered point */}
            {hovered && (
                <line
                    x1={xFor(hoveredIndex!)}
                    x2={xFor(hoveredIndex!)}
                    y1={padT}
                    y2={padT + plotH}
                    stroke={lineColor}
                    strokeOpacity={0.25}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                />
            )}

            {/* Tooltip */}
            {hovered && (() => {
                const tx = xFor(hoveredIndex!);
                const ty = yFor(hovered.score);
                const boxW = 64;
                const boxH = 34;
                const boxX = tx + boxW + 8 > width ? tx - boxW - 8 : tx + 8;
                const boxY = Math.max(padT, ty - boxH - 8);
                return (
                    <g style={{ pointerEvents: 'none' }}>
                        <rect
                            x={boxX}
                            y={boxY}
                            width={boxW}
                            height={boxH}
                            rx={6}
                            fill={tooltipFill}
                            stroke={tooltipBorder}
                            strokeWidth={1}
                            style={isLight ? { filter: 'drop-shadow(0 2px 6px rgba(15,23,42,0.15))' } : undefined}
                        />
                        <text x={boxX + boxW / 2} y={boxY + 14} textAnchor="middle" fontSize={9} fill={tooltipLabelColor}>
                            {hovered.label}
                        </text>
                        <text x={boxX + boxW / 2} y={boxY + 27} textAnchor="middle" fontSize={12} fontWeight={700} fill={tooltipValueColor}>
                            {hovered.score}
                        </text>
                    </g>
                );
            })()}

            {/* X-axis labels */}
            {data.map((d, i) => (
                <text key={d.label} x={xFor(i)} y={height - 4} textAnchor="middle" fontSize={10} fill={axisTextColor}>
                    {d.label}
                </text>
            ))}
        </svg>
    );
};

// ─── Top objections (horizontal bar list) ───────────────────────────────────

const TopObjectionsList: React.FC<TopObjectionsListProps> = ({ objections, isLight, onSelect }) => {
    const max = Math.max(...objections.map((o) => o.count), 1);
    const axisMax = Math.ceil((max + 2) / 5) * 5; // round up to a friendly tick

    return (
        <div className="flex flex-col gap-3.5">
            {objections.map((o) => (
                <button
                    key={o.label}
                    type="button"
                    onClick={() => onSelect(o)}
                    disabled={o.latest.length === 0}
                    className={`grid grid-cols-[110px_1fr_28px] items-center gap-3 text-left rounded-md -mx-1 px-1 py-0.5 transition-colors ${o.latest.length > 0
                        ? `cursor-pointer ${isLight ? 'hover:bg-slate-100' : 'hover:bg-white/5'}`
                        : 'cursor-default'
                        }`}
                >
                    <span className="text-sm text-text-secondary truncate">{o.label}</span>
                    <div className={`h-2.5 rounded-full overflow-hidden ${isLight ? 'bg-slate-100' : 'bg-white/5'}`}>
                        <div
                            className="h-full rounded-full bg-gradient-to-r from-red-500 to-red-400"
                            style={{ width: `${(o.count / axisMax) * 100}%` }}
                        />
                    </div>
                    <span className="text-sm font-semibold text-text-primary text-right tabular-nums">{o.count}</span>
                </button>
            ))}
            {/* Axis ticks */}
            <div className="grid grid-cols-[110px_1fr_28px] gap-3">
                <span />
                <div className="flex justify-between text-[10px] text-text-tertiary">
                    {Array.from({ length: axisMax / 5 + 1 }, (_, i) => i * 5).map((t) => (
                        <span key={t}>{t}</span>
                    ))}
                </div>
                <span />
            </div>
        </div>
    );
};

// ─── Ranked rep list (Top Performers / Needs Coaching) ──────────────────────

const RANK_COLORS: Record<RankedRepListProps['rankTheme'], string[]> = {
    positive: ['bg-emerald-500', 'bg-emerald-500/70', 'bg-emerald-500/50'],
    attention: ['bg-red-500', 'bg-red-500/70', 'bg-red-500/50'],
};

const RankedRepList: React.FC<RankedRepListProps> = ({ reps, rankTheme, isLight, onSelectRep }) => (
    <div className="flex flex-col gap-1">
        {reps.map((rep, i) => {
            const avatarColor = avatarColorFor(rep.name);
            const rankColor = RANK_COLORS[rankTheme][i] ?? RANK_COLORS[rankTheme][RANK_COLORS[rankTheme].length - 1];
            return (
                <button
                    type="button"
                    key={rep.name}
                    onClick={() => onSelectRep?.(rep)}
                    disabled={!onSelectRep}
                    className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-xl text-left transition-colors ${onSelectRep ? (isLight ? 'hover:bg-slate-50 cursor-pointer' : 'hover:bg-white/[0.03] cursor-pointer') : 'cursor-default'}`}
                >
                    <span className={`w-5 h-5 rounded-full ${rankColor} text-white text-[11px] font-bold flex items-center justify-center shrink-0`}>
                        {i + 1}
                    </span>
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${avatarColor.bg} ${avatarColor.text}`}>
                        {initialsFor(rep.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-text-primary truncate">{rep.name}</p>
                        <p className="text-xs text-text-tertiary truncate">{rep.role}</p>
                    </div>
                    <span className="text-sm font-bold text-text-primary tabular-nums">{rep.score}</span>
                </button>
            );
        })}
    </div>
);

// ─── All AEs table ───────────────────────────────────────────────────────────
// Score color follows a fixed threshold so it stays consistent regardless of
// who's in the list: ≥80 strong (green), ≥65 building (amber), else at-risk (red).

function scoreTheme(score: number): { bar: string; text: string } {
    if (score >= 70) return { bar: 'bg-emerald-500', text: 'text-emerald-400' };
    if (score >= 40) return { bar: 'bg-amber-500', text: 'text-amber-400' };
    return { bar: 'bg-red-500', text: 'text-red-400' };
}

const AllAEsTable: React.FC<AllAEsTableProps> = ({ aes, isLight, onSelectAe }) => (
    <div className="flex flex-col">
        {/* Column headers */}
        <div className="grid grid-cols-[1fr_80px_180px_20px] gap-4 px-2 pb-2 text-[11px] font-bold text-text-tertiary uppercase tracking-wider border-b border-border-subtle">
            <span>AE</span>
            <span className="text-left">Calls</span>
            <span>Score</span>
            <span />
        </div>

        {aes.map((ae) => {
            const avatarColor = avatarColorFor(ae.name);
            const theme = scoreTheme(ae.score);
            const isClickable = Boolean(onSelectAe);

            return (
                <button
                    key={ae.name}
                    type="button"
                    onClick={() => onSelectAe?.(ae)}
                    disabled={!isClickable}
                    className={`grid grid-cols-[1fr_80px_180px_20px] gap-4 px-2 py-3 items-center border-b border-border-subtle last:border-b-0 text-left transition-colors ${isClickable ? (isLight ? 'hover:bg-slate-50 cursor-pointer' : 'hover:bg-white/[0.03] cursor-pointer') : 'cursor-default'}`}
                >
                    <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${avatarColor.bg} ${avatarColor.text}`}>
                            {initialsFor(ae.name)}
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-semibold text-text-primary truncate">{ae.name}</p>
                            <p className="text-xs text-text-tertiary truncate">{ae.role}</p>
                        </div>
                    </div>

                    <span className="text-sm text-text-secondary text-left tabular-nums">{ae.calls}</span>

                    <div className="flex items-center gap-2">
                        <div className={`flex-1 h-1.5 rounded-full overflow-hidden ${isLight ? 'bg-slate-100' : 'bg-white/5'}`}>
                            <div className={`h-full rounded-full ${theme.bar}`} style={{ width: `${ae.score}%` }} />
                        </div>
                        <span className="text-sm font-bold text-text-primary tabular-nums w-6 text-right">{ae.score}</span>
                    </div>

                    <ChevronRight size={15} className="text-text-tertiary justify-self-end" />
                </button>
            );
        })}
    </div>
);

// ─── Section card wrapper ───────────────────────────────────────────────────

const SectionCard: React.FC<SectionCardProps> = ({ title, subtitle, icon, headerRight, cardCls, children }) => (
    <div className={`rounded-2xl border p-5 flex flex-col gap-4 ${cardCls}`}>
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
                <div className="flex items-center gap-2">
                    {icon}
                    <h3 className="text-sm font-bold text-text-primary">{title}</h3>
                </div>
                {subtitle && <p className="text-xs text-text-tertiary mt-0.5">{subtitle}</p>}
            </div>
            {headerRight}
        </div>
        {children}
    </div>
);

// ─── Main export ─────────────────────────────────────────────────────────────

export const ManagerDashboard: React.FC<ManagerDashboardProps> = ({ isOpen }) => {
    const isLight = useResolvedTheme() === 'light';
    const [selectedAe, setSelectedAe] = useState<AeSummary | null>(null);
    const openAeFromRep = (rep: RepEntry) =>
        setSelectedAe({ userId: rep.userId, name: rep.name, role: rep.role, calls: 0, score: rep.score });
    const openAeFromRow = (ae: AeEntry) =>
        setSelectedAe({ userId: ae.userId, name: ae.name, role: ae.role, calls: ae.calls, score: ae.score });

    // ── 1. Tenant + admin check (GET /tenants/me) ───────────────────────────
    const [tenant, setTenant] = useState<Tenant | null>(null);
    const [isLoadingTenant, setIsLoadingTenant] = useState(true);
    const [tenantError, setTenantError] = useState<string | null>(null);
    const isAdmin = useIsTenantOwner(tenant);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        setIsLoadingTenant(true);
        setTenantError(null);
        tenantsApi
            .listMine()
            .then((tenants) => {
                if (cancelled) return;
                // No tenant created yet → nothing to show (handled in render).
                setTenant(tenants[0] ?? null);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setTenantError(err instanceof ApiError ? err.message : 'Failed to load your team.');
            })
            .finally(() => {
                if (!cancelled) setIsLoadingTenant(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    // ── 2. Dashboard data (GET /dashboard?tenant_id=...&period=...) ─────────
    const [period, setPeriod] = useState<DashboardPeriod>('last_week');
    const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
    const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);
    const [dashboardError, setDashboardError] = useState<string | null>(null);
    const [isPeriodMenuOpen, setIsPeriodMenuOpen] = useState(false);

    const [selectedObjection, setSelectedObjection] = useState<ObjectionType | null>(null);

    useEffect(() => {
        if (!isOpen || !tenant || !isAdmin) return;
        let cancelled = false;
        setIsLoadingDashboard(true);
        setDashboardError(null);
        dashboardApi
            .get(tenant.id, period)
            .then((data) => {
                if (!cancelled) setDashboard(data);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setDashboardError(err instanceof ApiError ? err.message : 'Failed to load dashboard data.');
            })
            .finally(() => {
                if (!cancelled) setIsLoadingDashboard(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen, tenant, isAdmin, period]);

    // ── Map API shapes → the presentational props these components already expect ──
    const activeReps = dashboard?.active_members_count ?? 0;
    const totalCalls = dashboard?.total_calls ?? 0;
    const teamAvgScore = dashboard?.team_avg_score ?? 0;
    const allAes: DashboardActiveMember[] = (dashboard?.active_members ?? []).filter((m) => m.role !== 'admin');

    const teamScoreTrend = (dashboard?.trend ?? []).map((t) => ({
        label: t.label,
        score: t.avg_score,
    }));

    const objections: ObjectionType[] = (dashboard?.top_objections ?? []).map((o) => ({
        label: o.category,
        count: o.count,
        latest: o.latest ?? [],
    }));

    const topPerformers: RepEntry[] = (dashboard?.top_performers ?? []).map((p) => ({
        userId: p.user_id,
        name: p.name,
        role: `${p.call_count} call${p.call_count === 1 ? '' : 's'}`,
        score: p.avg_score,
    }));

    const needsCoaching: RepEntry[] = (dashboard?.lowest_performers ?? []).map((p) => ({
        userId: p.user_id,
        name: p.name,
        role: `${p.call_count} call${p.call_count === 1 ? '' : 's'}`,
        score: p.avg_score,
    }));

    const allAeRows: AeEntry[] = allAes.map((m) => ({
        userId: m.user_id,
        name: m.name || m.email || 'Unknown',
        role: m.role === 'admin' ? 'Admin' : 'Member',
        calls: m.calls,
        score: m.avg_score,
    }))

    console.log(allAeRows);
    const periodLabel = PERIOD_OPTIONS.find((p) => p.value === period)?.label ?? 'Select period';
    const hasTenant = tenant !== null;

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
                                        {/* <button
                                        onClick={onClose}
                                        aria-label="Close Manager Dashboard"
                                        className="w-7 h-7 -ml-1 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-item-active/60 transition-colors"
                                    >
                                        <X size={15} />
                                    </button> */}
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
                                    {/* <button className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors ${pillBtnCls}`}>
                                    <SlidersHorizontal size={14} />
                                    Filters
                                </button> */}
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
                <AeDetailView ae={selectedAe} tenantId={tenant?.id ?? null} onBack={() => setSelectedAe(null)} />
            </AnimatePresence>
            <AnimatePresence>
                {selectedObjection && (
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