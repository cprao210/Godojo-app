// Covers the ordering fix in MeetingPersistence.processAndSaveMeeting: the
// backend RAG chunking trigger (POST /meetings/:id/chunking) must not fire
// until the Supabase mirror has actually flushed the transcript batch it
// just enqueued in saveMeeting() — otherwise the backend routinely finds "no
// transcript yet" on its very first attempt, which is exactly the race
// backendRagChunking.ts's retry/durable-queue machinery exists to paper
// over. See MeetingPersistence.ts's processAndSaveMeeting for the fix.
//
// Every module MeetingPersistence.ts pulls in transitively (LLM SDKs,
// better-sqlite3, electron itself) is mocked out below; this test only
// exercises the save -> flush -> chunk-request sequencing, not any
// LLM/DB/Supabase behaviour.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const callOrder: string[] = [];

const saveMeeting = vi.fn();
const getMeetingScorecard = vi.fn();
vi.mock('../db/DatabaseManager', () => ({
    DatabaseManager: {
        getInstance: () => ({
            saveMeeting,
            getMeetingScorecard,
            getScoringCriteria: vi.fn(() => null),
            saveMeetingScorecard: vi.fn(),
        }),
    },
    formatDuration: (_ms: number) => '00:00',
}));

const flush = vi.fn(async (_timeoutMs?: number) => { callOrder.push('flush'); });
vi.mock('../db/SupabaseMirrorService', () => ({
    SupabaseMirrorService: { getInstance: () => ({ flush }) },
}));

const notifyMeetingSummaryReady = vi.fn();
vi.mock('../main', () => ({
    AppState: { getInstance: () => ({ notifyMeetingSummaryReady }) },
}));

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: (): any[] => [] },
}));

// Everything below is reachable only via static imports at the top of
// MeetingPersistence.ts, never actually exercised by the short (<=2-turn)
// transcript this test uses (which deliberately skips the title/summary/
// scorecard/call-analysis LLM branches) — mocked purely so importing the
// module under test doesn't pull in real LLM SDKs / sqlite / electron.
vi.mock('../llm', () => ({
    GROQ_TITLE_PROMPT: '',
    GROQ_SUMMARY_JSON_PROMPT: '',
    verifySummaryAgainstTranscript: vi.fn(),
    buildCorrectionAddendum: vi.fn(),
}));
vi.mock('../utils/salesBriefUtils', () => ({ buildCompanyContextBlock: vi.fn(() => '') }));
vi.mock('../llm/ScoreCardLLM', () => ({ buildScorecardPrompt: vi.fn() }));
vi.mock('../scorecardReconciliation', () => ({ reconcileScorecardWithLiveAnalysis: vi.fn((r: any) => r) }));
vi.mock('../summaryReconciliation', () => ({ reconcileBantMeddicWithLiveAnalysis: vi.fn((s: any) => s) }));
vi.mock('../services/AuthManager', () => ({ AuthManager: { getInstance: () => ({}) } }));
// The real clipForLocalAnalysis, so the long-transcript test below sees the real clip.
vi.mock('../utils/uploadAnalysis', async (importOriginal) => ({
    clipForLocalAnalysis: (await importOriginal<typeof import('../utils/uploadAnalysis')>()).clipForLocalAnalysis,
    buildUploadAnalysisPrompt: vi.fn(() => 'analysis prompt'),
    normalizeUploadAnalysis: vi.fn(() => ({ bant: {}, meddic: {}, objections: [], signals: [] })),
}));
vi.mock('../utils/uploadAnalysisBridge', () => ({
    requestUploadAnalysis: vi.fn(),
    isLocalUploadAnalysisForced: vi.fn(() => false),
}));
vi.mock('../utils/finalAnalysisBridge', () => ({
    requestFinalAnalysisV2: vi.fn(),
    isFinalAnalysisV2Enabled: vi.fn(() => false),
}));
const generateCallAnalysis = vi.fn();
vi.mock('../utils/callAnalysis', () => ({
    generateCallAnalysis: (...args: any[]) => generateCallAnalysis(...args),
    hasUsableCallAnalysis: vi.fn(),
    meetingTypesForRegenerate: vi.fn(),
    REGENERATE_ANALYSIS_TIMEOUT_MS: 1000,
}));
vi.mock('../SessionTracker', () => ({ SessionTracker: class { } }));
vi.mock('../LLMHelper', () => ({ LLMHelper: class { } }));

const requestBackendChunking = vi.fn(async (_id: string, _tenant: string | null) => { callOrder.push('chunk'); });
vi.mock('../utils/backendRagChunking', () => ({
    requestBackendChunking: (id: string, tenant: string | null) => requestBackendChunking(id, tenant),
}));

