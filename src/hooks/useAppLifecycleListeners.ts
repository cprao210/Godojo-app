import { AppLifecycleState, IncompatibleProviderWarning, OllamaPullState } from "@/types";
import { useEffect, useState } from "react";

/**
 * Wires up the grab-bag of one-shot status checks + IPC event listeners that
 * App.tsx needs on mount: meetings-updated (clears the "processing" flag),
 * Ollama auto-pull progress, and the "your AI provider changed" re-index
 * warning.
 */
export function useAppLifecycleListeners(): AppLifecycleState {
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

        // Meeting processing finished.
        const removeMeetingsListener = window.electronAPI?.onMeetingsUpdated?.(() => {
            setIsProcessingMeeting(false);
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
        isProcessingMeeting,
        setIsProcessingMeeting,
        ollamaPull,
        incompatibleWarning,
        dismissIncompatibleWarning: () => setIncompatibleWarning(null),
        reindexIncompatibleMeetings,
    };
}