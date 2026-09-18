import { BrowserWindow, screen, systemPreferences, shell } from "electron"
import { EventEmitter } from "node:events"
import path from "node:path"
import { getStartUrl } from "./WindowHelper"
import type { CalendarEvent } from "./services/CalendarManager"

/**
 * MeetingPopupWindowHelper
 *
 * The floating "meeting starting soon" card — a small always-on-top window
 * that appears top-right while the main app is minimised or hidden in the
 * background. Replaces the native OS Notification that CalendarManager and
 * ZoomCalendarManager used to raise (see their showReminder()).
 *
 * Design constraints that drive nearly every decision in this file:
 *
 *  1. It must never make the app laggy. The popup loads its OWN tiny bundle
 *     (meeting-popup.html), not the ~2.9 MB main renderer bundle, and the
 *     window is created shortly before it is needed and DESTROYED after
 *     dismissal — so there is no extra renderer process resident between
 *     meetings. Note the deliberate absence of `backgroundThrottling: false`
 *     here: unlike SettingsWindowHelper, we want a hidden popup throttled.
 *
 *  2. It must not steal focus. Every show path uses showInactive(), and
 *     setAlwaysOnTop is asserted ONCE at creation — re-asserting it on each
 *     show triggers [NSApp activate] on macOS and pulls focus (see the
 *     comment in WindowHelper.showOverlayWindow).
 *
 *  3. It must reach the user regardless of which monitor they're looking at.
 *     There is no reliable signal for "which screen is the user's attention
 *     on" — the previous cursor-based placement just showed the card on
 *     whichever display the mouse last happened to idle over, which is not
 *     the same thing. So the card is shown on EVERY connected display at
 *     once (one BrowserWindow per display, all standing in for the same
 *     meeting/countdown — acting on any one of them, e.g. Cancel, tears down
 *     all of them), plus a single system beep so a user who is heads-down on
 *     a monitor the card didn't happen to land near still gets a cue.
 */

/** One popup BrowserWindow, paired with the display it was placed on. */
interface PopupInstance {
    win: BrowserWindow
    display: Electron.Display
}

/** How long before the reminder we create the window so the show is instant. */
export const PREWARM_LEAD_MS = 30 * 1000

/** Auto-dismiss the card this long after it appears, if the user ignores it. */
const AUTO_DISMISS_MS = 90 * 1000

/**
 * Grace period between the card appearing and recording starting by itself.
 * With the standard 2-minute reminder lead this means recording begins about
 * 90s before the meeting's scheduled start.
 */
export const AUTO_START_COUNTDOWN_MS = 30 * 1000

/**
 * How far past the intended instant an auto-start may still fire.
 *
 * setTimeout is monotonic and does not advance while macOS sleeps, and nothing
 * re-syncs the calendar on resume, so a pending timer can fire minutes late —
 * potentially for a meeting that has already finished. Anything outside this
 * window is treated as stale and refused.
 */
const AUTO_START_STALE_TOLERANCE_MS = 2 * 60 * 1000

/** Window geometry. Height is a starting point — the renderer resizes to fit. */
const POPUP_WIDTH = 380
const POPUP_HEIGHT = 260
const SCREEN_MARGIN = 16

/** How long a shown event stays in the dedupe set. */
const DEDUPE_TTL_MS = 10 * 60 * 1000

/**
 * Emits:
 *  - `auto-start-due` (event: CalendarEvent) — the countdown elapsed without
 *    being cancelled and every precondition still holds. main.ts turns this
 *    into appState.startMeetingFromCalendarEvent(event). Emitting rather than
 *    calling AppState directly keeps this module out of a require cycle
 *    (WindowHelper already imports main.ts).
 */
export class MeetingPopupWindowHelper extends EventEmitter {
    /** One entry per connected display currently showing the card. */
    private windows: PopupInstance[] = []

    /**
     * The event the renderer will ask for via the `meeting-popup:ready`
     * handshake. We do NOT push it on did-finish-load: that can fire before
     * React has mounted its listener, and the payload would be dropped (the
     * same latent bug CropperWindowHelper has in its cold-start branch).
     */
    private pendingEvent: CalendarEvent | null = null

    private contentProtection: boolean = false
    private autoDismissTimer: NodeJS.Timeout | null = null
    /** Windows-only opacity shield timer, shared across every display's window. */
    private opacityTimeout: NodeJS.Timeout | null = null

