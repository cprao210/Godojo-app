import { describe, expect, it } from 'vitest';

import { buildCoachCallTypeSection, buildSummaryPrompt, BANT_MEDDICC_OUTPUT_SCHEMA } from '../llm/summaryPrompt';
import { GROQ_SUMMARY_JSON_PROMPT, SUMMARY_VERIFICATION_PROMPT } from '../llm/prompts';

// The summary output contract is duplicated across prompt variants that must
// stay in step: the main prompt (with and without live analysis), the compact
// Groq prompt, and the shared call-type section appended to all of them. These
// tests pin that a given call type asks for exactly the right blocks.

const LA: any = {
    bant: {
        budget: { status: 'confirmed', evidence: 'Budget of 200k approved' },
        authority: { status: 'partial', evidence: 'CFO mentioned' },
        need: { status: 'confirmed', evidence: 'dispatch pain' },
        timeline: { status: 'missing', evidence: '' },
    },
    meddic: {
        metrics: { status: 'confirmed', evidence: '40% faster' },
        economic_buyer: { status: 'missing', evidence: '' },
        decision_criteria: { status: 'missing', evidence: '' },
        decision_process: { status: 'missing', evidence: '' },
        identify_pain: { status: 'confirmed', evidence: 'spreadsheets' },
        champion: { status: 'missing', evidence: '' },
        competition: { status: 'missing', evidence: '' },
    },
    objections: [
        { type: 'customer_question', quote: 'How does pricing work at scale?', owner: 'customer', status: 'open', suggested_answer: 'Tiered from 500 seats.' },
    ],
    signals: [],
};

describe('deal block (read by the backend to keep the deal up to date)', () => {
    it.each(['discovery', 'demo', 'negotiation'] as const)('every prompt variant for a %s call asks for it', (callType) => {
        for (const prompt of [
            buildCoachCallTypeSection(callType),
            buildSummaryPrompt(null, null, callType),
        ]) {
            expect(prompt).toContain('"deal": {');
            for (const field of ['"stage"', '"amount"', '"currency"', '"expectedCloseDate"', '"competitors"', '"people"', '"nextSteps"']) {
                expect(prompt).toContain(field);
            }
            expect(prompt).toContain('Closed Won / Closed Lost / Unknown');
            expect(prompt).toContain('never estimate it from a budget range');
            // sanitizeCoachSummary strips a top-level `stakeholders`; the prompt must not ask for one.
            expect(prompt).not.toContain('"stakeholders"');
        }
    });
});

describe('buildCoachCallTypeSection', () => {
    it('discovery asks for no type-specific blocks', () => {
        const section = buildCoachCallTypeSection('discovery');
        expect(section).toContain('CALL TYPE: DISCOVERY');
        expect(section).not.toContain('"demoReview"');
        expect(section).not.toContain('"negotiation"');
        expect(section).not.toContain('"stakeholders"');
        // Common coaching fields are still described.
        expect(section).toContain('"openLoops"');
        expect(section).toContain('"promises"');
        expect(section).toContain('callGoal');
    });

    it('demo asks for demoReview only — never negotiation or stakeholders', () => {
        const section = buildCoachCallTypeSection('demo');
        expect(section).toContain('CALL TYPE: DEMO');
        expect(section).toContain('"demoReview"');
        expect(section).toContain('"successCriteria"');
        // stakeholders is no longer generated — nothing consumes it.
        expect(section).not.toContain('"stakeholders"');
        expect(section).not.toContain('"negotiation"');
        expect(section).not.toContain('"pathToSignature"');
        // Verbatim-quote + no-silence-as-positive rules for demo reactions.
        expect(section).toContain('verbatim');
        expect(section).toContain('silence or politeness is NOT positive feedback');
    });

    it('negotiation asks for negotiation only — never demoReview or stakeholders', () => {
        const section = buildCoachCallTypeSection('negotiation');
        expect(section).toContain('CALL TYPE: NEGOTIATION');
        expect(section).toContain('"negotiation"');
        expect(section).toContain('"pathToSignature"');
        expect(section).toContain('"trades"');
        expect(section).not.toContain('"stakeholders"');
        expect(section).not.toContain('"demoReview"');
        // The walk-away limit rule: only when the rep explicitly states it.
        expect(section).toContain('EXPLICITLY stated walk-away');
        expect(section).toContain('omit "limit" entirely');
        // Proposed ≠ agreed.
        expect(section).toContain('Discussing a term is NOT agreeing to it');
    });

    it('labels the section per call type without referencing deal stage', () => {
        for (const callType of ['discovery', 'demo', 'negotiation'] as const) {
            const section = buildCoachCallTypeSection(callType);
            expect(section).toContain(`CALL TYPE: ${callType.toUpperCase()}`);
            expect(section).not.toContain('dealStatus');
        }
    });
});

