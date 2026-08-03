/**
 * GoDojo runs several BrowserWindows off the same renderer bundle, each
 * distinguished by a `?window=` query param (see main.tsx's platform/window
 * attribute setup and electron/main for where each window is created).
 *
 * This hook centralizes that routing decision so App.tsx doesn't re-parse
 * `location.search` five separate times.
 */

import { WindowRoute } from "@/types";

export function useWindowRoute(): WindowRoute {
    const windowParam = new URLSearchParams(window.location.search).get("window");

    const isSettingsWindow = windowParam === "settings";
    const isLauncherWindow = windowParam === "launcher";
    const isOverlayWindow = windowParam === "overlay";
    const isModelSelectorWindow = windowParam === "model-selector";
    const isCropperWindow = windowParam === "cropper";
    const isDefault = !isSettingsWindow && !isOverlayWindow && !isModelSelectorWindow && !isCropperWindow;

    return {
        isSettingsWindow,
        isLauncherWindow,
        isOverlayWindow,
        isModelSelectorWindow,
        isCropperWindow,
        isDefault,
    };
}