/**
 * meetingGeneration.ts
 *
 * Renderer-side mirror of main's meeting generation — "which call are we on".
 *
 * The overlay window is created once at startup and only hidden/shown per
 * meeting (see App.tsx), so every hook inside it (useFloatingDock →
 * useLiveAnalysis, useObjectionWatch, …) mounts ONCE and survives every call.
 * That makes "which meeting does this async result belong to?" a genuine
 * question: a live-analysis run started in meeting A can resolve while meeting
 * B is live, in the same hook instance, with the same refs.
 *
 * Main answers it with a counter bumped on every startMeeting. This module
 * keeps the renderer's copy of it so any async operation can stamp its result
 * with the generation it was computed for. Module scope (rather than a hook or
 * context) is deliberate: it is genuinely one value per window, and it has to
 * be readable from inside async callbacks that have no access to React state.
 */

let currentGeneration = 0;
let subscribed = false;

/**
 * Subscribe to `session-reset` and bootstrap from main. Idempotent, lazy, and
 * safe to call when there is no `window.electronAPI` (unit tests, web build).
 */
function ensureSubscribed(): void {
    if (subscribed) return;
    if (typeof window === 'undefined' || !window.electronAPI) return;
    subscribed = true;

    // Authoritative signal: fires on every meeting start, before any analysis
    // for that meeting can run.
    window.electronAPI.onSessionReset?.((payload) => {
        if (typeof payload?.meetingGeneration === 'number') {
            currentGeneration = payload.meetingGeneration;
        }
    });

    // Safety net for a renderer that (re)loaded mid-meeting and so missed the
    // session-reset for the call already in progress.
    window.electronAPI.getMeetingGeneration?.()
        .then((res) => {
            if (res?.success && typeof res.data === 'number') {
                // Never move backwards — a session-reset may have landed first.
                currentGeneration = Math.max(currentGeneration, res.data);
            }
        })
        .catch(() => { /* non-fatal: an untagged write is treated as current */ });
}

/** The generation to stamp on results computed right now. */
export function getMeetingGeneration(): number {
    ensureSubscribed();
    return currentGeneration;
}

/** Test seam — also used by the session-reset handlers that already have the payload. */
export function setMeetingGeneration(generation: number): void {
    currentGeneration = generation;
}
