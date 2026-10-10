import { describe, expect, it, vi } from 'vitest';
import {
    beginMeetingProcessing,
    completeProcessingSteps,
    endMeetingProcessing,
    getMeetingProcessingSnapshot,
    setProcessingStepDetail,
    startProcessingStep,
    waitForMeetingProcessingEnd,
} from '../utils/meetingProcessingProgress';

describe('meetingProcessingProgress registry', () => {
    it('tracks a meeting through its real steps and forgets it when done', () => {
        beginMeetingProcessing('m1', ['title', 'summary', 'save']);
        expect(getMeetingProcessingSnapshot('m1')?.steps.map(s => s.id)).toEqual(['transcript', 'title', 'summary', 'save']);

        startProcessingStep('m1', 'summary', 'Drafting', 0);
        setProcessingStepDetail('m1', 'summary', 'Verifying', 0.17);
        expect(getMeetingProcessingSnapshot('m1')?.steps.find(s => s.id === 'summary'))
            .toMatchObject({ status: 'active', detail: 'Verifying', fraction: 0.17 });

        completeProcessingSteps('m1', 'title', 'summary');
        endMeetingProcessing('m1', true);
        expect(getMeetingProcessingSnapshot('m1')).toBeNull();
    });

    it('begin is idempotent — a second call keeps the first plan and progress', () => {
        beginMeetingProcessing('m2', ['analysis', 'save']);
        completeProcessingSteps('m2', 'analysis');
        beginMeetingProcessing('m2', ['title', 'summary', 'save']);
        const snap = getMeetingProcessingSnapshot('m2')!;
        expect(snap.steps.map(s => s.id)).toEqual(['transcript', 'analysis', 'save']);
        expect(snap.steps.find(s => s.id === 'analysis')?.status).toBe('done');
        endMeetingProcessing('m2', false);
    });

    it('updates for unknown meetings are harmless no-ops', () => {
        expect(() => startProcessingStep('nope', 'summary')).not.toThrow();
        expect(() => endMeetingProcessing('nope', true)).not.toThrow();
    });

    it('lists steps in execution order: an upload analyses AFTER the summary', () => {
        beginMeetingProcessing('m3', ['title', 'summary', 'analysis', 'save']);
        expect(getMeetingProcessingSnapshot('m3')?.steps.map(s => s.id))
            .toEqual(['transcript', 'title', 'summary', 'analysis', 'save']);
        endMeetingProcessing('m3', false);
    });

    it('a live meeting that needs the transcript analysis gets it inserted before save when it starts', () => {
        beginMeetingProcessing('m4', ['liveAnalysis', 'summary', 'save']);
        completeProcessingSteps('m4', 'liveAnalysis', 'summary');
        startProcessingStep('m4', 'analysis');
        const snap = getMeetingProcessingSnapshot('m4')!;
        expect(snap.steps.map(s => s.id)).toEqual(['transcript', 'liveAnalysis', 'summary', 'analysis', 'save']);
        expect(snap.steps.find(s => s.id === 'analysis')?.status).toBe('active');
        endMeetingProcessing('m4', false);
    });
});
describe('waitForMeetingProcessingEnd', () => {
    it('resolves immediately when the meeting is not being processed', async () => {
        await expect(waitForMeetingProcessingEnd('never-started', 60_000)).resolves.toBeUndefined();
    });

    it('resolves when processing ends (saved or not)', async () => {
        beginMeetingProcessing('w1', ['save']);
        let done = false;
        const p = waitForMeetingProcessingEnd('w1', 60_000).then(() => { done = true; });
        await Promise.resolve();
        expect(done).toBe(false);
        endMeetingProcessing('w1', false);
        await p;
        expect(done).toBe(true);
    });

    it('resolves after the timeout if processing never ends', async () => {
        vi.useFakeTimers();
        try {
            beginMeetingProcessing('w2', ['save']);
            const p = waitForMeetingProcessingEnd('w2', 5_000);
            await vi.advanceTimersByTimeAsync(5_000);
            await expect(p).resolves.toBeUndefined();
        } finally {
            endMeetingProcessing('w2', false);
            vi.useRealTimers();
        }
    });
});
