// Live mic + system-audio levels (0–1) for the floating dock's wave
// indicator. Purely visual confirmation that a channel is actually receiving
// samples right now — separate from isClientSpeaking/isUserSpeaking (which
// are STT-partial-driven and can lag or stay quiet on a provider hiccup while
// the underlying capture is perfectly healthy).
//
// The main process throttles + pushes 'audio-level' events only while a
// capture is alive; if a channel goes idle (meeting paused, device unplugged,
// capture crashed) no further events arrive. We treat "silence" the same as
// "no event" by decaying the level to 0 after a short window rather than
// waiting on an explicit stop signal — cheap, and self-heals if a stop event
// is ever missed.
//
// COST NOTE: these two values live in FloatingDock state, so every publish
// re-renders the whole dock tree. Both channels emit ~10 keepalive chunks a
// second even in silence, which used to mean ~20 no-op re-renders a second for
// the entire meeting. Levels are therefore quantized and identical values are
// dropped (React bails out when a setState returns the previous value), so a
// silent call publishes nothing at all. The idle decay is a single shared
// interval rather than two timers re-armed on every chunk.

import { useEffect, useRef, useState } from 'react';

const IDLE_DECAY_MS = 400;

// How long after the last event a channel still counts as STREAMING. Distinct
// from the level decay above: a healthy capture emits ~10 keepalive chunks a
// second even in total silence, so "no events" means the capture stopped, not
// that the room went quiet. Generous enough to ride out a scheduling hiccup,
// short enough that an unplugged device reads as dead within a beat.
const ACTIVE_TIMEOUT_MS = 1200;

// Quantization step for published levels. Finer than the meter can render, so
// it is visually lossless, but it collapses the long runs of identical values a
// gated channel produces.
const LEVEL_STEPS = 128;

// Resolution of the idle-decay sweep. Effective zeroing lands somewhere in
// [IDLE_DECAY_MS, IDLE_DECAY_MS + IDLE_SWEEP_MS); this is a visual failsafe, so
// that slack is fine and one timer beats ~40 clear/set pairs a second.
const IDLE_SWEEP_MS = 200;

const quantize = (v: number): number => {
    if (!Number.isFinite(v)) return 0;
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
    return Math.round(clamped * LEVEL_STEPS) / LEVEL_STEPS;
};

export interface LiveAudioLevels {
    /** 0–1 built-in/external microphone input level ("You"). */
    micLevel: number;
    /** 0–1 system-audio output level ("Client" / other party, incl. any connected external playback device). */
    systemLevel: number;
    /**
     * Mic samples are arriving right now — true through silence, false once the
     * capture stops. Flips only on transitions, so it costs no extra renders
     * during a call.
     */
    micActive: boolean;
    /** As `micActive`, for the system-audio channel. */
    systemActive: boolean;
}

export function useLiveAudioLevels(enabled: boolean): LiveAudioLevels {
    const [micLevel, setMicLevel] = useState(0);
    const [systemLevel, setSystemLevel] = useState(0);
    const [micActive, setMicActive] = useState(false);
    const [systemActive, setSystemActive] = useState(false);
    const lastMicAt = useRef(0);
    const lastSystemAt = useRef(0);

    useEffect(() => {
        if (!enabled) {
            setMicLevel(0);
            setSystemLevel(0);
            setMicActive(false);
            setSystemActive(false);
            return;
        }

        const unsubscribe = window.electronAPI?.onAudioLevel?.(({ channel, level }) => {
            const next = quantize(level);
            if (channel === 'mic') {
                lastMicAt.current = Date.now();
                // React bails out on an identical value, so this is free after
                // the first chunk of a call.
                setMicActive(true);
                setMicLevel((prev) => (prev === next ? prev : next));
            } else {
                lastSystemAt.current = Date.now();
                setSystemActive(true);
                setSystemLevel((prev) => (prev === next ? prev : next));
            }
        });

        const sweep = setInterval(() => {
            const now = Date.now();
            if (now - lastMicAt.current > IDLE_DECAY_MS) setMicLevel((prev) => (prev === 0 ? prev : 0));
            if (now - lastSystemAt.current > IDLE_DECAY_MS) setSystemLevel((prev) => (prev === 0 ? prev : 0));
            if (now - lastMicAt.current > ACTIVE_TIMEOUT_MS) setMicActive((prev) => (prev ? false : prev));
            if (now - lastSystemAt.current > ACTIVE_TIMEOUT_MS) setSystemActive((prev) => (prev ? false : prev));
        }, IDLE_SWEEP_MS);

        return () => {
            unsubscribe?.();
            clearInterval(sweep);
            setMicLevel(0);
            setSystemLevel(0);
            setMicActive(false);
            setSystemActive(false);
        };
    }, [enabled]);

    return { micLevel, systemLevel, micActive, systemActive };
}