import { describe, it, expect } from 'vitest';
import {
    LEVEL_HEARTBEAT_MS,
    LEVEL_STEPS,
    createLevelGateState,
    quantizeLevel,
    shouldSendLevel,
} from '../audio/audioLevelGate';

/** Mirrors main.ts's sendAudioLevel: decide, then commit only on a real send. */
const drive = (samples: Array<{ level: number; at: number }>): number[] => {
    const gate = createLevelGateState();
    const sent: number[] = [];
    for (const s of samples) {
        const q = quantizeLevel(s.level);
        if (!shouldSendLevel(gate, q, s.at)) continue;
        gate.lastSent = q;
        gate.lastSentAt = s.at;
        sent.push(q);
    }
    return sent;
};

describe('quantizeLevel', () => {
    it('snaps to the renderer 1/128 grid', () => {
        expect(quantizeLevel(0.5)).toBe(64 / LEVEL_STEPS);
        // Two RMS values inside the same step collapse to one value.
        expect(quantizeLevel(0.5001)).toBe(quantizeLevel(0.5));
    });

    it('clamps out-of-range input', () => {
        expect(quantizeLevel(-1)).toBe(0);
        expect(quantizeLevel(4)).toBe(1);
    });

    it('treats non-finite input as silence', () => {
        // A meaningless RMS must not be reported as a full-scale level.
        expect(quantizeLevel(NaN)).toBe(0);
        expect(quantizeLevel(Infinity)).toBe(0);
    });
});

describe('shouldSendLevel', () => {
    it('always sends the first sample, even silence', () => {
        const gate = createLevelGateState();
        expect(shouldSendLevel(gate, 0, 0)).toBe(true);
    });

    it('suppresses an identical quantized value inside the heartbeat window', () => {
        const gate = { lastSent: 0.25, lastSentAt: 10_000 };
        expect(shouldSendLevel(gate, 0.25, 10_000 + LEVEL_HEARTBEAT_MS - 1)).toBe(false);
    });

    it('sends a changed value immediately', () => {
        const gate = { lastSent: 0.25, lastSentAt: 10_000 };
        expect(shouldSendLevel(gate, 0.25 + 1 / LEVEL_STEPS, 10_050)).toBe(true);
    });

    it('sends an unchanged value once the heartbeat is due', () => {
        const gate = { lastSent: 0.25, lastSentAt: 10_000 };
        expect(shouldSendLevel(gate, 0.25, 10_000 + LEVEL_HEARTBEAT_MS)).toBe(true);
    });

    it('keeps the liveness heartbeat well inside the renderer active timeout', () => {
        // useLiveAudioLevels drops micActive/systemActive after 1200ms without an
        // event, so the floor on our send interval has to stay comfortably below it.
        expect(LEVEL_HEARTBEAT_MS).toBeLessThan(1200 / 2);
    });
});

describe('gate driven at the real 20Hz sampling cadence', () => {
    it('collapses a silent stretch to heartbeats only', () => {
        // 2 seconds of digital silence sampled every 50ms = 40 samples.
        const samples = Array.from({ length: 40 }, (_, i) => ({ level: 0, at: i * 50 }));
        const sent = drive(samples);
        // First sample + one per 500ms window, instead of all 40.
        expect(sent.length).toBe(1 + 3);
        expect(sent.every((v) => v === 0)).toBe(true);
    });

    it('does not throttle speech', () => {
        // A level that moves by more than one step on every sample.
        const samples = Array.from({ length: 20 }, (_, i) => ({
            level: 0.2 + (i % 5) * 0.05,
            at: i * 50,
        }));
        expect(drive(samples).length).toBe(20);
    });

    it('a suppressed sample does not postpone the heartbeat', () => {
        // Same value throughout: the deadline is measured from the last real send,
        // so the second send lands at exactly 500ms and not later.
        const samples = Array.from({ length: 11 }, (_, i) => ({ level: 0.5, at: i * 50 }));
        const gate = createLevelGateState();
        const times: number[] = [];
        for (const s of samples) {
            const q = quantizeLevel(s.level);
            if (!shouldSendLevel(gate, q, s.at)) continue;
            gate.lastSent = q;
            gate.lastSentAt = s.at;
            times.push(s.at);
        }
        expect(times).toEqual([0, 500]);
    });
});
