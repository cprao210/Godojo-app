// Covers electron/utils/callAnalysis — how a meeting with no live analysis gets its Call
// Analysis, on the upload path and when regenerating. Regenerate used to rebuild only the
// summary, so an upload whose first analysis failed never got one.

import { describe, it, expect, vi } from 'vitest';
import {
    generateCallAnalysis,
    hasUsableCallAnalysis,
    meetingTypesForRegenerate,
} from '../utils/callAnalysis';

const ANALYSIS: any = { bant: {}, meddic: {}, objections: [], signals: [], source: 'v2_end' };
const LOCAL: any = { bant: {}, meddic: {}, objections: [], signals: [], source: 'local' };
const TURNS = [
    { speaker: 'user', text: 'How many guards do you run today?' },
    { speaker: 'client', text: 'Eighteen guards across two sites.' },
    { speaker: 'user', text: 'And who signs off on the budget?' },
];

describe('generateCallAnalysis', () => {
    it('uses the backend answer and never runs the local analyser', async () => {
        const runLocal = vi.fn();
        const requestBackend = vi.fn().mockResolvedValue(ANALYSIS);
        const out = await generateCallAnalysis(TURNS, ['demo'], { requestBackend, runLocal });
        expect(out).toEqual({ analysis: ANALYSIS, producer: 'backend' });
        expect(requestBackend).toHaveBeenCalledWith(TURNS, ['demo']);
        expect(runLocal).not.toHaveBeenCalled();
    });

    it('falls back to the local analyser when the backend rejects or returns nothing', async () => {
        const warn = vi.fn();
        const rejected = await generateCallAnalysis(TURNS, ['negotiation'], {
            requestBackend: vi.fn().mockRejectedValue(new Error('renderer did not answer')),
            runLocal: vi.fn().mockResolvedValue(LOCAL),
            warn,
        });
        expect(rejected).toEqual({ analysis: LOCAL, producer: 'local' });
        expect(warn.mock.calls[0][0]).toContain('renderer did not answer');

        const runLocal = vi.fn().mockResolvedValue(LOCAL);
        const empty = await generateCallAnalysis(TURNS, ['negotiation'], {
            requestBackend: vi.fn().mockResolvedValue(null),
            runLocal,
        });
        expect(empty.producer).toBe('local');
        expect(runLocal).toHaveBeenCalledWith(true); // negotiation hint reaches the local prompt
    });

    it('skips the backend when local analysis is forced', async () => {
        const requestBackend = vi.fn();
        const out = await generateCallAnalysis(TURNS, [], {
            requestBackend,
            runLocal: vi.fn().mockResolvedValue(LOCAL),
            forceLocal: true,
        });
        expect(out.producer).toBe('local');
        expect(requestBackend).not.toHaveBeenCalled();
    });

    it('returns null without throwing when both producers fail', async () => {
        const out = await generateCallAnalysis(TURNS, [], {
            requestBackend: vi.fn().mockRejectedValue(new Error('429')),
            runLocal: vi.fn().mockRejectedValue(new Error('RESOURCE_EXHAUSTED')),
            warn: () => {},
        });
        expect(out).toEqual({ analysis: null, producer: null });
    });

    it('does nothing for a transcript too short to analyse', async () => {
        const requestBackend = vi.fn();
        const runLocal = vi.fn();
        const out = await generateCallAnalysis(TURNS.slice(0, 2), [], { requestBackend, runLocal });
        expect(out.analysis).toBeNull();
        expect(requestBackend).not.toHaveBeenCalled();
        expect(runLocal).not.toHaveBeenCalled();
    });
});

describe('meetingTypesForRegenerate', () => {
    it('takes the first source with valid types and drops unknown values', () => {
        expect(meetingTypesForRegenerate(undefined, ['demo', 'bogus', 'demo'], ['discovery'])).toEqual(['demo']);
        expect(meetingTypesForRegenerate([], null, ['negotiation'])).toEqual(['negotiation']);
        expect(meetingTypesForRegenerate(undefined, 'demo', {})).toEqual([]);
    });
});

describe('hasUsableCallAnalysis', () => {
    it('needs BANT and MEDDIC, not just an object', () => {
        expect(hasUsableCallAnalysis(ANALYSIS)).toBe(true);
        expect(hasUsableCallAnalysis({})).toBe(false);
        expect(hasUsableCallAnalysis(null)).toBe(false);
        expect(hasUsableCallAnalysis({ bant: {} })).toBe(false);
    });
});
