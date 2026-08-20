// Locks the client-side half of the objection-handler delta contract: the renderer
// owns the objection list, so merge/resolve/dedupe correctness lives here rather than
// on the backend. Pure functions only — the repo's vitest runs `environment: 'node'`.

import { describe, it, expect } from 'vitest';
import type { Objection } from '@/types';
import {
    stableId,
    mergeObjectionDelta,
    partitionObjections,
    openQuotes,
    shouldTick,
    objectionsOnlyAnalysis,
    MAX_OPEN_OBJECTIONS,
    OBJECTION_SETTLE_MS,
    OBJECTION_MIN_GAP_MS,
} from '@/lib/objections';

const objection = (quote: string, extra: Partial<Objection> = {}): Objection => ({
    type: 'customer_question',
    quote,
    owner: 'customer',
    status: 'open',
    ...extra,
});

describe('mergeObjectionDelta', () => {
    it('prepends new objections newest-first and stamps a stable id', () => {
        const current = [{ ...objection('too expensive'), id: stableId('too expensive') }];

        const merged = mergeObjectionDelta(current, {
            new: [objection('what about SOC 2?')],
            resolved: [],
        });

        expect(merged.map(o => o.quote)).toEqual(['what about SOC 2?', 'too expensive']);
        expect(merged[0].id).toBe(stableId('what about SOC 2?'));
    });

    it('dedupes a new quote whose id is already tracked', () => {
        const current = [{ ...objection('too expensive'), id: stableId('too expensive') }];

        const merged = mergeObjectionDelta(current, {
            new: [objection('too expensive'), objection('who signs off?')],
            resolved: [],
        });

        expect(merged.map(o => o.quote)).toEqual(['who signs off?', 'too expensive']);
    });

    it('does not resurrect an objection that was already resolved', () => {
        const current = [{ ...objection('too expensive'), id: stableId('too expensive'), resolved: true }];

        const merged = mergeObjectionDelta(current, { new: [objection('too expensive')], resolved: [] });

        expect(merged).toHaveLength(1);
        expect(merged[0].resolved).toBe(true);
    });

    it('drops a new objection with an empty quote', () => {
        const merged = mergeObjectionDelta([], { new: [objection('   ')], resolved: [] });
        expect(merged).toEqual([]);
    });

    it('flags a resolved quote instead of removing it, so it still reaches the summary', () => {
        const current = [
            { ...objection('what about SOC 2?'), id: stableId('what about SOC 2?') },
            { ...objection('too expensive'), id: stableId('too expensive') },
        ];

        const merged = mergeObjectionDelta(current, { new: [], resolved: ['too expensive'] });

        expect(merged).toHaveLength(2);
        expect(merged.find(o => o.quote === 'too expensive')?.resolved).toBe(true);
        expect(merged.find(o => o.quote === 'what about SOC 2?')?.resolved).toBeUndefined();
    });

    it('matches a resolved quote through whitespace/punctuation drift', () => {
        const current = [{ ...objection('Too expensive!'), id: stableId('Too expensive!') }];

        const merged = mergeObjectionDelta(current, { new: [], resolved: ['too  expensive'] });

        expect(merged[0].resolved).toBe(true);
    });

    it('ignores a resolved quote that matches nothing tracked', () => {
        const current = [{ ...objection('too expensive'), id: stableId('too expensive') }];

        const merged = mergeObjectionDelta(current, { new: [], resolved: ['never said this'] });

        expect(merged).toHaveLength(1);
        expect(merged[0].resolved).toBeUndefined();
    });

    it('is a no-op on a null/empty delta', () => {
        const current = [{ ...objection('too expensive'), id: 'abc' }];
        expect(mergeObjectionDelta(current, null)).toEqual(current);
        expect(mergeObjectionDelta(current, { new: [], resolved: [] })).toEqual(current);
    });
});

describe('partitionObjections', () => {
    it('splits resolved out while preserving order within each group', () => {
        const all = [
            objection('a'),
            objection('b', { resolved: true }),
            objection('c'),
        ];

        const { active, resolved } = partitionObjections(all);

        expect(active.map(o => o.quote)).toEqual(['a', 'c']);
        expect(resolved.map(o => o.quote)).toEqual(['b']);
    });
});

describe('openQuotes', () => {
    it('returns open quotes only', () => {
        const all = [objection('a'), objection('b', { resolved: true }), objection('c')];
        expect(openQuotes(all)).toEqual(['a', 'c']);
    });

    it('caps at the backend max_length of 25', () => {
        const all = Array.from({ length: 40 }, (_, i) => objection(`q${i}`));
        expect(openQuotes(all)).toHaveLength(MAX_OPEN_OBJECTIONS);
        expect(openQuotes(all)[0]).toBe('q0');
    });
});

describe('shouldTick', () => {
    const base = {
        now: 100_000,
        turnCount: 5,
        cursor: 3,
        newestTurnAt: 100_000 - OBJECTION_SETTLE_MS - 1,
        lastTickAt: 100_000 - OBJECTION_MIN_GAP_MS - 1,
        inFlight: false,
        isMeetingPaused: false,
        hasNewProspectTurn: true,
    };

    it('fires once the newest turn has settled and the gap has elapsed', () => {
        expect(shouldTick(base)).toBe(true);
    });

    it('waits for the sentence to settle', () => {
        expect(shouldTick({ ...base, newestTurnAt: base.now - 100 })).toBe(false);
    });

    it('respects the minimum gap between calls', () => {
        expect(shouldTick({ ...base, lastTickAt: base.now - 1_000 })).toBe(false);
    });

    it('does not fire for an AE-only delta', () => {
        expect(shouldTick({ ...base, hasNewProspectTurn: false })).toBe(false);
    });

    it('does not fire when the cursor is already current', () => {
        expect(shouldTick({ ...base, cursor: 5 })).toBe(false);
    });

    it('does not fire while a request is in flight or the meeting is paused', () => {
        expect(shouldTick({ ...base, inFlight: true })).toBe(false);
        expect(shouldTick({ ...base, isMeetingPaused: true })).toBe(false);
    });
});

describe('objectionsOnlyAnalysis', () => {
    it('carries the objections through and leaves every other section empty', () => {
        const objections = [objection('too expensive'), objection('no budget this quarter')];

        const data = objectionsOnlyAnalysis(objections);

        expect(data.objections).toEqual(objections);
        expect(data.signals).toEqual([]);
        expect(data.dealOptimizer).toBeUndefined();
    });

    it("marks every BANT/MEDDIC field 'missing', not ''", () => {
        // FloatingIntelligencePanel's hasContent() treats any status other than
        // 'missing' as real content. If these were '' the shell would read as
        // populated, so the panel would render an all-empty analysis instead of
        // its countdown placeholder whenever a single objection existed.
        const data = objectionsOnlyAnalysis([]);

        const fields = [...Object.values(data.bant), ...Object.values(data.meddic)];
        expect(fields).toHaveLength(11);
        for (const field of fields) {
            expect(field.status).toBe('missing');
            expect(field.evidence).toBe('');
        }
    });

    it('does not share field objects between calls', () => {
        // The panel and LiveAnalysisContent both read these; a shared frozen literal
        // would let one mutation leak across every shell ever produced.
        const a = objectionsOnlyAnalysis([]);
        const b = objectionsOnlyAnalysis([]);

        expect(a.bant.budget).not.toBe(b.bant.budget);
        expect(a.bant.budget).not.toBe(a.meddic.metrics);
    });
});
