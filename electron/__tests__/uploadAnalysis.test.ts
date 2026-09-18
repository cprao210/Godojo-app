import { describe, expect, it } from 'vitest';

import { buildUploadAnalysisPrompt, normalizeUploadAnalysis } from '../utils/uploadAnalysis';
import { stableId } from '../../src/lib/objections';

const qual = (status: string, evidence = status === 'missing' ? '' : 'they have 200k approved', question?: string) => ({
    status, evidence, suggested_question: question ?? '',
});

describe('buildUploadAnalysisPrompt', () => {
    it('exposes the backend objection taxonomy, signal catalogue and ask-this rule in both modes', () => {
        for (const negotiation of [false, true]) {
            const p = buildUploadAnalysisPrompt(negotiation);
            expect(p).toContain('budget_pricing|timing|authority|competitor|product_fit|trust_risk|contract_terms|technical_integration|need_to_think|other');
            expect(p).toContain('buying_intent');
            expect(p).toContain('stall_signal');
            expect(p).toContain('process_signal');
            expect(p).toContain('NO QUOTE = NO STATUS');
            expect(p).toContain('"" ONLY when status is "confirmed"');
            expect(p).toContain('ae_deferral');
        }
    });

    it('physically excludes the dealOptimizer section unless negotiation is flagged (backend prompt behaviour)', () => {
        const noNeg = buildUploadAnalysisPrompt(false);
        expect(noNeg).not.toContain('dealOptimizer');
        expect(noNeg).not.toContain('SECTION 4');

        const neg = buildUploadAnalysisPrompt(true);
        expect(neg).toContain('SECTION 4: DEAL OPTIMIZER');
        for (const trigger of ['pricing_objection', 'discount_request', 'competitor_comparison', 'procurement_pressure', 'budget_concern', 'closing_signal']) {
            expect(neg).toContain(trigger);
        }
        expect(neg).toContain('NEVER recommend a discount as the first move');
    });
});

describe('normalizeUploadAnalysis — BANT/MEDDIC', () => {
    it('missing fields get ❌ and the backend generic fallback question', () => {
        const out = normalizeUploadAnalysis({}, false);
        expect(out.bant.budget.status).toBe('missing');
        expect(out.bant.budget.emoji).toBe('❌');
        expect(out.bant.budget.suggested_question).toBe('Do you have a budget allocated for this initiative?');
        expect(out.meddic.champion.suggested_question).toBe('Who internally is championing this initiative?');
        expect(out.meddic.economic_buyer.status).toBe('missing');
    });

    it('confirmed fields NEVER carry an ask-this recommendation', () => {
        const out = normalizeUploadAnalysis({
            bant: { budget: qual('confirmed', 'we have 200k approved', 'What is your budget?') },
        }, false);
        expect(out.bant.budget.suggested_question).toBe('');
        expect(out.bant.budget.emoji).toBe('✅');
        expect(out.bant.budget.evidence).toBe('we have 200k approved');
    });

    it('NO QUOTE = NO STATUS: unevidenced claims downgrade to missing, question kept or filled', () => {
        const out = normalizeUploadAnalysis({
            bant: { timeline: qual('confirmed', '', 'anything'), need: qual('partial', '') },
        }, false);
        expect(out.bant.timeline.status).toBe('missing');
        expect(out.bant.timeline.emoji).toBe('❌');
        // A downgraded field keeps the question the model already supplied —
        // the backend's ensure_suggested_questions only fills EMPTY questions.
        expect(out.bant.timeline.suggested_question).toBe('anything');
        // …and one that never had a question gets the generic fallback.
        expect(out.bant.need.status).toBe('missing');
        expect(out.bant.need.suggested_question).toBe("What's the main problem you're hoping to solve?");
    });

    it('partial fields keep their specific question and ⚠️', () => {
        const out = normalizeUploadAnalysis({
            meddic: { metrics: qual('partial', 'cut scheduling by 40%', 'Which KPI would you track?') },
        }, false);
        expect(out.meddic.metrics.status).toBe('partial');
        expect(out.meddic.metrics.emoji).toBe('⚠️');
        expect(out.meddic.metrics.suggested_question).toBe('Which KPI would you track?');
    });

    it('clamps long evidence to 300 chars at the last sentence boundary', () => {
        const long = 'A'.repeat(200) + '. ' + 'B'.repeat(200);
        const out = normalizeUploadAnalysis({ bant: { need: qual('confirmed', long) } }, false);
        expect(out.bant.need.evidence.length).toBeLessThanOrEqual(300);
        expect(out.bant.need.evidence.endsWith('.')).toBe(true);
    });
});

