// usePerformanceMode.ts
//
// Decides whether the floating dock should run in "Performance Mode" — a
// reduced-visual-fidelity mode that drops the (expensive) backdrop-filter
// blur used across the dock, DockButton, and the three overlay panels down
// to a flat, solid background.
//
// WHY THIS EXISTS: backdrop-filter blur is one of the most GPU-intensive CSS
// effects available — it re-samples everything behind an element on every
// composite. The floating dock stacks several independently-blurred, mostly
// always-mounted layers (the pill, up to 3 panels, every dock button) on top
// of a transparent, frameless, always-on-top window. On a discrete GPU this
// is invisible; on a lot of mid-range/integrated-GPU laptops — where Chromium
// itself has decided to fall back to SOFTWARE compositing/rasterization
// (see electron/ipcHandlers.ts: get-gpu-performance-status, backed by
// app.getGPUFeatureStatus()) — the same effect becomes CPU-bound and is a
// primary source of the lag/hangs users report.
//
// Modes:
//   - 'auto' (default): ask the main process once at startup whether this
//     machine's GPU compositing/rasterization is running in software
//     fallback, and enable Performance Mode automatically if so.
//   - 'on' / 'off': explicit user override (persisted), always wins over
//     the auto GPU check.
//
// Safe-by-default: if the GPU query fails or is unavailable for any reason,
// we do NOT assume the worst — we fall back to full visual fidelity (current
// behavior) rather than silently degrading everyone's UI.

import { useEffect, useState } from 'react';

export type PerformanceModePreference = 'auto' | 'on' | 'off';

const STORAGE_KEY = 'natively_performanceModePreference';

const readStoredPreference = (): PerformanceModePreference => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'on' || stored === 'off' || stored === 'auto') return stored;
    } catch {
        // localStorage unavailable (e.g. private mode edge cases) — fall through
    }
    return 'auto';
};

export function usePerformanceMode() {
    const [preference, setPreferenceState] = useState<PerformanceModePreference>(readStoredPreference);
    // Result of the one-time GPU capability check, only consulted when
    // preference === 'auto'. `null` while the check is in flight — during
    // that brief window we default to full fidelity (see isPerformanceMode
    // below) rather than flashing the reduced UI on and off.
    const [isLowPowerGpu, setIsLowPowerGpu] = useState<boolean | null>(null);

    useEffect(() => {
        let cancelled = false;
        window.electronAPI?.getGpuPerformanceStatus?.()
            .then((status) => {
                if (!cancelled) setIsLowPowerGpu(status?.isLowPowerGpu ?? false);
            })
            .catch(() => {
                if (!cancelled) setIsLowPowerGpu(false); // fail safe: full fidelity
            });
        return () => { cancelled = true; };
    }, []);

    const setPreference = (next: PerformanceModePreference) => {
        setPreferenceState(next);
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // ignore — preference just won't persist across restarts
        }
    };

    const isPerformanceMode =
        preference === 'on' ? true :
            preference === 'off' ? false :
                !!isLowPowerGpu; // 'auto': off until the GPU check resolves, then follows it

    return { isPerformanceMode, preference, setPreference };
}

export default usePerformanceMode;