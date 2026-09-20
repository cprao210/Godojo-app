// Splash policy — WHEN the full-screen startup splash may play.
//
// The splash is only for two moments:
//   1. a fresh page load of the launcher window (app start / hard refresh), and
//   2. a sign-in (handled in App.tsx by re-arming after sign-out).
//
// An account switch also ends in a window reload, which would otherwise look
// exactly like a hard refresh. The switch flow calls markSkipSplashOnNextLoad()
// right before reloading, and the next page load reads + clears the marker
// here so it goes straight to the app behind the plain loader instead.
//
// sessionStorage survives webContents.reload*() but is per-window, so only the
// window that initiated the switch is affected. The timestamp guards against a
// stale marker (e.g. the reload never happened) silently skipping the splash on
// some later refresh.

const KEY = 'gd_skip_splash_once';
const MAX_AGE_MS = 15_000;

/** Call immediately before reloading the window for an account switch. */
export function markSkipSplashOnNextLoad(): void {
    try {
        sessionStorage.setItem(KEY, String(Date.now()));
    } catch { /* storage unavailable — worst case the splash plays */ }
}

/**
 * Evaluated exactly once per page load (module scope, NOT inside a component:
 * React StrictMode double-invokes initializers, which would consume the marker
 * on the first call and report false on the second).
 */
export const skipSplashThisLoad: boolean = (() => {
    try {
        const raw = sessionStorage.getItem(KEY);
        sessionStorage.removeItem(KEY);
        if (!raw) return false;
        return Date.now() - Number(raw) < MAX_AGE_MS;
    } catch {
        return false;
    }
})();