    /** Pending auto-start, if one is armed for the current card. */
    private autoStartTimer: NodeJS.Timeout | null = null
    /** Epoch ms the countdown ends — handed to the renderer to display. */
    private autoStartAt: number | null = null

    /**
     * Lets the helper refuse to auto-start while a meeting is already running.
     * Injected by main.ts rather than importing AppState (require cycle), the
     * same way SettingsWindowHelper receives its WindowHelper.
     */
    private isMeetingActive: () => boolean = () => false

    /**
     * Google and Zoom schedule reminders independently, so a meeting present
     * on both calendars fires twice. Keyed by both `source:id` and a
     * cross-source `title|startTime` key so either path dedupes.
     */
    private recentlyShown = new Map<string, number>()

    /**
     * Returns the first display's window, for callers that only need to check
     * "is this webContents one of mine" against a single reference (legacy
     * shape). Prefer `ownsWebContentsId` for that check — it's correct across
     * every display's window, not just the first.
     */
    public getWindow(): BrowserWindow | null {
        return this.windows[0]?.win ?? null
    }

    /** True if `webContentsId` belongs to any of the (possibly several) popup windows. */
    public ownsWebContentsId(webContentsId: number): boolean {
        return this.windows.some(({ win }) => !win.isDestroyed() && win.webContents.id === webContentsId)
    }

    public setMeetingActiveProvider(fn: () => boolean): void {
        this.isMeetingActive = fn
    }

    /** Epoch ms at which the armed countdown fires, or null if none. */
    public getAutoStartAt(): number | null {
        return this.autoStartAt
    }

    public getPendingEvent(): CalendarEvent | null {
        return this.pendingEvent
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Create one window per connected display, off-screen and not shown yet,
     * so showReminder() below is instant. Called ~30s before the reminder.
     */
    public prewarm(event: CalendarEvent): void {
        if (this.isDuplicate(event)) return
        this.pendingEvent = event
        if (this.windows.length > 0) return
        this.createWindows()
    }

    /**
     * Show the card for `event`, on every connected display at once.
     *
     * Returns false when the popup could not be shown on any display, so the
     * caller can fall back to a native Notification rather than silently
     * losing the reminder.
     */
    public showReminder(event: CalendarEvent): boolean {
        try {
            if (this.isDuplicate(event)) return true
            this.markShown(event)

            this.pendingEvent = event

            if (this.windows.length === 0) {
                this.createWindows()
            } else {
                // Windows were pre-warmed with a (possibly different) event —
                // push the current one so a late-arriving reminder wins. (If
                // the set of connected displays changed since prewarm, the
                // pre-warmed windows are reused as-is rather than reconciled —
                // a monitor being plugged/unplugged in this exact 30s window
                // is rare enough not to be worth the extra bookkeeping.)
                for (const { win } of this.windows) {
                    if (!win.isDestroyed()) win.webContents.send("meeting-popup:event", event)
                }
            }

            if (this.windows.length === 0) return false

            this.positionAll()
            this.presentAllWithoutFocus()
            // Placement can only ever be a best guess at which screen the user
            // is actually looking at, even shown on every display — a system
            // beep is the part that reaches them regardless.
            shell.beep()

            // Only arm auto-start once the card is genuinely on screen, so the
            // user always had a countdown they could cancel. armAutoStart
            // reports whether it took; if it didn't, fall back to the plain
            // auto-dismiss behaviour. The two timers are mutually exclusive —
            // auto-dismiss would otherwise destroy the card mid-countdown.
            if (!this.armAutoStart(event)) {
                this.armAutoDismiss(event)
            }
            return true
        } catch (e) {
            console.error("[MeetingPopupWindowHelper] Failed to show reminder:", e)
            return false
        }
    }

    /** Hide and destroy every window — the popup leaves no renderer behind. */
    public dismiss(): void {
        this.clearTimers()
        this.pendingEvent = null

        const instances = this.windows
        this.windows = []
        for (const { win } of instances) {
            if (!win.isDestroyed()) {
                try { win.destroy() } catch { /* already gone */ }
            }
        }
    }

    /** Ghost mode. Mirrors the contract implemented by the other helpers. */
    public setContentProtection(enable: boolean): void {
        this.contentProtection = enable
        for (const { win } of this.windows) {
            if (!win.isDestroyed()) win.setContentProtection(enable)
        }
    }

    /**
     * Resize every display's window to the renderer's measured content
     * HEIGHT. Routed through the shared `update-content-dimensions` channel,
     * like the other helpers. Each display's window runs its own independent
     * renderer, but they show identical content, so every reporter's measured
     * height is applied uniformly to keep every copy of the card the same size.
     *
     * The reported width is deliberately ignored and POPUP_WIDTH is kept.
     * The card is `w-full`, so applying a measured width feeds back: the
     * window shrinks, the card re-measures narrower inside it, and the window
     * shrinks again — a ratchet (observed going 380 → 361 → 343 → 332 → …).
     * The popup is a fixed-width card by design, so width is simply pinned.
     */
    public setWindowDimensions(_width: number, height: number): void {
        if (this.windows.length === 0) return

        const nextHeight = Math.round(height)
        for (const entry of this.windows) {
            const { win, display } = entry
            if (win.isDestroyed() || !win.isVisible()) continue

            const current = win.getBounds()
            // No-op on unchanged size, otherwise renderer→main→renderer can loop.
            if (current.width === POPUP_WIDTH && current.height === nextHeight) continue

            win.setSize(POPUP_WIDTH, nextHeight)
            this.positionOnDisplay(win, display)
        }
    }

    // =========================================================================
    // Internals
    // =========================================================================

    private createWindows(): void {
        const startUrl = getStartUrl()
        if (!startUrl) {
            console.warn("[MeetingPopupWindowHelper] Renderer URL not ready — skipping popup")
            return
        }

        for (const display of screen.getAllDisplays()) {
            this.windows.push({ win: this.createWindowOnDisplay(startUrl), display })
        }
    }

    private createWindowOnDisplay(startUrl: string): BrowserWindow {
        const win = new BrowserWindow({
            width: POPUP_WIDTH,
            height: POPUP_HEIGHT,
            // Created off-screen; positionAll() places it before showing.
            x: -10000,
            y: -10000,
            frame: false,
            transparent: true,
            resizable: false,
            movable: true,
            fullscreenable: false,
            hasShadow: false,
            alwaysOnTop: true,
            backgroundColor: "#00000000",
            show: false,
            skipTaskbar: true,
            // macOS: make this an NSPanel. A non-activating panel is what
            // actually renders above another app's FULLSCREEN Space — an
            // ordinary NSWindow stays behind it no matter how high its level,
            // which is the "doesn't show over other windows/tabs" symptom. It
            // also reinforces the no-focus-stealing requirement, since a panel
            // never activates the app. Ignored on Windows/Linux.
            ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, "preload.js"),
                // NOTE: backgroundThrottling intentionally left at its default
                // (true) — a hidden popup should be throttled, not kept hot.
            },
        })

