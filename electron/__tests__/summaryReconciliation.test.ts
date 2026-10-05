import { describe, expect, it } from 'vitest';

import {
    buildMissingWhatIMissed,
    deriveOpenLoopsFromLiveAnalysis,
    isPlaceholderSummaryItem,
    reconcileBantMeddicWithLiveAnalysis,
} from '../summaryReconciliation';

// The bug this file pins down: on the upload/recovery path the summary's
// reconciliation first runs while liveAnalysisData is still null (no-op), and
// the call analysis is generated afterwards. Once analysis exists, the summary
// must be re-reconciled against it — Call Analysis is the single source of
// truth for BANT/MEDDIC, and Sales Self-Analysis ("What I did right") is
// derived from exactly the confirmed set shown in the Call Analysis tab.

type F = { status: string; evidence: string };
const field = (status: F['status'], evidence: string): F => ({ status, evidence });

const ALL_CONFIRMED: any = {
    bant: {
        budget: field('confirmed', 'Budget of 200k approved'),
        authority: field('confirmed', 'I can approve this myself'),
        need: field('confirmed', 'dispatch is our biggest headache'),
        timeline: field('confirmed', 'we want to go live next quarter'),
    },
    meddic: {
        metrics: field('confirmed', 'cut scheduling time by 40%'),
        economic_buyer: field('confirmed', 'CFO signs off'),
        decision_criteria: field('confirmed', 'ease of setup matters most'),
        decision_process: field('confirmed', 'pilot then two-week eval'),
        identify_pain: field('confirmed', 'spreadsheets fall apart'),
        champion: field('confirmed', 'Daniel will advocate internally'),
        competition: field('confirmed', 'also looking at CompetitorX'),
    },
    objections: [],
    signals: [],
};

// A non-English call: the backend sends the verbatim span plus its readable
// rendering, and the summary's `detail` — which people read in the Summary tab,
// the PDF and the exports — must be the readable one.
const TRANSLATED: any = {
    bant: {
        budget: { status: 'partial', evidence: 'आपकी cost क्या है?', evidence_clean: 'What is your cost?' },
        authority: { status: 'missing', evidence: '' },
        need: field('confirmed', 'dispatch is the headache'),
        timeline: { status: 'missing', evidence: '' },
    },
    meddic: {
        metrics: { status: 'missing', evidence: '' },
        economic_buyer: { status: 'missing', evidence: '' },
        decision_criteria: { status: 'missing', evidence: '' },
        decision_process: { status: 'missing', evidence: '' },
        identify_pain: { status: 'confirmed', evidence: '30 से 40% के पास mobile ही नहीं है', evidence_clean: "30 to 40% of our guards don't have a mobile." },
        champion: { status: 'missing', evidence: '' },
        competition: { status: 'missing', evidence: '' },
    },
    objections: [],
    signals: [],
};

const MIXED: any = {
    bant: {
        budget: field('confirmed', '200k approved'),
        authority: field('partial', 'need CFO sign-off'),
        need: field('confirmed', 'pain is dispatch'),
        timeline: field('missing', ''),
    },
    meddic: {
        metrics: field('confirmed', '40% faster scheduling'),
        economic_buyer: field('partial', 'CFO involved'),
        decision_criteria: field('missing', ''),
        decision_process: field('confirmed', 'pilot then eval'),
        identify_pain: field('confirmed', 'spreadsheets fall apart'),
        champion: field('missing', ''),
        competition: field('partial', 'maybe CompetitorX'),
    },
    objections: [],
    signals: [],
};

