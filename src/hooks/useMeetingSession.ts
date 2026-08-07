import { useEffect, useRef } from "react";
import { verifySessionIsActive, signOut as fbSignOut } from "../lib/firebase";
import { analytics } from "../lib/analytics/analytics.service";
import { TranscriptSegmentInput, MeetingSessionControls } from "@/types";

/**
 * Owns the Electron IPC meeting lifecycle (start/end + window-mode switching)
 * and buffers native-audio transcript turns while a backend meeting session
 * is active (backendMeetingIdRef tracks the id returned by meetingsApi.start;
 * segmentsRef buffers turns so we can submit them all at once at end-of-meeting,
 * per the backend contract).
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
    const backendMeetingIdRef = useRef<string | null>(null);
    const transcriptSegmentsRef = useRef<TranscriptSegmentInput[]>([]);

    // Buffer transcript turns while a backend meeting session is active.
    useEffect(() => {
        const cleanup = window.electronAPI?.onNativeAudioTranscript?.((t) => {
            if (!backendMeetingIdRef.current) return;
            transcriptSegmentsRef.current.push({
                speaker: (t.speaker as TranscriptSegmentInput["speaker"]) ?? "client",
                text: t.text,
                timestamp: t.timestamp ?? Date.now(),
                final: t.final,
                confidence: t.confidence,
            });
        });
        return () => cleanup?.();
    }, []);

    const handleStartMeeting = async (calendarEvent?: any) => {
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

            // Note: result.meetingId is the real meeting id, generated up-front
            // in main.ts#startMeeting(). We don't need to track it here — this
            // hook runs in the launcher window, but FloatingChatPanel lives in
            // the separate overlay window and gets the id directly via the
            // 'meeting-id-assigned' IPC broadcast (see useFloatingDock.ts).
            const result = await window.electronAPI.startMeeting(meetingMetadata);
            if (result.success) {
                analytics.trackMeetingStarted();
                await window.electronAPI.setWindowMode("overlay");
            } else {
                console.error("Failed to start meeting:", result.error);
            }
        } catch (err) {
            console.error("Failed to start meeting:", err);
        }
    };

    const handleEndMeeting = async (meetingTypes?: ("discovery" | "demo" | "negotiation")[]) => {
        console.log("[useMeetingSession] handleEndMeeting triggered");
        analytics.trackMeetingEnded();
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

        // Fire endMeeting without awaiting — the backend saves the placeholder and
        // broadcasts meetings-updated independently. Switching to launcher immediately
        // means the placeholder card is visible as soon as Launcher mounts and
        // receives the onMeetingsUpdated event, instead of only after the full IPC
        // round-trip completes.
        console.log("[useMeetingSession] handleEndMeeting: tenantId at IPC call =", tenantId ?? "(null)");
        window.electronAPI.endMeeting(meetingTypes, tenantId).catch((err) =>
            console.error("Failed to end meeting:", err)
        );

        try {
            await window.electronAPI.setWindowMode("launcher");
        } catch (err) {
            console.error("Failed to switch window mode:", err);
        }
    };

    return { handleStartMeeting, handleEndMeeting };
}