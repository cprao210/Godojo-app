// stampIds sits on the round trip: whatever it returns is what the renderer
// holds as analysis state, and that state is posted straight back to the
// backend as `previous_analysis` on the next tick (see
// src/api/intelligenceApi.ts). It may stamp ids onto the list-shaped sections
// it owns — objections, signals, dealOptimizer — but BANT/MEDDIC must come
// through untouched, because they carry backend keys this client does not
// model and a rewrite here would silently drop them.

import { describe, expect, it } from 'vitest';

import { stampIds } from '@/lib/liveAnalysisIds';

describe('stampIds', () => {
    it('passes bant/meddic through BY REFERENCE, not as a copy', () => {
        const data = {
            bant: {
                budget: {
                    emoji: '⚠️',
                    status: 'partial',
                    summary: 'Pricing discussed, budget unconfirmed.',
                    evidence: ['₹60 per user per month.'],
                    an_unmodelled_key: true,
                },
            },
            meddic: { metrics: { emoji: '', status: 'missing', evidence: [] } },
            objections: [],
            signals: [],
            dealOptimizer: [],
        } as any;

        const out = stampIds(data);

        // Identity, not deep equality: nothing reconstructed these objects.
        expect(out.bant).toBe(data.bant);
        expect(out.meddic).toBe(data.meddic);
        expect((out.bant.budget as any).an_unmodelled_key).toBe(true);
    });
});