describe('normalizeUploadAnalysis — objections', () => {
    it('valid category gets its backend label; high confidence clears needs_review', () => {
        const out = normalizeUploadAnalysis({
            objections: [{ type: 'customer_question', quote: 'this feels expensive', owner: 'customer', status: 'open', suggested_answer: 'cheaper per user', category: 'budget_pricing', confidence: 0.8 }],
        }, false);
        expect(out.objections[0].category).toBe('budget_pricing');
        expect(out.objections[0].category_label).toBe('Budget / Pricing');
        expect(out.objections[0].needs_review).toBe(false);
        expect(out.objections[0].id).toBe(stableId('this feels expensive'));
    });

    it('unknown category behaves like a classifier miss: blank, confidence 0, needs_review', () => {
        const out = normalizeUploadAnalysis({
            objections: [{ quote: 'we will think about it', category: 'pricing_too_high', confidence: 0.9 }],
        }, false);
        expect(out.objections[0].category).toBe('');
        expect(out.objections[0].category_label).toBe('');
        expect(out.objections[0].confidence).toBe(0);
        expect(out.objections[0].needs_review).toBe(true);
    });

    it('low-confidence known category still needs review (0.55 threshold)', () => {
        const out = normalizeUploadAnalysis({
            objections: [{ quote: 'is SOC2 available', category: 'trust_risk', confidence: 0.4 }],
        }, false);
        expect(out.objections[0].needs_review).toBe(true);
    });

    it('ae_deferral is AE-owned with no suggested answer; customer_question always customer-owned', () => {
        const out = normalizeUploadAnalysis({
            objections: [
                { type: 'ae_deferral', quote: 'I will send the security review', owner: 'ae', status: 'deferred', suggested_answer: 'should not exist' },
                { type: 'customer_question', quote: 'what about onboarding', owner: 'ae', suggested_answer: 'painless rollout' },
            ],
        }, false);
        expect(out.objections[0]).toMatchObject({ type: 'ae_deferral', owner: 'ae', status: 'deferred', suggested_answer: '' });
        expect(out.objections[1]).toMatchObject({ owner: 'customer', suggested_answer: 'painless rollout' });
    });

    it('dedupes identical concerns and keeps the resolved flag; objection quotes are NOT clamped', () => {
        const long = 'C'.repeat(400);
        const out = normalizeUploadAnalysis({
            objections: [
                { quote: 'Do you integrate with SAP?', resolved: true },
                { quote: 'do you integrate with SAP?  ' }, // same_quote, different case/whitespace
                { quote: long },
            ],
        }, false);
        expect(out.objections).toHaveLength(2);
        expect(out.objections[0].resolved).toBe(true);
        expect(out.objections[1].quote).toHaveLength(400);
    });
});

describe('normalizeUploadAnalysis — signals + dealOptimizer gate', () => {
    it('strips catalogue-invalid signal types and drops signals left empty', () => {
        const out = normalizeUploadAnalysis({
            signals: [
                { quote: 'we want to move fast', signal_type: ['buying_intent', 'urgency', 'positive', 'nonsense'] },
                { quote: 'hmm', signal_type: ['objection'] }, // old prompt enum — invalid, drops
            ],
        }, false);
        expect(out.signals).toHaveLength(1);
        expect(out.signals[0].signal_type).toEqual(['buying_intent', 'urgency']);
        expect(out.signals[0].category).toBe('positive');
        expect(out.signals[0].id).toBe(stableId('we want to move fast'));
    });

    it('hard-gates dealOptimizer off for non-negotiation calls, even if the model emits alerts', () => {
        const raw = { dealOptimizer: [{ trigger: 'discount_request', quote: 'can you do anything on price?', headline: 'price push', moves: ['lead with value', 'trade term for rate'], intensity: 'high' }] };
        expect(normalizeUploadAnalysis(raw, false).dealOptimizer).toEqual([]);

        const neg = normalizeUploadAnalysis(raw, true);
        expect(neg.dealOptimizer).toHaveLength(1);
        expect(neg.dealOptimizer![0]).toMatchObject({ trigger: 'discount_request', headline: 'price push', anchor: '' });
        expect(neg.dealOptimizer![0]!.id).toBe(stableId('can you do anything on price?'));
    });

    it('drops invalid triggers, caps moves at three, defaults intensity', () => {
        const out = normalizeUploadAnalysis({
            dealOptimizer: [
                { trigger: 'margin_pressure', quote: 'x', moves: ['a', 'b', 'c', 'd'] },
                { trigger: 'budget_concern', quote: 'budget is tight', moves: [] },
            ],
        }, true);
        expect(out.dealOptimizer).toHaveLength(1);
        expect(out.dealOptimizer![0]!.moves).toEqual([]);
        expect(out.dealOptimizer![0]!.intensity).toBe('medium');
    });
});