        win.setContentProtection(this.contentProtection)

        // Assert the float level exactly once, here. See the class comment.
        if (process.platform === "darwin") {
            win.setHiddenInMissionControl(true)
            // Join every Space, including other apps' fullscreen Spaces.
            this.applyMacWorkspaceVisibilityFor(win)
            // "screen-saver" (NSWindowLevel 1000), not "floating" (3).
            //
            // A reminder that only shows while the user happens to be looking at
            // the desktop is useless — the entire point is that it reaches them
            // mid-meeting, over a fullscreen Zoom/Meet window or whatever app
            // they are in. NSFloatingWindowLevel sits just above ordinary
            // windows and loses to the active app's fullscreen Space, which is
            // exactly the reported symptom. This matches the level the non-mac
            // branch below has always used.
            win.setAlwaysOnTop(true, "screen-saver")
        } else {
            win.setAlwaysOnTop(true, "screen-saver")
        }

        // Watchdog: the OS can silently drop the topmost flag (DWM z-order
        // churn on Alt-Tab, another app requesting topmost). Electron only
        // fires this on an actual state change, so it costs nothing at rest.
        win.on("always-on-top-changed", (_e, isAlwaysOnTop) => {
            if (isAlwaysOnTop) return
            if (win.isDestroyed()) return
            win.setAlwaysOnTop(true, "screen-saver")
        })

        win.on("closed", () => {
            this.windows = this.windows.filter((entry) => entry.win !== win)
            // Only tear down the shared timers once every display's card is
            // gone — one display's window closing unexpectedly (e.g. that
            // monitor was unplugged) shouldn't cancel a countdown the user can
            // still see and cancel on another screen.
            if (this.windows.length === 0) this.clearTimers()
        })

