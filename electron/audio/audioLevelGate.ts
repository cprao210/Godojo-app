/**
 * audioLevelGate.ts
 *
 * Send-gate for the `audio-level` IPC feed.
 *
 * The meter is sampled at 20 Hz per channel for the whole meeting, i.e. ~40
 * `webContents.send` calls a second across two channels and two windows — each
 * one a structured clone, a preload dispatch and a renderer callback. The
 * renderer then quantizes to 1/128 and throws away anything that did not change,
 * so most of that cost bought nothing: during a silent stretch every single
 * message carries a value the renderer already has.
 *
 * Quantizing on this side instead lets main drop those duplicates before they
 * cross the process boundary. A silent call goes from ~20 sends/s/channel to ~2;
 * speech is unaffected, because then the value really does change.
 *
 * The heartbeat is not defensive padding — it is load-bearing. `useLiveAudioLevels`
 * treats *event arrival* as the liveness signal (ACTIVE_TIMEOUT_MS = 1200: "no
 * events means the capture stopped"), and the launcher tray's live dot is driven
 * by that. Without a floor on the send interval, a genuinely silent meeting would
 * look like a dead capture.
 *
 * Kept pure and separate from main.ts so the predicate is unit-testable.
 */

/** Matches LEVEL_STEPS in src/hooks/useLiveAudioLevels.ts — the renderer's own grid. */
export const LEVEL_STEPS = 128;

/** Longest a channel may go without a send. Must stay well under the renderer's
 *  ACTIVE_TIMEOUT_MS (1200 ms) or the tray would flicker on a quiet call. */
export const LEVEL_HEARTBEAT_MS = 500;

/** Snap to the same 1/128 grid the renderer uses, so "unchanged" means the same
 *  thing on both sides of the IPC boundary. */
export const quantizeLevel = (level: number): number => {
    if (!Number.isFinite(level)) return 0;
    const clamped = Math.max(0, Math.min(1, level));
    return Math.round(clamped * LEVEL_STEPS) / LEVEL_STEPS;
};

export interface LevelGateState {
    /** Last quantized value actually sent. -1 = nothing sent yet (not a reachable
     *  quantized level, so the first sample always sends). */
    lastSent: number;
    /** Timestamp of that send. */
    lastSentAt: number;
}

export const createLevelGateState = (): LevelGateState => ({ lastSent: -1, lastSentAt: 0 });

/**
 * Whether this quantized level should cross the IPC boundary.
 *
 * Send when the value changed, or when the heartbeat is due. Pure — the caller
 * commits the new state only if it actually sends, so a suppressed sample does
 * not push the heartbeat deadline out.
 */
export const shouldSendLevel = (
    state: LevelGateState,
    quantized: number,
    now: number,
): boolean => quantized !== state.lastSent || now - state.lastSentAt >= LEVEL_HEARTBEAT_MS;
