/**
 * NextMeetingCard.tsx
 *
 * Drop-in replacement for the inline next-meeting card in Launcher.tsx.
 * Usage — replace the `nextMeeting ? (...)  : (...)` block in the LEFT
 * column of the hero cards section with:
 *
 *   <NextMeetingCard
 *       meeting={nextMeeting}
 *       isLight={isLight}
 *       getMeetingStartText={getMeetingStartText}
 *       onStart={onStartMeeting}
 *       onSalesBrief={setSalesBriefEvent}
 *       onPrepare={handlePrepare}
 *   />
 *
 * When `meeting` is null/undefined the empty-state card is shown instead.
 */

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, Video, Users, Briefcase, Play, Plus, Clock } from 'lucide-react';
import { SiGooglemeet, SiZoom } from 'react-icons/si';
import { BsMicrosoftTeams } from "react-icons/bs";
import { Attendee, NextMeetingCardProps, UpcomingMeeting } from '@/types';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

/** Detect meeting provider from link URL */
function detectProvider(link?: string): 'meet' | 'zoom' | 'teams' | 'other' | null {
    if (!link) return null;
    if (link.includes('meet.google.com')) return 'meet';
    if (link.includes('zoom.us')) return 'zoom';
    if (link.includes('teams.microsoft.com')) return 'teams';
    return 'other';
}

