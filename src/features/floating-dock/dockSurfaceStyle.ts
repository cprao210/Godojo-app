// dockSurfaceStyle.ts
//
// Shared "frosted glass" background used by the nav dock pill and all three
// overlay panels. Centralized so Performance Mode (see usePerformanceMode.ts)
// only has to be reasoned about in one place.
//
// backdrop-filter blur is one of the most GPU-expensive CSS effects there
// is, and this app stacks several independent blurred layers, most of them
// mounted for the whole meeting. On machines where Chromium has fallen back
// to software compositing (common on older/weaker integrated GPUs), that
// cost becomes CPU-bound and is a primary source of lag/hangs. When
// Performance Mode is on, we drop the blur entirely and fall back to a
// slightly more opaque flat color, which reads as visually similar (frosted
// glass vs. a solid dark panel) at a fraction of the render cost.
import type { CSSProperties } from 'react';

interface DockSurfaceStyleOptions {
    /** Shared dock opacity from the appearance slider (0-1). */
    opacity: number;
    /** RGB triplet e.g. "18, 22, 34" — kept separate from alpha so callers can vary the base color. */
    rgb: string;
    /** Blur radius in px to use when NOT in performance mode. */
    blurPx: number;
    /** CSS saturate() percentage to pair with the blur, e.g. 180 for "saturate(180%)". */
    saturatePct?: number;
    isPerformanceMode: boolean;
}

/**
 * Returns the `background`/`backdropFilter`/`WebkitBackdropFilter` trio for
 * a dock surface, adapting to Performance Mode.
 */
export function getDockSurfaceStyle({
    opacity,
    rgb,
    blurPx,
    saturatePct = 180,
    isPerformanceMode,
}: DockSurfaceStyleOptions): Pick<CSSProperties, 'background' | 'backdropFilter' | 'WebkitBackdropFilter'> {
    if (isPerformanceMode) {
        // No blur: compensate with a touch more opacity so the surface still
        // reads clearly against whatever's behind it (a meeting app, a
        // browser, the desktop) without needing to sample it every frame.
        const boostedOpacity = Math.min(1, opacity + 0.08);
        return {
            background: `rgba(${rgb}, ${boostedOpacity})`,
            backdropFilter: 'none',
            WebkitBackdropFilter: 'none',
        };
    }

    return {
        background: `rgba(${rgb}, ${opacity})`,
        backdropFilter: `blur(${blurPx}px) saturate(${saturatePct}%)`,
        WebkitBackdropFilter: `blur(${blurPx}px) saturate(${saturatePct}%)`,
    };
}