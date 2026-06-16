import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LiveAnalysisData } from '../types/liveAnalysis';
import { useResolvedTheme } from '../hooks/useResolvedTheme';

// ─── Scoring logic ────────────────────────────────────────────────────────────
//
// Weights (must sum to 100):
//   BANT fields  — 40 pts total  (10 each: budget, authority, need, timeline)
//   MEDDICC fields — 42 pts total  (6 each: metrics, economic_buyer,
//                                   decision_criteria, decision_process,
//                                   identify_pain, champion, competition)
//   Signals bonus — up to 12 pts  (+3 per positive signal, −3 per negative,
//                                   capped ±12)
//   Objections penalty — up to −6 pts (−3 per open objection, capped)
//
// Per-field points: confirmed=full, partial=half, missing=0

const BANT_WEIGHT = 10;   // × 4 fields = 40
const MEDDICC_WEIGHT = 6;  // × 7 fields = 42
const MAX_SIGNAL_BONUS = 12;
const MAX_OBJECTION_PENALTY = 6;

function statusPoints(status: string, weight: number): number {
    if (status === 'confirmed') return weight;
    if (status === 'partial') return weight * 0.5;
    return 0;
}

export function computeDealScore(data: LiveAnalysisData): number {
    // BANT
    const bantScore =
        statusPoints(data.bant.budget.status, BANT_WEIGHT) +
        statusPoints(data.bant.authority.status, BANT_WEIGHT) +
        statusPoints(data.bant.need.status, BANT_WEIGHT) +
        statusPoints(data.bant.timeline.status, BANT_WEIGHT);

    // MEDDICC
    const meddicScore =
        statusPoints(data.meddic.metrics.status, MEDDICC_WEIGHT) +
        statusPoints(data.meddic.economic_buyer.status, MEDDICC_WEIGHT) +
        statusPoints(data.meddic.decision_criteria.status, MEDDICC_WEIGHT) +
        statusPoints(data.meddic.decision_process.status, MEDDICC_WEIGHT) +
        statusPoints(data.meddic.identify_pain.status, MEDDICC_WEIGHT) +
        statusPoints(data.meddic.champion.status, MEDDICC_WEIGHT) +
        statusPoints(data.meddic.competition.status, MEDDICC_WEIGHT);

    // Signals bonus
    const positiveSignals = data.signals.filter(s => s.category === 'positive').length;
    const negativeSignals = data.signals.filter(s => s.category === 'negative').length;
    const rawSignalBonus = (positiveSignals * 3) - (negativeSignals * 3);
    const signalBonus = Math.max(-MAX_SIGNAL_BONUS, Math.min(MAX_SIGNAL_BONUS, rawSignalBonus));

    // Open objection penalty
    const openObjections = data.objections.filter(o => o.status === 'open').length;
    const objectionPenalty = Math.min(MAX_OBJECTION_PENALTY, openObjections * 3);

    const raw = bantScore + meddicScore + signalBonus - objectionPenalty;
    return Math.max(0, Math.min(100, Math.round(raw)));
}

// ─── Score label / colour ─────────────────────────────────────────────────────
function scoreLabel(score: number): { label: string; color: string; glow: string; trackColor: string } {
    if (score >= 75) return {
        label: 'Strong',
        color: '#34d399',      // emerald-400
        glow: 'rgba(52,211,153,0.35)',
        trackColor: 'rgba(52,211,153,0.15)',
    };
    if (score >= 50) return {
        label: 'Building',
        color: '#fbbf24',      // amber-400
        glow: 'rgba(251,191,36,0.35)',
        trackColor: 'rgba(251,191,36,0.12)',
    };
    if (score >= 25) return {
        label: 'Early',
        color: '#fb923c',      // orange-400
        glow: 'rgba(251,146,60,0.35)',
        trackColor: 'rgba(251,146,60,0.12)',
    };
    return {
        label: 'At Risk',
        color: '#f87171',      // red-400
        glow: 'rgba(248,113,113,0.35)',
        trackColor: 'rgba(248,113,113,0.10)',
    };
}

// ─── Animated arc (SVG) ───────────────────────────────────────────────────────
const ARC_R = 32;
const ARC_CX = 44;
const ARC_CY = 40;
const ARC_START_DEG = 240;
const ARC_SWEEP_DEG = 240;