describe('buildSummaryPrompt', () => {
    it('defaults to discovery when no call type is given', () => {
        expect(buildSummaryPrompt()).toContain('CALL TYPE: DISCOVERY');
        expect(buildSummaryPrompt(null, null)).toContain('CALL TYPE: DISCOVERY');
    });

    it.each(['demo', 'negotiation'] as const)(
        'with live analysis, a %s call asks only for %s blocks',
        (callType) => {
            const prompt = buildSummaryPrompt(LA, null, callType);
            expect(prompt).toContain(`CALL TYPE: ${callType.toUpperCase()}`);
            expect(prompt).toContain('LIVE ANALYSIS — AUTHORITATIVE BANT + MEDDIC DATA');
            if (callType === 'demo') {
                expect(prompt).toContain('"demoReview"');
                expect(prompt).not.toContain('"pathToSignature"');
            } else {
                expect(prompt).toContain('"pathToSignature"');
                expect(prompt).not.toContain('"demoReview"');
            }
        },
    );

    it.each(['discovery', 'demo', 'negotiation'] as const)(
        'without live analysis, a %s call still gets the call-type section',
        (callType) => {
            const prompt = buildSummaryPrompt(null, null, callType);
            expect(prompt).toContain(`CALL TYPE: ${callType.toUpperCase()}`);
            expect(prompt).not.toContain('LIVE ANALYSIS — AUTHORITATIVE');
        },
    );

    it('describes callGoal and the structured questionsToAsk format in every variant', () => {
        for (const prompt of [buildSummaryPrompt(LA, null, 'demo'), buildSummaryPrompt(null, null, 'negotiation')]) {
            expect(prompt).toContain('"callGoal"');
            expect(prompt).toContain('"questionsToAsk"');
            expect(prompt).toContain('"gap"');
            expect(prompt).toContain('omit \\"gap\\" when the link is unclear');
        }
    });

    it('renders objection status + suggested answer so open loops can be grounded', () => {
        const prompt = buildSummaryPrompt(LA, null, 'discovery');
        expect(prompt).toContain('How does pricing work at scale? (open)');
        expect(prompt).toContain('suggested answer: Tiered from 500 seats.');
    });

    it('marks objections the rep resolved so they are not treated as open', () => {
        const la = {
            ...LA,
            objections: [
                { type: 'customer_question', quote: 'Is onboarding included?', owner: 'customer', status: 'open', handled: 'resolved' },
            ],
        };
        const prompt = buildSummaryPrompt(la, null, 'discovery');
        expect(prompt).toContain('Is onboarding included? (open, handled:resolved)');
        // No suggested answer is offered for a resolved objection.
        expect(prompt).not.toContain('suggested answer:');
    });
});

describe('GROQ_SUMMARY_JSON_PROMPT — same output contract', () => {
    it('base Groq schema describes callGoal and structured questionsToAsk', () => {
        expect(GROQ_SUMMARY_JSON_PROMPT).toContain('"callGoal"');
        expect(GROQ_SUMMARY_JSON_PROMPT).toContain('"question"');
        expect(GROQ_SUMMARY_JSON_PROMPT).toContain('"gap"');
    });

    it('base Groq schema omits bant/meddicc — appended only when no live analysis exists', () => {
        expect(GROQ_SUMMARY_JSON_PROMPT).not.toContain('"bant"');
        expect(GROQ_SUMMARY_JSON_PROMPT).not.toContain('"meddicc"');
        // The conditional fallback block lives in BANT_MEDDICC_OUTPUT_SCHEMA.
        expect(BANT_MEDDICC_OUTPUT_SCHEMA).toContain('"bant": {');
        expect(BANT_MEDDICC_OUTPUT_SCHEMA).toContain('"gaps"');
    });
});

describe('SUMMARY_VERIFICATION_PROMPT — new-field checks', () => {
    it('verifies the coaching fields without changing the response format', () => {
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('"confidence": 0-100');
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('"issues"');
        for (const marker of [
            'nextCallPlaybook.callGoal',
            'openLoops.concern',
            'promises',
            'demoReview.reactions',
            'negotiation.terms',
            'negotiation.limit',
            'negotiation.pathToSignature',
        ]) {
            expect(SUMMARY_VERIFICATION_PROMPT).toContain(marker);
        }
        // Walk-away limits and verbatim quotes get explicit fabrication checks.
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('EXPLICITLY stated walk-away point');
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('VERBATIM');
        // Placeholder-filling is flagged.
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('"N/A", "Unknown", "Not discussed"');
        // Existing checks are untouched.
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('BANT/MEDDICC status marked Clear/Confirmed');
    });
});

