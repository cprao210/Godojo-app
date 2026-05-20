import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Radio, RefreshCw, Clock, ChevronDown } from 'lucide-react';
import { LiveAnalysisContent } from '../../LiveAnalysisContent';
import { LiveAnalysisData } from '../../../types/liveAnalysis';

const EMPTY_ANALYSIS: LiveAnalysisData = {
    bant: {
        budget: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
        authority: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
        need: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
        timeline: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
    },
    meddic: {
        metrics: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
        economic_buyer: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
        decision_criteria: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
        decision_process: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
        identify_pain: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
        champion: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
        competition: { emoji: '', status: 'missing', evidence: '', suggested_question: '' },
    },
    objections: [
        { type: "customer_question", quote: "Missing Objection", owner: "customer", status: "open" }
    ],
    signals: [
        { quote: "Not mentioned", signal_type: ["No Detection"], ask_now: "What's next?", intensity: "low", category: "neutral" }
    ],
};

const AUTO_REFRESH_OPTIONS = [
    { label: '5-min', value: 5 },
    { label: '10-min', value: 10 },
    { label: '15-min', value: 15 },
    { label: '20-min', value: 20 },
];

interface FloatingIntelligencePanelProps {
    transcriptRef: React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>;
    meetingTitle?: string;
    isMeetingPaused: boolean;
    // Analysis state is owned by FloatingDock and passed down — never lost on remount
    analysisData: LiveAnalysisData | null;
    isLoading: boolean;
    showTranscript: boolean;
    onRegenerate: () => void;      // Manual / forced refresh
    onAutoRefresh?: () => void;    // Scheduled auto-refresh (respects pause state)
}

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

export const FloatingIntelligencePanel: React.FC<FloatingIntelligencePanelProps> = ({
    transcriptRef,
    isMeetingPaused,
    analysisData,
    showTranscript,
    isLoading,
    onRegenerate,
    onAutoRefresh,
}) => {
    const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(5);
    const [showRefreshPicker, setShowRefreshPicker] = useState(false);
    const autoRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const refreshPickerRef = useRef<HTMLDivElement>(null);

    const displayData = analysisData || EMPTY_ANALYSIS;

    // Cleanup auto-refresh timer on unmount
    useEffect(() => {
        return () => {
            if (autoRefreshTimerRef.current) clearInterval(autoRefreshTimerRef.current);
        };
    }, []);

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

    const handleAutoRefresh = (minutes: number | null) => {
        if (autoRefreshTimerRef.current) clearInterval(autoRefreshTimerRef.current);
        setAutoRefreshInterval(minutes);
        setShowRefreshPicker(false);

        if (minutes !== null) {
            // Auto-refresh uses onAutoRefresh (force=false, respects pause state).
            // Falls back to onRegenerate if not provided.
            const refreshFn = onAutoRefresh || onRegenerate;
            autoRefreshTimerRef.current = setInterval(() => {
                refreshFn();
            }, minutes * 60 * 1000);
        }
    };

    const recentTranscript = transcriptRef.current?.slice(-3) || [];

    return (
        <div
            className="rounded-2xl overflow-hidden flex flex-col"
            style={{
                width: 420,
                height: 550,
                background: 'rgba(14, 18, 30, 0.93)',
                backdropFilter: 'blur(28px) saturate(180%)',
                WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 4px 24px rgba(0,0,0,0.4)',
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
                                {isMeetingPaused ? 'Paused' : 'Active'}
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
                                    className="absolute right-0 rounded-xl overflow-hidden z-20"
                                    style={{
                                        bottom: 'calc(100% - 200px)',
                                        background: 'rgba(18,22,34,0.98)',
                                        border: '1px solid rgba(255,255,255,0.1)',
                                        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                                        minWidth: 100,
                                    }}
                                >
                                    {autoRefreshInterval !== null && (
                                        <button
                                            onClick={() => handleAutoRefresh(null)}
                                            className="w-full px-4 py-2.5 text-left text-[12px] text-red-400 hover:bg-white/5 transition-colors"
                                        >
                                            Off
                                        </button>
                                    )}
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

                    <button
                        onClick={onRegenerate}
                        disabled={isLoading}
                        className="flex items-center gap-2 p-2 rounded-xl text-[12px] font-bold tracking-wide uppercase transition-all active:scale-95"
                        style={{
                            background: 'rgba(59,130,246,0.15)',
                            border: '1px solid rgba(59,130,246,0.3)',
                            color: '#3b82f6',
                            opacity: isLoading ? 0.6 : 1,
                        }}
                    >
                        <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            {/* Rolling transcript strip */}
            {showTranscript && recentTranscript.length > 0 && (
                <div
                    className="px-5 py-3 shrink-0"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}
                >
                    {recentTranscript.slice(-2).map((seg, i) => (
                        <div key={i} className="text-[11px] leading-relaxed truncate">
                            <span className="text-blue-400/70 font-semibold mr-1.5">
                                {seg.displayName || (seg.speaker === 'user' ? 'You' : 'Other Party')}:
                            </span>
                            <span className="text-white/40">{seg.text}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* Content */}
            <div className="overflow-y-auto flex-1" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}>
                {isLoading ? (
                    <IntelligenceSkeleton />
                ) : (
                    <LiveAnalysisContent analysisData={displayData} hideBar="Missing Details" />
                )}
            </div>
        </div>
    );
};