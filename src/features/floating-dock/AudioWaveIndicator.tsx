/**
 * AudioWaveIndicator.tsx
 *
 * Single "equalizer" style wave representing BOTH audio channels in the call.
 *
 *   - blue (sky)     → "You" — mic input is the dominant signal.
 *   - orange (amber) → "Client" — system audio (other party) is dominant.
 *
 * Idle: three soft breathing dots (reads as "listening", not "dead").
 * Active: a center-anchored, symmetric equalizer with per-bar gradient, an
 * audio-reactive glow, and a dominant-speaker aura behind it. Color eases
 * between blue/orange as dominance shifts (with hysteresis) so cross-talk
 * doesn't strobe.
 *
 * ── Why each channel is normalized separately ─────────────────────────────
 * Both levels come from computeAudioRmsLevel() in the main process, which maps
 * RMS→0..1 through one fixed divisor (rms / 10000). That divisor suits loopback
 * system audio — a conferencing app's already-AGC'd output, RMS commonly
 * 3000–10000, so 0.3–1.0 of the meter. A raw mic capture at arm's length,
 * post-AEC, sits an order of magnitude lower (RMS 300–2000 → 0.03–0.2), which
 * is under every bar threshold except the center one. Untreated, "You" showed a
 * single twitching center bar while "Client" swept the full equalizer — and
 * because the meter takes max(mic, system), a quiet voice was hidden outright
 * whenever the far end was loud. Each channel now gets its own gain, a shared
 * noise-floor subtraction and a mild expansion curve, so an ordinary speaking
 * voice fills the meter the same way on both sides.
 *
 * ── Ballistics ───────────────────────────────────────────────────────────
 * The mic is VAD- and echo-gated far harder than system audio (native
 * suppressor threshold 100 / hangover 150ms vs 30 / 300ms), so it emits
 * all-zero keepalive chunks between syllables. A peak-hold with linear decay
 * bridges those gaps; an asymmetric one-pole (fast attack, slow release) does
 * the final smoothing — instant on speech, gliding down instead of chattering.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────
 * This is a 16px widget that runs for the whole meeting, so it must not cost
 * anything measurable. The loop writes styles straight to the DOM through refs
 * (React re-renders zero times while animating), is capped at 30fps — 15 in
 * Performance Mode — quantizes color and glow so the expensive strings and the
 * `filter` are rebuilt a few times a second rather than 60 times, parks itself
 * completely when both channels are idle or the window is hidden, and drops to
 * static bars under `prefers-reduced-motion`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

interface AudioWaveIndicatorProps {
    /** 0–1 live microphone level ("You"). */
    micLevel: number;
    /** 0–1 live system-audio level ("Client" / other party). */
    systemLevel: number;
    /** Color when mic is dominant, e.g. 'rgb(56, 189, 248)' (sky-400). */
    micColor?: string;
    /** Color when system audio is dominant, e.g. 'rgb(251, 146, 60)' (orange-400). */
    systemColor?: string;
    size?: 'sm' | 'md';
    /**
     * Gain applied to `micLevel` before shaping. Default lifts a raw mic
     * capture onto the same visual scale as AGC'd system audio — see the
     * normalization note in the file header. Tune here if a particular
     * headset reads consistently hot or cold.
     */
    micGain?: number;
    /** Gain applied to `systemLevel` before shaping. */
    systemGain?: number;
    /**
     * Project-wide reduced-fidelity mode (see `usePerformanceMode`): drops the
     * per-frame `filter` glow and halves the frame rate. Passed down by
     * FloatingDock exactly like every other dock surface.
     */
    isPerformanceMode?: boolean;
}

// Symmetric equalizer: thresholds mirror around the center bar, so the wave
// fills progressively outward from the middle. Center bar wakes first.
// Exported for the level-mapping test — the whole point of the per-channel gain
// is that BOTH channels reach the outer thresholds at ordinary speech volume.
export const BAR_THRESHOLDS = [0.42, 0.18, 0.03, 0.18, 0.42];

