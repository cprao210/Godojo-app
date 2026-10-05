import { describe, expect, it } from 'vitest';

import { clearForeignCoachBlocks, sanitizeCoachSummary } from '../utils/coachSummaryData';

// Post-parse guarantees for the coach-ready fields: placeholders and invalid
// enum entries are dropped, type-mismatched blocks are stripped, and nothing
// else about the summary is touched. The prompt forbids these — this makes
// the forbidment real (same philosophy as summaryReconciliation).

const DEMO_SUMMARY = {
    overview: 'Demo of the reporting module.',
    actionItems: ['Send follow-up'],
    keyPoints: ['Went well'],
    nextCallPlaybook: {
        callGoal: 'Confirm the pilot success criteria with Dana.',
        questionsToAsk: [{ question: 'Who signs off on the pilot?', gap: 'Economic Buyer' }],
    },
    demoReview: {
        reactions: [
            { feature: 'Reporting', verdict: 'landed', quote: 'This is exactly what ops asked for', speaker: 'Dana', timestamp: '12:40' },
            { feature: 'Mobile app', verdict: 'meh', quote: 'Not sure we would use it', speaker: 'Dana' },
            { feature: 'Integrations', verdict: 'follow_up', quote: '', speaker: 'Dana' },
        ],
        successCriteria: [
            { metric: 'Report build time', target: 'Under 5 minutes', owner: 'Dana' },
            { metric: 'Adoption', target: '' },
            { metric: '', target: '80%' },
        ],
    },
    stakeholders: [
        { name: 'Dana', role: 'Head of Ops', stance: 'champion', note: 'Pushed for this evaluation' },
        { name: 'Mystery', role: 'Unknown', stance: 'very_positive' },
    ],
};

const NEGOTIATION_SUMMARY = {
    overview: 'Commercial negotiation.',
    actionItems: ['Redline contract'],
    keyPoints: ['Close to agreement'],
    negotiation: {
        terms: [
            { term: 'Annual price', theyAsked: '20% discount', youOffered: '10% for annual prepay', status: 'leaning' },
            { term: 'Contract length', theyAsked: 'Monthly', youOffered: '12 months', status: 'agreed' },
            { term: 'Payment terms', theyAsked: 'Net 60', youOffered: '', status: 'finalized??' },
        ],
        trades: [
            { give: 'Annual commitment', get: 'Discounted pricing' },
            { give: 'Onboarding waiver', get: '' },
        ],
        limit: 'Not discussed',
        pathToSignature: [
            { step: 'Legal review', date: 'October 10', owner: 'Their counsel' },
            { step: 'Procurement approval', date: 'N/A' },
            { step: '' },
        ],
    },
    stakeholders: [{ name: 'Priya', role: 'Procurement lead', stance: 'needs_answer' }],
};

describe('sanitizeCoachSummary — demo', () => {
    it('keeps valid reactions and success criteria verbatim', () => {
        const out = sanitizeCoachSummary(DEMO_SUMMARY, 'demo');
        expect(out.demoReview.reactions).toEqual([
            { feature: 'Reporting', verdict: 'landed', quote: 'This is exactly what ops asked for', speaker: 'Dana', timestamp: '12:40' },
        ]);
        expect(out.demoReview.successCriteria).toEqual([
            { metric: 'Report build time', target: 'Under 5 minutes', owner: 'Dana' },
        ]);
        // stakeholders is dead — dropped for every call type, even when the
        // LLM (against the current prompt) still emits it.
        expect(out.stakeholders).toBeUndefined();
        // Untouched summary fields.
        expect(out.overview).toBe(DEMO_SUMMARY.overview);
        expect(out.actionItems).toEqual(DEMO_SUMMARY.actionItems);
        expect(out.nextCallPlaybook.callGoal).toBe('Confirm the pilot success criteria with Dana.');
    });

    it('drops reactions with invalid verdicts or missing quote/speaker entirely', () => {
        const out = sanitizeCoachSummary(DEMO_SUMMARY, 'demo');
        expect(out.demoReview.reactions).toHaveLength(1);
        expect(out.demoReview.reactions[0].feature).toBe('Reporting');
    });
});

