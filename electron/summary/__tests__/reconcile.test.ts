/**
 * Behaviour lock for reconcileBantMeddicWithLiveAnalysis, in particular the
 * whatIDidRight change: it now FILTERS the LLM's own rep-behaviour text down to
 * the components whose reconciled status is Clear, instead of SYNTHESIZING the
 * text from liveAnalysis.evidence — which is a prospect quote, so the section
 * used to render the customer's words as the rep's achievements.
 */
import { describe, it, expect } from 'vitest';

const field = (status: string, evidence: string) => ({ emoji: '', status, evidence } as any);

const live: any = {
    bant: {
        budget: field('confirmed', 'We have forty thousand approved for this.'),
        authority: field('partial', 'I would need to loop in my VP.'),
        need: field('confirmed', 'The manual reconciliation is killing us.'),
        timeline: field('missing', ''),
    },
    meddic: {
        metrics: field('confirmed', 'It takes us 40 hours a month.'),
        economic_buyer: field('missing', ''),
        decision_criteria: field('partial', 'Integration matters most.'),
        decision_process: field('missing', ''),
        identify_pain: field('confirmed', 'Month-end close slips by a week.'),
        champion: field('missing', ''),
        competition: field('missing', ''),
    },
    objections: [],
    signals: [],
};

const loadReconcile = async () => {
    const mod = await import('../reconcile');
    return mod.reconcileBantMeddicWithLiveAnalysis;
};

describe('reconcileBantMeddicWithLiveAnalysis', () => {
    it('is a no-op when there is no live analysis', async () => {
        const reconcile = await loadReconcile();
        const input = { keyPoints: ['a'], bant: { budget: { status: 'Clear', detail: 'x' } } };
        expect(reconcile(input, null)).toEqual(input);
        expect(reconcile(input, undefined)).toEqual(input);
    });

    it('maps live statuses onto the canonical vocabulary', async () => {
        const reconcile = await loadReconcile();
        const out = reconcile({ keyPoints: [], actionItems: [] }, live);
        expect(out.bant.budget.status).toBe('Clear');
        expect(out.bant.authority.status).toBe('Partial');
        expect(out.bant.timeline.status).toBe('Missing');
        expect(out.meddicc.economicBuyer.status).toBe('Missing');
        expect(out.meddicc.identifyPain.status).toBe('Clear');
    });

    it('overwrites whatever BANT/MEDDICC the LLM invented', async () => {
        const reconcile = await loadReconcile();
        const out = reconcile(
            { keyPoints: [], actionItems: [], bant: { budget: { status: 'Missing', detail: 'nope' } } },
            live,
        );
        expect(out.bant.budget.status).toBe('Clear');
        expect(out.bant.budget.detail).toBe('We have forty thousand approved for this.');
    });

    it('derives meddicc.gaps when the LLM omitted them', async () => {
        const reconcile = await loadReconcile();
        const out = reconcile({ keyPoints: [], actionItems: [] }, live);
        expect(out.meddicc.gaps).toContain('economic_buyer');
        expect(out.meddicc.gaps).toContain('champion');
        expect(out.meddicc.gaps).not.toContain('metrics');
    });

    it("keeps the LLM's own gaps when it supplied them", async () => {
        const reconcile = await loadReconcile();
        const out = reconcile({ keyPoints: [], actionItems: [], meddicc: { gaps: ['champion'] } }, live);
        expect(out.meddicc.gaps).toEqual(['champion']);
    });

    describe('whatIDidRight', () => {
        it("keeps the LLM's rep-behaviour text, not the prospect's quote", async () => {
            const reconcile = await loadReconcile();
            const out = reconcile({
                keyPoints: [], actionItems: [],
                salesCoachReview: {
                    whatIDidRight: [
                        'MEDDICC Metrics: Quantified the 40-hour monthly cost by asking for a number.',
                        'BANT Budget: Asked directly about the approved range.',
                    ],
                },
            }, live);

            const items: string[] = out.salesCoachReview.whatIDidRight;
            expect(items).toContain('MEDDICC Metrics: Quantified the 40-hour monthly cost by asking for a number.');
            expect(items).toContain('BANT Budget: Asked directly about the approved range.');
            // The prospect's verbatim quote must NOT be presented as a rep win.
            expect(items.join(' ')).not.toContain('We have forty thousand approved for this.');
            expect(items.join(' ')).not.toContain('It takes us 40 hours a month.');
        });

        it('drops items for components that are not Clear', async () => {
            const reconcile = await loadReconcile();
            const out = reconcile({
                keyPoints: [], actionItems: [],
                salesCoachReview: {
                    whatIDidRight: [
                        'MEDDICC Metrics: Good quantification.',
                        'BANT Timeline: Nailed the urgency.',     // timeline is Missing
                        'MEDDICC Champion: Found our champion.',  // champion is Missing
                    ],
                },
            }, live);
            const items: string[] = out.salesCoachReview.whatIDidRight;
            expect(items).toEqual(['MEDDICC Metrics: Good quantification.']);
        });

        it('orders MEDDICC items before BANT items', async () => {
            const reconcile = await loadReconcile();
            const out = reconcile({
                keyPoints: [], actionItems: [],
                salesCoachReview: {
                    whatIDidRight: [
                        'BANT Budget: Asked about budget.',
                        'MEDDICC Metrics: Quantified the cost.',
                    ],
                },
            }, live);
            const items: string[] = out.salesCoachReview.whatIDidRight;
            expect(items[0]).toMatch(/^MEDDICC/);
            expect(items[1]).toMatch(/^BANT/);
        });

        it('falls back to naming Clear components without inventing rep behaviour', async () => {
            const reconcile = await loadReconcile();
            const out = reconcile({ keyPoints: [], actionItems: [] }, live);
            const items: string[] = out.salesCoachReview.whatIDidRight;
            expect(items.length).toBeGreaterThan(0);
            // Never smuggles the prospect's evidence quote in as the text.
            expect(items.join(' ')).not.toContain('forty thousand approved');
        });

        it('returns an empty array when nothing is Clear', async () => {
            const reconcile = await loadReconcile();
            const nothingClear = {
                ...live,
                bant: {
                    budget: field('missing', ''), authority: field('missing', ''),
                    need: field('missing', ''), timeline: field('missing', ''),
                },
                meddic: Object.fromEntries(
                    Object.keys(live.meddic).map(k => [k, field('missing', '')]),
                ),
            };
            const out = reconcile({
                keyPoints: [], actionItems: [],
                salesCoachReview: { whatIDidRight: ['MEDDICC Metrics: something'] },
            }, nothingClear);
            expect(out.salesCoachReview.whatIDidRight).toEqual([]);
        });

        it('tolerates a non-array whatIDidRight from the LLM', async () => {
            const reconcile = await loadReconcile();
            for (const bad of [undefined, null, 'a string', 42, {}]) {
                const out = reconcile({
                    keyPoints: [], actionItems: [],
                    salesCoachReview: { whatIDidRight: bad as any },
                }, live);
                expect(Array.isArray(out.salesCoachReview.whatIDidRight)).toBe(true);
            }
        });
    });
});

