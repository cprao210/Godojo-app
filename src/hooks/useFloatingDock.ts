// State + orchestration layer for FloatingDock: owns panel switching, freeze
// mode, dock opacity (persisted + synced across windows), dock height
// measurement, the lifted live-analysis session (so it survives panel
// switches), chat history, and the single-shot auto-refresh countdown timer.
// Kept separate from the component so the component only owns rendering —
// same split as useManagerDashboard / useSignIn.

import { useEffect, useMemo, useRef, useState } from 'react';
// Imported directly (not via the './index' barrel) to avoid a circular
// import — this hook is itself re-exported from that barrel.
import { useLiveAnalysis } from './useLiveAnalysis';
import { useObjectionWatch } from './useObjectionWatch';
import { ActivePanel, ChatMessage, LiveAnalysisData, MeetingType } from '@/types';
import { objectionsOnlyAnalysis } from '@/lib/objections';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import { getMeetingGeneration, setMeetingGeneration } from '@/lib/meetingGeneration';
import { decideFinalAnalysis, FINAL_ANALYSIS_MAX_WAIT_MS } from '@/lib/meetingLifecycle';

const OPACITY_STORAGE_KEY = 'gd_dock_opacity';
const MIN_OPACITY = 0.35;
const MAX_OPACITY = 1;
// Gap between a panel's bottom edge and the top of the dock — single source
// of truth so every panel (intelligence, chat, settings) sits the same
// distance above the dock regardless of platform DPI or dock size changes.
const PANEL_DOCK_GAP = 65;
const DEFAULT_DOCK_HEIGHT = 64; // sensible fallback before first ResizeObserver measure
// Minimum number of prospect turns considered "enough transcript" to
// generate an analysis from — used both to fire early (before the countdown
// finishes) and to decide the zero-countdown outcome. Must count ONLY the
// prospect's own turns (speaker === 'client'); counting the rep's ('user')
// turns too meant checking "Negotiation" could force-fire an analysis after
// only the rep had spoken, before the prospect said anything — a low-signal
// refresh that looked like it was firing "randomly" on short transcripts.
const MIN_PROSPECT_TURNS = 2;
const PROSPECT_SPEAKER = 'client';
// How often the countdown cycle checks whether there is finally enough
// transcript to analyse. The countdown is a deadline, not a schedule — this is
// what makes the first analysis land *during* the call.
const EARLY_TRIGGER_POLL_MS = 5_000;
const IDLE_POLL_MS = 150;

/** Await `p`, but give up after `ms`. Never rejects. */
const raceDeadline = async (p: Promise<unknown>, ms: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            p.catch(() => { }),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

/**
 * Poll until an analysis run that someone else started finishes. Used when the
 * call ends mid-run: that run's result IS the final analysis, so the correct
 * move is to wait for it rather than start a competing one (runAnalysis would
 * reject the second call anyway, and the summary snapshot would be taken
 * before either landed).
 */
const waitWhileBusy = async (isBusy: () => boolean, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (isBusy() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
};

const clampOpacity = (v: number) => Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, v));

type TranscriptRef = React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>;

interface UseFloatingDockArgs {
    transcriptRef: TranscriptRef;
    isMeetingPaused: boolean;
    companyIntel?: Record<string, any> | null;
}