describe('reconcileBantMeddicWithLiveAnalysis', () => {
    it('all-confirmed call analysis → BANT/MEDDIC all Clear, film-review highlights survive', () => {
        const highlights = [
            { time: '08:26', skill: 'Listening', moment: 'let the buyer walk through all three pain points', why: 'the volunteered context became the discovery' },
            { time: '16:44', skill: 'Next steps', moment: 'asked for a specific implementation timeline', why: 'surfaced the seven-day urgency' },
        ];
        const llmSummary = {
            actionItems: ['send proposal'],
            keyPoints: ['strong interest'],
            overview: 'Discovery with Daniel.',
            salesCoachReview: {
                whatIDidRight: highlights,
                whatIMissedCompletely: ['Process: never asked about eval steps'],
            },
            meddicc: { gaps: ['decision_process'] },
        };

        const out = reconcileBantMeddicWithLiveAnalysis(llmSummary, ALL_CONFIRMED);

        expect(out.bant.budget).toEqual({ status: 'Clear', detail: 'Budget of 200k approved' });
        expect(out.meddicc.champion).toEqual({ status: 'Clear', detail: 'Daniel will advocate internally' });
        // LLM's gap list survives (it is genuinely a summarization task)…
        expect(out.meddicc.gaps).toEqual(['decision_process']);
        // …and the film-review highlights pass through untouched — the
        // reconciler no longer rebuilds this list from Confirmed fields.
        expect(out.salesCoachReview.whatIDidRight).toEqual(highlights);
        // Other LLM-authored fields are untouched.
        expect(out.salesCoachReview.whatIMissedCompletely).toHaveLength(1);
        expect(out.overview).toBe('Discovery with Daniel.');
        expect(out.keyPoints).toEqual(['strong interest']);
    });

    it('partial/missing metrics reconcile BANT/MEDDIC but leave highlights untouched', () => {
        const highlights = [{ skill: 'Questioning', moment: 'layered the deadline follow-up', why: 'uncovered the real driver' }];
        const out = reconcileBantMeddicWithLiveAnalysis({ salesCoachReview: { whatIDidRight: highlights } }, MIXED);
        expect(out.bant.timeline.status).toBe('Missing');
        expect(out.meddicc.decisionCriteria.status).toBe('Missing');
        expect(out.salesCoachReview.whatIDidRight).toEqual(highlights);
    });

    it('derives gaps from non-confirmed fields when the LLM omitted them', () => {
        const out = reconcileBantMeddicWithLiveAnalysis({}, MIXED);
        expect(out.meddicc.gaps.sort()).toEqual(
            ['economic_buyer', 'decision_criteria', 'competition', 'champion'].sort()
        );
    });

    it('null analysis leaves the LLM summary untouched (live pre-analysis pass)', () => {
        const llm = { actionItems: [] as string[], keyPoints: [] as string[], bant: { budget: { status: 'Partial', detail: 'x' } } };
        expect(reconcileBantMeddicWithLiveAnalysis(llm, null)).toBe(llm);
    });

    it('is idempotent — running it twice produces the same result', () => {
        const once = reconcileBantMeddicWithLiveAnalysis({}, ALL_CONFIRMED);
        const twice = reconcileBantMeddicWithLiveAnalysis(once, ALL_CONFIRMED);
        expect(twice.bant).toEqual(once.bant);
        expect(twice.salesCoachReview.whatIDidRight).toEqual(once.salesCoachReview.whatIDidRight);
    });
});

