// Covers the coach-ready data layer on the regeneration path:
//   - the call type is re-resolved from existing meeting data (persisted
//     coachCallType outranks scorecard detection; explicit would outrank both),
//   - both prompt variants (main + Groq) carry the call-type section,
//   - the parsed summary is sanitized (stray foreign blocks stripped) and
//     stamped with coachCallType,
//   - openLoops are derived from the stored live analysis's unresolved
//     objections (replacing LLM-authored ones),
//   - updateMeetingSummary receives the new fields and explicitly blanks
//     type-specific blocks the resolved call type no longer owns.
//
// The mock setup mirrors backendRagChunking.test.ts: every module
// MeetingPersistence.ts pulls in transitively (LLM SDKs, better-sqlite3,
// electron itself) is mocked; summaryReconciliation and callAnalysis are left
// REAL because their behaviour is under test here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMeetingSummary = vi.fn();
const getMeetingScorecard = vi.fn();
const getMeetingDetails = vi.fn();

vi.mock('../db/DatabaseManager', () => ({
    DatabaseManager: {
        getInstance: () => ({
            updateMeetingSummary,
            getMeetingScorecard,
            getMeetingDetails,
            saveMeeting: vi.fn(),
            getScoringCriteria: vi.fn(() => null),
            saveMeetingScorecard: vi.fn(),
        }),
    },
    formatDuration: (_ms: number) => '00:00',
}));

vi.mock('../db/SupabaseMirrorService', () => ({
    SupabaseMirrorService: { getInstance: () => ({ flush: vi.fn(async () => {}) }) },
}));

vi.mock('../main', () => ({
    AppState: { getInstance: () => ({}) },
}));

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: (): any[] => [] },
}));

// Marker Groq prompt so the test can assert composition without the real text.
vi.mock('../llm', () => ({
    GROQ_TITLE_PROMPT: '',
    GROQ_SUMMARY_JSON_PROMPT: 'GROQ_MARKER',
    verifySummaryAgainstTranscript: vi.fn(),
    buildCorrectionAddendum: vi.fn(() => ''),
}));
vi.mock('../utils/salesBriefUtils', () => ({ buildCompanyContextBlock: vi.fn(() => '') }));
vi.mock('../llm/ScoreCardLLM', () => ({ buildScorecardPrompt: vi.fn() }));
vi.mock('../scorecardReconciliation', () => ({ reconcileScorecardWithLiveAnalysis: vi.fn((r: any) => r) }));
vi.mock('../services/AuthManager', () => ({ AuthManager: { getInstance: () => ({}) } }));
vi.mock('../utils/uploadAnalysisBridge', () => ({
    requestUploadAnalysis: vi.fn(),
    isLocalUploadAnalysisForced: vi.fn(() => false),
}));
vi.mock('../utils/finalAnalysisBridge', () => ({
    requestFinalAnalysisV2: vi.fn(),
    isFinalAnalysisV2Enabled: vi.fn(() => false),
}));
vi.mock('../utils/backendRagChunking', () => ({ requestBackendChunking: vi.fn(async () => {}) }));
vi.mock('../SessionTracker', () => ({ SessionTracker: class { } }));
vi.mock('../LLMHelper', () => ({ LLMHelper: class { } }));

import { MeetingPersistence } from '../MeetingPersistence';

const field = (status: string, evidence: string) => ({ status, evidence });
const STORED_LIVE_ANALYSIS: any = {
    bant: {
        budget: field('confirmed', 'Budget of 200k approved'),
        authority: field('partial', 'CFO mentioned'),
        need: field('confirmed', 'dispatch pain'),
        timeline: field('missing', ''),
    },
    meddic: {
        metrics: field('confirmed', '40% faster'),
        economic_buyer: field('missing', ''),
        decision_criteria: field('missing', ''),
        decision_process: field('missing', ''),
        identify_pain: field('confirmed', 'spreadsheets'),
        champion: field('missing', ''),
        competition: field('missing', ''),
    },
    objections: [
        { type: 'customer_question', quote: 'How does pricing work at scale?', owner: 'customer', status: 'open', suggested_answer: 'Tiered from 500 seats.' },
        { type: 'customer_question', quote: 'Is support included?', owner: 'customer', status: 'open', resolved: true },
    ],
    signals: [],
};

const TRANSCRIPT = [
    { speaker: 'user', text: 'Let me show you the reporting module.', timestamp: 0, displayName: 'Alex (rep)' },
    { speaker: 'client', text: 'This is exactly what ops asked for.', timestamp: 10_000, displayName: 'Dana' },
    { speaker: 'client', text: 'Can we pilot it with the ops team?', timestamp: 20_000, displayName: 'Dana' },
];

function fakeMeeting(detailedSummary: any = {}): any {
    return {
        id: 'meeting-1',
        title: 'Demo call',
        source: 'manual',
        transcript: TRANSCRIPT,
        detailedSummary: { actionItems: [], keyPoints: [], speakerNames: { user: 'Alex', client: 'Dana' }, ...detailedSummary },
    };
}

// A demo summary as the LLM might emit it: valid demoReview, but also a stray
// negotiation block it was never asked for and invented open loops.
function llmJson(body: Record<string, unknown>): string {
    return '```json\n' + JSON.stringify(body) + '\n```';
}