describe('sanitizeCoachSummary — negotiation', () => {
    it('keeps valid terms/trades/path steps and drops invalid ones', () => {
        const out = sanitizeCoachSummary(NEGOTIATION_SUMMARY, 'negotiation');
        expect(out.negotiation.terms).toEqual([
            { term: 'Annual price', theyAsked: '20% discount', youOffered: '10% for annual prepay', status: 'leaning' },
            { term: 'Contract length', theyAsked: 'Monthly', youOffered: '12 months', status: 'agreed' },
            // Junk status never upgrades to "agreed" — 'open' claims the least.
            { term: 'Payment terms', theyAsked: 'Net 60', youOffered: '', status: 'open' },
        ]);
        expect(out.negotiation.trades).toEqual([{ give: 'Annual commitment', get: 'Discounted pricing' }]);
        expect(out.negotiation.pathToSignature).toEqual([
            { date: 'October 10', step: 'Legal review', owner: 'Their counsel' },
            { step: 'Procurement approval' },
        ]);
    });

    it('removes placeholder walk-away limits entirely', () => {
        const out = sanitizeCoachSummary(NEGOTIATION_SUMMARY, 'negotiation');
        expect(out.negotiation.limit).toBeUndefined();
        expect('limit' in out.negotiation).toBe(false);
    });

    it('keeps an explicitly stated walk-away limit', () => {
        const out = sanitizeCoachSummary(
            { negotiation: { limit: 'We cannot go below 8% discount.' } },
            'negotiation',
        );
        expect(out.negotiation.limit).toBe('We cannot go below 8% discount.');
    });

    it('drops the whole negotiation block when nothing in it survives', () => {
        const out = sanitizeCoachSummary({ negotiation: { limit: 'N/A', trades: [] } }, 'negotiation');
        expect(out.negotiation).toBeUndefined();
        expect('negotiation' in out).toBe(false);
    });
});

describe('sanitizeCoachSummary — type mismatches', () => {
    it('discovery strips demoReview, stakeholders and negotiation even if the LLM emitted them', () => {
        const out = sanitizeCoachSummary(
            { ...DEMO_SUMMARY, negotiation: NEGOTIATION_SUMMARY.negotiation },
            'discovery',
        );
        expect(out.demoReview).toBeUndefined();
        expect(out.stakeholders).toBeUndefined();
        expect(out.negotiation).toBeUndefined();
        // Common fields survive.
        expect(out.nextCallPlaybook.questionsToAsk).toEqual(DEMO_SUMMARY.nextCallPlaybook.questionsToAsk);
    });

    it('demo strips negotiation; negotiation strips demoReview', () => {
        expect('negotiation' in sanitizeCoachSummary(DEMO_SUMMARY, 'demo')).toBe(false);
        expect('demoReview' in sanitizeCoachSummary(NEGOTIATION_SUMMARY, 'negotiation')).toBe(false);
    });
});

describe('sanitizeCoachSummary — openLoops / promises / callGoal', () => {
    it('drops placeholder concerns and ungrounded suggested answers', () => {
        const out = sanitizeCoachSummary(
            {
                openLoops: [
                    { concern: 'How does pricing work at scale?', suggestedAnswer: 'Tiered from 500 seats.' },
                    { concern: 'N/A' },
                    { concern: '' },
                ],
            },
            'discovery',
        );
        expect(out.openLoops).toEqual([
            { concern: 'How does pricing work at scale?', suggestedAnswer: 'Tiered from 500 seats.' },
        ]);
    });

    it('keeps promises with real text and strips invented owners/dates', () => {
        const out = sanitizeCoachSummary(
            {
                promises: [
                    { text: 'Send the security questionnaire by Friday', owner: 'Me (rep)', dueDate: 'Friday' },
                    { text: 'N/A' },
                    { text: 'Set up the pilot', owner: 'unknown' },
                ],
            },
            'discovery',
        );
        expect(out.promises).toEqual([
            { text: 'Send the security questionnaire by Friday', owner: 'Me (rep)', dueDate: 'Friday' },
            { text: 'Set up the pilot' },
        ]);
    });

    it('removes placeholder call goals and empty lists entirely', () => {
        const out = sanitizeCoachSummary(
            { nextCallPlaybook: { callGoal: 'N/A' }, openLoops: [], promises: [] },
            'discovery',
        );
        expect(out.nextCallPlaybook).toEqual({});
        expect('openLoops' in out).toBe(false);
        expect('promises' in out).toBe(false);
    });
});

