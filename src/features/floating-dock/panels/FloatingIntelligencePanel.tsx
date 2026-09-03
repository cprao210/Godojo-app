import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Radio, RefreshCw, Clock, ChevronDown } from 'lucide-react';
import { LiveAnalysisContent } from '@/features/live-analysis';
import { LiveAnalysisData, MeetingType, FloatingIntelligencePanelProps } from '@/types';
import { resolveIntelligenceView } from '@/lib/intelligenceView';
import { getDockSurfaceStyle } from '../dockSurfaceStyle';

const AUTO_REFRESH_OPTIONS = [
    { label: '2-min', value: 2 },
    { label: '5-min', value: 5 },
    { label: '10-min', value: 10 },
    { label: '15-min', value: 15 },
    { label: '20-min', value: 20 },
];

interface FilmRollTranscriptProps {
    text: string;
    speakerLabel: string;
    speakerColor?: string;
    dotColor?: string;
    liveColor?: string;
}

// ── Film-roll transcript — text streams right-to-left like a ticker ──────────
const FilmRollTranscript: React.FC<FilmRollTranscriptProps> = ({ text, speakerLabel, speakerColor = 'text-white/55', dotColor = 'bg-blue-400', liveColor = '#f87171' }) => {

    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to end whenever text grows
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollLeft = el.scrollWidth;
    }, [text]);

    return (
        <div className="flex items-center gap-2 w-full min-w-0">
            {/* Live dot */}
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor} animate-pulse shrink-0`} />

            {/* Speaker label — fixed, never scrolls */}
            <span className={`text-[11px] font-medium shrink-0 ${speakerColor}`}>
                {speakerLabel === "Them" ? "Other Party" : speakerLabel}:
            </span>

            {/* Scrolling film strip */}
            <div
                ref={scrollRef}
                className="flex-1 -mt-[4px] min-w-0 overflow-hidden"
                style={{
                    maskImage: 'linear-gradient(to right, transparent 0%, black 8%, black 100%)',
                    WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 8%, black 100%)',
                }}
            >
                <motion.p
                    className="text-[11px] text-white/40 leading-relaxed whitespace-nowrap"
                    animate={{ x: 0 }}
                    style={{ display: 'inline-block' }}
                >
                    {text}
                </motion.p>
            </div>

            {/* LIVE badge */}
            <span
                className="text-[10px] font-bold shrink-0 ml-1"
                style={{ color: liveColor }}
            >
                LIVE
            </span>
        </div>
    );
};

// ─── AI Skeleton Loader ──────────────────────────────────────────────────────
const Shimmer: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className = '', style }) => (
    <div
        className={`rounded-lg overflow-hidden relative ${className}`}
        style={{
            background: 'rgba(255,255,255,0.04)',
            ...style,
        }}
    >
        <motion.div
            className="absolute inset-0"
            style={{
                background: 'linear-gradient(90deg, transparent 0%, rgba(59,130,246,0.08) 50%, transparent 100%)',
            }}
            animate={{ x: ['-100%', '100%'] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }}
        />
    </div>
);

const IntelligenceSkeleton: React.FC = () => (
    <div className="px-4 py-4 flex flex-col gap-5">
        {/* AI scanning indicator */}
        <div className="flex items-center gap-3 px-1">
            <div className="flex gap-1 items-end h-4">
                {[0.4, 0.7, 1, 0.6, 0.85, 0.5, 0.9].map((h, i) => (
                    <motion.div
                        key={i}
                        className="w-0.5 rounded-full bg-blue-400/60"
                        style={{ height: `${h * 100}%` }}
                        animate={{ scaleY: [1, h * 0.4 + 0.2, 1] }}
                        transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.1, ease: 'easeInOut' }}
                    />
                ))}
            </div>
            <motion.span
                className="text-[11px] font-semibold text-blue-400/80 tracking-wide"
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.8, repeat: Infinity }}
            >
                Analysing live call...
            </motion.span>
        </div>

        {/* BANT block */}
        <div>
            <div className="flex items-center gap-2 mb-3 px-1">
                <Shimmer className="w-16 h-2.5" />
                <div className="flex-1 h-px bg-white/[0.04]" />
            </div>
            <div className="grid grid-cols-2 gap-2">
                {['Budget', 'Authority', 'Need', 'Timeline'].map((label) => (
                    <div key={label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-white/10" />
                            <Shimmer className="w-12 h-2" />
                        </div>
                        <Shimmer className="w-full h-2" />
                        <Shimmer className="w-3/4 h-2" />
                    </div>
                ))}
            </div>
        </div>

        {/* MEDDIC block */}
        <div>
            <div className="flex items-center gap-2 mb-3 px-1">
                <Shimmer className="w-20 h-2.5" />
                <div className="flex-1 h-px bg-white/[0.04]" />
            </div>
            <div className="flex flex-col gap-2">
                {[90, 75, 60, 80].map((w, i) => (
                    <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 flex items-center gap-3">
                        <div className="w-2 h-2 rounded-full bg-white/10 shrink-0" />
                        <Shimmer style={{ width: `${w}%`, height: 8 }} />
                    </div>
                ))}
            </div>
        </div>

        {/* Signals block */}
        <div>
            <div className="flex items-center gap-2 mb-3 px-1">
                <Shimmer className="w-14 h-2.5" />
                <div className="flex-1 h-px bg-white/[0.04]" />
            </div>
            {[1, 2].map((i) => (
                <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 mb-2 flex flex-col gap-2">
                    <div className="flex gap-2">
                        <Shimmer className="w-16 h-4 rounded-full" />
                        <Shimmer className="w-12 h-4 rounded-full" />
                    </div>
                    <Shimmer className="w-full h-2" />
                    <Shimmer className="w-2/3 h-2" />
                </div>
            ))}
        </div>
    </div>
);

// ─── Waiting / No Data Placeholder ──────────────────────────────────────────
const WaitingPlaceholder: React.FC = () => (
    <div className="flex flex-col items-center justify-center h-full px-6 py-12 gap-5">
        <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.18)' }}
        >
            <Radio size={26} className="text-blue-400/70" strokeWidth={1.5} />
        </div>

        <div className="text-center flex flex-col gap-2">
            <p className="text-[13px] font-semibold text-white/60 tracking-wide">No Analysis Yet</p>
            <p className="text-[11px] text-white/30 leading-relaxed max-w-[220px]">
                Analysis will begin once there is enough transcript. Enable{' '}
                <span className="text-blue-400/70 font-semibold">Auto</span> for scheduled updates or hit{' '}
                <span className="text-blue-400/70 font-semibold">Refresh</span> manually.
            </p>
        </div>

        {/* Decorative idle waveform */}
        <div className="flex gap-1 items-end h-5">
            {[0.3, 0.5, 0.4, 0.6, 0.35, 0.55, 0.4].map((h, i) => (
                <motion.div
                    key={i}
                    className="w-0.5 rounded-full"
                    style={{
                        height: `${h * 100}%`,
                        background: 'rgba(59,130,246,0.25)',
                    }}
                    animate={{ scaleY: [1, h * 0.5 + 0.1, 1] }}
                    transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
                />
            ))}
        </div>
    </div>
);

// Shown when the auto-refresh countdown reached zero without enough
// transcript captured to run an analysis. Does not auto-retry — a new
// analysis cycle only starts on interval change, resume, or a new session.
const NoAnalysisCapturedPlaceholder: React.FC = () => (
    <div className="flex flex-col items-center justify-center h-full px-6 py-12 gap-5">
        <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.18)' }}
        >
            <Radio size={26} className="text-white/30" strokeWidth={1.5} />
        </div>

        <div className="text-center flex flex-col gap-2">
            <p className="text-[13px] font-semibold text-white/60 tracking-wide">No analysis captured</p>
            <p className="text-[11px] text-white/30 leading-relaxed max-w-[220px]">
                Not enough transcript was captured in this window. Hit{' '}
                <span className="text-blue-400/70 font-semibold">Refresh</span> once there's more to analyse.
            </p>
        </div>
    </div>
);

// ─── Countdown Placeholder ────────────────────────────────────────────────────
// Shows a live ring-countdown that matches the auto-refresh interval exactly.
// `openedAt`      — timestamp when the current timer cycle started (from FloatingDock)
// `intervalMins`  — the selected auto-refresh interval in minutes
// `isPaused`      — when true the countdown ring freezes
const CountdownPlaceholder: React.FC<{ openedAt: number; intervalMins: number; isPaused: boolean }> = ({ openedAt, intervalMins, isPaused }) => {

    const totalMs = intervalMins * 60 * 1000;

    // Elapsed time frozen at the moment the meeting was paused; null while running,
    // in which case elapsed is always derived live from `openedAt` (not a ref).
    //
    // Previously this used a `useRef(0)` for the running-elapsed baseline, which
    // reset to 0 on every mount — since this component fully unmounts/remounts
    // whenever the panel swaps to the loading skeleton and back (e.g. checking
    // "Negotiation" triggers an immediate analysis run → brief skeleton → back to
    // this component), the countdown was silently restarting from the full
    // duration on every such swap, discarding real elapsed time. Deriving
    // directly from the `openedAt` prop (which FloatingDock owns and does NOT
    // reset on remount) fixes that regardless of how often this component itself
    // gets torn down and recreated.
    const frozenElapsedAtPauseRef = useRef<number | null>(null);
    const computeElapsed = () => frozenElapsedAtPauseRef.current !== null ? frozenElapsedAtPauseRef.current : Date.now() - openedAt;

    const [remaining, setRemaining] = useState(() => Math.max(0, totalMs - computeElapsed()));

    useEffect(() => {
        // When pausing: snapshot elapsed so far and freeze the ring/digits.
        if (isPaused) {
            frozenElapsedAtPauseRef.current = Date.now() - openedAt;
            setRemaining(Math.max(0, totalMs - frozenElapsedAtPauseRef.current));
            return;
        }

        // Running (including resuming, or a fresh/re-mount): always compute
        // elapsed straight from `openedAt`, the one value that's actually
        // stable across this component's mount/unmount cycles.
        frozenElapsedAtPauseRef.current = null;

        const tick = () => {
            setRemaining(Math.max(0, totalMs - (Date.now() - openedAt)));
        };

        tick(); // immediate paint
        const id = setInterval(tick, 500);
        return () => clearInterval(id);
    }, [isPaused, openedAt, totalMs]);

    const totalSecs = Math.ceil(remaining / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const progress = remaining / totalMs; // 1 → 0 as time elapses (full → empty)

    const R = 45, CX = 48, CY = 48;
    const circumference = 2 * Math.PI * R;
    const dashOffset = circumference * (1 - progress);

    return (
        <div className="flex flex-col items-center justify-center h-full px-6 py-12 gap-5">
            {/* Circular progress ring */}
            <div className="relative" style={{ width: 96, height: 96 }}>
                <svg width="96" height="96" viewBox="0 0 96 96">
                    {/* Track */}
                    <circle
                        cx={CX} cy={CY} r={R}
                        fill="none"
                        stroke="rgba(59,130,246,0.10)"
                        strokeWidth="5"
                    />
                    {/* Progress arc */}
                    <motion.circle
                        cx={CX} cy={CY} r={R}
                        fill="none"
                        stroke={isPaused ? 'rgba(245,158,11,0.6)' : '#3b82f6'}
                        strokeWidth="5"
                        strokeLinecap="round"
                        strokeDasharray={circumference}
                        strokeDashoffset={dashOffset}
                        transform={`rotate(-90 ${CX} ${CY})`}
                        style={{
                            filter: isPaused
                                ? 'drop-shadow(0 0 6px rgba(245,158,11,0.4))'
                                : 'drop-shadow(0 0 6px rgba(59,130,246,0.5))',
                        }}
                        transition={{ duration: 0.5, ease: 'linear' }}
                    />
                </svg>
                {/* Countdown digits */}
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span
                        className="text-[20px] font-bold tabular-nums"
                        style={{ color: isPaused ? 'rgb(251,191,36)' : '#60a5fa', lineHeight: 1 }}
                    >
                        {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
                    </span>
                    <span className="text-[9px] font-semibold tracking-widest uppercase text-white/25 mt-0.5">
                        {isPaused ? 'paused' : 'left'}
                    </span>
                </div>
            </div>

            <div className="text-center flex flex-col gap-2">
                <p className="text-[13px] font-semibold text-white/60 tracking-wide">
                    {isPaused ? 'Meeting Paused' : 'Recording Transcript'}
                </p>
                <p className="text-[11px] text-white/30 leading-relaxed max-w-[220px]">
                    {isPaused
                        ? 'Countdown is paused. Resume the meeting to continue.'
                        : <>GoDojo Intelligence will analyse in <span className="text-blue-400/70 font-semibold">{intervalMins} min{intervalMins !== 1 ? 's' : ''}</span>.</>
                    }
                </p>
            </div>

            {/* Waveform — stills when paused */}
            <div className="flex gap-1 items-end h-5">
                {[0.3, 0.6, 0.4, 0.8, 0.35, 0.65, 0.45].map((h, i) => (
                    <motion.div
                        key={i}
                        className="w-0.5 rounded-full"
                        style={{ height: `${h * 100}%`, background: isPaused ? 'rgba(245,158,11,0.25)' : 'rgba(59,130,246,0.30)' }}
                        animate={isPaused ? { scaleY: 1 } : { scaleY: [1, h * 0.4 + 0.15, 1] }}
                        transition={{ duration: 1.8, repeat: isPaused ? 0 : Infinity, delay: i * 0.15, ease: 'easeInOut' }}
                    />
                ))}
            </div>
        </div>
    );
};

// ─── Meeting Type Selector ────────────────────────────────────────────────────
const MEETING_TYPES: { value: MeetingType; label: string; activeColor: string; activeBg: string; activeBorder: string }[] = [
    { value: 'discovery', label: 'Discovery', activeColor: '#a78bfa', activeBg: 'rgba(139,92,246,0.15)', activeBorder: 'rgba(139,92,246,0.35)' },
    { value: 'demo', label: 'Demo', activeColor: '#34d399', activeBg: 'rgba(52,211,153,0.12)', activeBorder: 'rgba(52,211,153,0.30)' },
    { value: 'negotiation', label: 'Negotiation', activeColor: '#fbbf24', activeBg: 'rgba(251,191,36,0.12)', activeBorder: 'rgba(251,191,36,0.30)' },
];

const MeetingTypeSelector: React.FC<{ selected: MeetingType[]; onChange: (types: MeetingType[]) => void; }> = ({ selected, onChange }) => {

    const toggle = (type: MeetingType) => {
        const isSelected = selected.includes(type);
        // Require at least one meeting type to remain selected — it's needed
        // for meeting score generation. Block unchecking the last one.
        if (isSelected && selected.length === 1) return;
        onChange(isSelected ? selected.filter(t => t !== type) : [...selected, type]);
    };

    return (
        <div
            className="px-4 shrink-0 flex items-center gap-1.5"
            style={{ height: 36, borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.015)' }}
        >
            <span className="text-[10px] font-semibold uppercase tracking-widest text-white/25 mr-1 shrink-0">Type</span>
            {MEETING_TYPES.map(opt => {
                const on = selected.includes(opt.value);
                return (
                    <button
                        key={opt.value}
                        onClick={() => toggle(opt.value)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all active:scale-95 select-none"
                        style={{
                            background: on ? opt.activeBg : 'rgba(255,255,255,0.04)',
                            border: `1px solid ${on ? opt.activeBorder : 'rgba(255,255,255,0.07)'}`,
                            color: on ? opt.activeColor : 'rgba(255,255,255,0.30)',
                        }}
                    >
                        <span
                            className="w-2.5 h-2.5 rounded-sm flex items-center justify-center shrink-0"
                            style={{ border: `1.5px solid ${on ? opt.activeColor : 'rgba(255,255,255,0.18)'}`, background: on ? opt.activeBg : 'transparent' }}
                        >
                            {on && (
                                <svg width="6" height="5" viewBox="0 0 6 5" fill="none">
                                    <path d="M0.5 2.5L2 4L5.5 0.5" stroke={opt.activeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            )}
                        </span>
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
};

export const FloatingIntelligencePanel: React.FC<FloatingIntelligencePanelProps> = ({
    isMeetingPaused,
    analysisData,
    analysisError,
    showTranscript,
    isLoading,
    onRegenerate,
    autoRefreshInterval,
    onAutoRefreshIntervalChange,
    isRefreshRun,
    rollingTranscriptUser,
    rollingTranscriptClient,
    isClientSpeaking,
    isUserSpeaking,
    speakerNames,
    panelFirstOpenedAt,
    noAnalysisCaptured,
    isCountdownActive = false,
    isOpen,
    meetingTypes,
    onMeetingTypesChange,
    isPerformanceMode = false,
}) => {
    const [showRefreshPicker, setShowRefreshPicker] = useState(false);
    const refreshPickerRef = useRef<HTMLDivElement>(null);
    // Objections lead: they arrive in ~1.5s from the dedicated objection-handler route,
    // they're the one output the rep needs while the prospect is still talking, and
    // everything else on this panel is a slower-cadence read.
    const [activeTab, setActiveTab] = useState<'meddicc' | 'bant' | 'signals' | 'objections' | 'deal_optimizer'>('objections');

    // Reset to default tab whenever the panel is opened
    useEffect(() => {
        if (isOpen) setActiveTab('objections');
    }, [isOpen]);

    // If Negotiation is unchecked while on deal_optimizer tab, jump back to meddicc
    useEffect(() => {
        if (activeTab === 'deal_optimizer' && !meetingTypes.includes('negotiation')) {
            setActiveTab('meddicc');
        }
    }, [meetingTypes, activeTab]);

    // Show the panel as soon as ANY section has something to say — not just BANT/MEDDIC.
    // The previous all-missing check nulled displayData whenever every BANT and MEDDIC
    // field was still 'missing', which is exactly the state in the first seconds of a
    // call: objections now land in ~1.5s from their own endpoint, long before the slow
    // extract has confirmed a single BANT field, and would otherwise have been fetched
    // and then hidden behind the WaitingPlaceholder.
    const hasContent = (data: LiveAnalysisData) =>
        data.objections.length > 0 ||
        data.signals.length > 0 ||
        (data.dealOptimizer?.length ?? 0) > 0 ||
        Object.values(data.bant).some(f => f.status !== 'missing') ||
        Object.values(data.meddic).some(f => f.status !== 'missing');

    const displayData = analysisData && hasContent(analysisData) ? analysisData : null;

    // Which of the six mutually-exclusive views this render shows. The rule lives
    // in src/lib/intelligenceView.ts so it can be unit-tested — in particular the
    // guarantee that the countdown ring is never re-entered once its cycle fired.
    const view = resolveIntelligenceView({
        hasDisplayData: displayData !== null,
        isLoading,
        isRefreshRun: !!isRefreshRun,
        hasError: !!analysisError,
        noAnalysisCaptured: !!noAnalysisCaptured,
        isCountdownActive,
        panelFirstOpenedAt,
        autoRefreshInterval,
    });

    // Close dropdown when clicking outside
    useEffect(() => {
        if (!showRefreshPicker) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (refreshPickerRef.current && !refreshPickerRef.current.contains(e.target as Node)) {
                setShowRefreshPicker(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [showRefreshPicker]);

    // Timer is owned by FloatingDock — this handler only updates the interval value
    // and closes the picker. The actual setInterval lives one level up.
    const handleAutoRefresh = (minutes: number | null) => {
        onAutoRefreshIntervalChange(minutes);
        setShowRefreshPicker(false);
    };


    return (
        <div
            className="rounded-2xl overflow-hidden flex flex-col"
            style={{
                width: 420,
                height: 550,
                ...getDockSurfaceStyle({ opacity: 0.93, rgb: '14, 18, 30', blurPx: 28, isPerformanceMode }),
                border: '1px solid rgba(255,255,255,0.08)',
            }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between px-5 py-4 shrink-0"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
            >
                <div className="flex items-center gap-3">
                    <div
                        className="w-9 h-9 rounded-xl flex items-center justify-center"
                        style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.25)' }}
                    >
                        <Radio size={17} className="text-blue-400" strokeWidth={1.8} />
                    </div>
                    <div>
                        <div className="text-[13px] font-bold text-white tracking-wide uppercase">GoDojo Intelligence</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse block" />
                            <span className="text-[11px] text-emerald-400 font-medium">
                                {isMeetingPaused ? 'Paused' : isLoading ? (isRefreshRun ? 'Refreshing…' : 'Analysing…') : 'Active'}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                    {/* Auto-refresh picker */}
                    <div className="relative" ref={refreshPickerRef}>
                        <AnimatePresence>
                            {showRefreshPicker && (
                                <motion.div
                                    initial={{ opacity: 0, y: 6, scale: 0.96 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0, y: 4, scale: 0.97 }}
                                    className="absolute -right-2.5 rounded-xl overflow-hidden z-20"
                                    style={{
                                        bottom: 'calc(100% - 230px)',
                                        background: 'rgba(18,22,34,0.98)',
                                        border: '1px solid rgba(255,255,255,0.1)',
                                        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                                        minWidth: 100,
                                    }}
                                >
                                    <button
                                        onClick={() => handleAutoRefresh(null)}
                                        disabled={autoRefreshInterval === null}
                                        className={`w-full px-4 py-2.5 text-left text-[12px] text-red-400 ${autoRefreshInterval !== null ? "hover:bg-white/5" : "opacity-60 cursor-not-allowed"} transition-colors`}
                                    >
                                        Off
                                    </button>
                                    {AUTO_REFRESH_OPTIONS.map(opt => (
                                        <button
                                            key={opt.value}
                                            onClick={() => handleAutoRefresh(opt.value)}
                                            className="w-full px-4 py-2.5 text-left text-[12px] hover:bg-white/5 transition-colors"
                                            style={{ color: autoRefreshInterval === opt.value ? '#3b82f6' : 'rgba(255,255,255,0.7)' }}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <button
                            onClick={() => setShowRefreshPicker(v => !v)}
                            className="flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] font-semibold transition-colors"
                            style={{
                                background: autoRefreshInterval ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.05)',
                                border: autoRefreshInterval ? '1px solid rgba(59,130,246,0.3)' : '1px solid rgba(255,255,255,0.08)',
                                color: autoRefreshInterval ? '#3b82f6' : 'rgba(255,255,255,0.5)',
                            }}
                        >
                            <Clock size={12} />
                            <span>{autoRefreshInterval ? `${autoRefreshInterval}-min` : 'Auto'}</span>
                            <ChevronDown size={10} />
                        </button>
                    </div>

                    <div className="relative group">
                        <button
                            onClick={onRegenerate}
                            disabled={isLoading}
                            className="flex items-center gap-2 p-2 rounded-xl text-[12px] font-bold tracking-wide uppercase transition-all active:scale-95"
                            style={{
                                background: 'rgba(59,130,246,0.15)',
                                border: '1px solid rgba(59,130,246,0.3)',
                                color: '#3b82f6',
                                opacity: isLoading && !isRefreshRun ? 0.6 : 1,
                            }}
                        >
                            <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
                        </button>
                        {/* Tooltip — only shown while a refresh run is in progress */}
                        {isLoading && isRefreshRun && (
                            <div
                                className="absolute right-0 top-full mt-1.5 px-2 py-1 rounded-lg text-[10px] font-semibold whitespace-nowrap pointer-events-none z-30"
                                style={{
                                    background: 'rgba(18,22,34,0.97)',
                                    border: '1px solid rgba(59,130,246,0.25)',
                                    color: 'rgba(255,255,255,0.6)',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                                }}
                            >
                                Refreshing...
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Rolling transcript strip — two rows, one per speaker, never mixed */}
            {showTranscript && (rollingTranscriptClient || rollingTranscriptUser || isClientSpeaking || isUserSpeaking) && (
                <div
                    className="px-5 py-2 shrink-0 flex flex-col gap-1"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}
                >
                    <FilmRollTranscript
                        text={rollingTranscriptClient}
                        speakerLabel={speakerNames.client}
                        dotColor="bg-red-400"
                        liveColor="#f87171"
                    />
                    {/* "Them" row — system audio / client */}
                    {/* {(rollingTranscriptClient || isClientSpeaking) && (
                        <div className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse mt-1 shrink-0" />
                            <p className="text-[11px] text-white/40 leading-relaxed line-clamp-1 flex-1 min-w-0">
                                <span className="text-white/55 font-medium mr-1">{speakerNames.client === "Them" ? "Client" : speakerNames.client}:</span>
                                <AnimatedTranscriptText text={rollingTranscriptClient} />
                                {isClientSpeaking && <span className="ml-1 text-white/25 animate-pulse">...</span>}
                            </p>
                            <span className="text-[10px] text-red-400 font-bold shrink-0 ml-auto">LIVE</span>
                        </div>
                    )} */}
                    {/* "Me" row — microphone / user */}
                    {/* {(rollingTranscriptUser || isUserSpeaking) && (
                        <div className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse mt-1 shrink-0" />
                            <p className="text-[11px] text-white/40 leading-relaxed line-clamp-1 flex-1 min-w-0">
                                <span className="text-white/55 font-medium mr-1">{speakerNames.user === "Me" ? "User" : speakerNames.user}:</span>
                                {rollingTranscriptUser}
                                {isUserSpeaking && <span className="ml-1 text-white/25 animate-pulse">...</span>}
                            </p>
                        </div>
                    )} */}
                </div>
            )}

            {/* Meeting Type Selector */}
            <MeetingTypeSelector
                selected={meetingTypes}
                onChange={onMeetingTypesChange}
            />

            {/* Tab bar — shown whenever there is live data, including while a
                background refresh of that data is in flight, so a refresh never
                unmounts the tabs while displayData is still valid.

                Gated on displayData alone: the content area below renders
                LiveAnalysisContent for ANY non-null displayData, and falls back to
                the skeleton/placeholders only when it's null, so those two are the
                same condition. The old `(!isLoading || isRefreshRun)` term is what
                made objections-before-first-analysis render content with no tab bar
                above it — the initial live-analysis call holds isLoading true for
                minutes, long after the fast objection route has answered. */}
            {displayData && (
                <div
                    className="shrink-0 overflow-x-auto"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', scrollbarWidth: 'none' }}
                >
                    <div className="flex items-center gap-0.5 px-3 pt-2.5 pb-0 w-max min-w-full">
                        {(
                            [
                                {
                                    // First tab: the fast, act-on-it-now output.
                                    // Badge counts OPEN objections only — resolved ones
                                    // move to a collapsed group and shouldn't inflate it.
                                    key: 'objections' as const,
                                    label: 'Objections',
                                    badge: (() => {
                                        const open = displayData.objections.filter(o => !o.resolved).length;
                                        return open > 0 ? `${open}` : null;
                                    })(),
                                },
                                {
                                    key: 'meddicc' as const,
                                    label: 'MEDDICC',
                                    badge: `${Object.values(displayData.meddic).filter(f => f.status === 'confirmed').length}/7`,
                                },
                                {
                                    key: 'bant' as const,
                                    label: 'BANT',
                                    badge: `${Object.values(displayData.bant).filter(f => f.status === 'confirmed').length}/4`,
                                },
                                {
                                    key: 'signals' as const,
                                    label: 'Signals',
                                    badge: displayData.signals.length > 0 ? `${displayData.signals.length}` : null,
                                },
                                ...(meetingTypes.includes('negotiation') ? [{
                                    key: 'deal_optimizer' as const,
                                    label: 'Deal Alert',
                                    badge: (displayData.dealOptimizer?.length ?? 0) > 0 ? `${displayData.dealOptimizer!.length}` : null,
                                }] : []),
                            ] as const
                        ).map(tab => {
                            const isActive = activeTab === tab.key;
                            return (
                                <button
                                    key={tab.key}
                                    onClick={() => setActiveTab(tab.key)}
                                    className="relative flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold transition-colors rounded-t-lg"
                                    style={{
                                        color: isActive ? '#ffffff' : 'rgba(255,255,255,0.35)',
                                        background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                                        borderBottom: isActive
                                            ? `2px solid ${tab.key === 'deal_optimizer' ? '#fbbf24' : '#3b82f6'}`
                                            : '2px solid transparent',
                                    }}
                                >
                                    {tab.label}
                                    {tab.badge && (
                                        <span
                                            className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                                            style={{
                                                background: isActive ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.08)',
                                                color: isActive ? '#93c5fd' : 'rgba(255,255,255,0.3)',
                                            }}
                                        >
                                            {tab.badge}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Content */}
            <div className="overflow-y-auto flex-1" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}>
                {view === 'skeleton' ? (
                    <IntelligenceSkeleton />
                ) : view === 'error' ? (
                    <div className="flex flex-col items-center justify-center h-full px-6 py-10 gap-4">
                        <div
                            className="w-12 h-12 rounded-xl flex items-center justify-center"
                            style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.20)' }}
                        >
                            <span style={{ fontSize: 20, color: '#f87171' }}>!</span>
                        </div>
                        <div className="text-center flex flex-col gap-1.5">
                            <p className="text-[13px] font-semibold text-white/60">Analysis failed</p>
                            <p className="text-[11px] text-white/30 leading-relaxed max-w-[220px]">{analysisError}</p>
                        </div>
                        <button
                            onClick={onRegenerate}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-semibold"
                            style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: '#3b82f6' }}
                        >
                            <RefreshCw size={12} /> Retry
                        </button>
                    </div>
                ) : view === 'no-analysis-captured' ? (
                    <NoAnalysisCapturedPlaceholder />
                ) : view === 'countdown' ? (
                    <CountdownPlaceholder openedAt={panelFirstOpenedAt!} intervalMins={autoRefreshInterval!} isPaused={isMeetingPaused} />
                ) : view === 'waiting' ? (
                    <WaitingPlaceholder />
                ) : (
                    <LiveAnalysisContent
                        analysisData={displayData!}
                        hideBar="Missing Details"
                        activeTab={activeTab as 'meddicc' | 'bant' | 'signals' | 'objections' | 'deal_optimizer'}
                    />
                )}
            </div>
        </div>
    );
};