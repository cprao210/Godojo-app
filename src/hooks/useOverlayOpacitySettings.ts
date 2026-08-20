// Overlay opacity slider (General tab). This one is unusually perf-sensitive:
// while the user drags the slider we mutate the DOM directly (see
// startPreviewingOpacity/handleOpacityChange) instead of going through React
// state on every pointer-move, so the live preview stays at 60fps. React
// state is only the source of truth for the *settled* value; a ref
// (`latestOpacityRef`) tracks the in-progress drag value without triggering
// re-renders, and gets flushed back into state once the drag ends.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    clampOverlayOpacity,
    OVERLAY_OPACITY_DEFAULT,
    getDefaultOverlayOpacity,
} from '@/lib/overlayAppearance';
import { useResolvedTheme } from './useResolvedTheme';

const OPACITY_KEY = 'gd_dock_opacity';

function readStoredOpacity(): { value: number; isUserSet: boolean } {
    const stored = localStorage.getItem(OPACITY_KEY);
    const parsed = stored ? parseFloat(stored) : NaN;
    // Treat a missing value or the old hardcoded default (0.65) as "not user-set",
    // so a theme change can still apply its own default.
    const isUserSet = Number.isFinite(parsed) && parsed !== OVERLAY_OPACITY_DEFAULT;
    return { value: isUserSet ? clampOverlayOpacity(parsed) : getDefaultOverlayOpacity(), isUserSet };
}

interface UseOverlayOpacitySettingsArgs {
    /** Restores all direct-DOM preview mutations if the overlay closes mid-drag. */
    isOpen: boolean;
}

