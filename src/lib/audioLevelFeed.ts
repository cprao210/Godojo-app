// Live mic + system-audio levels, published OUTSIDE React.
//
// Same source and same numbers as useLiveAudioLevels — the difference is where
// they land. That hook stores levels in component state, and its own COST NOTE
// spells out the consequence: the values live in FloatingDock state, so every
// publish re-renders the whole dock tree. While anyone is speaking the level
// changes on nearly every event, so the entire overlay (both panels, six dock
// buttons, LiveAnalysisContent, framer-motion's layout projection) reconciled
// up to ~40x a second for most of a call — to move eight bars in one leaf.
//
// The only consumer of the levels is AudioWaveIndicator, which is already
// fully ref/rAF-driven and never renders while animating. So the levels don't
// need to be React state at all: this module owns one IPC subscription per
// renderer and hands the numbers straight to that rAF loop.
//
// useLiveAudioLevels is deliberately left untouched — useAudioStatusTray still
// uses it (it needs micActive/systemActive as reactive state for the launcher
// tray, which is a different problem from driving an animation).

const IDLE_DECAY_MS = 400;
const LEVEL_STEPS = 128;

// Same quantization as the hook, so the meter sees bit-identical values.
const quantize = (v: number): number => {
    if (!Number.isFinite(v)) return 0;
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
    return Math.round(clamped * LEVEL_STEPS) / LEVEL_STEPS;
};

let micLevel = 0;
let systemLevel = 0;
let lastMicAt = 0;
let lastSystemAt = 0;

let refCount = 0;
let unsubscribeIpc: (() => void) | null = null;

// Callbacks that restart a parked animation loop. A rAF consumer parks itself
// when everything is at zero, and with no React render in the chain there is
// nothing else to wake it when audio resumes.
const wakeCallbacks = new Set<() => void>();

function handleLevel(payload: { channel: 'mic' | 'system'; level: number }): void {
    const next = quantize(payload.level);
    const now = Date.now();
    if (payload.channel === 'mic') {
        lastMicAt = now;
        micLevel = next;
    } else {
        lastSystemAt = now;
        systemLevel = next;
    }
    if (next > 0) {
        for (const cb of wakeCallbacks) cb();
    }
}

/**
 * Subscribe to the IPC feed for as long as the returned release function is
 * unused. Ref-counted so several consumers share one subscription and the last
 * one out tears it down.
 */
export function retainAudioLevelFeed(): () => void {
    refCount += 1;
    if (refCount === 1) {
        unsubscribeIpc = window.electronAPI?.onAudioLevel?.(handleLevel) ?? null;
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        refCount -= 1;
        if (refCount > 0) return;
        unsubscribeIpc?.();
        unsubscribeIpc = null;
        micLevel = 0;
        systemLevel = 0;
        lastMicAt = 0;
        lastSystemAt = 0;
    };
}

/** Called when a non-zero level arrives. Returns an unsubscribe function. */
export function subscribeAudioLevelWake(cb: () => void): () => void {
    wakeCallbacks.add(cb);
    return () => {
        wakeCallbacks.delete(cb);
    };
}

// Decay is applied at read time rather than on a sweep timer: the consumer is
// already a frame loop, so it asks often enough that a timer would be pure
// overhead. Same IDLE_DECAY_MS window as the hook — "silence" and "no events"
// both read as 0 shortly after the last chunk.
//
// Both accessors are guaranteed to return a quantized 0–1 value, so callers
// don't need to clamp.

export function readMicLevel(): number {
    return Date.now() - lastMicAt > IDLE_DECAY_MS ? 0 : micLevel;
}

export function readSystemLevel(): number {
    return Date.now() - lastSystemAt > IDLE_DECAY_MS ? 0 : systemLevel;
}
