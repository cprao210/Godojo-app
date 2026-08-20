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
            return next;
        });
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

    const panelTopOffset = dockHeight + PANEL_DOCK_GAP;

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
    const { analysisData, isLoading: analysisLoading, error: analysisError, runAnalysis, resetAnalysis, isRefreshRun } =
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
    // Debounced so a burst of ticks is one IPC call.
    useEffect(() => {
        if (!analysisData || !displayAnalysisData) return;
        const id = setTimeout(() => {
            window.electronAPI?.updateLiveAnalysis?.(displayAnalysisData).catch((err: any) =>
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

    // Moved above the negotiation-toggle effect (was previously declared further
    // down, next to the countdown timer) so both consumers can share it. `force`
    // in useLiveAnalysis.runAnalysis has no transcript-size guard of its own — it
    // only bails on a completely empty transcript — so any caller that wants to
    // avoid firing on a near-empty transcript has to check this itself.
    const hasEnoughTranscript = () => {
        const turns = transcriptRef.current ?? [];
        return turns.filter((t) => t.speaker?.toLowerCase() === PROSPECT_SPEAKER).length >= MIN_PROSPECT_TURNS;
    };

    // Fire an immediate analysis when Negotiation is NEWLY checked, so the Deal
    // Optimizer tab populates within seconds instead of waiting for the next
    // auto-refresh tick. The prev-ref means neither mount (['discovery']
    // default) nor a session-reset fires it, and unchecking never triggers a
    // run. Same force semantics as the Regenerate button; the hook's in-flight
    // guard prevents duplicate calls.
    //
    // BUGFIX: force=true skips useLiveAnalysis's own transcript checks, so
    // without the hasEnoughTranscript() gate below, checking the box seconds
    // into a call (only a couple of transcript words captured) triggered an
    // immediate low-signal API call and visible panel refresh. Now it only
    // force-fires once there's actually enough transcript to analyse — if
    // there isn't yet, the regular auto-refresh cycle (or the urgent-trigger
    // scan) will pick it up once enough turns arrive.
    const prevMeetingTypesRef = useRef<MeetingType[]>(meetingTypes);
    useEffect(() => {
        const hadNegotiation = prevMeetingTypesRef.current.includes('negotiation');
        prevMeetingTypesRef.current = meetingTypes;
        if (!hadNegotiation && meetingTypes.includes('negotiation') && hasEnoughTranscript()) {
            runAnalysisRef.current(true);
        }
    }, [meetingTypes]);

    // Track whether the first analysis has been triggered so we don't re-run
    // on every remount.
    const analysisInitiatedRef = useRef(false);

    // Trigger the first analysis immediately on meeting start (dock mount) —
    // analysis no longer waits for the intelligence panel to be opened. Runs
    // once on mount; analysisInitiatedRef guards against a second run if the
    // component remounts within the same session.
    useEffect(() => {
        if (analysisInitiatedRef.current) return;
        analysisInitiatedRef.current = true;
        runAnalysisRef.current(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

        // Don't schedule the timer while paused or when auto-refresh is off —
        // but the origin above is still reset, so the countdown displays
        // correctly once unpaused instead of resuming from a leftover
        // session's progress.
        if (autoRefreshInterval === null || isMeetingPaused) return;

        const durationMs = autoRefreshInterval * 60 * 1000;

        const finishCycle = (didFire: boolean) => {
            clearAll();
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

        return clearAll;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRefreshInterval, isMeetingPaused, sessionKey]);

    // ── Reset all state when a new meeting starts (IPC session-reset event) ──
    useEffect(() => {
        if (!window.electronAPI?.onSessionReset) return;
        const unsubscribe = window.electronAPI.onSessionReset(() => {
            resetAnalysis();                     // clears analysisData + error in the hook
            resetObjections();                   // clears the owned objection list + cursor
            analysisInitiatedRef.current = false; // allows first-open to trigger fresh analysis
            setChatMessages([]);                 // clears chat history
            setActivePanel(null);                // close any open panel
            setMeetingTypes(['discovery']);      // reset to default — Discovery pre-checked
            setSessionKey((k) => k + 1);         // forces the countdown timer effect to restart fresh
        });
        return () => unsubscribe();
    }, [resetAnalysis, resetObjections]);

    return {
        // panel switching / freeze
        activePanel,
        togglePanel,
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
        // chat history (lifted)
        handleInteractionId,
        chatMessages,
        setChatMessages,
        // auto-refresh countdown
        autoRefreshInterval,
        setAutoRefreshInterval,
        intelligencePanelFirstOpenedAt,
        noAnalysisCaptured,
    };
}