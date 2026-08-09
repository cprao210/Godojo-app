import { AppLifecycleState, IncompatibleProviderWarning, OllamaPullState } from "@/types";
import { useEffect, useState } from "react";

/**
 * Wires up the grab-bag of one-shot status checks + IPC event listeners that
 * App.tsx needs on mount: profile/premium status (for ad targeting),
 * meetings-updated (drives the post-meeting ad delay timer), Ollama
 * auto-pull progress, and the "your AI provider changed" re-index warning.
 */
export function useAppLifecycleListeners(): AppLifecycleState {
    const [hasProfile, setHasProfile] = useState(false);
    const [isPremiumActive, setIsPremiumActive] = useState(false);
    const [appStartTime] = useState<number>(Date.now());
    const [lastMeetingEndTime, setLastMeetingEndTime] = useState<number | null>(null);
    const [isProcessingMeeting, setIsProcessingMeeting] = useState<boolean>(false);

    const [ollamaPull, setOllamaPull] = useState<OllamaPullState>({
        status: "idle",
        percent: 0,
        message: "",
    });

    const [incompatibleWarning, setIncompatibleWarning] = useState<IncompatibleProviderWarning | null>(null);

    useEffect(() => {
        // Clean up old local storage.
        localStorage.removeItem("useLegacyAudioBackend");

        // Basic status check for ad-campaign targeting.
        window.electronAPI?.profileGetStatus?.()
            .then((s) => setHasProfile(s?.hasProfile || false))
            .catch(() => { });
        window.electronAPI?.licenseCheckPremium?.().then(setIsPremiumActive).catch(() => { });

        // Meeting processing finished — starts the post-meeting ad delay timer.
        const removeMeetingsListener = window.electronAPI?.onMeetingsUpdated?.(() => {
            console.log("[useAppLifecycleListeners] Meetings updated (processing finished), starting ad delay timer");
            setIsProcessingMeeting(false);
            setLastMeetingEndTime(Date.now());
        });

        // Ollama auto-pull progress.
        let removeProgress: (() => void) | undefined;
        let removeComplete: (() => void) | undefined;
        if (window.electronAPI?.onOllamaPullProgress && window.electronAPI?.onOllamaPullComplete) {
            removeProgress = window.electronAPI.onOllamaPullProgress((data) => {
                setOllamaPull({
                    status: "downloading",
                    percent: data.percent || 0,
                    message: data.status || "Downloading...",
                });
            });

            removeComplete = window.electronAPI.onOllamaPullComplete(() => {
                setOllamaPull({ status: "complete", percent: 100, message: "Local AI memory ready" });
                setTimeout(() => setOllamaPull((prev) => ({ ...prev, status: "idle" })), 3000);
            });
        }

        // Provider-incompatibility warning (search index built with a different AI provider).
        let removeWarning: (() => void) | undefined;
        if (window.electronAPI?.onIncompatibleProviderWarning) {
            removeWarning = window.electronAPI.onIncompatibleProviderWarning((data) => {
                setIncompatibleWarning(data);
            });
        }

        return () => {
            removeMeetingsListener?.();
            removeProgress?.();
            removeComplete?.();
            removeWarning?.();
        };
    }, []);

    const reindexIncompatibleMeetings = async () => {
        if (window.electronAPI?.reindexIncompatibleMeetings) {
            setIncompatibleWarning(null);
            await window.electronAPI.reindexIncompatibleMeetings();
        }
    };

    return {
        hasProfile,
        isPremiumActive,
        setIsPremiumActive,
        isProcessingMeeting,
        setIsProcessingMeeting,
        lastMeetingEndTime,
        appStartTime,
        ollamaPull,
        incompatibleWarning,
        dismissIncompatibleWarning: () => setIncompatibleWarning(null),
        reindexIncompatibleMeetings,
    };
}