describe('whatIMissedCompletely fallback (Room to Improve)', () => {
    it('MIXED analysis with empty LLM missed-list derives Missing-field items — section can no longer hide', () => {
        const out = reconcileBantMeddicWithLiveAnalysis(
            { salesCoachReview: { whatIMissedCompletely: [] } },
            MIXED,
        );
        // Missing in MIXED: bant.timeline, meddic.decision_criteria, meddic.champion
        expect(out.salesCoachReview.whatIMissedCompletely).toEqual([
            'MEDDICC DecisionCriteria: Never addressed in this call — follow up next time.',
            'MEDDICC Champion: Never addressed in this call — follow up next time.',
            'BANT Timeline: Never addressed in this call — follow up next time.',
        ]);
    });

    it('placeholder LLM output ("N/A", "None.") falls back to the deterministic list', () => {
        const out = reconcileBantMeddicWithLiveAnalysis(
            { salesCoachReview: { whatIMissedCompletely: ['N/A', 'None.', '—'] } },
            MIXED,
        );
        expect(out.salesCoachReview.whatIMissedCompletely).toHaveLength(3);
        expect(out.salesCoachReview.whatIMissedCompletely[0]).toContain('MEDDICC DecisionCriteria');
    });

    it('substantive LLM items win over the fallback (no clobbering)', () => {
        const llmItems = ['Pain: no pain points were ever explored with the prospect'];
        const out = reconcileBantMeddicWithLiveAnalysis(
            { salesCoachReview: { whatIMissedCompletely: llmItems } },
            MIXED,
        );
        expect(out.salesCoachReview.whatIMissedCompletely).toEqual(llmItems);
    });

    it('all-confirmed analysis derives an empty missed-list (Room to Improve legitimately absent)', () => {
        const out = reconcileBantMeddicWithLiveAnalysis(
            { salesCoachReview: { whatIMissedCompletely: [] } },
            ALL_CONFIRMED,
        );
        expect(out.salesCoachReview.whatIMissedCompletely).toEqual([]);
    });

    it('items starting with "Not"/"No" are NOT placeholders — prefix filtering is gone', () => {
        const llmItems = ['Authority: Not able to identify the decision maker', 'Budget: No budget discussion happened'];
        const out = reconcileBantMeddicWithLiveAnalysis(
            { salesCoachReview: { whatIMissedCompletely: llmItems } },
            MIXED,
        );
        expect(out.salesCoachReview.whatIMissedCompletely).toEqual(llmItems);
    });
});

describe('isPlaceholderSummaryItem', () => {
    it('matches only exact placeholders, with or without trailing punctuation', () => {
        expect(isPlaceholderSummaryItem('n/a')).toBe(true);
        expect(isPlaceholderSummaryItem(' None. ')).toBe(true);
        expect(isPlaceholderSummaryItem('—')).toBe(true);
        expect(isPlaceholderSummaryItem('not discussed')).toBe(true);
        expect(isPlaceholderSummaryItem(undefined)).toBe(true);
        // Real content that the old prefix filter wrongly dropped:
        expect(isPlaceholderSummaryItem('Not able to identify the champion')).toBe(false);
        expect(isPlaceholderSummaryItem('No budget discussion happened')).toBe(false);
        expect(isPlaceholderSummaryItem('None of the pain points were explored')).toBe(false);
    });
});

// ── Coach-ready fields: open loops + additive merge ─────────────────────────

const WITH_OBJECTIONS: any = {
    ...MIXED,
    objections: [
        { type: 'customer_question', quote: 'How does pricing work at scale?', owner: 'customer', status: 'open', suggested_answer: 'Tiered from 500 seats.' },
        // Deferred by the rep — still an open loop.
        { type: 'ae_deferral', quote: 'Can you integrate with our HR system?', owner: 'ae', status: 'deferred' },
        // Resolved during the call (client-owned flag) — must NOT loop.
        { type: 'customer_question', quote: 'Is support included?', owner: 'customer', status: 'open', resolved: true, suggested_answer: 'Yes, 24/7.' },
        // Graded resolved by the v2 end pass — must NOT loop.
        { type: 'customer_question', quote: 'Does it work offline?', owner: 'customer', status: 'open', handled: 'resolved' },
        // Graded partially/unresolved by the v2 end pass — still open.
        { type: 'customer_question', quote: 'What about data migration?', owner: 'customer', status: 'open', handled: 'partially', suggested_answer: 'We offer migration services.' },
    ],
};

