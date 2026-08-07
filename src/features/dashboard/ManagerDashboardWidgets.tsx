/**
 * ManagerDashboardWidgets.tsx
 *
 * Pure presentational pieces used by ManagerDashboard. None of these own any
 * data-fetching or network state — that all lives in useManagerDashboard —
 * they only render whatever props they're handed.
 */

import React from 'react';
import { ChevronRight } from 'lucide-react';
import { AllAEsTableProps, RankedRepListProps, SectionCardProps, StatCardProps, TopObjectionsListProps, TeamScoreChartProps } from '@/types';
import { Skeleton, avatarColorFor, initialsFor } from './shared';

// ─── Stat card ────────────────────────────────────────────────────────────────

export const StatCard: React.FC<StatCardProps> = ({ icon, iconBg, label, value, cardCls }) => (
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

export const StatCardSkeleton: React.FC<{ icon: React.ReactNode; iconBg: string; label: string; cardCls: string; isLight: boolean }> = ({ icon, iconBg, label, cardCls, isLight }) => (
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

// ─── Skeleton loaders ────────────────────────────────────────────────────────

export const ChartSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <div className="flex items-end gap-2 h-[180px] py-2">
        {[45, 70, 55, 85, 60, 95, 50].map((h, i) => (
            <Skeleton key={i} isLight={isLight} className="flex-1" style={{ height: `${h}%` } as React.CSSProperties} />
        ))}
    </div>
);

export const ListSkeleton: React.FC<{ isLight: boolean; rows?: number }> = ({ isLight, rows = 4 }) => (
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

export const TableSkeleton: React.FC<{ isLight: boolean; rows?: number }> = ({ isLight, rows = 6 }) => (
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

export const TeamScoreChart: React.FC<TeamScoreChartProps> = ({ data, isLight }) => {

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

export const TopObjectionsList: React.FC<TopObjectionsListProps> = ({ objections, isLight, onSelect }) => {
    const max = Math.max(...objections.map((o) => o.count), 1);
    const axisMax = Math.ceil((max + 2) / 5) * 5; // round up to a friendly tick

    return (
        <div className="flex flex-col gap-3.5">
            {objections.map((o, i) => (
                <button
                    key={o.label ? `${o.label}-${i}` : `objection-${i}`}
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

export const RankedRepList: React.FC<RankedRepListProps> = ({ reps, rankTheme, isLight, onSelectRep }) => (
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
// who's in the list: ≥70 strong (green), ≥40 building (amber), else at-risk (red).

function scoreTheme(score: number): { bar: string; text: string } {
    if (score >= 70) return { bar: 'bg-emerald-500', text: 'text-emerald-400' };
    if (score >= 40) return { bar: 'bg-amber-500', text: 'text-amber-400' };
    return { bar: 'bg-red-500', text: 'text-red-400' };
}

export const AllAEsTable: React.FC<AllAEsTableProps> = ({ aes, isLight, onSelectAe }) => (
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

export const SectionCard: React.FC<SectionCardProps> = ({ title, subtitle, icon, headerRight, cardCls, children }) => (
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