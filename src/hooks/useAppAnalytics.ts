import { useEffect } from "react";
import { analytics } from "../lib/analytics/analytics.service";
import { FrontendLoggerService } from "@/lib/logger/frontend.logger";

/**
 * Initializes the analytics service and tracks app-open / app-close /
 * assistant-start / assistant-stop events for this window.
 *
 * The service itself guards against double-init, but WHICH window reports
 * "App Open" vs "Assistant Start" still needs to be decided here: the
 * launcher is the main entry point, the overlay is the "Assistant".
 */
export function useAppAnalytics(logger: FrontendLoggerService, isLauncherWindow: boolean, isOverlayWindow: boolean, isDefault: boolean): void {
    useEffect(() => {

        // Only init if we are in a main window context to avoid duplicate events from helper windows
        // Actually, we probably want to track app open from the main entry point.
        // Let's protect initialization to ensure single run per window.
        // The service handles single-init, but let's be thoughtful about WHICH window tracks "App Open".
        // Launcher is the main entry. Overlay is the "Assistant".

        if (import.meta.env.DEV) {
            logger.interceptConsole();
        }

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