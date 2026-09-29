// usePerformanceMode.ts
//
// Decides whether the app should run in "Performance Mode" — a
// reduced-visual-fidelity mode that drops the (expensive) backdrop-filter
// blur used across the UI down to flat, solid backgrounds, and disables
// decorative animations (see App.tsx's app-wide wiring + index.css).
//
// WHY THIS EXISTS: backdrop-filter blur is one of the most GPU-intensive CSS
// effects available — it re-samples everything behind an element on every
// composite. The app stacks several independently-blurred layers (the dock
// pill + panels, modals, toasts) — some over transparent, frameless,
// always-on-top windows. On a discrete GPU this is invisible; on weak
// machines it dominates CPU/GPU during calls (measured ~47% CPU / ~61% GPU
// on an i3-10110U laptop during screen share).
//
// Modes:
//   - 'auto' (default): ask the main process once at startup. Auto turns ON
//     when ANY of:
//       1. Chromium fell back to software compositing/rasterization
//          (app.getGPUFeatureStatus(), via ipcHandlers).
//       2. CPU thread count <= 4.
//       3. Intel integrated GPU (vendor 0x8086) AND total RAM <= 8 GB.
//     RAM alone NEVER triggers (an 8 GB Apple Silicon Mac keeps full
//     fidelity). The decision comes from the pure function
//     utils/performanceClassification.ts (unit-tested) and includes the
//     triggering reason.
//   - 'on' / 'off': explicit user override (persisted), always wins over
//     the automatic detection.
//
// Safe-by-default: if the hardware query fails or is unavailable for any
// reason, we do NOT assume the worst — we fall back to full visual fidelity
// rather than silently degrading everyone's UI.

import { useEffect, useState } from 'react';
import type { PerformanceClassification } from '../../utils/performanceClassification';

export type PerformanceModePreference = 'auto' | 'on' | 'off';

const STORAGE_KEY = 'natively_performanceModePreference';
/** Same-window broadcast so every usePerformanceMode instance (the app-wide
 *  gate in main.tsx, the floating dock, and Settings → General) sees a change
 *  immediately. The cross-window case is covered by the native `storage`
 *  event below — localStorage only fires that for OTHER documents. */
const PERF_MODE_CHANGE_EVENT = 'godojo:perf-mode-change';

const readStoredPreference = (): PerformanceModePreference => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'on' || stored === 'off' || stored === 'auto') return stored;
    } catch {
        // localStorage unavailable (e.g. private mode edge cases) — fall through
    }
    return 'auto';
};

/** Last resolved 'auto' classification, cached so the next launch can apply the
 *  right root class / initial state on first paint, before the async hardware
 *  query returns. Stored as JSON of the full PerformanceClassification. */
const AUTO_CACHE_KEY = 'natively_performanceModeAutoClassification';

/** Validated read of the cached classification. Returns null on ANY problem
 *  (missing, unparsable, wrong shape, storage unavailable) — callers treat null
 *  as "unknown", which fails safe to full visual fidelity. */
