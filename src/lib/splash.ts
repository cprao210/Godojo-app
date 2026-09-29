// Splash policy — WHEN the full-screen startup splash may play.
//
// The splash is only for two moments:
//   1. a fresh page load of the launcher window (app start / hard refresh), and
//   2. a sign-in (handled in App.tsx by re-arming after sign-out).
//
// Some other flows also end in a window reload, which would otherwise look
// exactly like a hard refresh: an account switch, creating a team, and
// accepting a team invitation. Each of those flows calls
// markSkipSplashOnNextLoad() right before reloading, and the next page load
// reads + clears the marker here so it goes straight to the app behind the
// plain <BirdLoader /> ("draw" loader) instead of replaying the full startup
// splash.
//
// sessionStorage survives webContents.reload*() but is per-window, so only the
// window that initiated the reload is affected. The timestamp guards against a
// stale marker (e.g. the reload never happened) silently skipping the splash on
// some later refresh.

const KEY = 'gd_skip_splash_once';
const MAX_AGE_MS = 15_000;

const DEFAULT_LABEL = 'Loading…';

interface SkipSplashMarker {
    t: number;
    /** Caption shown under the plain loader while this reload settles. */
    label: string;
}

/**
 * Call immediately before reloading the window for a flow that shouldn't
 * replay the full startup splash (account switch, team creation, accepting
 * an invitation, …). `label` is shown under the <BirdLoader /> on the next
 * load, e.g. "Switching account…" / "Setting up your team…".
 */
export function markSkipSplashOnNextLoad(label: string = DEFAULT_LABEL): void {
    try {
        const marker: SkipSplashMarker = { t: Date.now(), label };
        sessionStorage.setItem(KEY, JSON.stringify(marker));
    } catch { /* storage unavailable — worst case the splash plays */ }
}

function readMarker(): SkipSplashMarker | null {
    try {
        const raw = sessionStorage.getItem(KEY);
        sessionStorage.removeItem(KEY);
        if (!raw) return null;
        // Back-compat: older markers were a bare timestamp string, no label.
        const parsed: unknown = /^\d+$/.test(raw) ? { t: Number(raw), label: DEFAULT_LABEL } : JSON.parse(raw);
        const marker = parsed as SkipSplashMarker;
        if (!marker || typeof marker.t !== 'number') return null;
        if (Date.now() - marker.t >= MAX_AGE_MS) return null;
        return marker;
    } catch {
        return null;
    }
}

/**
 * Evaluated exactly once per page load (module scope, NOT inside a component:
 * React StrictMode double-invokes initializers, which would consume the marker
 * on the first call and report false on the second).
 */
const skipSplashMarker: SkipSplashMarker | null = readMarker();

export const skipSplashThisLoad: boolean = skipSplashMarker !== null;

/** Caption to show under the plain loader when skipSplashThisLoad is true. */
export const skipSplashLabel: string = skipSplashMarker?.label ?? DEFAULT_LABEL;