describe('normalizeLiveAnalysisData', () => {
    const load = async () => (await import('../reconcile')).normalizeLiveAnalysisData;

    it('returns null for nothing usable', async () => {
        const n = await load();
        expect(n(null)).toBeNull();
        expect(n(undefined)).toBeNull();
        expect(n('a string')).toBeNull();
        expect(n(42)).toBeNull();
    });

    it('fills every BANT and MEDDIC key even from an empty object', async () => {
        const n = await load();
        const out = n({})!;
        for (const k of ['budget', 'authority', 'need', 'timeline']) {
            expect(out.bant[k as keyof typeof out.bant]).toEqual({ emoji: '', status: '', evidence: '' });
        }
        for (const k of ['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'competition']) {
            expect((out.meddic as any)[k].status).toBe('');
        }
        expect(out.objections).toEqual([]);
        expect(out.signals).toEqual([]);
    });

    it('rejects an unknown status rather than passing it through', async () => {
        const n = await load();
        const out = n({ bant: { budget: { status: 'CONFIRMED_ISH', evidence: 'x' } } })!;
        expect(out.bant.budget.status).toBe('');
        expect(out.bant.budget.evidence).toBe('x');
    });

    it('lowercases and trims a valid status', async () => {
        const n = await load();
        const out = n({ bant: { budget: { status: '  Confirmed ' } } })!;
        expect(out.bant.budget.status).toBe('confirmed');
    });

    it('coerces a bare-string signal_type into an array', async () => {
        const n = await load();
        const out = n({ signals: [{ quote: 'q', signal_type: 'buying_intent' }] })!;
        expect(out.signals[0].signal_type).toEqual(['buying_intent']);
    });

    it('defaults out-of-range enums on signals', async () => {
        const n = await load();
        const out = n({ signals: [{ quote: 'q', intensity: 'extreme', category: 'weird' }] })!;
        expect(out.signals[0].intensity).toBe('low');
        expect(out.signals[0].category).toBe('neutral');
    });

    it('drops non-object entries from arrays instead of throwing', async () => {
        const n = await load();
        const out = n({ objections: [null, 'x', { quote: 'real' }], signals: [undefined, { quote: 's' }] })!;
        expect(out.objections).toHaveLength(1);
        expect(out.signals).toHaveLength(1);
    });

    it('survives arrays arriving as non-arrays', async () => {
        const n = await load();
        const out = n({ objections: 'nope', signals: { a: 1 }, dealOptimizer: 5 })!;
        expect(out.objections).toEqual([]);
        expect(out.signals).toEqual([]);
        expect(out.dealOptimizer).toEqual([]);
    });

    it('normalizes dealOptimizer alerts', async () => {
        const n = await load();
        const out = n({ dealOptimizer: [{ trigger: 'discount_request', headline: 'h', quote: 'q', moves: ['a', 2] }] })!;
        expect(out.dealOptimizer![0].moves).toEqual(['a']);
        expect(out.dealOptimizer![0].trigger).toBe('discount_request');
    });

    it('output is safe to feed straight into reconcile', async () => {
        const n = await load();
        const reconcile = await loadReconcile();
        const normalized = n({ bant: { budget: { status: 'confirmed', evidence: 'e' } } })!;
        expect(() => reconcile({ keyPoints: [], actionItems: [] }, normalized)).not.toThrow();
    });
});
