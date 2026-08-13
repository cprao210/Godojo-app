/**
 * AeDetailWidgets.tsx
 *
 * Pure presentational pieces used by AeDetailView. None of these own any
 * data-fetching or network state — that all lives in useAeDetail — they only
 * render whatever props they're handed.
 */

import React from 'react';
import { Briefcase, CheckCircle2, Lightbulb, ChevronRight, TrendingUp } from 'lucide-react';
import { DimensionGaugeProps, StrengthOrGap, RecentCall } from '@/types';
import { Skeleton } from './shared';

// ─── AE detail skeletons ─────────────────────────────────────────────────────
// Shape-matched placeholders shown while isLoadingDetail is true, so the panel
// reads as "this rep's data is loading" rather than a bare "Loading…" string.

export const DimensionGaugeSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <div className="flex flex-col items-center py-4">
        <Skeleton isLight={isLight} className="w-48 h-24 rounded-t-full rounded-b-none" />
        <div className="flex items-center gap-3 mt-5">
            {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} isLight={isLight} className="h-3 w-10" />
            ))}
        </div>
    </div>
);

export const RecentCallsSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <div className="flex flex-col gap-3 py-1">
        {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1.5 flex-1">
                    <Skeleton isLight={isLight} className="h-3.5 w-1/2" />
                    <Skeleton isLight={isLight} className="h-3 w-1/3" />
                </div>
                <Skeleton isLight={isLight} className="h-6 w-10 shrink-0" />
            </div>
        ))}
    </div>
);

// Row-shaped placeholder for "Strengths & areas to focus" — mirrors
// StrengthsAndGapsList's icon-chip + title/description layout so the card
// doesn't jump around once real data lands.
export const StrengthsAndGapsSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <div className="flex flex-col gap-1">
        {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-2 py-2.5">
                <Skeleton isLight={isLight} className="w-7 h-7 rounded-lg shrink-0" />
                <div className="min-w-0 flex-1 flex flex-col gap-1.5 pt-0.5">
                    <Skeleton isLight={isLight} className="h-3.5 w-2/5" />
                    <Skeleton isLight={isLight} className="h-3 w-4/5" />
                </div>
            </div>
        ))}
    </div>
);

// ─── Radial dimension gauge (6 colored arc segments over a semicircle) ──────

function polar(cx: number, cy: number, r: number, angleDeg: number) {
    // angleDeg: 0 = top, -90 = left, 90 = right (matches a left-to-right semicircle sweep)
    const a = (angleDeg - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx: number, cy: number, rOuter: number, rInner: number, startA: number, endA: number) {
    const p1 = polar(cx, cy, rOuter, startA);
    const p2 = polar(cx, cy, rOuter, endA);
    const p3 = polar(cx, cy, rInner, endA);
    const p4 = polar(cx, cy, rInner, startA);
    const large = endA - startA > 180 ? 1 : 0;
    return [
        `M ${p1.x} ${p1.y}`,
        `A ${rOuter} ${rOuter} 0 ${large} 1 ${p2.x} ${p2.y}`,
        `L ${p3.x} ${p3.y}`,
        `A ${rInner} ${rInner} 0 ${large} 0 ${p4.x} ${p4.y}`,
        'Z',
    ].join(' ');
}

export const DimensionGauge: React.FC<DimensionGaugeProps> = ({ dimensions, overallScore, isLight, isAboveTeamAverage }) => {
    const width = 520;
    const height = 340;
    const cx = width / 2;
    const cy = 250;
    const rOuter = 150;

    const rInner = 100;
    const rBadge = (rOuter + rInner) / 2;

    const startAngle = -90;
    const endAngle = 90;
    const segAngle = (endAngle - startAngle) / dimensions.length;
    const gap = 1.2; // deg of breathing room between segments

    const textColor = isLight ? '#64748b' : '#94a3b8';
    const ringFill = isLight ? '#e2e8f0' : '#1e293b';
    const bgColor = isLight ? '#fff' : '#0d1117';
    const leaderColor = isLight ? '#94a3b8' : '#64748b';

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="Sales performance by dimension">
            {/* Outer halo ring/track */}
            <path d={arcPath(cx, cy, rOuter + 14, rOuter + 10, startAngle - 1, endAngle + 1)} fill={ringFill} />

            {dimensions.map((d, i) => {
                const a1 = startAngle + i * segAngle + gap / 2;
                const a2 = startAngle + (i + 1) * segAngle - gap / 2;
                const mid = (a1 + a2) / 2;
                const badgePos = polar(cx, cy, rBadge, mid);
                const tickPos = polar(cx, cy, rOuter + 12, mid);
                const leaderEnd = polar(cx, cy, rOuter + 34, mid);
                const labelPos = polar(cx, cy, rOuter + 54, mid);
                const Icon = d.icon;
                const ringColor = d.ring ?? d.color;

                return (
                    <g key={d.key}>
                        <path d={arcPath(cx, cy, rOuter, rInner, a1, a2)} fill={d.color} opacity={0.94} />

                        {/* Icon + score, stacked, centered on the segment */}
                        <foreignObject x={badgePos.x - 16} y={badgePos.y - 20} width={32} height={40}>
                            <div className="flex flex-col items-center justify-center text-white">
                                <Icon size={20} className="opacity-95" />
                                <span className="text-[12px] font-bold leading-tight mt-0.5">{d.score}</span>
                            </div>
                        </foreignObject>

                        {/* Tick dot sitting on the halo ring */}
                        <circle cx={tickPos.x} cy={tickPos.y} r={4.5} fill={bgColor} stroke={ringColor} strokeWidth={2} />

                        {/* Dotted leader line up to the label */}
                        <line
                            x1={tickPos.x}
                            y1={tickPos.y}
                            x2={leaderEnd.x}
                            y2={leaderEnd.y}
                            stroke={leaderColor}
                            strokeWidth={1}
                            strokeDasharray="2 3"
                        />

                        {/* Dimension label */}
                        <text
                            x={labelPos.x}
                            y={labelPos.y}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fontSize={11}
                            fontWeight={600}
                            fill={textColor}
                        >
                            {d.label}
                        </text>
                    </g>
                );
            })}

            {/* Center: overall score */}
            <text x={cx} y={cy - 24} textAnchor="middle" fontSize={52} fontWeight={800} fill={isLight ? '#0f172a' : '#fff'}>
                {overallScore}
            </text>
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill={textColor}>
                Overall score
            </text>
            {isAboveTeamAverage && (
                <foreignObject x={cx - 90} y={cy + 18} width={180} height={28}>
                    <div className="flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs font-semibold w-fit mx-auto">
                        <TrendingUp size={12} />
                        Above team average
                    </div>
                </foreignObject>
            )}
        </svg>
    );
};

