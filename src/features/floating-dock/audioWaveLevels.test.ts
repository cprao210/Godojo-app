// Guards the fix for "the client wave animates but the user wave doesn't".
//
// The bug was never in the rendering — both channels drive the same five bars —
// it was that a raw mic capture lands an order of magnitude lower on the meter
// than AGC'd loopback audio, so only the centre bar (threshold 0.03) ever woke
// up for "You". These cases pin the mapping that fixes it: the RMS bands each
// channel actually produces must both reach the outer bars.

import { describe, it, expect } from 'vitest';
import {
    shapeLevel,
    BAR_THRESHOLDS,
    DEFAULT_MIC_GAIN,
    DEFAULT_SYSTEM_GAIN,
} from './AudioWaveIndicator';

// computeAudioRmsLevel() in electron/main.ts is min(rms / 10000, 1).
const rawFromRms = (rms: number) => Math.min(rms / 10000, 1);

const OUTER_BAR = Math.max(...BAR_THRESHOLDS); // 0.42
const MID_BAR = 0.18;
const CENTRE_BAR = Math.min(...BAR_THRESHOLDS); // 0.03

describe('shapeLevel — microphone channel', () => {
    it('leaves a silent/gated channel at zero', () => {
        expect(shapeLevel(0, DEFAULT_MIC_GAIN)).toBe(0);
    });

    it('keeps room tone below the active threshold', () => {
        // RMS ~30 is an idle laptop mic in a quiet room.
        expect(shapeLevel(rawFromRms(30), DEFAULT_MIC_GAIN)).toBeLessThan(CENTRE_BAR);
    });

    it('lifts soft speech (RMS ~600) onto the mid bars', () => {
        const level = shapeLevel(rawFromRms(600), DEFAULT_MIC_GAIN);
        expect(level).toBeGreaterThan(MID_BAR);
        expect(level).toBeLessThan(OUTER_BAR);
    });

    it('drives normal speech (RMS ~1500) past the outer bars', () => {
        // This is the case that used to sit at 0.15 and move nothing but the
        // centre bar.
        expect(shapeLevel(rawFromRms(1500), DEFAULT_MIC_GAIN)).toBeGreaterThan(OUTER_BAR);
    });

    it('leaves a hot headset headroom instead of pegging it', () => {
        // A boom mic runs 2-3x hotter than a laptop array. Normal speech through
        // one lands near RMS 3000, and the meter has to still have somewhere to
        // go — a gain that saturates here reads as "always maxed" and loses the
        // dynamics just as thoroughly as the old too-low mapping did.
        const level = shapeLevel(rawFromRms(3000), DEFAULT_MIC_GAIN);
        expect(level).toBeGreaterThan(OUTER_BAR);
        expect(level).toBeLessThan(0.9);
    });

    it('saturates at 1 for a loud close mic', () => {
        expect(shapeLevel(rawFromRms(6000), DEFAULT_MIC_GAIN)).toBe(1);
    });
});

describe('shapeLevel — system-audio channel', () => {
    it('still reaches the outer bars at ordinary playback level', () => {
        // RMS ~4000 is a conferencing app at a normal volume.
        expect(shapeLevel(rawFromRms(4000), DEFAULT_SYSTEM_GAIN)).toBeGreaterThan(OUTER_BAR);
    });

    it('saturates at full scale', () => {
        expect(shapeLevel(1, DEFAULT_SYSTEM_GAIN)).toBe(1);
    });

    it('stays monotonic across its whole band', () => {
        let previous = -1;
        for (let rms = 0; rms <= 12000; rms += 250) {
            const level = shapeLevel(rawFromRms(rms), DEFAULT_SYSTEM_GAIN);
            expect(level).toBeGreaterThanOrEqual(previous);
            previous = level;
        }
    });
});

describe('shapeLevel — cross-channel comparability', () => {
    it('puts a normal voice and normal playback within one bar band of each other', () => {
        const voice = shapeLevel(rawFromRms(1500), DEFAULT_MIC_GAIN);
        const playback = shapeLevel(rawFromRms(5000), DEFAULT_SYSTEM_GAIN);
        // Before the per-channel gain these differed by ~0.35 — more than the
        // full 0.03→0.42 span of the meter — so max(mic, system) always showed
        // the far end.
        expect(Math.abs(voice - playback)).toBeLessThan(0.25);
    });

    it('rejects non-finite input rather than propagating NaN into a transform', () => {
        expect(shapeLevel(Number.NaN, DEFAULT_MIC_GAIN)).toBe(0);
        expect(shapeLevel(Number.POSITIVE_INFINITY, DEFAULT_MIC_GAIN)).toBe(1);
    });
});