        win.loadURL(`${startUrl}/meeting-popup.html`).catch((e) => {
            console.error("[MeetingPopupWindowHelper] Failed to load popup URL:", e)
        })

        return win
    }

    /**
     * Show every display's window without taking focus, with the Windows
     * "opacity shield" so no card leaks a frame into a screen share before
     * content protection has been applied to the freshly-shown window.
     */
    private presentAllWithoutFocus(): void {
        for (const { win } of this.windows) {
            if (win.isDestroyed()) continue

            // Re-assert Space membership immediately before showing — see
            // applyMacWorkspaceVisibilityFor for why once at creation isn't enough.
            this.applyMacWorkspaceVisibilityFor(win)

            if (process.platform === "win32" && this.contentProtection) {
                win.setOpacity(0)
                win.showInactive()
                win.setContentProtection(true)
            } else {
                win.setContentProtection(this.contentProtection)
                win.showInactive()
            }
        }

        if (process.platform === "win32" && this.contentProtection) {
            if (this.opacityTimeout) clearTimeout(this.opacityTimeout)
            this.opacityTimeout = setTimeout(() => {
                for (const { win } of this.windows) {
                    if (!win.isDestroyed()) win.setOpacity(1)
                }
            }, 60)
        }
    }

    /**
     * macOS: make one card join every Space, including other apps' fullscreen
     * Spaces.
     *
     * Re-applied on every show, not just at creation. macOS drops or rebinds a
     * window's collection behaviour across hide/show cycles and Space switches,
     * after which the card gets pinned to whichever Space it was last shown on
     * — the "only appears on the desktop" symptom. Unlike setAlwaysOnTop, this
     * does not trigger [NSApp activate], so re-asserting it steals no focus.
     */
    private applyMacWorkspaceVisibilityFor(win: BrowserWindow): void {
        if (process.platform !== "darwin") return
        if (win.isDestroyed()) return
        try {
            win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        } catch (e) {
            console.warn("[MeetingPopupWindowHelper] Could not set workspace visibility:", e)
        }
    }

    /** Top-right of the work area of the display this window was created for. */
    private positionOnDisplay(win: BrowserWindow, display: Electron.Display): void {
        if (win.isDestroyed()) return
        try {
            const { workArea } = display
            const { width } = win.getBounds()

            const x = workArea.x + workArea.width - width - SCREEN_MARGIN
            const y = workArea.y + SCREEN_MARGIN

            // Clamp so the card is always fully on-screen.
            win.setPosition(
                Math.round(Math.max(workArea.x, x)),
                Math.round(Math.max(workArea.y, y))
            )
        } catch (e) {
            console.warn("[MeetingPopupWindowHelper] Could not position popup:", e)
        }
    }

    /** positionOnDisplay for every currently-tracked window. */
    private positionAll(): void {
        for (const { win, display } of this.windows) {
            this.positionOnDisplay(win, display)
        }
    }

    /**
     * An ignored card shouldn't linger. Dismiss at the meeting start time (plus
     * a small grace) or after AUTO_DISMISS_MS, whichever comes first.
     */
    /**
     * Start the countdown that ends in recording, if it is safe to do so.
     *
     * Returns false — and arms nothing — whenever auto-start must not happen,
     * so the caller can fall back to the plain auto-dismiss card. Every refusal
     * is logged, because a silently-absent countdown is exactly the kind of
     * thing that is impossible to debug later.
     */
    private armAutoStart(event: CalendarEvent): boolean {
        // At least one card has to actually be on screen: this is what
        // guarantees we never start recording without the user having had a
        // visible chance to cancel. createWindows() no-ops when the renderer
        // URL isn't ready yet.
        const liveWindows = this.windows.filter(({ win }) => !win.isDestroyed() && win.isVisible())
        if (liveWindows.length === 0) {
            console.warn("[MeetingPopupWindowHelper] No card visible on any display — not arming auto-start")
            return false
        }

        let enabled = true
        try {
            const { SettingsManager } = require("./services/SettingsManager")
            enabled = SettingsManager.getInstance().get("autoStartMeetings") ?? true
        } catch (e) {
            console.warn("[MeetingPopupWindowHelper] Could not read autoStartMeetings — assuming enabled:", e)
        }
        if (!enabled) return false

        if (this.isMeetingActive()) {
            console.log("[MeetingPopupWindowHelper] A meeting is already running — not arming auto-start")
            return false
        }

        // Never let an unattended start raise a permission dialog. startMeeting
        // would call askForMediaAccess() when the status is 'not-determined',
        // popping an OS modal with nobody there to answer it, and throws
        // outright when denied.
        if (process.platform === "darwin") {
            const micStatus = systemPreferences.getMediaAccessStatus("microphone")
            if (micStatus !== "granted") {
                console.log(`[MeetingPopupWindowHelper] Microphone access is '${micStatus}' — not arming auto-start`)
                return false
            }
        }

        this.autoStartAt = Date.now() + AUTO_START_COUNTDOWN_MS
        this.autoStartTimer = setTimeout(() => this.fireAutoStart(event), AUTO_START_COUNTDOWN_MS)

        // Hand every card the deadline so each can draw the countdown. They
        // only render the number — main owns the authoritative timer, because
        // these windows are background-throttled by design and are destroyed
        // on dismiss. A renderer that mounts later picks the same value up
        // from the `meeting-popup:ready` handshake instead.
        for (const { win } of liveWindows) {
            win.webContents.send("meeting-popup:auto-start", { autoStartAt: this.autoStartAt })
        }
        return true
    }

    /**
     * The countdown elapsed. Re-validate everything before recording, because
     * arbitrary wall-clock time may have passed since arming (see
     * AUTO_START_STALE_TOLERANCE_MS).
     */
    private fireAutoStart(event: CalendarEvent): void {
        this.autoStartTimer = null
        const expectedAt = this.autoStartAt
        this.autoStartAt = null

        const bail = (reason: string) => {
            console.warn(`[MeetingPopupWindowHelper] Auto-start skipped — ${reason}`)
            this.dismiss()
        }

        if (this.windows.length === 0) return bail("the card is gone")
        if (this.isMeetingActive()) return bail("a meeting is already running")

        const now = Date.now()
        if (expectedAt !== null && now - expectedAt > AUTO_START_STALE_TOLERANCE_MS) {
            return bail(`it fired ${Math.round((now - expectedAt) / 1000)}s late (machine likely slept)`)
        }

        const endsAt = new Date(event.endTime).getTime()
        if (Number.isFinite(endsAt) && now >= endsAt) {
            return bail("the meeting has already ended")
        }

        this.emit("auto-start-due", event)
        this.dismiss()
    }

    private armAutoDismiss(event: CalendarEvent): void {
        if (this.autoDismissTimer) clearTimeout(this.autoDismissTimer)

        const untilStart = new Date(event.startTime).getTime() - Date.now()
        const graceAfterStart = untilStart > 0 ? untilStart + 30_000 : 30_000
        const delay = Math.max(10_000, Math.min(AUTO_DISMISS_MS, graceAfterStart))

        this.autoDismissTimer = setTimeout(() => this.dismiss(), delay)
    }

    private clearTimers(): void {
        // Cancelling the pending auto-start here is what makes closing the card
        // (the X button, or Escape, both of which route to dismiss()) actually
        // stop the recording from starting — rather than merely hiding a card
        // whose timer is still running.
        if (this.autoStartTimer) {
            clearTimeout(this.autoStartTimer)
            this.autoStartTimer = null
        }
        this.autoStartAt = null

        if (this.autoDismissTimer) {
            clearTimeout(this.autoDismissTimer)
            this.autoDismissTimer = null
        }
        if (this.opacityTimeout) {
            clearTimeout(this.opacityTimeout)
            this.opacityTimeout = null
        }
    }

    private dedupeKeys(event: CalendarEvent): string[] {
        return [
            `${event.source}:${event.id}`,
            `${event.title}|${event.startTime}`,
        ]
    }

    private isDuplicate(event: CalendarEvent): boolean {
        const now = Date.now()
        // Opportunistic prune — the map only ever holds a day of reminders.
        for (const [key, at] of this.recentlyShown) {
            if (now - at > DEDUPE_TTL_MS) this.recentlyShown.delete(key)
        }
        return this.dedupeKeys(event).some((k) => this.recentlyShown.has(k))
    }

    private markShown(event: CalendarEvent): void {
        const now = Date.now()
        for (const key of this.dedupeKeys(event)) {
            this.recentlyShown.set(key, now)
        }
    }
}
