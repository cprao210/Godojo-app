import { describe, expect, it } from 'vitest';

import {
    buildConfirmedWhatIDidRight,
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
    it('all-confirmed call analysis → summary BANT/MEDDIC all Clear and 11 self-analysis wins', () => {
        const llmSummary = {
            actionItems: ['send proposal'],
            keyPoints: ['strong interest'],
            overview: 'Discovery with Daniel.',
            salesCoachReview: {
                // The LLM's conservative, capped cherry-pick — this is what
                // made Sales Self-Analysis disagree with the fully-confirmed
                // Call Analysis.
                whatIDidRight: ['BANT Need: uncovered dispatch pain', 'MEDDICC Metrics: ROI discussed'],
                whatIMissedCompletely: ['Process: never asked about eval steps'],
            },
            meddicc: { gaps: ['decision_process'] },
        };

        const out = reconcileBantMeddicWithLiveAnalysis(llmSummary, ALL_CONFIRMED);

        expect(out.bant.budget).toEqual({ status: 'Clear', detail: 'Budget of 200k approved' });
        expect(out.meddicc.champion).toEqual({ status: 'Clear', detail: 'Daniel will advocate internally' });
        // LLM's gap list survives (it is genuinely a summarization task)…
        expect(out.meddicc.gaps).toEqual(['decision_process']);
        // …but the wins list is rebuilt from the confirmed set: 7 MEDDICC
        // first, then 4 BANT.
        expect(out.salesCoachReview.whatIDidRight).toHaveLength(11);
        expect(out.salesCoachReview.whatIDidRight[0]).toBe('MEDDICC Metrics: cut scheduling time by 40%');
        expect(out.salesCoachReview.whatIDidRight[6]).toBe('MEDDICC Competition: also looking at CompetitorX');
        expect(out.salesCoachReview.whatIDidRight[7]).toBe('BANT Budget: Budget of 200k approved');
        expect(out.salesCoachReview.whatIDidRight[10]).toBe('BANT Timeline: we want to go live next quarter');
        // Other LLM-authored fields are untouched.
        expect(out.salesCoachReview.whatIMissedCompletely).toHaveLength(1);
        expect(out.overview).toBe('Discovery with Daniel.');
        expect(out.keyPoints).toEqual(['strong interest']);
    });

    it('partial/missing metrics downgrade self-analysis to the confirmed subset', () => {
        const out = reconcileBantMeddicWithLiveAnalysis({}, MIXED);
        // confirmed in MIXED: bant.budget, bant.need, meddic.metrics,
        // meddic.decision_process, meddic.identify_pain → 5 wins, not 11.
        expect(out.salesCoachReview.whatIDidRight).toHaveLength(5);
        expect(out.bant.timeline.status).toBe('Missing');
        expect(out.meddicc.decisionCriteria.status).toBe('Missing');
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

describe('buildConfirmedWhatIDidRight', () => {
    it('empty details still render labelled items from the confirmed set', () => {
        const items = buildConfirmedWhatIDidRight(
            { budget: { status: 'Clear', detail: '' } } as any,
            {}
        );
        expect(items).toEqual(['BANT Budget: ']);
    });
});
