/**
 * MeetingPopup — the floating "meeting starting soon" card.
 *
 * Runs in its own BrowserWindow (see electron/MeetingPopupWindowHelper.ts),
 * loaded from its own tiny Vite entry. It is created shortly before a meeting
 * reminder and destroyed on dismiss, so it must stay cheap:
 *
 *   - import leaf modules only, never the `@/hooks` / `@/features` barrels
 *   - no framer-motion (the CSS `animate-scale-in` keyframe is enough)
 *   - the countdown ticks on minute boundaries, not every second — the label
 *     only ever reads "In 2 minutes"
 *   - the company blurb is fetched AFTER first paint and never blocks the card
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapPin, NotebookPen, Video, X } from "lucide-react";

// Pure, dependency-free formatter shared with the launcher's meeting UI.
// Imported from the leaf module, not the `@/hooks` barrel.
import { formatTimeShort } from "@/hooks/useMeetingTimeline";
import { detectProviderOrOther } from "@/lib/meetingProviderUtils";
import type { CalendarEvent, CompanyIntel } from "@/types";

const PROVIDER_LABELS: Record<string, string> = {
    meet: "Google Meet",
    zoom: "Zoom",
    teams: "Microsoft Teams",
    other: "Online meeting",
};

const GENERIC_EMAIL_DOMAINS = new Set([
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
    "aol.com", "protonmail.com", "mail.com", "live.com", "me.com", "msn.com",
]);

/**
 * Pick the prospect company from the attendee list.
 *
 * This mirrors deriveCompanyCandidates() in useCompanyIntel.ts, but is
 * re-implemented here rather than imported: that module pulls in
 * `@/lib/firebase` and the PostHog service, which are exactly the two things
 * this window exists to avoid loading.
 */
function deriveProspect(event: CalendarEvent): { companyName: string; domain: string } | null {
    const attendees = event.attendees ?? [];
    const hasSelfFlag = attendees.some((a: any) => a.self);
    const selfDomain = (hasSelfFlag
        ? attendees.find((a: any) => a.self)?.email?.split("@")[1]
        : event.organizer?.split("@")[1]
    )?.toLowerCase() ?? "";

    for (const attendee of attendees) {
        const email: string | undefined = attendee?.email;
        if (!email) continue;
        const domain = email.split("@")[1]?.toLowerCase();
        if (!domain || GENERIC_EMAIL_DOMAINS.has(domain)) continue;
        if (hasSelfFlag ? attendee.self : domain === selfDomain) continue;

        const bare = domain.split(".")[0];
        return {
            companyName: bare.charAt(0).toUpperCase() + bare.slice(1),
            domain,
        };
    }
    return null;
}

/** Compose the one-line context blurb from the structured intel record. */
function blurbFromIntel(intel: CompanyIntel): string | null {
    const parts: string[] = [];
    const descriptor = [intel.industry, intel.businessModel].filter(Boolean)[0];
    if (descriptor) parts.push(`${intel.companyName} is ${descriptor}`);
    else parts.push(intel.companyName);

    if (intel.foundedYear) parts.push(`founded in ${intel.foundedYear}`);
    if (intel.employeeCount) parts.push(`~${intel.employeeCount} staff`);
    if (intel.latestFundingNews) parts.push(intel.latestFundingNews);
    else if (intel.recentNews?.[0]?.headline) parts.push(intel.recentNews[0].headline);

    const text = parts.join(", ");
    return text.length > 2 ? `${text}.` : null;
}

/**
 * "In 2 minutes" / "In 1 hour 20 minutes" / "Starting now".
 *
 * The launcher's getRelativeLabel() is deliberately not reused here: it emits
 * the compact "2m" form for the timeline pills, whereas this card has room for
 * the spelled-out phrasing and reads better with it.
 */
function formatCountdown(startTime: string): string {
    const diffMs = new Date(startTime).getTime() - Date.now();
    if (diffMs <= 0) return "Starting now";

    const totalMins = Math.ceil(diffMs / 60_000);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;

    const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

    if (hrs === 0) return `In ${plural(mins, "minute")}`;
    if (mins === 0) return `In ${plural(hrs, "hour")}`;
    return `In ${plural(hrs, "hour")} ${plural(mins, "minute")}`;
}

/**
 * Re-render on minute boundaries so "In 2 minutes" stays accurate without a
 * 1s interval. Returns a value that changes only when the label could change.
 */
function useMinuteTick(): number {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        const schedule = () => {
            const msToNextMinute = 60_000 - (Date.now() % 60_000);
            timer = setTimeout(() => {
                setTick((t) => t + 1);
                schedule();
            }, msToNextMinute + 50);
        };
        schedule();
        return () => clearTimeout(timer);
    }, []);

    return tick;
}

