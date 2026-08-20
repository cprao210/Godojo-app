import React from 'react';
import { motion } from 'framer-motion';
import { Calendar, Play, Plus } from 'lucide-react';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';

// ─────────────────────────────────────────────────────────────────
// EMPTY STATE CARD (no upcoming meeting)
// ─────────────────────────────────────────────────────────────────

export function NextMeetingEmptyState({ isLight, onStart }: { isLight: boolean; onStart: () => void }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className={[
                "h-full relative rounded-2xl overflow-hidden border flex flex-col items-center justify-center px-8 py-8 text-center",
                isLight
                    ? "border-slate-200/80 bg-gradient-to-b from-white to-[#f5f7fc] shadow-[0_4px_24px_-8px_rgba(30,58,138,0.12)]"
                    : "border-white/[0.06] bg-gradient-to-b from-[#0a0f1f] to-[#070b18]",
            ].join(" ")}
        >
            {/* Ambient glow */}
            <div
                aria-hidden
                className={[
                    "pointer-events-none absolute inset-x-0 -top-12 mx-auto h-36 w-36 rounded-full blur-3xl",
                    isLight ? "bg-blue-300/25" : "bg-blue-600/15",
                ].join(" ")}
            />

            {/* Animated calendar icon */}
            <div className="relative mb-4 flex h-16 w-16 items-center justify-center">
                <motion.svg viewBox="0 0 140 80" className="absolute inset-0 h-full w-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
                    <ellipse cx="70" cy="40" rx="58" ry="22" fill="none"
                        stroke={isLight ? "#93b4ef" : "#3b82f6"} strokeOpacity={0.5}
                        strokeWidth="1" strokeDasharray="4 5" />
                </motion.svg>
                {[{ x: 8, y: 10, d: 0 }, { x: 126, y: 14, d: 0.4 }, { x: 20, y: 60, d: 0.8 }, { x: 116, y: 62, d: 1.2 }].map((p, i) => (
                    <motion.span key={i}
                        className={["absolute h-1 w-1 rounded-full", isLight ? "bg-blue-500" : "bg-blue-400"].join(" ")}
                        style={{ left: p.x, top: p.y }}
                        animate={{ opacity: [0.2, 1, 0.2], scale: [0.6, 1.2, 0.6] }}
                        transition={{ duration: 2.4, repeat: Infinity, delay: p.d, ease: "easeInOut" }}
                    />
                ))}
                <motion.div
                    animate={{ y: [0, -3, 0] }}
                    transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
                    className="relative flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-blue-400 via-blue-500 to-blue-700 shadow-[0_10px_28px_-8px_rgba(59,130,246,0.7)]"
                >
                    <Calendar className="h-7 w-7 text-white" strokeWidth={2.2} />
                    <span
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-purple-600 shadow-[0_4px_10px_-2px_rgba(168,85,247,0.7)]"
                        style={{ boxShadow: '0 0 0 2px ' + (isLight ? '#f5f7fc' : '#070b18') + ', 0 4px 10px -2px rgba(168,85,247,0.7)' }}
                    >
                        <Plus className="h-3 w-3 text-white" strokeWidth={3} />
                    </span>
                </motion.div>
            </div>

            <h2 className="text-[16px] font-semibold tracking-tight">No upcoming meetings</h2>
            <p className={["mt-1.5 max-w-[260px] text-xs leading-relaxed", isLight ? "text-slate-500" : "text-slate-400"].join(" ")}>
                You're free! New calendar events will appear here automatically.
            </p>

            <motion.button
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                onClick={() => {
                    posthogAnalytics.trackStartGodojoClicked('empty_state');
                    onStart();
                }}
                className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-4 text-xs font-semibold text-white shadow-[0_6px_18px_-4px_rgba(59,130,246,0.6)] transition hover:from-blue-400 hover:to-blue-600"
            >
                <Play className="h-3.5 w-3.5 fill-white" />
                Start GoDojo
            </motion.button>
        </motion.div>
    );
}