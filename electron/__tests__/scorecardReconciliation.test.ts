// The Meeting Score must never disagree with the Call Analysis tab. Every case
// here is a shape the two can actually be in after a real call.

import { describe, expect, it } from 'vitest';

import type { LiveAnalysisData, MeetingScorecardResult, ScoredCategory } from '../../src/types';
import {
    classifyFrameworkCategory,
    reconcileScorecardWithLiveAnalysis,
    SIGNALS_FOR_FULL_MARKS,
} from '../scorecardReconciliation';

type Status = 'confirmed' | 'partial' | 'missing';

const field = (status: Status, evidence = '') => ({ emoji: '' as const, status, evidence });

/** Live analysis with everything missing; override just what a case is about. */
const liveAnalysis = (over: Partial<LiveAnalysisData> = {}): LiveAnalysisData => ({
    bant: {
        budget: field('missing'),
        authority: field('missing'),
        need: field('missing'),
        timeline: field('missing'),
    },
    meddic: {
        metrics: field('missing'),
        economic_buyer: field('missing'),
        decision_criteria: field('missing'),
        decision_process: field('missing'),
        identify_pain: field('missing'),
        champion: field('missing'),
        competition: field('missing'),
    },
    objections: [],
    signals: [],
    ...over,
});

const category = (over: Partial<ScoredCategory> = {}): ScoredCategory => ({
    categoryName: 'BANT',
    key: 'bant',
    score: 24,
    maxScore: 30,
    weight: 30,
    reasoning: 'the model made this up',
    transcriptEvidence: ['REP: invented quote'],
    strengths: ['invented strength'],
    improvementAreas: [],
    ...over,
});

const scorecard = (categories: ScoredCategory[], over: Record<string, unknown> = {}): MeetingScorecardResult => ({
    detectedTypes: ['discovery'],
    overallWeightedScore: 80,
    scorecards: [
        {
            meetingType: 'discovery',
            overallScore: 80,
            confidenceScore: 95,
            detectedReason: 'discovery questions throughout',
            categoryBreakdown: categories,
            topStrengths: [],
            coachingRecommendations: [],
            ...over,
        },
    ],
});

const catOf = (result: MeetingScorecardResult, index = 0) => result.scorecards[0].categoryBreakdown[index];

describe('classifyFrameworkCategory', () => {
    it('recognises the default discovery and demo framework categories', () => {
        expect(classifyFrameworkCategory('meddic', 'MEDDIC')).toBe('meddic');
        expect(classifyFrameworkCategory('bant', 'BANT')).toBe('bant');
        expect(classifyFrameworkCategory('objection_handling', 'Objection Handling')).toBe('objection_handling');
        expect(classifyFrameworkCategory('buying_intent', 'Buying Intent Signals')).toBe('buying_signals');
    });

    it('recognises a renamed custom label by its key, and a renamed key by its label', () => {
        expect(classifyFrameworkCategory('bant', 'Deal Qualification')).toBe('bant');
        expect(classifyFrameworkCategory('qualification_v2', 'MEDDIC coverage')).toBe('meddic');
    });

    it('leaves categories that merely mention framework topics alone', () => {
        // Negotiation "Preparation" checkpoints cover budget, timeline and
        // decision makers — it must not be hijacked as BANT.
        expect(classifyFrameworkCategory('preparation', 'Preparation')).toBeNull();
        expect(classifyFrameworkCategory('value_creation', 'Value Creation')).toBeNull();
        expect(classifyFrameworkCategory('competitive_positioning', 'Competitive Positioning')).toBeNull();
        expect(classifyFrameworkCategory(undefined, undefined)).toBeNull();
    });
});

describe('reconcileScorecardWithLiveAnalysis — BANT and MEDDIC', () => {
    it('scores BANT straight off the live-analysis statuses', () => {
        // 1 confirmed + 1 partial out of 4 → 1.5/4 of 30 = 11.25 → 11
        const live = liveAnalysis({
            bant: {
                budget: field('confirmed', 'we have 50k approved for this'),
                authority: field('partial', 'needs the VP to sign off'),
                need: field('missing'),
                timeline: field('missing'),
            },
        });

        const out = reconcileScorecardWithLiveAnalysis(scorecard([category()]), live);
        const cat = catOf(out);

        expect(cat.score).toBe(11);
        expect(cat.reasoning).toContain('1 of 4 components confirmed');
        expect(cat.transcriptEvidence).toEqual([
            'Budget: we have 50k approved for this',
            'Authority: needs the VP to sign off',
        ]);
        expect(cat.strengths).toEqual(['Budget confirmed — we have 50k approved for this']);
        expect(cat.improvementAreas).toContain('Need was never established on this call.');
    });

    it('scores MEDDIC over all seven components, matching the rows Call Analysis renders', () => {
        const live = liveAnalysis();
        live.meddic.metrics = field('confirmed', '20 hours a week wasted');
        live.meddic.identify_pain = field('confirmed', 'the manual handoff breaks weekly');

        const out = reconcileScorecardWithLiveAnalysis(
            scorecard([category({ key: 'meddic', categoryName: 'MEDDIC', maxScore: 40, weight: 40, score: 36 })]),
            live,
        );

        // 2 of 7 confirmed → 2/7 of 40 = 11.4 → 11
        expect(catOf(out).score).toBe(11);
        expect(catOf(out).reasoning).toContain('2 of 7 components confirmed');
    });

    it('gives full marks only when every component is confirmed', () => {
        const live = liveAnalysis({
            bant: {
                budget: field('confirmed', 'a'),
                authority: field('confirmed', 'b'),
                need: field('confirmed', 'c'),
                timeline: field('confirmed', 'd'),
            },
        });

        expect(catOf(reconcileScorecardWithLiveAnalysis(scorecard([category({ score: 4 })]), live)).score).toBe(30);
    });
});