/**
 * Stable avatar hue per person, so the same attendee always gets the same
 * colour. Hashing the email locally keeps this card free of the launcher's
 * NextMeetingAvatarStack, which lives behind a barrel that would drag the
 * whole app graph into this bundle.
 */
function hueFromEmail(email: string): number {
    let hash = 0;
    for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) | 0;
    return Math.abs(hash) % 360;
}

/**
 * A SINGLE initial. Deliberately one letter, not two: the avatars overlap in a
 * stack, and at 22px a second letter is clipped by the next avatar.
 */
function initialFor(attendee: any): string {
    const raw = String(attendee?.name || attendee?.displayName || attendee?.email || "?");
    return (raw.trim()[0] ?? "?").toUpperCase();
}

/** 0:07 style clock for the auto-start countdown. */
function formatSeconds(total: number): string {
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Live seconds remaining until `deadline`, or null when there is no countdown.
 *
 * Ticks once a second, but ONLY while a countdown is active — the card is
 * visible for its whole life, so this is never a background-throttled timer,
 * and it stops as soon as the countdown ends. The renderer never decides when
 * to start recording: main owns the authoritative timer and this only draws it.
 */
function useSecondsRemaining(deadline: number | null): number | null {
    const [remaining, setRemaining] = useState<number | null>(null);

    useEffect(() => {
        if (!deadline) { setRemaining(null); return; }
        const compute = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        setRemaining(compute());
        const id = setInterval(() => {
            const next = compute();
            setRemaining(next);
            if (next <= 0) clearInterval(id);
        }, 1000);
        return () => clearInterval(id);
    }, [deadline]);

    return remaining;
}

export default function MeetingPopup() {
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [blurb, setBlurb] = useState<string | null>(null);
    const [autoStartAt, setAutoStartAt] = useState<number | null>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const tick = useMinuteTick();
    const secondsLeft = useSecondsRemaining(autoStartAt);
    const isCountingDown = secondsLeft !== null;
    // Total is inferred from the first reading so the bar always starts full,
    // without the renderer needing to know AUTO_START_COUNTDOWN_MS.
    const countdownTotalRef = useRef<number | null>(null);
    if (secondsLeft !== null && countdownTotalRef.current === null) {
        countdownTotalRef.current = Math.max(1, secondsLeft);
    }
    if (secondsLeft === null) countdownTotalRef.current = null;
    const countdownPercent = secondsLeft !== null && countdownTotalRef.current
        ? Math.max(0, Math.min(100, (secondsLeft / countdownTotalRef.current) * 100))
        : 0;

    const isLight =
        typeof document !== "undefined" &&
        document.documentElement.getAttribute("data-theme") === "light";

    // --- Payload handshake -------------------------------------------------
    // Ask main for the event now that our listener is mounted, and also stay
    // subscribed so a pre-warmed window picks up a later reminder.
    useEffect(() => {
        let cancelled = false;

        window.electronAPI?.meetingPopupReady?.().then((payload) => {
            if (cancelled || !payload) return;
            if (payload.event) setEvent(payload.event);
            // Present when the countdown was armed before this renderer mounted.
            if (payload.autoStartAt) setAutoStartAt(payload.autoStartAt);
        });

        const unsubscribe = window.electronAPI?.onMeetingPopupEvent?.((incoming) => {
            if (cancelled) return;
            setEvent(incoming);
            setBlurb(null); // different meeting — drop the previous company blurb
            setAutoStartAt(null);
        });

        const unsubscribeAutoStart = window.electronAPI?.onMeetingPopupAutoStart?.(({ autoStartAt: at }) => {
            if (!cancelled) setAutoStartAt(at);
        });

        return () => {
            cancelled = true;
            unsubscribe?.();
            unsubscribeAutoStart?.();
        };
    }, []);

    // --- Company blurb, strictly after the card is on screen ---------------
    useEffect(() => {
        if (!event) return;
        const prospect = deriveProspect(event);
        if (!prospect) return;

        let cancelled = false;
        // Deferred a frame so fetching never competes with first paint. The
        // main-process handler is DB-cached, so this is usually instant and
        // costs nothing on repeat reminders for the same company.
        const id = requestAnimationFrame(() => {
            window.electronAPI?.fetchCompanyIntel?.({
                companyName: prospect.companyName,
                domain: prospect.domain,
            })
                .then((res: any) => {
                    if (cancelled || !res?.success || !res.intel) return;
                    setBlurb(blurbFromIntel(res.intel));
                })
                .catch(() => { /* no blurb is fine — the card still works */ });
        });

        return () => {
            cancelled = true;
            cancelAnimationFrame(id);
        };
    }, [event]);

    // --- Size the window to the card --------------------------------------
    useEffect(() => {
        const el = cardRef.current;
        if (!el) return;

        let lastReported = 0;
        const report = () => {
            const height = Math.ceil(el.getBoundingClientRect().height);
            if (!height || height === lastReported) return;
            lastReported = height;
            // Width is ignored by the helper — the card is fixed-width — but
            // this is the app's shared resize channel, so both are sent.
            window.electronAPI?.updateContentDimensions?.({
                width: Math.ceil(el.getBoundingClientRect().width),
                height,
            });
        };

        // The card's final height isn't known at mount. Two things land after
        // first paint and both change text metrics: the stylesheet (Vite
        // injects CSS asynchronously in dev) and the Inter webfont. Measuring
        // once yields the unstyled layout and locks the window ~12px too
        // short, clipping the buttons. So settle: sample briefly until the
        // height stops changing, then rely on the observer for real content
        // changes (e.g. the company blurb arriving).
        report();
        let elapsed = 0;
        const settle = setInterval(() => {
            elapsed += 150;
            report();
            if (elapsed >= 1500) clearInterval(settle);
        }, 150);

        const observer = new ResizeObserver(report);
        observer.observe(el);
        return () => {
            clearInterval(settle);
            observer.disconnect();
        };
    }, [event, blurb, isCountingDown]);

    const dismiss = useCallback(() => {
        window.electronAPI?.meetingPopupDismiss?.();
    }, []);

    const takeNotes = useCallback(() => {
        window.electronAPI?.meetingPopupTakeNotes?.();
    }, []);

    const join = useCallback(() => {
        window.electronAPI?.meetingPopupJoin?.();
    }, []);

    // Escape dismisses, matching every other transient surface in the app.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") dismiss();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [dismiss]);

    const attendees = useMemo(
        () => (event?.attendees ?? []).filter((a: any) => !a?.self && a?.email),
        [event]
    );

    const locationLabel = useMemo(() => {
        if (!event) return null;
        if (event.location) return event.location;
        const provider = detectProviderOrOther(event.link);
        return provider ? PROVIDER_LABELS[provider] ?? PROVIDER_LABELS.other : null;
    }, [event]);

    // `tick` is read so this recomputes on each minute boundary.
    const timing = useMemo(() => {
        if (!event) return null;
        void tick;
        return {
            clock: formatTimeShort(event.startTime),
            relative: formatCountdown(event.startTime),
        };
    }, [event, tick]);

    if (!event || !timing) return <div className="w-full h-full bg-transparent" />;

    const panelClass = isLight
        ? "bg-[#F3F4F6]/92 border-black/10 shadow-black/10"
        : "bg-[#1E1E1E]/85 border-white/10 shadow-black/40";
    const chipClass = isLight
        ? "bg-black/5 border-black/10 text-neutral-700"
        : "bg-white/5 border-white/10 text-neutral-300";
    const subtleText = isLight ? "text-neutral-500" : "text-neutral-400";
    const titleText = isLight ? "text-neutral-900" : "text-white";

    return (
        <div className="w-full bg-transparent flex flex-col">
            <div
                ref={cardRef}
                className={`w-full backdrop-blur-xl border rounded-[18px] shadow-2xl p-4 flex flex-col gap-3 animate-scale-in origin-top-right ${panelClass}`}
            >
                {/* Time + dismiss */}
                <div className="flex items-start justify-between gap-2">
                    <div className={`text-[12px] font-medium tracking-tight ${subtleText}`}>
                        {timing.clock}
                        <span className="opacity-40 mx-1.5">•</span>
                        {timing.relative}
                    </div>
                    <button
                        onClick={dismiss}
                        aria-label={isCountingDown ? "Cancel auto-start" : "Dismiss reminder"}
                        title={isCountingDown ? "Cancel — don't record this meeting" : "Dismiss"}
                        className={`no-drag -mt-1 -mr-1 p-1 rounded-full transition-colors ${isLight ? "hover:bg-black/10 text-neutral-400 hover:text-neutral-700" : "hover:bg-white/10 text-neutral-500 hover:text-white"}`}
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* Title */}
                <div className={`text-[18px] font-semibold leading-[1.25] tracking-[-0.01em] line-clamp-2 -mt-1 ${titleText}`}>
                    {event.title}
                </div>

                {/* Meta — provider and people share one row so the card stays compact */}
                {(locationLabel || attendees.length > 0) && (
                    <div className="flex items-center gap-2 flex-wrap -mt-0.5">
                        {locationLabel && (
                            <span className={`inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full border text-[11px] font-medium ${chipClass}`}>
                                {event.link ? <Video size={12} /> : <MapPin size={12} />}
                                <span className="truncate max-w-[140px]">{locationLabel}</span>
                            </span>
                        )}

                        {attendees.length > 0 && (
                            <span className="inline-flex items-center gap-2 min-w-0">
                                <span className="flex -space-x-1">
                                    {attendees.slice(0, 3).map((a: any) => (
                                        <span
                                            key={a.email}
                                            title={a.name || a.email}
                                            className={`w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-bold text-white ring-2 ${isLight ? "ring-[#F3F4F6]" : "ring-[#1E1E1E]"}`}
                                            style={{ backgroundColor: `hsl(${hueFromEmail(a.email)} 55% 45%)` }}
                                        >
                                            {initialFor(a)}
                                        </span>
                                    ))}
                                    {attendees.length > 3 && (
                                        <span className={`w-[22px] h-[22px] rounded-full flex items-center justify-center text-[9px] font-bold ring-2 ${isLight ? "bg-neutral-300 text-neutral-700 ring-[#F3F4F6]" : "bg-neutral-600 text-neutral-100 ring-[#1E1E1E]"}`}>
                                            +{attendees.length - 3}
                                        </span>
                                    )}
                                </span>
                                <span className={`text-[11px] truncate ${subtleText}`}>
                                    {attendees.length === 1
                                        ? (attendees[0].email ?? "1 participant")
                                        : `${attendees.length} participants`}
                                </span>
                            </span>
                        )}
                    </div>
                )}

                {/* Company context — appears only once it resolves */}
                {blurb && (
                    <p className={`text-[12px] leading-[1.5] line-clamp-3 ${isLight ? "text-neutral-600" : "text-neutral-400"}`}>
                        {blurb}
                    </p>
                )}

                {/* Auto-start countdown. Shown only while main has a countdown
                    armed — the bar depletes over AUTO_START_COUNTDOWN_MS. Since
                    the setting defaults ON, this row is the user's only warning
                    that recording is about to begin by itself, so it names the
                    action and carries an explicit Cancel. */}
                {isCountingDown && (
                    <div className={`rounded-xl border overflow-hidden ${isLight ? "border-blue-500/25 bg-blue-500/[0.06]" : "border-blue-500/25 bg-blue-500/[0.08]"}`}>
                        <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-2">
                            <span className={`flex items-center gap-2 text-[12px] font-semibold ${isLight ? "text-blue-700" : "text-blue-300"}`}>
                                <span className="relative flex w-2 h-2">
                                    <span className="absolute inline-flex w-full h-full rounded-full bg-blue-500 opacity-60 animate-ping" />
                                    <span className="relative inline-flex w-2 h-2 rounded-full bg-blue-500" />
                                </span>
                                Recording starts in {formatSeconds(secondsLeft!)}
                            </span>
                            <button
                                onClick={dismiss}
                                className={`no-drag text-[11px] font-medium px-2 py-0.5 rounded-md transition-colors ${isLight ? "text-neutral-600 hover:text-neutral-900 hover:bg-black/5" : "text-neutral-400 hover:text-white hover:bg-white/10"}`}
                            >
                                Cancel
                            </button>
                        </div>
                        {/* Full-bleed depletion bar pinned to the panel's edge */}
                        <div className={`h-[3px] ${isLight ? "bg-black/[0.07]" : "bg-white/10"}`}>
                            <div
                                className="h-full bg-blue-500 transition-[width] duration-1000 ease-linear"
                                style={{ width: `${countdownPercent}%` }}
                            />
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2">
                    {event.link && (
                        <button
                            onClick={join}
                            title="Open the meeting link"
                            className={`no-drag flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl border text-[12px] font-semibold transition-all active:scale-[0.98] ${chipClass} ${isLight ? "hover:bg-black/10" : "hover:bg-white/10"}`}
                        >
                            <Video size={14} />
                            Join
                        </button>
                    )}
                    <button
                        onClick={takeNotes}
                        className="no-drag flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-[13px] font-semibold text-white bg-gradient-to-b from-[#5B85F5] to-[#3B62D9] shadow-lg shadow-[#3B62D9]/30 hover:from-[#6A91F7] hover:to-[#4670E0] active:scale-[0.98] transition-all"
                    >
                        <NotebookPen size={15} />
                        {isCountingDown ? "Start now" : "Take Notes"}
                    </button>
                </div>
            </div>
        </div>
    );
}
