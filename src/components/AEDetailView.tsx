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
 */

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    ArrowLeft,
    Search,
    Briefcase,
    Target,
    MessageCircle,
    Handshake,
    Radio,
    CheckCircle2,
    Lightbulb,
    ChevronRight,
    TrendingUp,
    Info,
    type LucideIcon,
} from 'lucide-react';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { tenantsApi } from '../lib/tenantsApi';
import { ApiError } from '../lib/apiClient';
import type { MemberDetail, MemberDetailRadarScores, MemberDetailRecentCall } from '../types/tenant';
import MeetingDetails from './MeetingDetails';
import type { Meeting } from '../types/meeting';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AeSummary {
    userId: string;
    name: string;
    role: string;
    calls: number;
    score: number;
}

interface DimensionScore {
    key: string;
    label: string;
    score: number;
    icon: LucideIcon;
    color: string; // hex, used for the arc segment + badge
    ring?: string; // hex, used for the connector-dot stroke (lighter tint of color)
}

interface StrengthOrGap {
    title: string;
    description: string;
    tag: 'Strength' | 'Opportunity';
}

interface RecentCall {
    meetingId: string;
    title: string;
    meta: string; // e.g. "Today · 10:30 AM · 45 min"
    highlight: string; // short green/teal label, e.g. "Economic Buyer"
    score: number;
}

// ─── Dimension metadata (icon/color per radar_scores key) ──────────────────
// Order here drives the order the segments are drawn in on the gauge.

const DIMENSION_META: { key: keyof MemberDetailRadarScores; label: string; icon: LucideIcon; color: string; ring: string }[] = [
    { key: 'MEDDICC', label: 'MEDDICC', icon: Briefcase, color: '#7c3aed', ring: '#a78bfa' },
    { key: 'Discovery', label: 'Discovery', icon: Search, color: '#7c5cf0', ring: '#a5b4fc' },
    { key: 'BANT', label: 'BANT', icon: Target, color: '#4f7fee', ring: '#93c5fd' },
    { key: 'Objections', label: 'Objections', icon: MessageCircle, color: '#22b8cf', ring: '#67e8f9' },
    { key: 'Closing', label: 'Closing', icon: Handshake, color: '#14b88f', ring: '#6ee7b7' },
    { key: 'Signals', label: 'Signals', icon: Radio, color: '#22c55e', ring: '#86efac' },
];

function dimensionsFromRadarScores(radar: MemberDetailRadarScores): DimensionScore[] {
    return DIMENSION_META.map((d) => ({
        key: d.key,
        label: d.label,
        score: Math.round(radar[d.key] ?? 0),
        icon: d.icon,
        color: d.color,
        ring: d.ring,
    }));
}

function strengthsAndGapsFrom(detail: MemberDetail): StrengthOrGap[] {
    const items: StrengthOrGap[] = detail.strengths.map((s) => ({
        title: s.title,
        description: s.description,
        tag: 'Strength',
    }));
    if (detail.weakest_area) {
        items.push({
            title: `${detail.weakest_area} needs focus`,
            description: `${detail.weakest_area} is the lowest-scoring dimension across recent calls.`,
            tag: 'Opportunity',
        });
    }
    return items;
}