export function useFloatingDock({ transcriptRef, isMeetingPaused, companyIntel }: UseFloatingDockArgs) {
    // ── Panel switching + freeze mode ────────────────────────────────────────
    const [activePanel, setActivePanel] = useState<ActivePanel>(null);
    // Remembers the last panel that was open so the brand bar's ▽ chevron can
    // re-open it when nothing is currently shown. Defaults to Intelligence.
    const lastPanelRef = useRef<Exclude<ActivePanel, null>>('intelligence');
    const [isFrozen, setIsFrozen] = useState(false);

    const togglePanel = (panel: ActivePanel) => {
        if (isFrozen && panel !== null) return;
        setActivePanel((prev) => {
            const next = prev === panel ? null : panel;
            // Only fire on genuine opens (next !== null) — toggling a panel
            // closed, or switching directly between two panels, shouldn't
            // double-count as an "open" for the panel being left.
            if (next === 'intelligence') posthogAnalytics.trackLiveAnalysisOpened();
            else if (next === 'chat') posthogAnalytics.trackLiveChatOpened();
            else if (next === 'settings') posthogAnalytics.trackLiveSettingsOpened();
            if (next) lastPanelRef.current = next; // remember for the brand-bar re-open (▽)
            return next;
        });
    };

    // ── Dock expand/collapse (nav dock + panel visibility) ──────────────────
    // Separate from `activePanel` on purpose: collapsing hides the nav dock
    // AND whichever panel was open, but must NOT forget which panel that was
    // — so expanding again restores it instead of falling back to
    // Intelligence every time. Starts collapsed: on meeting start only the
    // brand bar is visible.
    const [isDockExpanded, setIsDockExpanded] = useState(false);

    // Used by the always-visible brand bar above the dock (DockBrandBar): the
    // chevron collapses the dock (hiding nav + panel), or expands it again —
    // restoring the last-active panel, or Intelligence on first-ever expand.
    const collapseDock = () => setIsDockExpanded(false);
    const expandDock = () => {
        setIsDockExpanded(true);
        // Only fall back to the last/default panel if nothing is selected
        // yet (first expand of the session) — otherwise keep whatever the
        // user was last looking at before collapsing.
        setActivePanel((prev) => prev ?? lastPanelRef.current);
    };

    const handleFreezeMode = () => setIsFrozen((prev) => !prev);

    // ── Dock + panel opacity — persisted to localStorage, synced across windows ─
    const [dockOpacity, setDockOpacity] = useState<number>(() => {
        const stored = localStorage.getItem(OPACITY_STORAGE_KEY);
        const parsed = stored ? parseFloat(stored) : NaN;
        return Number.isFinite(parsed) ? clampOpacity(parsed) : 0.97;
    });

    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === OPACITY_STORAGE_KEY && e.newValue) {
                const parsed = parseFloat(e.newValue);
                if (Number.isFinite(parsed)) setDockOpacity(clampOpacity(parsed));
            }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const handleDockOpacityChange = (val: number) => {
        const clamped = clampOpacity(val);
        setDockOpacity(clamped);
        localStorage.setItem(OPACITY_STORAGE_KEY, String(clamped));
        window.dispatchEvent(new StorageEvent('storage', { key: OPACITY_STORAGE_KEY, newValue: String(clamped) }));
        window.electronAPI?.setOverlayOpacity?.(clamped);
    };

    // ── Meeting type multi-select (Discovery / Negotiation / …) ─────────────
    const [meetingTypes, setMeetingTypes] = useState<MeetingType[]>(['discovery']);

    // ── Dock height measurement → panel vertical offset ──────────────────────
    const dockRef = useRef<HTMLDivElement>(null);
    const [dockHeight, setDockHeight] = useState(DEFAULT_DOCK_HEIGHT);

    useEffect(() => {
        const el = dockRef.current;
        if (!el) return;
        const observer = new ResizeObserver((entries) => {
            const h = entries[0]?.contentRect.height;
            if (h) setDockHeight(h);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const panelTopOffset = dockHeight + PANEL_DOCK_GAP - 52;

    // ── Fast objection watcher — ticks in seconds, not minutes ──────────────
    // Owns the objection list outright (delta-in/delta-out contract with
    // /intelligence/objection-handler). Lifted here for the same reason the analysis
    // session is: it must survive panel switches and remounts.
    const {
        active: activeObjections,
        resolved: resolvedObjections,
        objectionsRef,
        isEnabled: objectionWatchEnabled,
        resetObjections,
    } = useObjectionWatch(transcriptRef, isMeetingPaused);

    // ── Lifted analysis session — survives panel switches/remounts ──────────
    const { analysisData, isLoading: analysisLoading, error: analysisError, runAnalysis, resetAnalysis, isRefreshRun, getAnalysisProgress } =
        useLiveAnalysis(
            transcriptRef,
            isMeetingPaused,
            companyIntel,
            meetingTypes,
            // null while the watcher is disabled (backend without the route) so
            // live-analysis keeps producing objections the way it does today.
            objectionWatchEnabled ? objectionsRef : null,
        );

    // What the panel actually renders: the slow analysis, with the objection slice
    // replaced by the list the watcher owns. Resolved objections stay in the array
    // (LiveAnalysisContent partitions them into a collapsed group) so they still
    // reach `previous_analysis.objections` and the post-call summary.
    //
    // Objections do NOT depend on live analysis. They come from their own endpoint on
    // a seconds cadence, so when there is no analysis yet — first minutes of a call,
    // or live analysis failing/timing out for the whole call — they get an empty
    // container to ride in rather than being dropped. Previously this returned null
    // whenever `analysisData` was null, which meant the fast route could answer in
    // ~1.5s and the rep would still see the countdown placeholder.
    const displayAnalysisData = useMemo<LiveAnalysisData | null>(() => {
        if (!objectionWatchEnabled) return analysisData;
        const watched = [...activeObjections, ...resolvedObjections];
        if (analysisData) return { ...analysisData, objections: watched };
        // Stay null on an empty list so the panel keeps showing its countdown /
        // waiting placeholder instead of an all-missing shell with nothing in it.
        return watched.length > 0 ? objectionsOnlyAnalysis(watched) : null;
    }, [analysisData, activeObjections, resolvedObjections, objectionWatchEnabled]);

    // Objections tick far more often than live analysis runs, so re-push the composed
    // result to the main process in between — that's what ends up in
    // `summary_json.liveAnalysis` at meeting end.
    //
    // Gated on the REAL analysisData, not displayAnalysisData: an objections-only
    // payload would carry empty BANT/MEDDIC into reconcileBantMeddicWithLiveAnalysis
    // (MeetingPersistence), which treats live analysis as authoritative and would wipe
    // the summary LLM's own BANT. displayAnalysisData is now deliberately non-null
    // before the first analysis lands (see above), so this check has to name
    // analysisData explicitly — the objections-only shell must never be persisted.
    // Debounced so a burst of ticks is one IPC call. Tagged with the meeting
    // generation: this fires on a timer, so it can land after the call ended.
    useEffect(() => {
        if (!analysisData || !displayAnalysisData) return;
        const generation = getMeetingGeneration();
        const id = setTimeout(() => {
            window.electronAPI?.updateLiveAnalysis?.(displayAnalysisData, generation).catch((err: any) =>
                console.error('[useFloatingDock] Failed to persist objections:', err),
            );
        }, 1000);
        return () => clearTimeout(id);
    }, [analysisData, displayAnalysisData]);

    // Stable ref to runAnalysis — prevents the timer effect below from
    // re-running (and resetting the countdown) whenever runAnalysis's
    // identity changes.
    const runAnalysisRef = useRef(runAnalysis);
    useEffect(() => {
        runAnalysisRef.current = runAnalysis;
    }, [runAnalysis]);

    // `force` in useLiveAnalysis.runAnalysis has no transcript-size guard of
    // its own — it only bails on a completely empty transcript — so any
    // caller that wants to avoid firing on a near-empty transcript has to
    // check this itself.
    const hasEnoughTranscript = () => {
        const turns = transcriptRef.current ?? [];
        return turns.filter((t) => t.speaker?.toLowerCase() === PROSPECT_SPEAKER).length >= MIN_PROSPECT_TURNS;
    };

    // Has the end-of-call analysis already been requested for this call? Ending
    // is reachable more than once (a second End Call click while the first is
    // still awaiting, a meeting-ended broadcast landing after the click), and a
    // duplicate run costs a second LLM call and races the first one's write.
    const finalAnalysisRequestedRef = useRef(false);

    /**
     * Last chance to analyse the complete transcript.
     *
     * Awaited by the End Call button so the result is in main's live-analysis
     * slot BEFORE stopMeeting() snapshots it — that snapshot is what
     * buildSummaryPrompt and reconcileBantMeddicWithLiveAnalysis read, and it is
     * taken by value, so an analysis that lands afterwards can only be patched
     * onto the saved row and never reaches the summary.
     *
     * Bounded by FINAL_ANALYSIS_MAX_WAIT_MS: a hung provider must not trap the
     * user in a call they asked to end. On timeout the call ends anyway and
     * main's pending-generation patch is the fallback.
     */
    const ensureFinalAnalysisBeforeEndCall = async () => {
        const turns = transcriptRef.current ?? [];
        // Same filter useLiveAnalysis applies before advancing its cursor, so
        // the two counts are comparable.
        const humanTurnCount = turns.filter(
            (t) => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()),
        ).length;
        const progress = getAnalysisProgress();

        const decision = decideFinalAnalysis({
            alreadyRequested: finalAnalysisRequestedRef.current,
            isLoading: progress.isLoading,
            hasAnalysis: progress.hasAnalysis,
            lastAnalyzedTurnIndex: progress.lastAnalyzedTurnIndex,
            humanTurnCount,
            hasEnoughTranscript: hasEnoughTranscript(),
        });
        console.log(`[useFloatingDock] Final analysis → ${decision.action}: ${decision.reason}`);

        if (decision.action === 'skip') return;
        finalAnalysisRequestedRef.current = true;

        if (decision.action === 'wait') {
            await waitWhileBusy(() => getAnalysisProgress().isLoading, FINAL_ANALYSIS_MAX_WAIT_MS);
            return;
        }

        // Tell main an analysis is in flight BEFORE starting it, so that if we
        // do time out, endMeeting records this meeting as the one awaiting a
        // late result.
        try {
            await window.electronAPI?.setLiveAnalysisInFlight?.(true, getMeetingGeneration());
        } catch { /* non-fatal — the run below still tags its own write */ }

        await raceDeadline(runAnalysisRef.current(true), FINAL_ANALYSIS_MAX_WAIT_MS);
    };

    // ── Chat history — lifted so it survives panel switches ─────────────────
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

    // ── Live chat interaction ids ────────────────────────────────────────
    // /chat/live has no real meeting_id to attach to at query time (the
    // meeting isn't persisted until the call ends), so each turn only
    // returns an `interaction_id`. Collect every one seen during the call,
    // then once the call actually ends and a real meeting_id exists,
    // retroactively link the whole batch via POST /live/link-meeting so
    // meeting history / MeetingChatOverlay can retrieve these turns.
    const interactionIdsRef = useRef<number[]>([]);
    const handleInteractionId = (interactionId: number) => {
        interactionIdsRef.current.push(interactionId);
    };

    // 'live-call-ended' fires exactly once, from main.ts#endMeeting, with the
    // authoritative meetingId for the call that just ended.
    //
    // We do NOT call chatApi.linkMeetingInteractions here — the backend
    // (Supabase mirror) doesn't have this meeting yet at call-end (only local
    // SQLite does; useMeetingDetails.ts explicitly gates its HTTP fetch on
    // `!isProcessing` for the same reason), so link-meeting 404s with
    // "Meeting not found" if called this early. Instead, persist the ids
    // durably and link them lazily — see useMeetingDetails.ts, which calls
    // chatApi.linkMeetingInteractions once it has *confirmed* (by successfully
    // fetching) that the backend has this meeting.
    useEffect(() => {
        const unsubscribe = window.electronAPI?.onLiveCallEnded?.(async ({ meetingId }) => {
            if (interactionIdsRef.current.length === 0 || !meetingId) return;

            const idsToSave = interactionIdsRef.current;
            interactionIdsRef.current = []; // clear before the await so a call
            // straddling two meetings can't
            // double-submit the same batch
            try {
                await window.electronAPI?.savePendingLiveChatInteractions?.(meetingId, idsToSave);
            } catch (err) {
                console.error('[useFloatingDock] failed to persist pending live chat interactions', err);
            }
        });
        return () => unsubscribe?.();
    }, []);

    // ── Auto-refresh countdown timer ─────────────────────────────────────────
    // Owned here (not in the panel) so the timer survives panel close/open
    // cycles and responds correctly to isMeetingPaused changes.
    const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(2);
    const autoRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const earlyTriggerPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Timestamp of when the current countdown cycle started — synchronises
    // the countdown display with the actual auto-refresh timer.
    const [intelligencePanelFirstOpenedAt, setIntelligencePanelFirstOpenedAt] = useState<number | null>(null);

    // True when the countdown reached zero without enough transcript to
    // analyse. Cleared whenever a new cycle starts (new session, resume,
    // interval change).
    const [noAnalysisCaptured, setNoAnalysisCaptured] = useState(false);

    // True only while the single startup countdown cycle is still armed. Set
    // when a cycle begins, cleared the instant it finishes — whether that was
    // the early trigger or the deadline.
    //
    // The panel needs this because "no data to show" is NOT the same as "the
    // countdown is still running". The first analysis of a call usually fires
    // early (as soon as the prospect has spoken twice) and often comes back with
    // nothing usable yet — all BANT/MEDDIC still `missing`, no signals. That
    // left the panel with displayData === null after the loading skeleton, so
    // the branch chain fell straight back to CountdownPlaceholder: the user saw
    // countdown → loader → countdown again, the second one ticking down against
    // a deadline that had already been cleared.
    const [countdownCycleActive, setCountdownCycleActive] = useState(false);

    // Bumped on every session-reset so the timer effect below always re-runs
    // and re-anchors intelligencePanelFirstOpenedAt to "now" — even when
    // autoRefreshInterval/isMeetingPaused haven't changed across the reset.
    // Without this, the countdown origin from the ENDED meeting survived into
    // the new one, so the display could open showing an arbitrary leftover
    // value (e.g. "0:10") instead of the full configured duration.
    const [sessionKey, setSessionKey] = useState(0);

    // Runs ONCE per cycle (single-shot, not recurring):
    //   - If enough transcript is captured before the countdown finishes,
    //     analysis fires immediately and the cycle ends there.
    //   - If the countdown reaches zero with enough transcript, analysis fires.
    //   - If the countdown reaches zero WITHOUT enough transcript, the timer
    //     stops and `noAnalysisCaptured` is set instead of silently restarting.
    // A new cycle only begins when: the interval changes, the meeting is
    // resumed after a pause, or a new live-analysis session starts (sessionKey).
    useEffect(() => {
        const clearAll = () => {
            if (autoRefreshTimeoutRef.current) {
                clearTimeout(autoRefreshTimeoutRef.current);
                autoRefreshTimeoutRef.current = null;
            }
            if (earlyTriggerPollRef.current) {
                clearInterval(earlyTriggerPollRef.current);
                earlyTriggerPollRef.current = null;
            }
        };

        clearAll();

        // Reset origin and any stale "no analysis" state unconditionally, even
        // if this run is about to bail out on the paused check below.
        // isMeetingPaused is a prop driven by a separate IPC/pause channel, not
        // something this effect owns — it isn't guaranteed to have settled back
        // to false by the instant a new meeting's session-reset bumps
        // sessionKey. Gating this reset behind the pause check meant a fast
        // end→restart could land while isMeetingPaused still briefly read true,
        // leaving the ENDED meeting's origin timestamp in place —
        // CountdownPlaceholder then rendered a decayed countdown against the
        // new session instead of a fresh 2:00.
        setIntelligencePanelFirstOpenedAt(Date.now());
        setNoAnalysisCaptured(false);

        // Arm the display flag whenever auto-refresh is on — including while
        // paused, where the ring is deliberately shown frozen and the cycle
        // starts fresh on resume.
        setCountdownCycleActive(autoRefreshInterval !== null);

        // Don't schedule the timer while paused or when auto-refresh is off —
        // but the origin above is still reset, so the countdown displays
        // correctly once unpaused instead of resuming from a leftover
        // session's progress.
        if (autoRefreshInterval === null || isMeetingPaused) return;

        const durationMs = autoRefreshInterval * 60 * 1000;

        const finishCycle = (didFire: boolean) => {
            clearAll();
            // The countdown is over the moment it fires, in both directions.
            // Nothing re-arms it except a new cycle (interval/pause/session),
            // so the ring can never reappear behind a later empty result.
            setCountdownCycleActive(false);
            if (didFire) runAnalysisRef.current(false);
            else setNoAnalysisCaptured(true);
            // Intentionally single-shot: no rescheduling here. The countdown
            // only runs again if this effect re-runs (interval/pause/session
            // change).
        };

        // Countdown's final deadline.
        autoRefreshTimeoutRef.current = setTimeout(() => {
            finishCycle(hasEnoughTranscript());
        }, durationMs);

        // Early trigger — the piece that makes the FIRST analysis of a call land
        // during the call instead of at the deadline. The dock mounts once for
        // the whole app lifetime (the overlay window is only hidden between
        // meetings, never destroyed), so a mount-time kick can't do this job:
        // at mount the transcript is always empty, and the effect never re-runs.
        //
        // Restricted to the first analysis on purpose. Afterwards the deadline
        // and useLiveAnalysis's urgent-signal trigger own the cadence; polling
        // past that point would fire an extra run on every pause/resume.
        if (!getAnalysisProgress().hasAnalysis) {
            earlyTriggerPollRef.current = setInterval(() => {
                if (hasEnoughTranscript()) finishCycle(true);
            }, EARLY_TRIGGER_POLL_MS);
        }

        return clearAll;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRefreshInterval, isMeetingPaused, sessionKey]);

    // ── Reset all state when a new meeting starts (IPC session-reset event) ──
    useEffect(() => {
        if (!window.electronAPI?.onSessionReset) return;
        const unsubscribe = window.electronAPI.onSessionReset((payload) => {
            // Adopt the new generation FIRST: everything below can cause an async
            // write, and any write still in flight from the previous call must be
            // stamped as stale from this instant on.
            if (typeof payload?.meetingGeneration === 'number') {
                setMeetingGeneration(payload.meetingGeneration);
            }
            resetAnalysis();                     // clears analysisData + error in the hook
            resetObjections();                   // clears the owned objection list + cursor
            finalAnalysisRequestedRef.current = false; // re-arm the end-of-call analysis
            setChatMessages([]);                 // clears chat history
            setActivePanel(null);                // close any open panel
            setIsDockExpanded(false);            // collapse to brand-bar-only for the new meeting
            setMeetingTypes(['discovery']);      // reset to default — Discovery pre-checked
            setSessionKey((k) => k + 1);         // forces the countdown timer effect to restart fresh
        });
        return () => unsubscribe();
    }, [resetAnalysis, resetObjections]);

    // Whether the panel is allowed to render the countdown ring at all. Two
    // independent guards, both required:
    //   - the startup cycle must still be armed (see countdownCycleActive), and
    //   - nothing may have come back from analysis yet.
    // The second uses the RAW analysisData, not displayAnalysisData: an analysis
    // that returned only `missing` fields is non-null here but renders as empty
    // in the panel, and that combination is exactly what used to bring the ring
    // back after the loading skeleton.
    const isCountdownActive = countdownCycleActive && analysisData === null;

    return {
        // panel switching / freeze
        activePanel,
        togglePanel,
        isDockExpanded,
        collapseDock,
        expandDock,
        isFrozen,
        handleFreezeMode,
        // dock opacity
        dockOpacity,
        handleDockOpacityChange,
        // dock height → panel offset
        dockRef,
        panelTopOffset,
        // meeting types
        meetingTypes,
        setMeetingTypes,
        // analysis session (lifted) — `analysisData` carries the watcher's objections
        analysisData: displayAnalysisData,
        analysisLoading,
        analysisError,
        runAnalysis,
        isRefreshRun,
        ensureFinalAnalysisBeforeEndCall,
        // chat history (lifted)
        handleInteractionId,
        chatMessages,
        setChatMessages,
        // auto-refresh countdown
        autoRefreshInterval,
        setAutoRefreshInterval,
        intelligencePanelFirstOpenedAt,
        noAnalysisCaptured,
        isCountdownActive,
    };
}