function polarToXY(cx: number, cy: number, r: number, deg: number) {
    const rad = (deg - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number, pct: number): string {
    const actualSweep = sweepDeg * pct;
    const start = polarToXY(cx, cy, r, startDeg);
    const end = polarToXY(cx, cy, r, startDeg + actualSweep);
    const large = actualSweep > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

function trackPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): string {
    const start = polarToXY(cx, cy, r, startDeg);
    const end = polarToXY(cx, cy, r, startDeg + sweepDeg);
    return `M ${start.x} ${start.y} A ${r} ${r} 0 1 1 ${end.x} ${end.y}`;
}

interface ArcGaugeProps {
    score: number;
    color: string;
    glow: string;
    trackColor: string;
    subTextColor: string;
}

const ArcGauge: React.FC<ArcGaugeProps> = ({ score, color, glow, trackColor, subTextColor }) => {
    const pct = score / 100;
    const filledPath = arcPath(ARC_CX, ARC_CY, ARC_R, ARC_START_DEG, ARC_SWEEP_DEG, pct);
    const trackPathStr = trackPath(ARC_CX, ARC_CY, ARC_R, ARC_START_DEG, ARC_SWEEP_DEG);

    // Animated score number
    const [displayed, setDisplayed] = useState(0);
    const raf = useRef<number | null>(null);
    const startRef = useRef<number | null>(null);
    const fromRef = useRef(0);

    useEffect(() => {
        fromRef.current = displayed;
        startRef.current = null;
        const duration = 900;
        const animate = (ts: number) => {
            if (!startRef.current) startRef.current = ts;
            const elapsed = ts - startRef.current;
            const t = Math.min(elapsed / duration, 1);
            // ease-out cubic
            const ease = 1 - Math.pow(1 - t, 3);
            setDisplayed(Math.round(fromRef.current + (score - fromRef.current) * ease));
            if (t < 1) raf.current = requestAnimationFrame(animate);
        };
        raf.current = requestAnimationFrame(animate);
        return () => { if (raf.current) cancelAnimationFrame(raf.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [score]);

    return (
        <div className="relative shrink-0" style={{ width: 88, height: 88 }}>
            <svg width="88" height="88" viewBox="0 0 88 88" style={{ overflow: 'visible' }}>
                <defs>
                    <filter id="gauge-glow" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="2.5" result="blur" />
                        <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>

                {/* Track */}
                <path
                    d={trackPathStr}
                    fill="none"
                    stroke={trackColor}
                    strokeWidth="5"
                    strokeLinecap="round"
                />

                {/* Filled arc — drawn with a motion path length trick */}
                <motion.path
                    d={filledPath}
                    fill="none"
                    stroke={color}
                    strokeWidth="5"
                    strokeLinecap="round"
                    filter="url(#gauge-glow)"
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ duration: 0.9, ease: [0.33, 1, 0.68, 1] }}
                    key={score} // re-trigger animation on score change
                />
            </svg>

            {/* Center number */}
            <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ paddingBottom: 8 }}>
                <span
                    className="font-bold tabular-nums"
                    style={{ fontSize: 22, lineHeight: 1, color, textShadow: `0 0 12px ${glow}` }}
                >
                    {displayed}
                </span>
                <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: subTextColor, marginTop: 1 }}>
                    /100
                </span>
            </div>
        </div>
    );
};

// ─── Mini breakdown bar ────────────────────────────────────────────────────────
interface BreakdownBarProps {
    label: string;
    filled: number;
    total: number;
    color: string;
    labelColor: string;
    trackBg: string;
    pctColor: string;
}