describe('sanitizeCoachSummary — backward compatibility', () => {
    it('an old-schema summary passes through unchanged', () => {
        const old = {
            overview: 'The buyer is evaluating the solution.',
            dealStatus: { stage: 'Discovery', summary: 'Initial qualification complete.' },
            bant: {},
            meddicc: {},
            salesCoachReview: { whatIDidRight: [] as string[], whatICouldHaveDoneBetter: [] as string[], whatIMissedCompletely: [] as string[] },
            nextCallPlaybook: {
                openingRecap: 'Recap',
                questionsToAsk: ['Who approves this?', 'What outcome defines success?'],
                valueAndROI: { quantitative: ['Save 10 hrs/week'], qualitative: ['Peace of mind'] },
            },
            keyPoints: ['a'],
            actionItems: ['b'],
            speakerNames: { user: 'Me', client: 'Them' },
        };
        // Old string questions are NOT rewritten.
        expect(sanitizeCoachSummary(old, 'discovery')).toEqual(old);
    });

    it('never mutates the input summary', () => {
        const input = JSON.parse(JSON.stringify(DEMO_SUMMARY));
        sanitizeCoachSummary(input, 'demo');
        expect(input).toEqual(DEMO_SUMMARY);
    });
});

describe('clearForeignCoachBlocks', () => {
    it('blanks the blocks the call type does not own — and stakeholders for every type', () => {
        expect(clearForeignCoachBlocks('demo')).toEqual({ negotiation: undefined, stakeholders: undefined });
        expect(clearForeignCoachBlocks('negotiation')).toEqual({ demoReview: undefined, stakeholders: undefined });
        expect(clearForeignCoachBlocks('discovery')).toEqual({
            demoReview: undefined,
            stakeholders: undefined,
            negotiation: undefined,
        });
    });

    it('undefined values disappear through JSON.stringify — stored keys are removed on merge', () => {
        const merged = { demoReview: [{ feature: 'x' }], ...sanitizeCoachSummary({ keyPoints: [] }, 'negotiation'), ...clearForeignCoachBlocks('negotiation') };
        const round = JSON.parse(JSON.stringify(merged));
        expect('demoReview' in round).toBe(false);
    });
});

describe('sanitizeCoachSummary — whatIDidRight film-review guard', () => {
    it('drops framework-labelled strings and objects (fallback-tier output)', () => {
        const out = sanitizeCoachSummary({
            salesCoachReview: {
                whatIDidRight: [
                    'EconomicBuyer: The prospect will include a senior team member in the demo',
                    'MEDDICC IdentifyPain: The prospect faces cumbersome purchase invoice entry',
                    { time: '09:05', skill: 'Timeline', moment: 'The prospect wants to implement within seven days', why: '' },
                    { time: '08:26', skill: 'Listening', moment: 'let the buyer finish every answer', why: 'the volunteered context became the discovery' },
                    { skill: 'Questioning', moment: '', why: '' },
                    'not a string label-free moment',
                ],
                whatICouldHaveDoneBetter: [],
            },
        } as any, 'discovery');
        expect(out.salesCoachReview.whatIDidRight).toEqual([
            { time: '08:26', skill: 'Listening', moment: 'let the buyer finish every answer', why: 'the volunteered context became the discovery' },
            'not a string label-free moment',
        ]);
    });

    it('keeps "Discovery" as a skill label (not a framework prefix edge case)', () => {
        const out = sanitizeCoachSummary({
            salesCoachReview: { whatIDidRight: [{ skill: 'Discovery', moment: 'uncovered the real workflow', why: 'grounded the pitch' }] },
        } as any, 'discovery');
        expect(out.salesCoachReview.whatIDidRight).toHaveLength(1);
    });

    it('empties the list when everything is framework junk', () => {
        const out = sanitizeCoachSummary({
            salesCoachReview: { whatIDidRight: ['Need: prospect has pain', 'BANT Timeline: wants it fast'] },
        } as any, 'discovery');
        expect(out.salesCoachReview.whatIDidRight).toEqual([]);
    });
});
