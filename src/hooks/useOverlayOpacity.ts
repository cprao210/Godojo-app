import { useEffect, useState } from "react";
import { clampOverlayOpacity, OVERLAY_OPACITY_DEFAULT, getDefaultOverlayOpacity } from "../lib/overlayAppearance";

const OPACITY_KEY = "gd_dock_opacity";
const LEGACY_OPACITY_KEY = "natively_overlay_opacity"; // key used before the rename

/**
 * Reads the last user-set overlay opacity from localStorage (migrating the
 * pre-rename key if present), falling back to the theme-aware default if
 * the user never explicitly set one.
 */
function getInitialOverlayOpacity(): number {
    let stored = localStorage.getItem(OPACITY_KEY);
    if (stored === null) {
        const legacy = localStorage.getItem(LEGACY_OPACITY_KEY);
        if (legacy !== null) {
            localStorage.setItem(OPACITY_KEY, legacy);
            localStorage.removeItem(LEGACY_OPACITY_KEY);
            stored = legacy;
        }
    }

    const parsed = stored ? parseFloat(stored) : NaN;
    // Treat missing value or the old default (0.65) as "not user-set".
    const isUserSet = Number.isFinite(parsed) && parsed !== OVERLAY_OPACITY_DEFAULT;
    return isUserSet ? clampOverlayOpacity(parsed) : getDefaultOverlayOpacity();
}

/**
 * Overlay transparency — only meaningful when isOverlayWindow, but
 * initialized from localStorage once and kept in sync with:
 *  - IPC pushes (`onOverlayOpacityChanged`, e.g. user drags the slider)
 *  - theme changes, when the user hasn't explicitly set their own value
 */
export function useOverlayOpacity(isOverlayWindow: boolean): [number, (opacity: number) => void] {
    const [overlayOpacity, setOverlayOpacity] = useState<number>(getInitialOverlayOpacity);

    useEffect(() => {
        if (!isOverlayWindow) return;
        const removeListener = window.electronAPI?.onOverlayOpacityChanged?.((opacity) => {
            setOverlayOpacity(opacity);
        });
        return () => {
            if (removeListener) removeListener();
        };
    }, [isOverlayWindow]);

    // When the theme switches and no user preference is stored, reset to theme-aware default.
    useEffect(() => {
        if (!isOverlayWindow || !window.electronAPI?.onThemeChanged) return;
        return window.electronAPI.onThemeChanged(() => {
            const stored = localStorage.getItem(OPACITY_KEY);
            if (!stored) {
                setOverlayOpacity(getDefaultOverlayOpacity());
            }
        });
    }, [isOverlayWindow]);

    return [overlayOpacity, setOverlayOpacity];
}