const readCachedAutoClassification = (): PerformanceClassification | null => {
    try {
        const raw = localStorage.getItem(AUTO_CACHE_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const c = parsed as Record<string, unknown>;
        if (typeof c.autoPerformanceMode !== 'boolean') return null;
        if (c.reason !== null && typeof c.reason !== 'string') return null;
        if (typeof c.summary !== 'string') return null;
        return { autoPerformanceMode: c.autoPerformanceMode, reason: c.reason as string | null, summary: c.summary };
    } catch {
        return null;
    }
};

/** Best-effort write — a failure just means the next launch starts uncached. */
const writeCachedAutoClassification = (c: PerformanceClassification): void => {
    try {
        localStorage.setItem(AUTO_CACHE_KEY, JSON.stringify(c));
    } catch {
        // localStorage unavailable — ignore
    }
};

/** SYNC, first-paint-safe resolution used by main.tsx: explicit preference wins,
 *  'auto' uses the cached result of the previous launch's hardware check (false on
 *  the very first launch — the hook corrects it as soon as the check resolves). */
export function resolveCachedPerformanceMode(): boolean {
    const preference = readStoredPreference();
    if (preference === 'on') return true;
    if (preference === 'off') return false;
    return readCachedAutoClassification()?.autoPerformanceMode ?? false;
}

/** ONE-SHOT async resolution for non-React callers (e.g. analytics init). Same
 *  precedence as the hook: explicit preference, else the main-process hardware check. */
export async function resolvePerformanceMode(): Promise<boolean> {
    const preference = readStoredPreference();
    if (preference === 'on') return true;
    if (preference === 'off') return false;
    try {
        const status: any = await window.electronAPI?.getGpuPerformanceStatus?.();
        return !!(status?.autoClassification?.autoPerformanceMode ?? status?.isLowPowerGpu);
    } catch {
        return false; // fail safe: full behaviour
    }
}

export function usePerformanceMode() {
    const [preference, setPreferenceState] = useState<PerformanceModePreference>(readStoredPreference);
    // Result of the one-time hardware capability check, only consulted when
    // preference === 'auto'. `null` while the check is in flight — during
    // that brief window we default to full fidelity (see isPerformanceMode
    // below) rather than flashing the reduced UI on and off.
    const [autoClassification, setAutoClassification] = useState<PerformanceClassification | null>(readCachedAutoClassification);

    // Keep every instance in the SAME window in sync: changing the mode in
    // Settings → General must flip the floating dock (and vice versa) without
    // a remount, because both render simultaneously during a call.
    useEffect(() => {
        const onLocalChange = (e: Event) => {
            const next = (e as CustomEvent<PerformanceModePreference>).detail;
            if (next === 'on' || next === 'off' || next === 'auto') setPreferenceState(next);
        };
        // Cross-window (e.g. Settings is its own window in some layouts):
        // the native storage event fires in every OTHER document.
        const onStorageChange = (e: StorageEvent) => {
            if (e.key !== STORAGE_KEY) return;
            const next = readStoredPreference();
            setPreferenceState(next);
        };
        window.addEventListener(PERF_MODE_CHANGE_EVENT, onLocalChange);
        window.addEventListener('storage', onStorageChange);
        return () => {
            window.removeEventListener(PERF_MODE_CHANGE_EVENT, onLocalChange);
            window.removeEventListener('storage', onStorageChange);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        window.electronAPI?.getGpuPerformanceStatus?.()
            .then((status: any) => {
                if (cancelled) return;
                // New payload carries the full classification (reason included);
                // fall back to the legacy boolean if an older main process
                // somehow answered without it.
                const classification: PerformanceClassification = status?.autoClassification ?? {
                    autoPerformanceMode: !!status?.isLowPowerGpu,
                    reason: status?.isLowPowerGpu ? 'Chromium software rendering fallback' : null,
                    summary: '',
                };
                setAutoClassification(classification);
                writeCachedAutoClassification(classification);
                if (classification.autoPerformanceMode) {
                    console.info(`Performance Mode auto: on — ${classification.reason} (${classification.summary})`);
                }
            })
            .catch(() => {
                // fail safe: full fidelity, and record the OFF decision so
                // 'auto' resolves instead of flickering
                if (!cancelled) setAutoClassification({ autoPerformanceMode: false, reason: null, summary: '' });
            });
        return () => { cancelled = true; };
    }, []);

    // Mirror the effective preference into the main process (initial value and every
    // change) so main-process background work honours it. Fire-and-forget; main
    // ignores unchanged values.
    useEffect(() => {
        window.electronAPI?.setPerformanceModePreference?.(preference)?.catch?.(() => { });
    }, [preference]);

    const setPreference = (next: PerformanceModePreference) => {
        setPreferenceState(next);
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // ignore — preference just won't persist across restarts
        }
        // Tell the other instances in this window (dock ⇄ settings ⇄ gate).
        window.dispatchEvent(new CustomEvent(PERF_MODE_CHANGE_EVENT, { detail: next }));
    };

    const isPerformanceMode =
        preference === 'on' ? true :
            preference === 'off' ? false :
                autoClassification?.autoPerformanceMode ?? false; // 'auto': off until the check resolves

    return {
        isPerformanceMode,
        preference,
        setPreference,
        /** Why 'auto' resolved the way it did (null while the check is in
         *  flight or when auto is OFF). Useful for the settings UI and
         *  telemetry; never overrides the explicit user choice. */
        autoReason: autoClassification?.reason ?? null,
    };
}

export default usePerformanceMode;