// Asymmetric one-pole smoothing (ms). Attack fast, release slow.
const ATTACK_TAU_MS = 35;
const RELEASE_TAU_MS = 320;

// Peak-hold decay — full scale to zero in ~900ms. This is what bridges the
// all-zero keepalive chunks a gated mic emits between syllables; without it the
// meter collapses and re-attacks on every word.
const PEAK_DECAY_PER_MS = 1 / 900;

// Subtracted after gain, before shaping, so room tone and a gated-but-not-quite
// silent channel stay at idle instead of being expanded into a visible wave.
// Sized so a laptop array in a quiet-ish room (RMS ~60) lands flat at 0 rather
// than hovering at ACTIVE_LEVEL and flickering the meter awake between words.
const NOISE_FLOOR = 0.015;

// Expansion exponent (<1 lifts the low end). Note this lifts BOTH channels'
// mid-range — the client side reads a little fuller than it used to (RMS 1500:
// 0.15 → 0.28) while both ends of its range are unchanged, which is why the
// system gain below stays at 1.
const LEVEL_EXPONENT = 0.65;

// Default per-channel gains. The mic needs the boost because
// computeAudioRmsLevel()'s /10000 divisor is calibrated for AGC'd loopback.
// 2.2 is deliberately below the ~3x that maps a laptop array's normal speech to
// full scale: a headset boom mic runs 2–3x hotter than an array, and at 3x it
// would sit pegged at ~0.97 through every sentence, hiding all the dynamics in
// the top 3% of the meter. At 2.2 an array's normal speech lights the outer bars
// (0.48) and a headset's still has headroom (0.76).
export const DEFAULT_MIC_GAIN = 2.2;
export const DEFAULT_SYSTEM_GAIN = 1;

// Keep whichever channel was dominant while levels are within this margin.
const DOMINANCE_HYSTERESIS = 0.06;

// Level above which the bars replace the idle dots.
const ACTIVE_LEVEL = 0.03;

// Frame budget. A 16px level meter is indistinguishable at 30fps from 60, and
// Performance Mode (software compositing) halves it again.
const FRAME_MS = 1000 / 30;
const FRAME_MS_PERF = 1000 / 15;
const FRAME_MS_REDUCED = 100;

// Ignore absurd deltas after a tab stall / resume so the meter eases in rather
// than snapping through a full attack-release in one frame.
const MAX_DT_MS = 250;

// Park the loop once both channels have been idle this long. The idle dots are
// pure CSS keyframes, so a parked loop still looks alive at zero JS cost.
const IDLE_PARK_MS = 600;

// Color and glow are rebuilt only when their quantized bucket changes, which
// turns ~600 regex-parsed string builds per second into a handful.
const COLOR_STEPS = 24;
const GLOW_STEPS = 8;

type Rgb = [number, number, number];

// Inject keyframes once, lazily, so the component stays self-contained.
let waveStyleInjected = false;

