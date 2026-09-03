// Two lifecycle rules with real consequences: a duplicated end-of-call analysis
// costs an extra LLM round-trip and races the first one's write, while a missed
// one means the meeting is summarized with no analysis at all.

import { describe, expect, it } from 'vitest';

import {
    decideFinalAnalysis,
    deriveProcessingStage,
    FinalAnalysisInput,
    hasGeneratedSummary,
    ProcessingStageInput,
} from '@/lib/meetingLifecycle';

/** A call that was analyzed once, with no new turns since. */
const analyzed = (over: Partial<FinalAnalysisInput> = {}): FinalAnalysisInput => ({
    alreadyRequested: false,
    isLoading: false,
    hasAnalysis: true,
    lastAnalyzedTurnIndex: 8,
    humanTurnCount: 8,
    hasEnoughTranscript: true,
    ...over,
});

describe('decideFinalAnalysis', () => {
    it('runs when the rep never analyzed the call', () => {
        expect(decideFinalAnalysis(analyzed({ hasAnalysis: false, lastAnalyzedTurnIndex: 0 })))
            .toMatchObject({ action: 'run' });
    });

    it('runs when turns arrived after the last analysis', () => {
        expect(decideFinalAnalysis(analyzed({ humanTurnCount: 14 }))).toMatchObject({ action: 'run' });
    });

    it('skips when the existing analysis already covers the whole transcript', () => {
        // The user's explicit ask: a manual analysis during the call must not be
        // followed by a redundant one at end.
        expect(decideFinalAnalysis(analyzed())).toMatchObject({ action: 'skip' });
    });

    it('only ever fires once per call', () => {
        // Double-clicking End Call, or an end broadcast arriving after the click.
        expect(decideFinalAnalysis(analyzed({ alreadyRequested: true, humanTurnCount: 99 })))
            .toMatchObject({ action: 'skip' });
    });

    it('waits for a run already in flight instead of queueing a second one', () => {
        expect(decideFinalAnalysis(analyzed({ isLoading: true, humanTurnCount: 14 })))
            .toMatchObject({ action: 'wait' });
    });

    it('skips a call with too little transcript to analyze', () => {
        expect(decideFinalAnalysis(analyzed({ hasEnoughTranscript: false, hasAnalysis: false })))
            .toMatchObject({ action: 'skip' });
    });
});

const processing = (over: Partial<ProcessingStageInput> = {}): ProcessingStageInput => ({
    isProcessing: true,
    hasScorecard: false,
    isDetailResolved: false,
    isStalled: false,
    ...over,
});

describe('deriveProcessingStage', () => {
    it('reports analyzing while nothing has been persisted yet', () => {
        expect(deriveProcessingStage(processing()).stage).toBe('analyzing');
    });

    it('advances to validating once the scorecard row lands', () => {
        // Real signal: scoring finished, so the remaining wait is the summary's
        // generate → verify loop.
        expect(deriveProcessingStage(processing({ hasScorecard: true })).stage).toBe('validating');
    });

    it('reports finalizing once processing is done but the detail read has not landed', () => {
        // This is the gap that used to paint the score before the summary.
        expect(deriveProcessingStage(processing({ isProcessing: false, hasScorecard: true })).stage)
            .toBe('finalizing');
    });

    it('is ready only when processing finished AND the detail read resolved', () => {
        expect(
            deriveProcessingStage(processing({ isProcessing: false, hasScorecard: true, isDetailResolved: true })).stage,
        ).toBe('ready');
    });

    it('stops promising a summary that is never coming', () => {
        // Overrides every other stage — a crashed run must not spin forever.
        const view = deriveProcessingStage(processing({ isStalled: true, hasScorecard: true }));
        expect(view.stage).toBe('stalled');
        expect(view.detail).toMatch(/regenerate/i);
    });
});

describe('hasGeneratedSummary', () => {
    it('is false for a meeting with no summary at all', () => {
        expect(hasGeneratedSummary(undefined)).toBe(false);
        expect(hasGeneratedSummary(null)).toBe(false);
        expect(hasGeneratedSummary({})).toBe(false);
    });

    it('is false for the list-row shape: arrays guaranteed, all of them empty', () => {
        // mapMeetingRow fills in actionItems/keyPoints so consumers can treat
        // them as arrays. That must not read as "the summary has landed".
        expect(hasGeneratedSummary({ actionItems: [], keyPoints: [] })).toBe(false);
    });

    it('is false when the only content is live analysis', () => {
        // The exact state that caused the reported flicker: isSummaryEmpty says
        // "not empty" here (the Analysis tab does have content), but there is no
        // summary prose to paint, so the Summary tab must keep waiting.
        expect(hasGeneratedSummary({ actionItems: [], keyPoints: [], liveAnalysis: { bant: {} } } as any))
            .toBe(false);
    });

    it('ignores whitespace-only fields', () => {
        expect(hasGeneratedSummary({ overview: '   ', keyPoints: ['', '  '] })).toBe(false);
    });

    it('is true once any real summary field has content', () => {
        expect(hasGeneratedSummary({ overview: 'Discovery call with Acme.' })).toBe(true);
        expect(hasGeneratedSummary({ keyPoints: ['Budget approved'] })).toBe(true);
        expect(hasGeneratedSummary({ actionItems: ['Send pricing'] })).toBe(true);
        expect(hasGeneratedSummary({ dealStatus: { stage: 'Discovery' } })).toBe(true);
        expect(hasGeneratedSummary({ dealStatus: { summary: 'Late stage' } })).toBe(true);
        expect(hasGeneratedSummary({ salesCoachReview: { whatIDidRight: ['Strong open'] } })).toBe(true);
        expect(hasGeneratedSummary({ salesCoachReview: { whatICouldHaveDoneBetter: ['Rushed pricing'] } })).toBe(true);
        expect(hasGeneratedSummary({ salesCoachReview: { whatIMissedCompletely: ['No champion'] } })).toBe(true);
        expect(hasGeneratedSummary({ nextCallPlaybook: { openingRecap: 'Recap the ROI' } })).toBe(true);
        expect(hasGeneratedSummary({ nextCallPlaybook: { questionsToAsk: ['Who signs?'] } })).toBe(true);
    });
});
