/**
 * MeetingTimeline.tsx  (v2 — horizontal strip)
 *
 * A horizontally-scrollable row of upcoming meeting pills rendered
 * BELOW the NextMeetingCard. Clicking a pill selects that meeting.
 * Only rendered when upcomingEvents.length > 1.
 *
 * Layout in Launcher.tsx:
 *
 *   <div className="flex-1 min-w-0 flex flex-col gap-2">
 *
 *       <div className="flex-1 min-w-0">
 *           <NextMeetingCard ... meeting={focusedMeeting} ... />
 *       </div>
 *
 *       {upcomingEvents.length > 1 && (
 *           <MeetingTimeline
 *               events={upcomingEvents}
 *               selectedId={focusedMeetingId}
 *               onSelect={setFocusedMeetingId}
 *               isLight={isLight}
 *           />
 *       )}
 *   </div>
 *
 * State wiring (add near other useState in Launcher):
 *
 *   const [focusedMeetingId, setFocusedMeetingId] = useState<string | null>(null);
 *   const focusedMeeting = upcomingEvents.find(e => e.id === focusedMeetingId) ?? nextMeeting ?? null;
 *
 *   useEffect(() => {
 *       if (nextMeeting?.id && !focusedMeetingId) setFocusedMeetingId(nextMeeting.id);
 *   }, [nextMeeting?.id]);
 */

import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { SiGooglemeet, SiZoom } from 'react-icons/si';
import { BsMicrosoftTeams } from "react-icons/bs";
import { Video, Clock } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

interface CalendarEvent {
    id: string;
    title: string;
    startTime: string;
    endTime: string;
    link?: string;
    organizer?: string;
    attendees?: any[];
}

interface MeetingTimelineProps {
    events: CalendarEvent[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    isLight: boolean;
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function detectProvider(link?: string): 'meet' | 'zoom' | 'teams' | null {
    if (!link) return null;
    if (link.includes('meet.google.com')) return 'meet';
    if (link.includes('zoom.us')) return 'zoom';
    if (link.includes('teams.microsoft.com')) return 'teams';
    return null;
}

const PROVIDER_CONFIG = {
    meet: { Icon: SiGooglemeet, color: 'text-[#00897B]' },
    zoom: { Icon: SiZoom, color: 'text-[#2D8CFF]' },
    teams: { Icon: BsMicrosoftTeams, color: 'text-[#6264A7]' },
};

function getRelativeLabel(startTime: string): string {
    const diffMs = new Date(startTime).getTime() - Date.now();
    if (diffMs <= 0) return 'Now';
    const totalMins = Math.ceil(diffMs / 60000);
    if (totalMins < 60) return `${totalMins}m`;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatTimeShort(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

// ─────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────

const MeetingTimeline: React.FC<MeetingTimelineProps> = ({
    events,
    selectedId,
    onSelect,
    isLight,
}) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef<HTMLButtonElement>(null);

    // Scroll active pill into view
    useEffect(() => {
        activeRef.current?.scrollIntoView({
            inline: 'nearest',
            block: 'nearest',
            behavior: 'smooth',
        });
    }, [selectedId]);

    return (
        <div className="relative shrink-0">
            {/* Left fade mask */}
            <div
                aria-hidden
                className={[
                    "pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10",
                    "bg-gradient-to-r",
                    "from-bg-main",
                    "to-transparent",
                ].join(" ")}
            />
            {/* Right fade mask */}
            <div
                aria-hidden
                className={[
                    "pointer-events-none absolute right-0 top-0 bottom-0 w-10 z-10",
                    "bg-gradient-to-l",
                    "from-bg-main",
                    "to-transparent",
                ].join(" ")}
            />

            {/* Scrollable pill row */}
            <div
                ref={scrollRef}
                className="flex items-center gap-2 overflow-x-auto px-1 pb-0.5"
                style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
            >
                {events.map((event) => {
                    const isSelected = event.id === selectedId;
                    const diffMs = new Date(event.startTime).getTime() - Date.now();
                    const isNow = diffMs >= -5 * 60 * 1000 && diffMs <= 15 * 60 * 1000;
                    const isPast = diffMs < -5 * 60 * 1000;
                    const provider = detectProvider(event.link);
                    const cfg = provider ? PROVIDER_CONFIG[provider] : null;
                    const relLabel = getRelativeLabel(event.startTime);
                    const timeLabel = formatTimeShort(event.startTime);

                    return (
                        <motion.button
                            key={event.id}
                            ref={isSelected ? activeRef : undefined}
                            onClick={() => onSelect(event.id)}
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.97 }}
                            className={[
                                "flex items-center gap-2.5 shrink-0 rounded-xl px-3.5 py-2 border transition-all duration-200",
                                "text-left cursor-pointer",
                                isPast ? "opacity-40" : "",
                                isSelected
                                    ? "border-blue-500/40 bg-bg-item-active shadow-[0_0_0_1px_rgba(59,130,246,0.2)]"
                                    : "border-border-subtle bg-bg-card hover:border-border-muted hover:bg-bg-item-surface",
                            ].join(" ")}
                        >
                            {/* Live dot — only for "now" events */}
                            {isNow && (
                                <span className="relative flex h-1.5 w-1.5 shrink-0">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
                                </span>
                            )}

                            {/* Time */}
                            <div className="flex flex-col items-start leading-none gap-0.5">
                                <span className={[
                                    "text-[12px] font-bold tabular-nums whitespace-nowrap",
                                    isNow
                                        ? "text-emerald-400"
                                        : isSelected
                                            ? "text-blue-400"
                                            : "text-text-primary",
                                ].join(" ")}>
                                    {timeLabel}
                                </span>
                                <span className={[
                                    "text-[10px] font-medium whitespace-nowrap flex items-center gap-0.5",
                                    isNow
                                        ? "text-emerald-400/70"
                                        : "text-text-tertiary",
                                ].join(" ")}>
                                    <Clock size={9} strokeWidth={2} />
                                    {isNow ? 'Soon' : `In ${relLabel}`}
                                </span>
                            </div>

                            {/* Divider */}
                            <div className={[
                                "w-px h-6 shrink-0",
                                "bg-border-muted",
                            ].join(" ")} />

                            {/* Title */}
                            <span className={[
                                "text-[11px] font-semibold max-w-[130px] truncate leading-tight",
                                "text-text-primary",
                            ].join(" ")}>
                                {event.title}
                            </span>

                            {/* Provider icon */}
                            {cfg && (
                                <span className={`text-[13px] shrink-0 ${cfg.color}`}>
                                    <cfg.Icon />
                                </span>
                            )}
                        </motion.button>
                    );
                })}
            </div>
        </div>
    );
};

export default MeetingTimeline;