describe('salesCoachReview — conversation-quality coaching contract', () => {
    it('both buildSummaryPrompt variants ask for skill-area labels, not framework labels', () => {
        for (const prompt of [buildSummaryPrompt(null, null, 'negotiation'), buildSummaryPrompt(LA, null, 'demo')]) {
            expect(prompt).toContain('skill-area label');
            expect(prompt).toContain('OVERALL quality of the sales conversation');
            expect(prompt).toContain('Objection handling:');
            expect(prompt).toContain('Do NOT output "whatIMissedCompletely"');
            // Framework-labelled coaching and the missed-completely schema are gone.
            expect(prompt).not.toContain('MEDDICC [ComponentName]');
            expect(prompt).not.toContain('"whatIMissedCompletely": [');
        }
    });

    it('GROQ prompt carries the same coaching contract', () => {
        expect(GROQ_SUMMARY_JSON_PROMPT).toContain('skill-area label');
        expect(GROQ_SUMMARY_JSON_PROMPT).toContain('OVERALL quality of the sales conversation');
        expect(GROQ_SUMMARY_JSON_PROMPT).not.toContain('"whatIMissedCompletely": [');
    });

    it('the verifier grades coaching quality, not framework coverage', () => {
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('NOT BANT/MEDDICC component names');
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('practical next-time guidance');
    });
});

describe('salesCoachReview — film-review highlights for whatIDidRight', () => {
    it('both buildSummaryPrompt variants ask for highlight objects about REP behavior', () => {
        for (const prompt of [buildSummaryPrompt(null, null, 'discovery'), buildSummaryPrompt(LA, null, 'negotiation')]) {
            expect(prompt).toContain('film-review HIGHLIGHT OBJECTS');
            expect(prompt).toContain('"moment"');
            expect(prompt).toContain('"why"');
            expect(prompt).toContain("never the prospect's attributes and never deal facts");
            expect(prompt).toContain('NEVER use BANT/MEDDICC component names');
            expect(prompt).toContain('No two items may describe the same moment');
        }
    });

    it('GROQ prompt carries the same film-review contract', () => {
        expect(GROQ_SUMMARY_JSON_PROMPT).toContain('film-review HIGHLIGHT OBJECTS');
        expect(GROQ_SUMMARY_JSON_PROMPT).toContain('"moment"');
        expect(GROQ_SUMMARY_JSON_PROMPT).toContain('"why"');
    });

    it('the verifier grades highlight objects, not framework wins', () => {
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('objects with time/skill/moment/why');
        expect(SUMMARY_VERIFICATION_PROMPT).toContain('duplicated moments');
    });
});

describe('bant/meddicc output schema — only without live analysis', () => {
    it('LA variant does not ask the LLM to echo bant/meddicc (reconciliation owns them)', () => {
        const prompt = buildSummaryPrompt(LA, null, 'discovery');
        expect(prompt).not.toContain('"bant": {');
        expect(prompt).not.toContain('"meddicc": {');
        expect(prompt).toContain('Do NOT include');
        expect(prompt).toContain('"bant" or "meddicc"');
        // The live-analysis INPUT data is still there to ground reasoning.
        expect(prompt).toContain('LIVE ANALYSIS');
    });

    it('no-LA variant keeps the schema as the analysis-failure fallback', () => {
        const prompt = buildSummaryPrompt(null, null, 'discovery');
        expect(prompt).toContain('"bant": {');
        expect(prompt).toContain('"meddicc": {');
        expect(prompt).toContain('"gaps"');
    });
});

describe('dead keys dropped from the generation contract', () => {
    it('no variant asks for dealStatus or followUpEmail', () => {
        for (const prompt of [buildSummaryPrompt(LA, null, 'demo'), buildSummaryPrompt(null, null, 'negotiation')]) {
            expect(prompt).not.toContain('dealStatus');
            expect(prompt).not.toContain('followUpEmail');
        }
        // The Groq overview line says "deal status" in prose — assert on the
        // quoted JSON keys instead.
        expect(GROQ_SUMMARY_JSON_PROMPT).not.toContain('"dealStatus"');
        expect(GROQ_SUMMARY_JSON_PROMPT).not.toContain('"followUpEmail"');
    });
});