describe('deriveOpenLoopsFromLiveAnalysis', () => {
    it('keeps open + deferred objections and excludes resolved ones', () => {
        const loops = deriveOpenLoopsFromLiveAnalysis(WITH_OBJECTIONS);
        expect(loops.map((l) => l.concern)).toEqual([
            'How does pricing work at scale?',
            'Can you integrate with our HR system?',
            'What about data migration?',
        ]);
    });

    it('carries the analysis suggested answer when present', () => {
        const loops = deriveOpenLoopsFromLiveAnalysis(WITH_OBJECTIONS);
        expect(loops[0].suggestedAnswer).toBe('Tiered from 500 seats.');
        expect(loops[1].suggestedAnswer).toBeUndefined();
        expect(loops[2].suggestedAnswer).toBe('We offer migration services.');
    });

    it('returns [] when every objection was resolved', () => {
        expect(
            deriveOpenLoopsFromLiveAnalysis({ ...MIXED, objections: WITH_OBJECTIONS.objections.slice(2, 4) }),
        ).toEqual([]);
    });
});

describe('reconcileBantMeddicWithLiveAnalysis — coach-ready fields', () => {
    it('derives openLoops from the live analysis, replacing LLM-authored ones', () => {
        const out = reconcileBantMeddicWithLiveAnalysis(
            { openLoops: [{ concern: 'Invented concern that never came up' }] },
            WITH_OBJECTIONS,
        );
        expect(out.openLoops).toEqual(deriveOpenLoopsFromLiveAnalysis(WITH_OBJECTIONS));
        expect(out.openLoops).toHaveLength(3);
    });

    it('removes openLoops entirely when every objection was resolved', () => {
        const out = reconcileBantMeddicWithLiveAnalysis(
            { openLoops: [{ concern: 'stale' }] },
            { ...MIXED, objections: WITH_OBJECTIONS.objections.slice(2, 4) },
        );
        expect('openLoops' in out).toBe(false);
    });

    it('preserves every other summary field through the merge (additive, not rebuilt)', () => {
        const summary = {
            overview: 'Demo call.',
            keyPoints: ['reporting landed'],
            actionItems: ['send pilot plan'],
            actionItemsTitle: 'Follow-ups',
            nextCallPlaybook: {
                callGoal: 'Confirm pilot criteria.',
                openingRecap: 'Last time we saw…',
                questionsToAsk: [
                    { question: 'Who signs?', gap: 'Economic Buyer' },
                    'old-style plain string question',
                ],
                valueAndROI: { quantitative: ['5 hours saved'], qualitative: ['less risk'] },
            },
            openLoops: [{ concern: 'replaced by derivation' }],
            demoReview: { reactions: [{ feature: 'Reports', verdict: 'landed', quote: 'love it', speaker: 'Dana' }] },
            stakeholders: [{ name: 'Dana', role: 'Ops', stance: 'champion' }],
            negotiation: { limit: 'no lower than 8%' },
            promises: [{ text: 'Send the security docs', owner: 'rep', dueDate: 'Friday' }],
            someFutureField: { anything: true },
        };
        const out = reconcileBantMeddicWithLiveAnalysis(summary, WITH_OBJECTIONS);
        expect(out.overview).toBe('Demo call.');
        expect(out.keyPoints).toEqual(summary.keyPoints);
        expect(out.actionItems).toEqual(summary.actionItems);
        expect(out.actionItemsTitle).toBe('Follow-ups');
        expect(out.nextCallPlaybook).toEqual(summary.nextCallPlaybook);
        expect(out.demoReview).toEqual(summary.demoReview);
        expect(out.stakeholders).toEqual(summary.stakeholders);
        expect(out.negotiation).toEqual(summary.negotiation);
        expect(out.promises).toEqual(summary.promises);
        expect(out.someFutureField).toEqual({ anything: true });
    });

    it('leaves LLM-authored openLoops untouched when there is no live analysis', () => {
        const llm = { openLoops: [{ concern: 'from transcript alone' }], actionItems: [] as string[], keyPoints: [] as string[] };
        expect(reconcileBantMeddicWithLiveAnalysis(llm, null)).toBe(llm);
    });
});