describe('reconcileScorecardWithLiveAnalysis — objections and signals', () => {
    const objectionCat = category({
        key: 'objection_handling',
        categoryName: 'Objection Handling',
        score: 21,
        maxScore: 30,
        weight: 30,
    });

    it('zeroes objection handling when the Objections tab is empty', () => {
        const out = reconcileScorecardWithLiveAnalysis(scorecard([objectionCat]), liveAnalysis());
        const cat = catOf(out);

        expect(cat.score).toBe(0);
        expect(cat.reasoning).toContain('No objections were tracked');
        expect(cat.transcriptEvidence).toEqual([]);
    });

    it('credits resolved objections fully and deferred ones by half', () => {
        const live = liveAnalysis({
            objections: [
                { type: 'customer_question', quote: 'too expensive', owner: 'customer', status: 'open', resolved: true },
                { type: 'ae_deferral', quote: 'ill check on SSO', owner: 'ae', status: 'deferred' },
                { type: 'customer_question', quote: 'what about migration', owner: 'customer', status: 'open' },
            ],
        });

        const cat = catOf(reconcileScorecardWithLiveAnalysis(scorecard([objectionCat]), live));

        // (1 + 0.5) / 3 of 30 = 15
        expect(cat.score).toBe(15);
        expect(cat.transcriptEvidence).toEqual([
            'Resolved: too expensive',
            'Deferred: ill check on SSO',
            'Open: what about migration',
        ]);
        expect(cat.improvementAreas.some(a => a.includes('never addressed'))).toBe(true);
    });

    it('scores buying intent off the positive signals only', () => {
        const live = liveAnalysis({
            signals: [
                { quote: 'we want this live by Q3', signal_type: ['urgency'], ask_now: '', intensity: 'high', category: 'positive' },
                { quote: 'my team would use this daily', signal_type: ['value'], ask_now: '', intensity: 'medium', category: 'positive' },
                { quote: 'not sure about the price', signal_type: ['risk'], ask_now: '', intensity: 'low', category: 'negative' },
            ],
        });

        const buyingCat = category({
            key: 'buying_intent',
            categoryName: 'Buying Intent Signals',
            score: 9,
            maxScore: 10,
            weight: 10,
        });
        const cat = catOf(reconcileScorecardWithLiveAnalysis(scorecard([buyingCat]), live));

        // 2 positive of the 3 needed for full marks → 2/3 of 10 = 6.67 → 7
        expect(cat.score).toBe(Math.round((2 / SIGNALS_FOR_FULL_MARKS) * 10));
        expect(cat.transcriptEvidence).toEqual(['we want this live by Q3', 'my team would use this daily']);
        expect(cat.improvementAreas.some(a => a.includes('not sure about the price'))).toBe(true);
    });
});

describe('reconcileScorecardWithLiveAnalysis — safety and headline numbers', () => {
    it('leaves custom categories exactly as the model scored them', () => {
        const custom = category({
            key: 'discount_management',
            categoryName: 'Discount Management',
            score: 17,
            maxScore: 20,
            weight: 20,
            reasoning: 'held the line on price',
            transcriptEvidence: ['REP: our list price is firm'],
            strengths: ['anchored on value'],
            improvementAreas: ['ask for something in return'],
        });

        const out = reconcileScorecardWithLiveAnalysis(scorecard([custom]), liveAnalysis());
        expect(catOf(out)).toEqual(custom);
    });

    it('is a no-op when there is no live analysis to ground against', () => {
        const input = scorecard([category()]);
        expect(reconcileScorecardWithLiveAnalysis(input, null)).toBe(input);
        expect(reconcileScorecardWithLiveAnalysis(input, undefined)).toBe(input);
    });

    it('is a no-op for a scorecard with no recognised category', () => {
        const input = scorecard([category({ key: 'personalization', categoryName: 'Personalization' })]);
        expect(reconcileScorecardWithLiveAnalysis(input, liveAnalysis())).toBe(input);
    });

    it('recomputes the headline scores so they match the rows below them', () => {
        const live = liveAnalysis({
            bant: {
                budget: field('confirmed', 'signed off'),
                authority: field('confirmed', 'CFO is in'),
                need: field('missing'),
                timeline: field('missing'),
            },
        });

        const out = reconcileScorecardWithLiveAnalysis(
            scorecard([
                category(),                                                    // bant → 15/30
                category({ key: 'objection_handling', categoryName: 'Objection Handling', maxScore: 30, weight: 30 }), // → 0/30
                category({ key: 'personalization', categoryName: 'Personalization', score: 20, maxScore: 40, weight: 40 }), // untouched
            ]),
            live,
        );

        // 15/30*30 + 0 + 20/40*40 = 15 + 20 = 35
        expect(out.scorecards[0].overallScore).toBe(35);
        expect(out.overallWeightedScore).toBe(35);
    });

    it('survives a malformed live-analysis payload without throwing', () => {
        const broken = { objections: null, signals: undefined } as unknown as LiveAnalysisData;
        const out = reconcileScorecardWithLiveAnalysis(scorecard([category()]), broken);

        expect(catOf(out).score).toBe(0);
        expect(catOf(out).reasoning).toContain('0 of 4 components confirmed');
    });
});