/** Provider chip — icon + label */
function ProviderChip({ link, isLight }: { link?: string; isLight: boolean }) {
    const provider = detectProvider(link);
    if (!provider) return null;

    const configs = {
        meet: {
            Icon: SiGooglemeet,
            label: 'Google Meet',
            bg: isLight ? 'bg-white border-slate-200' : 'bg-[#1a2035] border-white/[0.08]',
            iconClass: 'text-yellow-500',
        },
        zoom: {
            Icon: SiZoom,
            label: 'Zoom',
            bg: isLight ? 'bg-white border-slate-200' : 'bg-[#1a2035] border-white/[0.08]',
            iconClass: 'text-[#2D8CFF]',
        },
        teams: {
            Icon: BsMicrosoftTeams,
            label: 'Teams',
            bg: isLight ? 'bg-white border-slate-200' : 'bg-[#1a2035] border-white/[0.08]',
            iconClass: 'text-[#6264A7]',
        },
        other: {
            Icon: Video,
            label: 'Meeting Link',
            bg: isLight ? 'bg-white border-slate-200' : 'bg-[#1a2035] border-white/[0.08]',
            iconClass: isLight ? 'text-slate-500' : 'text-slate-400',
        },
    };

    const { Icon, label, bg, iconClass } = configs[provider];

    return (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-[11px] font-medium ${bg} ${isLight ? 'text-slate-700' : 'text-slate-200'}`}>
            <Icon className={`text-[13px] ${iconClass}`} />
            {label}
        </div>
    );
}

/** Countdown ring — shows time remaining as an SVG arc */
function CountdownRing({ startTime, isLight }: { startTime: string; isLight: boolean }) {
    const [display, setDisplay] = useState({ hrs: 0, mins: 0, secs: 0, label: 'Starts in', total: 0 });

    useEffect(() => {
        const calc = () => {
            const diffMs = new Date(startTime).getTime() - Date.now();
            if (diffMs <= 0) {
                setDisplay({ hrs: 0, mins: 0, secs: 0, label: 'Starting now', total: 0 });
                return;
            }
            const totalSecs = Math.ceil(diffMs / 1000);
            const hrs = Math.floor(totalSecs / 3600);
            const mins = Math.floor((totalSecs % 3600) / 60);
            const secs = totalSecs % 60;
            setDisplay({ hrs, mins, secs, label: 'Starts in', total: totalSecs });
        };
        calc();
        const id = setInterval(calc, 1000);
        return () => clearInterval(id);
    }, [startTime]);

    // Arc: full circle = 60 min = 282.6 circumference
    const radius = 52;
    const circ = 2 * Math.PI * radius;
    // Progress fraction based on how far from 60 min window the meeting is
    const maxSecs = 60 * 60; // 60 min window
    const fraction = Math.min(display.total / maxSecs, 1);
    const dashOffset = circ * (1 - fraction);

    const isStartingNow = display.total <= 0;

    return (
        <div className="flex flex-col items-center justify-center shrink-0">
            <div className="relative flex items-center justify-center w-[130px] h-[130px]">
                {/* Track ring */}
                <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 130 130">
                    <circle
                        cx="65" cy="65" r={radius}
                        fill="none"
                        stroke={isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)'}
                        strokeWidth="5"
                    />
                    {/* Progress arc */}
                    <motion.circle
                        cx="65" cy="65" r={radius}
                        fill="none"
                        stroke={isStartingNow ? '#10b981' : '#3b82f6'}
                        strokeWidth="5"
                        strokeLinecap="round"
                        strokeDasharray={circ}
                        initial={{ strokeDashoffset: circ }}
                        animate={{ strokeDashoffset: dashOffset }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                        style={{
                            filter: isStartingNow
                                ? `drop-shadow(0 0 ${isLight ? '3px' : '6px'} rgba(16,185,129,${isLight ? '0.35' : '0.7'}))`
                                : `drop-shadow(0 0 ${isLight ? '3px' : '6px'} rgba(59,130,246,${isLight ? '0.35' : '0.7'}))`,
                        }}
                    />
                </svg>

                {/* Center text */}
                <div className="relative flex flex-col items-center leading-none">
                    {isStartingNow ? (
                        <span className="text-[11px] font-bold text-emerald-400 tracking-wide">NOW</span>
                    ) : (
                        <>
                            <span className={`text-[9px] font-medium mb-0.5 ${isLight ? 'text-slate-400' : 'text-slate-400'}`}>
                                {display.label}
                            </span>
                            <span className={`font-bold tabular-nums leading-none ${display.hrs > 0 ? 'text-[17px]' : 'text-[22px]'} ${isLight ? 'text-slate-800' : 'text-white'}`}>
                                {display.hrs > 0
                                    ? `${String(display.hrs).padStart(2, '0')}:${String(display.mins).padStart(2, '0')}:${String(display.secs).padStart(2, '0')}`
                                    : `${String(display.mins).padStart(2, '0')}:${String(display.secs).padStart(2, '0')}`
                                }
                            </span>
                            <span className={`text-[9px] font-medium mt-0.5 ${isLight ? 'text-slate-400' : 'text-slate-400'}`}>
                                {display.hrs > 0 ? 'hr' : 'min'}
                            </span>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Attendee avatar stack */
function AvatarStack({ attendees, isLight }: { attendees: Attendee[]; isLight: boolean }) {
    const visible = attendees.slice(0, 4);
    const overflow = attendees.length - visible.length;

    return (
        <div className="flex items-center">
            {visible.map((a, i) => {
                const initials = (a.displayName ?? a.name ?? a.email ?? '?')
                    .split(/\s+/)
                    .map(p => p[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase();

                // Generate a stable hue from email/name string
                const str = a.email ?? a.displayName ?? '';
                let hash = 0;
                for (let c = 0; c < str.length; c++) hash = str.charCodeAt(c) + ((hash << 5) - hash);
                const hue = Math.abs(hash) % 360;

                return (
                    <div
                        key={i}
                        title={a.displayName ?? a.name ?? a.email ?? ''}
                        className={[
                            "flex items-center justify-center rounded-full text-[9px] font-bold text-white ring-2 w-7 h-7",
                            i > 0 ? "-ml-2" : "",
                            isLight ? "ring-white" : "ring-[#0a0c14]",
                        ].join(" ")}
                        style={{ background: `hsl(${hue},60%,45%)`, zIndex: visible.length - i }}
                    >
                        {a.photoURL
                            ? <img src={a.photoURL} className="w-full h-full rounded-full object-cover" alt={initials} />
                            : initials
                        }
                    </div>
                );
            })}
            {overflow > 0 && (
                <div
                    className={[
                        "-ml-2 flex items-center justify-center rounded-full text-[9px] font-bold ring-2 w-7 h-7",
                        isLight ? "bg-slate-200 text-slate-600 ring-white" : "bg-white/10 text-slate-300 ring-[#0a0c14]",
                    ].join(" ")}
                    style={{ zIndex: 0 }}
                >
                    +{overflow}
                </div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────
// EMPTY STATE CARD (no upcoming meeting)
// ─────────────────────────────────────────────────────────────────

function EmptyStateCard({ isLight, onStart }: { isLight: boolean; onStart: () => void }) {
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
                onClick={onStart}
                className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-4 text-xs font-semibold text-white shadow-[0_6px_18px_-4px_rgba(59,130,246,0.6)] transition hover:from-blue-400 hover:to-blue-600"
            >
                <Play className="h-3.5 w-3.5 fill-white" />
                Start GoDojo
            </motion.button>
        </motion.div>
    );
}

// ─────────────────────────────────────────────────────────────────
// NEXT MEETING CARD
// ─────────────────────────────────────────────────────────────────

function NextMeetingDetails({
    meeting,
    isLight,
    onStart,
    onSalesBrief,
}: {
    meeting: UpcomingMeeting;
    isLight: boolean;
    getMeetingStartText: (s: string) => string;
    onStart: () => void;
    onSalesBrief: () => void;
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
                            <AvatarStack attendees={nonSelfAttendees} isLight={isLight} />
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
                        <ProviderChip link={meeting.link} isLight={isLight} />
                    </div>
                </div>

                {/* Right: Countdown ring */}
                <CountdownRing startTime={meeting.startTime} isLight={isLight} />
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

// ─────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────

const NextMeetingCard: React.FC<NextMeetingCardProps> = ({
    meeting,
    isLight,
    getMeetingStartText,
    onStart,
    onSalesBrief,
}) => {
    return (
        <AnimatePresence mode="wait">
            {meeting ? (
                <motion.div
                    key="meeting"
                    className="h-full"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                >
                    <NextMeetingDetails
                        meeting={meeting}
                        isLight={isLight}
                        getMeetingStartText={getMeetingStartText}
                        onStart={() => onStart(meeting)}
                        onSalesBrief={() => onSalesBrief(meeting)}
                    />
                </motion.div>
            ) : (
                <motion.div
                    key="empty"
                    className="h-full"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                >
                    <EmptyStateCard isLight={isLight} onStart={() => onStart(undefined)} />
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default NextMeetingCard;