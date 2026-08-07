import React from 'react';
import { motion } from 'framer-motion';
import { Calendar, Video, Users, Briefcase, Clock } from 'lucide-react';
import type { UpcomingMeeting } from '@/types';
import { NextMeetingProviderChip, NextMeetingAvatarStack } from './NextMeetingChips';
import { NextMeetingCountdownRing } from './NextMeetingCountdownRing';

// ─────────────────────────────────────────────────────────────────
// NEXT MEETING CARD (populated state)
// ─────────────────────────────────────────────────────────────────

export function NextMeetingDetails({
    meeting,
    isLight,
    onStart,
    onSalesBrief,
}: {
    meeting: UpcomingMeeting;
    isLight: boolean;
    getMeetingStartText: (s: string) => string;
    onStart: () => void;
    onSalesBrief: React.Dispatch<any>;
}) {
    const diffMs = new Date(meeting.startTime).getTime() - Date.now();
    const isStartingSoon = diffMs > 0 && diffMs < 15 * 60 * 1000; // within 15 min
    const isStartingNow = diffMs <= 0;

    const statusLabel = isStartingNow
        ? 'Starting now'
        : isStartingSoon
            ? 'Starting soon'
            : 'Up next';

    const statusColor = isStartingNow || isStartingSoon
        ? 'text-emerald-400'
        : 'text-blue-400';

    const statusDotColor = isStartingNow || isStartingSoon
        ? 'bg-emerald-400'
        : 'bg-blue-400';

    const nonSelfAttendees = (meeting.attendees ?? []).filter(a => !a.self);
    const organizer = meeting.organizer
        ? meeting.organizer.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        : null;

    const timeStr = `${new Date(meeting.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${new Date(meeting.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    const dateStr = new Date(meeting.startTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className={[
                "h-full relative rounded-2xl overflow-hidden border flex flex-col",
                isLight
                    ? "border-slate-200/80 bg-white shadow-[0_4px_24px_-8px_rgba(30,58,138,0.1)]"
                    : "border-white/[0.07] bg-[#0b0e1a]",
            ].join(" ")}
        >
            {/* Background subtle grid lines (dark only) */}
            {!isLight && (
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-[0.03]"
                    style={{
                        backgroundImage: 'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
                        backgroundSize: '40px 40px',
                    }}
                />
            )}

            {/* Ambient glow top-right */}
            <div
                aria-hidden
                className={[
                    "pointer-events-none absolute top-0 right-0 w-[200px] h-[200px] rounded-full blur-[80px]",
                    isStartingNow || isStartingSoon ? "bg-emerald-500/10" : "bg-blue-500/10",
                ].join(" ")}
            />

            {/* Main content */}
            <div className="relative flex-1 flex gap-4 p-4">

                {/* Left: all text content */}
                <div className="flex-1 min-w-0 flex flex-col gap-2">

                    {/* Status badge */}
                    <div className="flex items-center gap-1.5">
                        <span className={`relative flex h-1.5 w-1.5 shrink-0`}>
                            {(isStartingNow || isStartingSoon) && (
                                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${statusDotColor} opacity-75`} />
                            )}
                            <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${statusDotColor}`} />
                        </span>
                        <span className={`text-[11px] font-bold uppercase tracking-widest ${statusColor}`}>
                            {statusLabel}
                        </span>
                    </div>

                    {/* Title */}
                    <h2 className={[
                        "text-[18px] font-bold leading-snug tracking-tight line-clamp-2",
                        isLight ? "text-slate-900" : "text-white",
                    ].join(" ")}>
                        {meeting.title}
                    </h2>

                    {/* Organizer + participant count + avatars */}
                    <div className="flex items-center gap-2 flex-wrap">
                        {organizer && (
                            <>
                                <div className={["flex items-center gap-1.5 text-[12px]", isLight ? "text-slate-500" : "text-slate-400"].join(" ")}>
                                    <Calendar size={11} strokeWidth={2} />
                                    <span>{organizer}</span>
                                </div>
                                <span className={isLight ? "text-slate-300" : "text-white/20"}>•</span>
                            </>
                        )}
                        {nonSelfAttendees.length > 0 && (
                            <div className={["flex items-center gap-1.5 text-[12px]", isLight ? "text-slate-500" : "text-slate-400"].join(" ")}>
                                <Users size={11} strokeWidth={2} />
                                <span>{nonSelfAttendees.length} Participant{nonSelfAttendees.length !== 1 ? 's' : ''}</span>
                            </div>
                        )}
                        {nonSelfAttendees.length > 0 && (
                            <NextMeetingAvatarStack attendees={nonSelfAttendees} isLight={isLight} />
                        )}
                    </div>

                    {/* Date/time + provider chips row */}
                    <div className="flex items-center gap-2 flex-wrap">
                        {/* Date + time chip */}
                        <div className={[
                            "flex items-center gap-2 px-3 py-2 rounded-xl border text-[11px] font-medium",
                            isLight ? "bg-slate-50 border-slate-200 text-slate-700" : "bg-[#1a2035] border-white/[0.08] text-slate-300",
                        ].join(" ")}>
                            <Calendar size={12} strokeWidth={2} className={isLight ? "text-slate-400" : "text-slate-500"} />
                            <span>{dateStr}</span>
                            <span className={isLight ? "text-slate-300" : "text-white/20"}>•</span>
                            <Clock size={11} strokeWidth={2} className={isLight ? "text-slate-400" : "text-slate-500"} />
                            <span>{timeStr}</span>
                        </div>

                        {/* Provider chip */}
                        <NextMeetingProviderChip link={meeting.link} isLight={isLight} />
                    </div>
                </div>

                {/* Right: Countdown ring */}
                <NextMeetingCountdownRing startTime={meeting.startTime} isLight={isLight} />
            </div>

            {/* Action bar */}
            <div className={[
                "relative px-5 py-3 border-t flex items-center gap-2.5",
                isLight ? "border-slate-100 bg-slate-50/60" : "border-white/[0.05] bg-white/[0.02]",
            ].join(" ")}>
                {/* Join Meeting — primary CTA */}
                <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => {
                        // Open the meeting link in the system browser
                        if (meeting.link) {
                            window.electronAPI?.openExternal?.(meeting.link);
                        }
                        // Start live analysis + show the bottom dock
                        onStart();
                    }}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 text-white text-[12px] font-semibold shadow-[0_4px_14px_-4px_rgba(59,130,246,0.6)] transition hover:from-blue-400 hover:to-blue-600"
                >
                    <Video size={13} strokeWidth={2.2} />
                    Join Meeting
                </motion.button>

                {/* Sales Brief */}
                <button
                    onClick={onSalesBrief}
                    className={[
                        "flex items-center gap-2 px-4 py-2.5 rounded-xl border text-[12px] font-medium transition-all",
                        isLight
                            ? "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                            : "bg-white/[0.04] border-white/[0.08] text-slate-300 hover:bg-white/[0.08]",
                    ].join(" ")}
                >
                    <Briefcase size={13} strokeWidth={2} />
                    Company Insights
                </button>
            </div>
        </motion.div>
    );
}