function ensureKeyframes() {
    if (waveStyleInjected || typeof document === 'undefined') return;
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-audio-wave-indicator', '');
    styleEl.textContent = `
        @keyframes audio-wave-idle-breathe {
            0%, 100% { transform: scale(0.85); opacity: 0.35; }
            50%      { transform: scale(1);    opacity: 0.65; }
        }
    `;
    document.head.appendChild(styleEl);
    waveStyleInjected = true;
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/** Raw RMS level → meter position, per-channel gain + noise floor + expansion. */
export function shapeLevel(raw: number, gain: number): number {
    const scaled = raw * gain - NOISE_FLOOR;
    // NaN fails every comparison below and would reach the DOM as
    // `scaleY(NaN)`, which Chromium drops silently — leaving a bar frozen at
    // whatever it last was. Reject it here rather than trusting every caller.
    if (Number.isNaN(scaled) || scaled <= 0) return 0;
    const norm = scaled / (1 - NOISE_FLOOR);
    return norm >= 1 ? 1 : Math.pow(norm, LEVEL_EXPONENT);
}

/** Asymmetric one-pole: fast attack, slow release, snaps when close enough. */
function smooth(current: number, target: number, dt: number): number {
    const tau = target > current ? ATTACK_TAU_MS : RELEASE_TAU_MS;
    const next = current + (target - current) * (1 - Math.exp(-dt / tau));
    return Math.abs(next - target) < 0.001 ? target : next;
}

function parseRgb(c: string): Rgb {
    const parts = c.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
    return [parts[0] ?? 255, parts[1] ?? 255, parts[2] ?? 255];
}

/** Linear interpolation between two parsed colors. `t` = 0 → a, 1 → b. */
function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
    const c = clamp01(t);
    return [
        Math.round(a[0] + (b[0] - a[0]) * c),
        Math.round(a[1] + (b[1] - a[1]) * c),
        Math.round(a[2] + (b[2] - a[2]) * c),
    ];
}