import { MeetingPersistence } from '../MeetingPersistence';

// processAndSaveMeeting falls back to the session's speaker map when no names are passed.
const SESSION: any = { getSpeakerNameMap: () => ({ user: 'Me', client: 'Them' }) };

// A transcript of exactly 2 turns is short enough that processAndSaveMeeting
// skips title generation (a title is supplied via metadata anyway), summary
// generation, and call-analysis generation (all gated on
// `data.transcript.length > 2`) — isolating this test to just the
// save -> flush -> chunk-request sequencing under test.
const SHORT_TRANSCRIPT = [
    { speaker: 'user', text: 'Hi there', timestamp: 0 },
    { speaker: 'client', text: 'Hello', timestamp: 1000 },
];

function callProcessAndSaveMeeting(persistence: MeetingPersistence, meetingId: string, tenantId: string | null) {
    return (persistence as any).processAndSaveMeeting(
        { transcript: SHORT_TRANSCRIPT, usage: [], startTime: 0, durationMs: 1000, context: '' },
        meetingId,
        { title: 'Test meeting', source: 'upload' },
        null,        // liveAnalysisData
        undefined,   // speakerNames
        null,        // companyIntel
        undefined,   // hintMeetingTypes
        tenantId,
    );
}

describe('MeetingPersistence.processAndSaveMeeting — chunk trigger ordering', () => {
    beforeEach(() => {
        callOrder.length = 0;
        saveMeeting.mockClear();
        flush.mockClear();
        requestBackendChunking.mockClear();
    });

    it('waits for the Supabase mirror to flush the transcript batch before requesting backend chunking', async () => {
        const persistence = new MeetingPersistence(SESSION, {} as any);

        await callProcessAndSaveMeeting(persistence, 'meeting-1', 'tenant-1');

        // The flush -> chunk-request sequence runs in a fire-and-forget async
        // IIFE (processAndSaveMeeting doesn't await it, so the toast/list
        // refresh above it are never delayed) — give the microtask queue a
        // turn to let it complete before asserting on it.
        await vi.waitFor(() => expect(requestBackendChunking).toHaveBeenCalled());

        expect(saveMeeting).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledTimes(1);
        // Generous timeout vs flush()'s own 8s default: an uploaded
        // transcript's batch can be large, and this must give the mirror a
        // real chance to land it before falling back to the retry queue.
        expect(flush).toHaveBeenCalledWith(20_000);
        expect(requestBackendChunking).toHaveBeenCalledWith('meeting-1', 'tenant-1');

        // The actual regression this test guards: flush must complete
        // (or at least be awaited) strictly before the chunk request fires.
        expect(callOrder).toEqual(['flush', 'chunk']);
    });

    it('still requests chunking even if the mirror flush fails (non-fatal — chunking retry/queue covers it)', async () => {
        flush.mockRejectedValueOnce(new Error('network down'));
        const persistence = new MeetingPersistence(SESSION, {} as any);

        await callProcessAndSaveMeeting(persistence, 'meeting-2', 'tenant-1');

        await vi.waitFor(() => expect(requestBackendChunking).toHaveBeenCalled());

        expect(flush).toHaveBeenCalledTimes(1);
        expect(requestBackendChunking).toHaveBeenCalledWith('meeting-2', 'tenant-1');
    });

    it('passes null tenantId through untouched when no tenant is active', async () => {
        const persistence = new MeetingPersistence(SESSION, {} as any);

        await callProcessAndSaveMeeting(persistence, 'meeting-3', null);

        await vi.waitFor(() => expect(requestBackendChunking).toHaveBeenCalled());

        expect(requestBackendChunking).toHaveBeenCalledWith('meeting-3', null);
    });
});
// Chunking needs only the transcript. Once the meeting is saved locally it must be
// requested whatever else failed — summary, score, call analysis or the UI notifications
// after the save. Before this, a throw from the call-analysis step escaped
// processAndSaveMeeting, so the meeting was never saved and never chunked.
describe('MeetingPersistence.processAndSaveMeeting — chunking survives failed steps', () => {
    // > 2 turns, so the title/summary/scorecard/call-analysis branches all run.
    const LONG_TRANSCRIPT = Array.from({ length: 300 }, (_, i) => ({
        speaker: i % 2 ? 'client' : 'user',
        text: `Turn ${i}: we covered budget, timeline and who signs off on the rollout.`,
        timestamp: i * 1000,
    }));

    function run(llmHelper: any, meetingId: string) {
        return (new MeetingPersistence(SESSION, llmHelper) as any).processAndSaveMeeting(
            { transcript: LONG_TRANSCRIPT, usage: [], startTime: 0, durationMs: 1000, context: '' },
            meetingId,
            { title: 'Test meeting', source: 'upload' },
            null, undefined, null, undefined, 'tenant-1',
        );
    }

    const failingLlm = () => ({ generateMeetingSummary: vi.fn().mockRejectedValue(new Error('all providers down')) });

    beforeEach(() => {
        callOrder.length = 0;
        saveMeeting.mockReset();
        flush.mockClear();
        requestBackendChunking.mockClear();
        generateCallAnalysis.mockReset();
        getMeetingScorecard.mockReset();
        notifyMeetingSummaryReady.mockReset();
    });

    it('saves and requests chunking when call analysis throws', async () => {
        generateCallAnalysis.mockRejectedValue(new Error('analysis exploded'));
        await run(failingLlm(), 'm-analysis');

        await vi.waitFor(() => expect(requestBackendChunking).toHaveBeenCalledWith('m-analysis', 'tenant-1'));
        expect(saveMeeting).toHaveBeenCalledTimes(1);
    });

    it('saves and requests chunking when summary and score generation throw', async () => {
        generateCallAnalysis.mockResolvedValue({ analysis: null, producer: null });
        const llm = failingLlm();
        await run(llm, 'm-summary');

        await vi.waitFor(() => expect(requestBackendChunking).toHaveBeenCalledWith('m-summary', 'tenant-1'));
        expect(llm.generateMeetingSummary).toHaveBeenCalled();
        expect(saveMeeting).toHaveBeenCalledTimes(1);
    });

    it('saves and requests chunking when scorecard finalization throws', async () => {
        generateCallAnalysis.mockResolvedValue({ analysis: null, producer: null });
        getMeetingScorecard.mockImplementation(() => { throw new Error('sqlite busy'); });
        const llm = {
            generateMeetingSummary: vi.fn(async (_p: string, _c: string, _g: string, task?: string) => {
                if (task === 'meeting_score') {
                    return JSON.stringify({ detectedTypes: ['demo'], overallWeightedScore: 7, scorecards: {} });
                }
                throw new Error('no summary today');
            }),
        };
        await run(llm, 'm-score');

        await vi.waitFor(() => expect(requestBackendChunking).toHaveBeenCalledWith('m-score', 'tenant-1'));
        expect(saveMeeting).toHaveBeenCalledTimes(1);
    });

    it('still requests chunking when a step after the save throws', async () => {
        generateCallAnalysis.mockResolvedValue({ analysis: null, producer: null });
        notifyMeetingSummaryReady.mockImplementation(() => { throw new Error('toast window failed'); });
        await run(failingLlm(), 'm-toast');

        await vi.waitFor(() => expect(requestBackendChunking).toHaveBeenCalledWith('m-toast', 'tenant-1'));
    });

    it('does not request chunking when the meeting was never saved locally', async () => {
        generateCallAnalysis.mockResolvedValue({ analysis: null, producer: null });
        saveMeeting.mockImplementation(() => { throw new Error('disk full'); });
        await run(failingLlm(), 'm-unsaved');

        // Let any stray fire-and-forget work settle before asserting it never happened.
        await new Promise(r => setTimeout(r, 20));
        expect(requestBackendChunking).not.toHaveBeenCalled();
    });

    it('marks a local fallback analysis over a clipped transcript as truncated', async () => {
        // Backend unavailable → the real flow runs the local analyser; mimic that here.
        generateCallAnalysis.mockImplementation(async (_turns: any, _types: any, deps: any) =>
            ({ analysis: await deps.runLocal(false), producer: 'local' }));
        const llm = {
            generateMeetingSummary: vi.fn(async (_p: string, _c: string, _g: string, task?: string) => {
                if (task === undefined) return '{"bant":{}}'; // the local analysis call
                throw new Error('no summary today');
            }),
        };
        await run(llm, 'm-truncated');

        await vi.waitFor(() => expect(saveMeeting).toHaveBeenCalledTimes(1));
        const analysisCall = llm.generateMeetingSummary.mock.calls.find(c => c[3] === undefined)!;
        expect(analysisCall[1].length).toBeLessThanOrEqual(12_000);

        const saved = saveMeeting.mock.calls[0][0];
        const truncated = saved.detailedSummary.liveAnalysis.truncated;
        expect(truncated.analyzedChars).toBe(analysisCall[1].length);
        expect(truncated.totalChars).toBeGreaterThan(12_000);
    });
});