function formatCallMeta(startTimeMs: number): string {
    const d = new Date(startTimeMs);
    const datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const timePart = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${datePart} · ${timePart}`;
}

function recentCallsFrom(detail: MemberDetail): RecentCall[] {
    return detail.recent_calls.map((c) => ({
        meetingId: c.meeting_id,
        title: c.title,
        meta: formatCallMeta(c.start_time),
        highlight: c.highlight || '—',
        score: c.score,
    }));
}

// Builds a minimal placeholder Meeting so MeetingDetails can paint instantly
// (title/date) while its own useQuery (meetingsApi.get) fetches the full
// record — same "list row as initialData" pattern Launcher/MeetingDetails use.
function placeholderMeetingFromCall(c: MemberDetailRecentCall): Meeting {
    return {
        id: c.meeting_id,
        title: c.title,
        date: new Date(c.start_time).toISOString(),
        duration: '',
        summary: '',
    };
}

// ─── Small shared bits (kept local so this file drops in standalone) ───────

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

// ─── Mini sparkline (inline SVG, no chart dependency) ───────────────────────

const MiniSparkline: React.FC<{ data: number[]; color: string; width?: number; height?: number }> = ({
    data,
    color,
    width = 220,
    height = 56,
}) => {
    if (data.length === 0) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = Math.max(1, max - min);
    const points = data
        .map((v, i) => {
            const x = data.length === 1 ? width / 2 : (i / (data.length - 1)) * width;
            const y = height - ((v - min) / range) * (height - 6) - 3;
            return `${x},${y}`;
        })
        .join(' ');

    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
            <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
        </svg>
    );
};

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

interface DimensionGaugeProps {
    dimensions: DimensionScore[];
    overallScore: number;
    isLight: boolean;
    isAboveTeamAverage: boolean;
}

const DimensionGauge: React.FC<DimensionGaugeProps> = ({ dimensions, overallScore, isLight, isAboveTeamAverage }) => {
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

const StrengthsAndGapsList: React.FC<{ items: StrengthOrGap[]; isLight: boolean }> = ({ items, isLight }) => (
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

const RecentCallsList: React.FC<{ calls: RecentCall[]; isLight: boolean; onSelectCall?: (call: RecentCall) => void }> = ({
    calls,
    isLight,
    onSelectCall,
}) => (
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
                {/* <span className="text-xs text-text-tertiary truncate">
                    Highlight: <span className="text-cyan-400 font-medium">{call.highlight}</span>
                </span> */}
                <span className="text-sm font-bold text-text-primary text-right tabular-nums">{call.score}</span>
                <ChevronRight size={14} className="text-text-tertiary justify-self-end" />
            </button>
        ))}
    </div>
);

// ─── Main export ─────────────────────────────────────────────────────────────

interface AeDetailViewProps {
    ae: AeSummary | null;
    tenantId: string | null;
    onBack: () => void;
}

export const AeDetailView: React.FC<AeDetailViewProps> = ({ ae, tenantId, onBack }) => {
    const isLight = useResolvedTheme() === 'light';
    const isOpen = ae !== null;

    // ── Detail fetch (GET /tenants/:tenant_id/members/:user_id) ─────────────
    const [detail, setDetail] = useState<MemberDetail | null>(null);
    const [isLoadingDetail, setIsLoadingDetail] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);

    useEffect(() => {
        if (!ae || !tenantId) {
            setDetail(null);
            setDetailError(null);
            return;
        }
        let cancelled = false;
        setIsLoadingDetail(true);
        setDetailError(null);
        setDetail(null);
        tenantsApi
            .getMember(tenantId, ae.userId)
            .then((data) => {
                if (!cancelled) setDetail(data);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setDetailError(err instanceof ApiError ? err.message : 'Failed to load AE detail.');
            })
            .finally(() => {
                if (!cancelled) setIsLoadingDetail(false);
            });
        return () => {
            cancelled = true;
        };
        // Re-fetch whenever a different AE (or tenant) is opened.
    }, [ae?.userId, tenantId]);

    const cardCls = isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle';
    const avatarColor = ae ? avatarColorFor(ae.name) : AVATAR_PALETTE[0];

    // Prefer live detail once it's back; fall back to the dashboard summary
    // (name/role/calls/score) so the header paints instantly on open.
    const displayName = detail?.name ?? ae?.name ?? '';
    const displayRole = ae?.role ?? (detail?.role === 'admin' ? 'Admin' : 'Member');
    const displayCalls = detail?.calls_total ?? ae?.calls ?? 0;
    const displayScore = Math.round(detail?.avg_score ?? ae?.score ?? 0);

    const dimensions = detail ? dimensionsFromRadarScores(detail.radar_scores) : [];
    const strengthsAndGaps = detail ? strengthsAndGapsFrom(detail) : [];
    const recentCalls = detail ? recentCallsFrom(detail) : [];
    const sparkline = recentCalls.map((c) => c.score).reverse();

    // ── Post-call analysis (opens the same MeetingDetails view used elsewhere) ─
    const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);

    // Reset the open call whenever a different AE is opened / the panel closes.
    useEffect(() => {
        setSelectedMeeting(null);
    }, [ae?.userId]);

    const handleSelectCall = (call: RecentCall) => {
        const raw = detail?.recent_calls.find((c) => c.meeting_id === call.meetingId);
        if (!raw) return;
        setSelectedMeeting(placeholderMeetingFromCall(raw));
    };

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
                                        <MiniSparkline data={sparkline} color="#8b5cf6" />
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
                                            <p className="text-sm text-text-tertiary py-16 text-center">Loading…</p>
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
                                            <p className="text-sm text-text-tertiary py-6 text-center">Loading…</p>
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