const BreakdownBar: React.FC<BreakdownBarProps> = ({ label, filled, total, color, labelColor, trackBg, pctColor }) => {
    const pct = total > 0 ? filled / total : 0;
    return (
        <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold tracking-wide uppercase w-11 shrink-0" style={{ color: labelColor }}>
                {label}
            </span>
            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: trackBg }}>
                <motion.div
                    className="h-full rounded-full"
                    style={{ background: color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${pct * 100}%` }}
                    transition={{ duration: 0.85, ease: [0.33, 1, 0.68, 1] }}
                />
            </div>
            <span className="text-[10px] tabular-nums w-5 text-right" style={{ color: pctColor }}>
                {Math.round(pct * 100)}%
            </span>
        </div>
    );
};

// ─── Trend arrow ──────────────────────────────────────────────────────────────
type Trend = 'up' | 'down' | 'flat';

function getTrend(prev: number | null, curr: number): Trend {
    if (prev === null) return 'flat';
    if (curr > prev + 2) return 'up';
    if (curr < prev - 2) return 'down';
    return 'flat';
}

// ─── Main export ──────────────────────────────────────────────────────────────
interface DealHealthScoreProps {
    analysisData: LiveAnalysisData;
    isRefreshRun?: boolean;
    calledFromAnalysisTab?: boolean;
}

export const DealHealthScore: React.FC<DealHealthScoreProps> = ({ analysisData, isRefreshRun, calledFromAnalysisTab = false, }) => {
    const score = computeDealScore(analysisData);
    const { label, color, glow, trackColor } = scoreLabel(score);

    const isLight = useResolvedTheme() !== "dark";

    // Track previous score for trend
    const prevScoreRef = useRef<number | null>(null);
    const [trend, setTrend] = useState<Trend>('flat');

    useEffect(() => {
        if (isRefreshRun && prevScoreRef.current !== null) {
            setTrend(getTrend(prevScoreRef.current, score));
        }
        prevScoreRef.current = score;
    }, [score, isRefreshRun]);

    // Breakdown sub-scores (0–1)
    const bantFields = [
        analysisData.bant.budget.status,
        analysisData.bant.authority.status,
        analysisData.bant.need.status,
        analysisData.bant.timeline.status,
    ];
    const meddicFields = [
        analysisData.meddic.metrics.status,
        analysisData.meddic.economic_buyer.status,
        analysisData.meddic.decision_criteria.status,
        analysisData.meddic.decision_process.status,
        analysisData.meddic.identify_pain.status,
        analysisData.meddic.champion.status,
        analysisData.meddic.competition.status,
    ];

    const bantEarned = bantFields.reduce((s, st) => s + (st === 'confirmed' ? 1 : st === 'partial' ? 0.5 : 0), 0);
    const meddicEarned = meddicFields.reduce((s, st) => s + (st === 'confirmed' ? 1 : st === 'partial' ? 0.5 : 0), 0);

    const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : null;
    const trendColor = trend === 'up' ? '#34d399' : '#f87171';

    // ── Theme tokens ──────────────────────────────────────────────────────────
    const cardBg = calledFromAnalysisTab ? isLight ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.03)';
    const cardBorder = calledFromAnalysisTab ? isLight ? `1px solid ${color}44` : `1px solid ${color}22` : `1px solid ${color}22`;
    const cardShadow = calledFromAnalysisTab ? isLight ? `0 2px 16px ${glow}18` : `0 0 20px ${glow}22` : `0 0 20px ${glow}22`;
    const dealHealthTextColor = calledFromAnalysisTab ? isLight ? 'rgba(30,30,40,0.45)' : 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.25)';
    const subTextColor = calledFromAnalysisTab ? isLight ? 'rgba(30,30,40,0.35)' : 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.3)';
    const barLabelColor = calledFromAnalysisTab ? isLight ? 'rgba(30,30,40,0.45)' : 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.35)';
    const barTrackBg = calledFromAnalysisTab ? isLight ? 'rgba(30,30,40,0.08)' : 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.06)';
    const barPctColor = calledFromAnalysisTab ? isLight ? 'rgba(30,30,40,0.40)' : 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.3)';

    return (
        <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            className="mx-4 mb-2 mt-2 rounded-xl flex items-center gap-4 px-4 py-3"
            style={{
                background: cardBg,
                border: cardBorder,
                boxShadow: cardShadow,
            }}
        >
            {/* Arc gauge */}
            <ArcGauge score={score} color={color} glow={glow} trackColor={trackColor} subTextColor={subTextColor} />

            {/* Right: label + trend + bars */}
            <div className="flex-1 min-w-0 flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                    <span className="text-[13px] font-bold tracking-wide" style={{ color }}>
                        {label}
                    </span>
                    <span className="text-[11px] font-medium" style={{ color: dealHealthTextColor }}>
                        Deal Health
                    </span>
                    <AnimatePresence>
                        {trendIcon && (
                            <motion.span
                                key={trend}
                                initial={{ opacity: 0, scale: 0.6 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0 }}
                                className="text-[12px] font-bold ml-auto"
                                style={{ color: trendColor }}
                            >
                                {trendIcon}
                            </motion.span>
                        )}
                    </AnimatePresence>
                </div>

                <div className="flex flex-col gap-1.5">
                    <BreakdownBar label="BANT" filled={bantEarned} total={4} color={color} labelColor={barLabelColor} trackBg={barTrackBg} pctColor={barPctColor} />
                    <BreakdownBar label="MEDDICC" filled={meddicEarned} total={7} color={color} labelColor={barLabelColor} trackBg={barTrackBg} pctColor={barPctColor} />
                </div>
            </div>
        </motion.div>
    );
};