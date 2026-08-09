import { useEffect } from "react";
import { analytics } from "../lib/analytics/analytics.service";

/**
 * Initializes the analytics service and tracks app-open / app-close /
 * assistant-start / assistant-stop events for this window.
 *
 * The service itself guards against double-init, but WHICH window reports
 * "App Open" vs "Assistant Start" still needs to be decided here: the
 * launcher is the main entry point, the overlay is the "Assistant".
 */
export function useAppAnalytics(isLauncherWindow: boolean, isOverlayWindow: boolean, isDefault: boolean): void {
    useEffect(() => {
        analytics.initAnalytics();

        if (isLauncherWindow || isDefault) {
            analytics.trackAppOpen();
        }

        if (isOverlayWindow) {
            analytics.trackAssistantStart();
        }

        const handleUnload = () => {
            if (isOverlayWindow) {
                analytics.trackAssistantStop();
            }
            if (isLauncherWindow || isDefault) {
                analytics.trackAppClose();
            }
        };

        window.addEventListener("beforeunload", handleUnload);
        return () => {
            window.removeEventListener("beforeunload", handleUnload);
        };
    }, [isLauncherWindow, isOverlayWindow, isDefault]);
}