describe('reconcileBantMeddicWithLiveAnalysis — translated evidence', () => {
    it('writes the readable rendering into detail, not the verbatim span', () => {
        const out = reconcileBantMeddicWithLiveAnalysis({}, TRANSLATED);
        expect(out.bant.budget).toEqual({ status: 'Partial', detail: 'What is your cost?' });
        expect(out.meddicc.identifyPain).toEqual({
            status: 'Clear',
            detail: "30 to 40% of our guards don't have a mobile.",
        });
    });

    it('still uses the verbatim span when no rendering was sent', () => {
        const out = reconcileBantMeddicWithLiveAnalysis({}, TRANSLATED);
        expect(out.bant.need).toEqual({ status: 'Clear', detail: 'dispatch is the headache' });
    });
});

// The current backend contract: each criterion carries a `summary` (its
// assessment) plus a LIST of supporting statements. `detail` is the one line
// people read in the Summary tab, the PDF and the follow-up email, so it takes
// the assessment — the statements are reference material and belong to the
// Call Analysis card's Evidence disclosure, not here.
describe('reconcileBantMeddicWithLiveAnalysis — summary is the source of truth', () => {
    const WITH_SUMMARY: any = {
        bant: {
            budget: {
                status: 'partial',
                summary: 'Pricing has been discussed, but the approved budget is unconfirmed.',
                evidence_clean: 'Pricing has been discussed, but the approved budget is unconfirmed.',
                evidence: ['Pricing discussed was ₹60 per user per month.', 'Considering a 100-user trial.'],
            },
            authority: { status: 'missing', summary: '', evidence: [] },
            // No summary: a row from before the contract changed.
            need: { status: 'confirmed', evidence: ['Adding sites needs approvals.', 'Monthly changes hurt.'] },
            timeline: { status: 'missing', evidence: [] },
        },
        meddic: {
            metrics: { status: 'partial', summary: 'Trial size and pricing are set; no business outcome is defined.', evidence: ['~3,000 employees.'] },
            economic_buyer: { status: 'missing', evidence: [] },
            decision_criteria: { status: 'missing', evidence: [] },
            decision_process: { status: 'missing', evidence: [] },
            identify_pain: { status: 'missing', evidence: [] },
            champion: { status: 'missing', evidence: [] },
            competition: { status: 'missing', evidence: [] },
        },
        objections: [],
        signals: [],
    };

    it('writes the assessment into detail, never the supporting statements', () => {
        const out = reconcileBantMeddicWithLiveAnalysis({}, WITH_SUMMARY);
        expect(out.bant.budget).toEqual({
            status: 'Partial',
            detail: 'Pricing has been discussed, but the approved budget is unconfirmed.',
        });
        expect(out.meddicc.metrics.detail).toBe('Trial size and pricing are set; no business outcome is defined.');
    });

    it('falls back to the joined statements on a row with no summary', () => {
        const out = reconcileBantMeddicWithLiveAnalysis({}, WITH_SUMMARY);
        expect(out.bant.need).toEqual({
            status: 'Clear',
            detail: 'Adding sites needs approvals. Monthly changes hurt.',
        });
    });

    it('carries the assessment into bant and leaves film-review highlights alone', () => {
        const highlights = [{ time: '10:39', skill: 'Questioning', moment: 'probed the mismatch flow', why: 'uncovered the real workflow' }];
        const out = reconcileBantMeddicWithLiveAnalysis({ salesCoachReview: { whatIDidRight: highlights } }, WITH_SUMMARY);
        expect(out.bant.need).toEqual({
            status: 'Clear',
            detail: 'Adding sites needs approvals. Monthly changes hurt.',
        });
        // The reconciler no longer rebuilds whatIDidRight from Confirmed
        // fields — the LLM's film-review highlights pass through untouched.
        expect(out.salesCoachReview.whatIDidRight).toEqual(highlights);
    });
});
