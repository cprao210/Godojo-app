import { describe, expect, it } from 'vitest';
import {
    computeProgressPercent,
    createSnapshot,
    ensureStep,
    finishSnapshot,
    updateStep,
} from '@/lib/postMeetingProgress';

const T = 1_000;

describe('createSnapshot', () => {
    it('always starts with the transcript step done and everything else pending', () => {
        const snap = createSnapshot('m1', ['analysis', 'summary', 'save'], T);
        expect(snap.steps.map(s => [s.id, s.status])).toEqual([
            ['transcript', 'done'], ['analysis', 'pending'], ['summary', 'pending'], ['save', 'pending'],
        ]);
        expect(snap.finished).toBe(false);
    });

    it('never plans a scoring step and de-dupes the plan', () => {
        const snap = createSnapshot('m1', ['summary', 'summary', 'save'], T);
        expect(snap.steps.filter(s => s.id === 'summary')).toHaveLength(1);
        expect(snap.steps.map(s => s.id)).not.toContain('scorecard' as never);
    });
});

describe('updateStep', () => {
    it('ignores steps that are not in this meeting\'s plan', () => {
        const snap = createSnapshot('m1', ['save'], T);
        expect(updateStep(snap, 'title', { status: 'active' }, T + 1)).toBe(snap);
    });

    it('is immutable and drops live detail once a step is done', () => {
        const snap = createSnapshot('m1', ['summary', 'save'], T);
        const active = updateStep(snap, 'summary', { status: 'active', detail: 'Drafting', fraction: 0.2 }, T + 1);
        expect(snap.steps[1].status).toBe('pending');
        expect(active.steps[1]).toMatchObject({ status: 'active', detail: 'Drafting', fraction: 0.2 });
        const done = updateStep(active, 'summary', { status: 'done' }, T + 2);
        expect(done.steps[1]).toEqual({ id: 'summary', status: 'done' });
    });
});

describe('computeProgressPercent', () => {
    it('only counts work that has actually finished', () => {
        const base = createSnapshot('m1', ['analysis', 'title', 'summary', 'save'], T);
        const start = computeProgressPercent(base.steps);
        const afterAnalysis = computeProgressPercent(updateStep(base, 'analysis', { status: 'done' }, T).steps);
        expect(afterAnalysis).toBeGreaterThan(start);
    });

    it('moves inside the summary step as attempts progress, but never completes it', () => {
        let snap = createSnapshot('m1', ['summary', 'save'], T);
        snap = updateStep(snap, 'summary', { status: 'active', fraction: 0 }, T);
        const p0 = computeProgressPercent(snap.steps);
        snap = updateStep(snap, 'summary', { fraction: 0.5 }, T);
        const p1 = computeProgressPercent(snap.steps);
        snap = updateStep(snap, 'summary', { fraction: 5 }, T); // out of range
        const p2 = computeProgressPercent(snap.steps);
        expect(p1).toBeGreaterThan(p0);
        expect(p2).toBeLessThan(100);
    });

    it('reads 100 only when every planned step is done', () => {
        const snap = finishSnapshot(createSnapshot('m1', ['analysis', 'summary', 'save'], T), true, T + 5);
        expect(computeProgressPercent(snap.steps)).toBe(100);
        expect(snap.finished).toBe(true);
    });

    it('a failed run is finished but does not claim success', () => {
        const snap = finishSnapshot(createSnapshot('m1', ['summary', 'save'], T), false, T + 5);
        expect(snap.finished).toBe(true);
        expect(computeProgressPercent(snap.steps)).toBeLessThan(100);
    });

    it('is 0 for an empty plan', () => {
        expect(computeProgressPercent([])).toBe(0);
    });
});

describe('ensureStep (work discovered mid-run)', () => {
    it('inserts the transcript analysis after the summary and before save', () => {
        const live = createSnapshot('m1', ['liveAnalysis', 'summary', 'save'], T);
        const next = ensureStep(live, 'analysis', 'save', T + 1);
        expect(next.steps.map(s => s.id)).toEqual(['transcript', 'liveAnalysis', 'summary', 'analysis', 'save']);
        expect(next.steps.find(s => s.id === 'analysis')?.status).toBe('pending');
    });

    it('is a no-op when the step is already planned', () => {
        const snap = createSnapshot('m1', ['summary', 'analysis', 'save'], T);
        expect(ensureStep(snap, 'analysis', 'save', T + 1)).toBe(snap);
    });

    it('appends when the anchor step is missing', () => {
        const snap = createSnapshot('m1', ['summary'], T);
        expect(ensureStep(snap, 'analysis', 'save', T + 1).steps.map(s => s.id)).toEqual(['transcript', 'summary', 'analysis']);
    });
});