function rgba(c: Rgb, alpha: number): string {
    return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${clamp01(alpha).toFixed(3)})`;
}

/**
 * Honour the OS "reduce motion" setting. A live level meter is informational,
 * so it keeps reflecting audio — but the looping idle breathe and the swelling
 * aura are decorative motion and get switched off.
 */
function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(
        () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    );

    useEffect(() => {
        const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (!mq) return;
        const onChange = () => setReduced(mq.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);

    return reduced;
}

export const AudioWaveIndicator: React.FC<AudioWaveIndicatorProps> = ({
    micLevel,
    systemLevel,
    micColor = 'rgb(56, 189, 248)', // sky-400 — "You"
    systemColor = 'rgb(251, 146, 60)', // orange-400 — "Client"
    size = 'sm',
    micGain = DEFAULT_MIC_GAIN,
    systemGain = DEFAULT_SYSTEM_GAIN,
    isPerformanceMode = false,
}) => {
    const reducedMotion = usePrefersReducedMotion();
    const micRgb = useMemo(() => parseRgb(micColor), [micColor]);
    const systemRgb = useMemo(() => parseRgb(systemColor), [systemColor]);

    const barWidth = size === 'sm' ? 3 : 4;
    const gap = size === 'sm' ? 3 : 4;
    const maxHeight = size === 'sm' ? 16 : 20;
    const dotSize = size === 'sm' ? 4 : 5;
    const dotGap = size === 'sm' ? 3 : 4;
    const minScale = dotSize / maxHeight;

    // Container sized to whichever state is wider.
    const barsWidth = BAR_THRESHOLDS.length * barWidth + (BAR_THRESHOLDS.length - 1) * gap;
    const dotsWidth = 3 * dotSize + 2 * dotGap;
    const containerWidth = Math.max(barsWidth, dotsWidth);

    const rootRef = useRef<HTMLDivElement | null>(null);
    const auraRef = useRef<HTMLDivElement | null>(null);
    const idleRef = useRef<HTMLDivElement | null>(null);
    const barsRef = useRef<HTMLDivElement | null>(null);
    const barEls = useRef<Array<HTMLSpanElement | null>>([]);
    const dotEls = useRef<Array<HTMLSpanElement | null>>([]);

    // Stable ref setters: inline arrows would make React detach and reattach all
    // eight nodes on every level update, which here is every ~50ms.
    const setBarEl = useMemo(
        () => BAR_THRESHOLDS.map((_, i) => (el: HTMLSpanElement | null) => { barEls.current[i] = el; }),
        []
    );
    const setDotEl = useMemo(
        () => [0, 1, 2].map((i) => (el: HTMLSpanElement | null) => { dotEls.current[i] = el; }),
        []
    );

    // All animation state lives in one ref: the loop mutates it every frame and
    // nothing here is allowed to trigger a React render.
    const anim = useRef({
        micTarget: 0,
        sysTarget: 0,
        micHold: 0,
        sysHold: 0,
        mic: 0,
        sys: 0,
        dominant: 'mic' as 'mic' | 'system',
        mix: 0,
        rgb: [255, 255, 255] as Rgb,
        lastCommit: 0,
        idleSince: 0,
        active: false,
        labelKey: -1,
        colorBucket: -1,
        glowBucket: -1,
        raf: 0,
        parked: true,
    });

    useEffect(() => {
        if (!reducedMotion) ensureKeyframes();
    }, [reducedMotion]);

    // Set by the animation effect so the props effect below can restart a parked
    // loop without owning any of the loop's closures.
    const wake = useRef<() => void>(() => { });

    useEffect(() => {
        const a = anim.current;
        const frameMs = reducedMotion ? FRAME_MS_REDUCED : isPerformanceMode ? FRAME_MS_PERF : FRAME_MS;
        // `filter` invalidates the element's paint, so an audio-reactive glow is
        // the single most expensive thing here. First casualty on a weak GPU.
        const enableGlow = !isPerformanceMode && !reducedMotion;
        const enableAuraSwell = !reducedMotion;

        // Fidelity can be toggled mid-meeting, so retire whatever the previous
        // mode left on the DOM instead of freezing it there, and force the
        // quantized color/glow to re-commit against the new parameters.
        a.colorBucket = -1;
        a.glowBucket = -1;
        if (!enableGlow && barsRef.current) barsRef.current.style.filter = 'none';
        if (!enableAuraSwell && auraRef.current) auraRef.current.style.transform = 'scale(1.6)';

        const commit = (dt: number) => {
            // Peak-hold with linear decay, then the asymmetric one-pole.
            const decay = dt * PEAK_DECAY_PER_MS;
            a.micHold = Math.max(a.micTarget, a.micHold - decay);
            a.sysHold = Math.max(a.sysTarget, a.sysHold - decay);
            a.mic = smooth(a.mic, a.micHold, dt);
            a.sys = smooth(a.sys, a.sysHold, dt);

            // Both channels are already on a common scale, so max() now means
            // "whoever is louder" rather than "whoever is system audio".
            const level = a.mic > a.sys ? a.mic : a.sys;

            const diff = a.mic - a.sys;
            if (diff > DOMINANCE_HYSTERESIS) a.dominant = 'mic';
            else if (diff < -DOMINANCE_HYSTERESIS) a.dominant = 'system';
            const mixTarget = a.dominant === 'mic' ? 0 : 1;
            a.mix += (mixTarget - a.mix) * Math.min(1, dt / 180);

            const active = level > ACTIVE_LEVEL;
            const glow = active ? Math.min(1, level * 1.3) : 0;

            const colorBucket = Math.round(a.mix * COLOR_STEPS);
            if (colorBucket !== a.colorBucket) {
                a.colorBucket = colorBucket;
                a.glowBucket = -1; // re-tint the glow on the next frame
                const rgb = mixRgb(micRgb, systemRgb, colorBucket / COLOR_STEPS);
                a.rgb = rgb;
                const fill = `linear-gradient(to bottom, ${rgba(rgb, 0.95)}, ${rgba(rgb, 0.65)})`;
                for (const el of barEls.current) if (el) el.style.background = fill;
                const dotColor = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
                const dotShadow = `0 0 ${dotSize}px ${rgba(rgb, 0.5)}`;
                for (const el of dotEls.current) {
                    if (!el) continue;
                    el.style.backgroundColor = dotColor;
                    el.style.boxShadow = dotShadow;
                }
                // Alpha is baked in and the swell is driven by `opacity`, so this
                // gradient is rebuilt on color change only — never per frame.
                if (auraRef.current) {
                    auraRef.current.style.background =
                        `radial-gradient(closest-side, ${rgba(rgb, 0.28)}, transparent 75%)`;
                }
            }

            if (enableGlow) {
                const glowBucket = Math.round(glow * GLOW_STEPS);
                if (glowBucket !== a.glowBucket) {
                    a.glowBucket = glowBucket;
                    const g = glowBucket / GLOW_STEPS;
                    if (barsRef.current) {
                        barsRef.current.style.filter = g > 0
                            ? `drop-shadow(0 0 ${(2 + g * 5).toFixed(1)}px ${rgba(a.rgb, 0.55 * g)})`
                            : 'none';
                    }
                }
            }

            if (auraRef.current) {
                auraRef.current.style.opacity = glow.toFixed(3);
                if (enableAuraSwell) {
                    auraRef.current.style.transform = `scale(${(1.6 + glow * 0.6).toFixed(3)})`;
                }
            }

            // Crossfade + a11y text flip rarely, so they stay CSS transitions
            // driven by state changes instead of per-frame writes.
            if (active !== a.active) {
                a.active = active;
                if (idleRef.current) idleRef.current.style.opacity = active ? '0' : '1';
                if (barsRef.current) barsRef.current.style.opacity = active ? '1' : '0';
                // A hidden keyframe still costs a compositor tick every frame on
                // weak GPUs — pause it while the bars are showing.
                const playState = active ? 'paused' : 'running';
                for (const el of dotEls.current) if (el) el.style.animationPlayState = playState;
            }

            const labelKey = active ? (a.mix < 0.5 ? 1 : 2) : 0;
            if (labelKey !== a.labelKey) {
                a.labelKey = labelKey;
                const label = labelKey === 0 ? null : labelKey === 1 ? 'You' : 'Client';
                if (rootRef.current) {
                    rootRef.current.title = `Audio: ${label ? `${label} speaking` : 'no audio detected'}`;
                    rootRef.current.setAttribute(
                        'aria-label',
                        `Call audio level: ${label ? `active — ${label}` : 'idle'}`
                    );
                }
            }

            const bars = barEls.current;
            for (let i = 0; i < BAR_THRESHOLDS.length; i++) {
                const el = bars[i];
                if (!el) continue;
                const threshold = BAR_THRESHOLDS[i];
                const excess = level - threshold;
                if (excess <= 0) {
                    // Must go fully transparent: scaleY is paint-only, so a
                    // collapsed bar still lays out a box whose rounded corners
                    // antialias into a faint hairline.
                    if (el.style.opacity !== '0') {
                        el.style.opacity = '0';
                        el.style.transform = 'scaleY(0)';
                    }
                    continue;
                }
                const headroom = 1 - threshold;
                const intensity = headroom > 0 ? Math.min(1, excess / headroom) : 0;
                const scale = Math.max(minScale, intensity);
                el.style.transform = `scaleY(${scale.toFixed(3)})`;
                el.style.opacity = (0.55 + intensity * 0.45).toFixed(3);
            }
        };

        const park = () => {
            if (a.raf) cancelAnimationFrame(a.raf);
            a.raf = 0;
            a.parked = true;
            a.lastCommit = 0;
            a.idleSince = 0;
        };

        const tick = (now: number) => {
            a.raf = requestAnimationFrame(tick);
            if (!a.lastCommit) {
                a.lastCommit = now;
                return;
            }
            const elapsed = now - a.lastCommit;
            if (elapsed < frameMs) return;
            a.lastCommit = now;
            commit(Math.min(elapsed, MAX_DT_MS));

            // Nothing to animate and nothing incoming — stop burning frames. The
            // props effect wakes us the moment a level arrives.
            if (a.active || a.micTarget > 0 || a.sysTarget > 0 || a.mic > 0 || a.sys > 0) {
                a.idleSince = 0;
                return;
            }
            if (!a.idleSince) a.idleSince = now;
            else if (now - a.idleSince >= IDLE_PARK_MS) park();
        };

        const start = () => {
            if (a.raf || (typeof document !== 'undefined' && document.hidden)) return;
            a.parked = false;
            a.lastCommit = 0;
            a.idleSince = 0;
            a.raf = requestAnimationFrame(tick);
        };

        // An occluded / minimised overlay window still runs rAF in Chromium when
        // it is merely covered, but `hidden` covers minimise and workspace
        // switches — the cheapest possible win for a background meeting.
        const onVisibility = () => {
            if (document.hidden) park();
            else start();
        };

        wake.current = start;
        start();
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            park();
            wake.current = () => { };
        };
    }, [reducedMotion, isPerformanceMode, micRgb, systemRgb, minScale, dotSize]);

    // Props → animation targets. Written in an effect rather than during render
    // so a discarded concurrent render cannot advance the meter, and runs on
    // every render because that is exactly when a new level has arrived.
    useEffect(() => {
        const a = anim.current;
        a.micTarget = shapeLevel(clamp01(micLevel), micGain);
        a.sysTarget = shapeLevel(clamp01(systemLevel), systemGain);
        if (a.parked && (a.micTarget > 0 || a.sysTarget > 0)) wake.current();
    });

    // Rendered once. Initial inline styles ARE the idle state, so there is no
    // first-frame flash before the loop takes over; everything after this is a
    // direct style write from `commit()`.
    return (
        <div
            ref={rootRef}
            className="relative flex items-center justify-center shrink-0 overflow-visible"
            // `contain: layout style` scopes recalc without `paint`, which would
            // clip the aura and the drop-shadow glow.
            style={{ width: containerWidth, height: maxHeight, contain: 'layout style' }}
            title="Audio: no audio detected"
            aria-label="Call audio level: idle"
            role="img"
        >
            {/* Ambient aura — a soft radial tint of the dominant speaker's color
                that swells with level. Gives the meter depth without a hard box.
                Only `opacity`/`transform` change per frame: both composited. */}
            <div
                ref={auraRef}
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{
                    background: `radial-gradient(closest-side, ${rgba(micRgb, 0.28)}, transparent 75%)`,
                    transform: 'scale(1.6)',
                    opacity: 0,
                }}
            />

            {/* Idle state — three soft, slowly breathing glowing dots (staggered),
                reads as "listening and ready" rather than dead/flat. */}
            <div
                ref={idleRef}
                className="absolute inset-0 w-full h-full flex items-center justify-center transition-opacity duration-300 ease-out"
                style={{ gap: dotGap, opacity: 1 }}
            >
                {[0, 1, 2].map((i) => (
                    <span
                        key={i}
                        ref={setDotEl[i]}
                        className="rounded-full"
                        style={{
                            width: dotSize,
                            height: dotSize,
                            backgroundColor: micColor,
                            boxShadow: `0 0 ${dotSize}px ${rgba(micRgb, 0.5)}`,
                            animation: reducedMotion
                                ? undefined
                                : `audio-wave-idle-breathe 2.2s ease-in-out ${i * 0.18}s infinite`,
                        }}
                    />
                ))}
            </div>

            {/* Active state — symmetric, center-anchored gradient bars, scaled
                via transform (GPU-composited) with an audio-reactive drop-shadow
                glow. inset-0 + full size centers reliably across Chromium/WebKit. */}
            <div
                ref={barsRef}
                className="absolute inset-0 w-full h-full flex items-center justify-center transition-opacity duration-300 ease-out"
                style={{ gap, opacity: 0 }}
            >
                {BAR_THRESHOLDS.map((_, i) => (
                    <span
                        key={i}
                        ref={setBarEl[i]}
                        className="rounded-full"
                        style={{
                            width: barWidth,
                            height: maxHeight,
                            // Vertical gradient — brighter top, tinted base — gives
                            // each bar a bit of dimensionality instead of flat fill.
                            background: `linear-gradient(to bottom, ${rgba(micRgb, 0.95)}, ${rgba(micRgb, 0.65)})`,
                            transform: 'scaleY(0)',
                            transformOrigin: 'center',
                            opacity: 0,
                        }}
                    />
                ))}
            </div>
        </div>
    );
};

export default AudioWaveIndicator;