// ─── Strengths & areas to focus list ─────────────────────────────────────────

export const StrengthsAndGapsList: React.FC<{ items: StrengthOrGap[]; isLight: boolean }> = ({ items, isLight }) => (
    <div className="flex flex-col gap-1">
        {items.length === 0 && (
            <p className="text-sm text-text-tertiary py-6 text-center">Not enough call data yet.</p>
        )}
        {items.map((item) => {
            const isStrength = item.tag === 'Strength';
            return (
                <div
                    key={item.title}
                    className={`flex items-start gap-3 px-2 py-2.5 rounded-xl transition-colors ${isLight ? 'hover:bg-slate-50' : 'hover:bg-white/[0.03]'}`}
                >
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${isStrength ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                        {isStrength ? <CheckCircle2 size={14} /> : <Lightbulb size={14} />}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-text-primary">{item.title}</p>
                        <p className="text-xs text-text-tertiary mt-0.5">{item.description}</p>
                    </div>
                    <span
                        className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold ${isStrength ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}
                    >
                        {item.tag}
                    </span>
                </div>
            );
        })}
    </div>
);

// ─── Recent calls list ────────────────────────────────────────────────────────

export const RecentCallsList: React.FC<{ calls: RecentCall[]; isLight: boolean; onSelectCall?: (call: RecentCall) => void }> = ({ calls, isLight, onSelectCall }) => (
    <div className="flex flex-col">
        {calls.length === 0 && (
            <p className="text-sm text-text-tertiary py-6 text-center">No recent calls in this period.</p>
        )}
        {calls.map((call, i) => (
            <button
                key={`${call.title}-${i}`}
                type="button"
                onClick={() => onSelectCall?.(call)}
                className={`grid grid-cols-[36px_1fr_180px_50px_16px] gap-3 items-center px-2 py-3 text-left border-b border-border-subtle last:border-b-0 transition-colors ${isLight ? 'hover:bg-slate-50' : 'hover:bg-white/[0.03]'}`}
            >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isLight ? 'bg-violet-100 text-violet-500' : 'bg-violet-500/15 text-violet-400'}`}>
                    <Briefcase size={14} />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-semibold text-text-primary truncate">{call.title}</p>
                    <p className="text-xs text-text-tertiary truncate">{call.meta}</p>
                </div>
                <span className="text-sm font-bold text-text-primary text-right tabular-nums">{call.score}</span>
                <ChevronRight size={14} className="text-text-tertiary justify-self-end" />
            </button>
        ))}
    </div>
);