import { useEffect, useRef } from "react";
import { verifySessionIsActive, signOut as fbSignOut } from "../lib/firebase";
import { MeetingSessionControls } from "@/types";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";
import { backendMeetingSession } from "@/lib/backendMeetingSession";

/**
 * Owns the Electron IPC meeting lifecycle (start/end + window-mode switching)
 * and, when the backend pipeline flag is on, mirrors that lifecycle onto the
 * FastAPI live-session routes via `backendMeetingSession`.
 *
 * Which pipeline generates the summary is decided at END of the call, not the
 * start: the backend session has to have survived the whole meeting (and
 * delivered its full transcript) to be trusted with it. If it didn't,
 * `backendMeetingSession.end()` returns null and we hand the meeting to
 * Electron's own processAndSaveMeeting exactly as before.
 *
 * `tenantId` is threaded through only so handleEndMeeting can pass it along to
 * the IPC call — it's owned by `useTenant`, not this hook. `setIsProcessingMeeting`
 * is owned by `useAppLifecycleListeners` (it feeds the post-meeting ad timer) —
 * this hook just flips it on; the listener flips it back off once the backend
 * reports the meeting finished processing.
 */
export function useMeetingSession(
    tenantId: string | null,
    setIsProcessingMeeting: (processing: boolean) => void
): MeetingSessionControls {
    // Guards against a double-click (or a calendar auto-join racing a manual
    // click) firing two concurrent start-meeting IPC calls. The backend now
    // also no-ops a duplicate startMeeting() while one is active — this is
    // the renderer-side half of the same fix.
    const isStartingRef = useRef(false);

    // Mirror transcript turns into the backend session. This is the same stream
    // main.ts feeds to SessionTracker (and already echo-filtered — see
    // main.ts#handleTranscriptSegment), so the two pipelines summarize identical
    // text. No-ops entirely when the backend session isn't active.
    useEffect(() => {
        const cleanup = window.electronAPI?.onNativeAudioTranscript?.((t) => {
            backendMeetingSession.captureSegment(t);
        });
        return () => cleanup?.();
    }, []);

    const handleStartMeeting = async (calendarEvent?: any) => {

        if (isStartingRef.current) {
            console.warn("[useMeetingSession] startMeeting already in flight — ignoring duplicate call.");
            return;
        }
        isStartingRef.current = true;

        try {
            // Always verify the session is live against Firebase servers before
            // starting GoDojo. getIdToken(forceRefresh=true) throws if the account
            // has been deleted, disabled, or the token revoked — the local Firebase
            // cache can still show a user object even after server-side deletion.
            const sessionActive = await verifySessionIsActive();
            if (!sessionActive) {
                console.warn("[useMeetingSession] startMeeting blocked — session invalid or account deleted.");
                await fbSignOut().catch(() => { });
                return;
            }

            localStorage.setItem("natively_last_meeting_start", Date.now().toString());
            const inputDeviceId = localStorage.getItem("preferredInputDeviceId");
            let outputDeviceId = localStorage.getItem("preferredOutputDeviceId");
            const useExperimentalSck = localStorage.getItem("useExperimentalSckBackend") === "true";

            // Override output device ID to force SCK if experimental mode is enabled.
            // Default to CoreAudio unless experimental is enabled.
            if (useExperimentalSck) {
                console.log("[useMeetingSession] Using ScreenCaptureKit backend (Experimental).");
                outputDeviceId = "sck";
            } else {
                console.log("[useMeetingSession] Using CoreAudio backend (Default).");
            }

            // Merge calendar event data if provided.
            const meetingMetadata = {
                audio: { inputDeviceId, outputDeviceId },
                ...(calendarEvent && {
                    title: calendarEvent.title,
                    calendarEventId: calendarEvent.id,
                    source: "calendar",
                    attendees: calendarEvent.attendees || [],
                    organizer: calendarEvent.organizer || "",
                }),
            };

            const result = await window.electronAPI.startMeeting(meetingMetadata);
            if (result.success) {
                // Open the parallel backend session. No-ops when the flag is off,
                // and never throws — a failure here just leaves the meeting on the
                // Electron pipeline.
                await backendMeetingSession.start({
                    title: calendarEvent?.title,
                    attendees: calendarEvent?.attendees || [],
                    calendar_event_id: calendarEvent?.id,
                    audio: { input_device_id: inputDeviceId, output_device_id: outputDeviceId },
                });
                await window.electronAPI.setWindowMode("overlay");
            } else {
                console.error("Failed to start meeting:", result.error);
                posthogAnalytics.trackMeetingStartFailed(result.error || "unknown");
            }
        } catch (err: any) {
            console.error("Failed to start meeting:", err);
            posthogAnalytics.trackMeetingStartFailed(err?.message || "unknown");
            posthogAnalytics.trackException(err instanceof Error ? err : new Error(String(err)), "useMeetingSession.handleStartMeeting");
        } finally {
            isStartingRef.current = false;
        }
    };

    const handleEndMeeting = async (meetingTypes?: ("discovery" | "demo" | "negotiation")[]) => {
        console.log("[useMeetingSession] handleEndMeeting triggered");
        setIsProcessingMeeting(true);

        // Check profile toaster threshold before firing endMeeting — we don't want
        // to wait for the IPC to resolve before switching back to launcher.
        const startStr = localStorage.getItem("natively_last_meeting_start");
        if (startStr) {
            const duration = Date.now() - parseInt(startStr, 10);
            const threshold = import.meta.env.DEV ? 10000 : 180000;
            if (duration >= threshold) {
                localStorage.setItem("natively_show_profile_toaster", "true");
            }
            localStorage.removeItem("natively_last_meeting_start");
        }

        // Switch to launcher first so the UI never waits on the end-of-meeting
        // network round-trip below.
        try {
            await window.electronAPI.setWindowMode("launcher");
        } catch (err: any) {
            console.error("Failed to switch window mode:", err);
            posthogAnalytics.trackMeetingEndFailed(err?.message || "window_mode_switch_failed");
            posthogAnalytics.trackException(err instanceof Error ? err : new Error(String(err)), "useMeetingSession.handleEndMeeting.setWindowMode");
        }

        // Finalize server-side and find out whether it actually succeeded. This
        // is awaited before the IPC call because `skipProcessing` depends on the
        // answer: handing the meeting to the backend and *also* letting Electron
        // summarize it would bill two LLM runs and race two writers onto the same
        // row. Cost of awaiting is that audio capture keeps running until the IPC
        // lands — a sub-second tail, after the user has already stopped the call.
        // Returns null (and no-ops) whenever the backend pipeline isn't in play.
        const backendMeetingId = await backendMeetingSession.end(meetingTypes ?? []);

        console.log("[useMeetingSession] handleEndMeeting: tenantId at IPC call =", tenantId ?? "(null)");
        window.electronAPI.endMeeting(meetingTypes, tenantId, {
            // The backend owns this meeting — Electron should tear down audio and
            // reset session state, but skip the LLM work and the local placeholder
            // (POST /meetings/start already wrote one under the backend's id).
            skipProcessing: backendMeetingId !== null,
            backendMeetingId,
        }).catch((err) => {
            console.error("Failed to end meeting:", err);
            posthogAnalytics.trackMeetingEndFailed(err?.message || String(err));
            posthogAnalytics.trackException(err instanceof Error ? err : new Error(String(err)), "useMeetingSession.handleEndMeeting");
        });
    };

    return { handleStartMeeting, handleEndMeeting };
}