export function useOverlayOpacitySettings({ isOpen }: UseOverlayOpacitySettingsArgs) {
    const [overlayOpacity, setOverlayOpacity] = useState<number>(() => readStoredOpacity().value);
    const [isPreviewingOpacity, setIsPreviewingOpacity] = useState(false);
    const [previewOverlayOpacity, setPreviewOverlayOpacity] = useState(overlayOpacity);

    // Holds the latest drag value without triggering renders during the drag itself.
    const latestOpacityRef = useRef(overlayOpacity);

    const resolvedTheme = useResolvedTheme();

    // ── Reset to the theme-aware default if the user never set a custom value ─
    useEffect(() => {
        if (!readStoredOpacity().isUserSet) {
            setOverlayOpacity(getDefaultOverlayOpacity());
        }
    }, [resolvedTheme]);

    // ── Keep the ref (and live preview) in sync whenever the settled value changes ─
    // (first mount, or any other code path updating `overlayOpacity` outside a drag).
    useEffect(() => {
        latestOpacityRef.current = overlayOpacity;
        setPreviewOverlayOpacity(overlayOpacity);
    }, [overlayOpacity]);

    // ── Persist to localStorage (debounced) — IPC happens live in handleOpacityChange instead ─
    useEffect(() => {
        const timeoutId = setTimeout(() => {
            localStorage.setItem(OPACITY_KEY, String(overlayOpacity));
        }, 150);
        return () => clearTimeout(timeoutId);
    }, [overlayOpacity]);

    // ── Cross-window sync via the `storage` event ────────────────────────────
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key !== OPACITY_KEY || !e.newValue) return;
            const clamped = clampOverlayOpacity(parseFloat(e.newValue));
            if (!Number.isFinite(clamped)) return;

            setOverlayOpacity(clamped);
            setPreviewOverlayOpacity(clamped);
            latestOpacityRef.current = clamped;

            // Direct-DOM sync too, so an in-progress preview in *this* window
            // (if any) reflects the value another window just saved.
            const sliderEl = document.getElementById('main-opacity-slider') as HTMLInputElement | null;
            if (sliderEl) sliderEl.value = String(clamped);
            document.querySelectorAll('.opacity-percent-label').forEach(
                (el) => (el.textContent = `${Math.round(clamped * 100)}%`),
            );
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    /** Called on every pointer-move while dragging — bypasses React for 60fps updates. */
    const handleOpacityChange = useCallback((val: number) => {
        const percentText = `${Math.round(val * 100)}%`;
        document.querySelectorAll('.opacity-percent-label').forEach((el) => (el.textContent = percentText));
        setPreviewOverlayOpacity(val);
        latestOpacityRef.current = val;

        // Safe to broadcast at 60fps — doesn't trigger a React render, and lets
        // the real meeting overlay track the slider in real time.
        window.electronAPI?.setOverlayOpacity?.(val);

        localStorage.setItem(OPACITY_KEY, String(val));
        window.dispatchEvent(new StorageEvent('storage', { key: OPACITY_KEY, newValue: String(val) }));
    }, []);

    /** Hides the Settings chrome and reveals the live mockup dock so the user can see their drag in context. */
    const startPreviewingOpacity = useCallback(() => {
        if (isPreviewingOpacity) return; // guards against duplicate pointerdown/touchstart firing

        document.body.classList.add('disable-transitions'); // instant, no CSS transition lag

        const backdrop = document.getElementById('settings-backdrop');
        const wrapper = document.getElementById('settings-panel-wrapper');
        const panel = document.getElementById('settings-panel');
        const card = document.getElementById('opacity-slider-card');
        const mockup = document.getElementById('settings-mockup-wrapper');
        const launcher = document.getElementById('launcher-container');

        if (backdrop) {
            backdrop.style.backgroundColor = 'transparent';
            backdrop.style.backdropFilter = 'none';
            backdrop.style.transition = 'none';
        }
        if (wrapper) {
            wrapper.style.backgroundColor = 'transparent';
            wrapper.style.border = 'none';
            wrapper.style.boxShadow = 'none';
        }
        if (panel) panel.style.visibility = 'hidden';
        if (launcher) launcher.style.visibility = 'hidden';
        if (card) {
            card.style.visibility = 'visible';
            card.style.position = 'relative';
            card.style.zIndex = '9999';
        }
        if (mockup) mockup.style.opacity = '1';

        setPreviewOverlayOpacity(latestOpacityRef.current);
        setIsPreviewingOpacity(true);
    }, [isPreviewingOpacity]);

    /** Restores the Settings chrome and commits the dragged value back to React state. */
    const stopPreviewingOpacity = useCallback(() => {
        document.body.classList.remove('disable-transitions');
        const backdrop = document.getElementById('settings-backdrop');
        const wrapper = document.getElementById('settings-panel-wrapper');
        const panel = document.getElementById('settings-panel');
        const card = document.getElementById('opacity-slider-card');
        const mockup = document.getElementById('settings-mockup-wrapper');
        const launcher = document.getElementById('launcher-container');

        if (backdrop) {
            backdrop.style.backgroundColor = '';
            backdrop.style.backdropFilter = '';
            backdrop.style.transition = '';
        }
        if (wrapper) {
            wrapper.style.backgroundColor = '';
            wrapper.style.border = '';
            wrapper.style.boxShadow = '';
        }
        if (panel) panel.style.visibility = '';
        if (launcher) launcher.style.visibility = '';
        if (card) {
            card.style.visibility = '';
            card.style.position = '';
            card.style.zIndex = '';
        }
        if (mockup) mockup.style.opacity = '0'; // restore to hidden rather than leaving it visible

        setIsPreviewingOpacity(false);
        // Persists to localStorage + IPC via the effects above.
        setOverlayOpacity(latestOpacityRef.current);
        setPreviewOverlayOpacity(latestOpacityRef.current);
    }, []);

    // ── If the overlay closes mid-drag, restore everything so nothing is left broken ─
    useEffect(() => {
        if (!isOpen && isPreviewingOpacity) {
            stopPreviewingOpacity();
        }
        // Deliberately isOpen-only: this should fire once when `isOpen` flips to
        // false, not on every isPreviewingOpacity/stopPreviewingOpacity render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    return {
        overlayOpacity,
        previewOverlayOpacity,
        isPreviewingOpacity,
        handleOpacityChange,
        startPreviewingOpacity,
        stopPreviewingOpacity,
    };
}