const DEMO_BODY = {
    overview: 'Demo of the reporting module.',
    dealStatus: { stage: 'Demo', summary: 'Positive reaction.' },
    leadName: 'Dana',
    company: 'Acme',
    bant: { budget: { status: 'Missing', detail: 'wrong' } },
    nextCallPlaybook: {
        callGoal: 'Confirm the pilot success criteria with Dana.',
        questionsToAsk: [{ question: 'Who signs off on the pilot?', gap: 'Economic Buyer' }],
    },
    demoReview: {
        reactions: [
            { feature: 'Reporting', verdict: 'landed', quote: 'This is exactly what ops asked for.', speaker: 'Dana' },
        ],
    },
    negotiation: { limit: 'N/A' },
    openLoops: [{ concern: 'Concern the customer never raised' }],
    promises: [{ text: 'Send the pilot plan by Friday', dueDate: 'Friday' }],
    keyPoints: ['Reporting landed well'],
    actionItems: ['Send pilot plan'],
};

const generateMeetingSummary = vi.fn();

function makePersistence(): MeetingPersistence {
    return new MeetingPersistence({} as any, { generateMeetingSummary } as any);
}

describe('MeetingPersistence.regenerateSummary — coach data layer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('resolves the call type from stored data, threads it into BOTH prompts, and stamps it', async () => {
        getMeetingDetails.mockReturnValue(fakeMeeting({
            liveAnalysis: STORED_LIVE_ANALYSIS,
            // Persisted resolution from the initial generation — reflects the
            // rep's explicit demo selection at end of call.
            coachCallType: 'demo',
        }));
        // Scorecard detected discovery, but the persisted resolution says demo —
        // the persisted resolution (which honoured the rep's explicit pick at
        // generation time) must win.
        getMeetingScorecard.mockReturnValue({ detectedTypes: ['discovery'] });
        generateMeetingSummary.mockResolvedValue(llmJson({ ...DEMO_BODY, coachCallType: 'discovery' /* LLM guess — must be overwritten */ }));

        const result = await makePersistence().regenerateSummary('meeting-1');

        expect(result).toBe(true);
        const [systemPrompt, , groqPrompt] = generateMeetingSummary.mock.calls[0];
        expect(systemPrompt).toContain('CALL TYPE: DEMO');
        expect(groqPrompt).toContain('GROQ_MARKER');
        expect(groqPrompt).toContain('CALL TYPE: DEMO');

        expect(updateMeetingSummary).toHaveBeenCalledTimes(1);
        const [meetingId, updates] = updateMeetingSummary.mock.calls[0];
        expect(meetingId).toBe('meeting-1');
        // Stamped in code, never taken from LLM output.
        expect(updates.coachCallType).toBe('demo');
        // Valid demo data survived sanitisation.
        expect(updates.demoReview.reactions).toHaveLength(1);
        expect(updates.nextCallPlaybook.questionsToAsk[0]).toEqual({ question: 'Who signs off on the pilot?', gap: 'Economic Buyer' });
        // The stray negotiation block the LLM emitted anyway is stripped AND
        // the stored key is explicitly blanked so the merge drops it.
        expect(updates.negotiation).toBeUndefined();
        expect('negotiation' in updates).toBe(true);
        // LLM open loops replaced by derivation from unresolved objections.
        expect(updates.openLoops).toEqual([
            { concern: 'How does pricing work at scale?', suggestedAnswer: 'Tiered from 500 seats.' },
        ]);
        // BANT reconciled against the stored live analysis.
        expect(updates.bant.budget).toEqual({ status: 'Clear', detail: 'Budget of 200k approved' });
        // Common fields flow through.
        expect(updates.actionItems).toEqual(['Send pilot plan']);
        expect(updates.promises).toEqual([{ text: 'Send the pilot plan by Friday', dueDate: 'Friday' }]);
        // The real live analysis is never clobbered by the summary JSON.
        expect(updates.liveAnalysis).toBeUndefined();
        // New fields survive a JSON round-trip.
        const round = JSON.parse(JSON.stringify(updates));
        expect(round.coachCallType).toBe('demo');
        expect(round.demoReview.reactions[0].verdict).toBe('landed');
    });

    it('scorecard detection drives the type when no resolution was persisted', async () => {
        getMeetingDetails.mockReturnValue(fakeMeeting({ liveAnalysis: STORED_LIVE_ANALYSIS }));
        getMeetingScorecard.mockReturnValue({ detectedTypes: ['negotiation'] });
        generateMeetingSummary.mockResolvedValue(llmJson({ overview: 'Negotiation call.' }));

        await makePersistence().regenerateSummary('meeting-1');

        const [systemPrompt] = generateMeetingSummary.mock.calls[0];
        expect(systemPrompt).toContain('CALL TYPE: NEGOTIATION');
        expect(updatesCoachCallType()).toBe('negotiation');
        // A negotiation regeneration blanks the demo block a previous demo
        // generation may have left in storage.
        const [, updates] = updateMeetingSummary.mock.calls[0];
        expect(updates.demoReview).toBeUndefined();
    });

    it('defaults to discovery with no stored type information at all', async () => {
        getMeetingDetails.mockReturnValue(fakeMeeting({ liveAnalysis: STORED_LIVE_ANALYSIS }));
        getMeetingScorecard.mockReturnValue(null);
        generateMeetingSummary.mockResolvedValue(llmJson({ overview: 'Plain call.' }));

        await makePersistence().regenerateSummary('meeting-1');

        expect(generateMeetingSummary.mock.calls[0][0]).toContain('CALL TYPE: DISCOVERY');
        expect(updatesCoachCallType()).toBe('discovery');
    });
});

function updatesCoachCallType(): string | undefined {
    return updateMeetingSummary.mock.calls[0]?.[1]?.coachCallType;
}
