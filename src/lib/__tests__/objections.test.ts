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
    isNearDuplicate,
    quotesOverlap,
    MAX_ACTIVE_OBJECTIONS,
    MAX_NEW_PER_TICK,
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
            // The empty form of the current contract's evidence LIST.
            expect(field.evidence).toEqual([]);
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

describe('splitRepFollowUps', () => {
  // The rep's own "let me check and get back to you" is a follow-up they owe, not the
  // prospect's objection — listing both together read as "it picks the sales person's objections".
  it('keeps prospect objections and moves the rep follow-ups out, order preserved', async () => {
    const { splitRepFollowUps, isRepFollowUp } = await import('../objections');
    const items: any[] = [
      { quote: 'if it is a little higher we need management approval', type: 'customer_question', owner: 'customer' },
      { quote: "let me check with the team and get back to you", type: 'ae_deferral', owner: 'ae' },
      { quote: 'what about vendors forwarding the link?', type: 'customer_question', owner: 'customer' },
      { quote: 'I will send the security document', owner: 'ae' },
    ];
    const { objections, followUps } = splitRepFollowUps(items);
    expect(objections.map(o => o.quote)).toEqual([items[0].quote, items[2].quote]);
    expect(followUps.map(o => o.quote)).toEqual([items[1].quote, items[3].quote]);
    expect(isRepFollowUp(items[0])).toBe(false);
  });
});

// One call ended with 80 "objections" on the panel — several of them one line said again with
// different filler, which exact-id dedupe let through every time.
describe('precision caps', () => {
    it('drops a same-words repeat of anything already tracked, open or resolved', () => {
        const current = [
            { ...objection('how many modules do we have?'), id: stableId('how many modules do we have?') },
            { ...objection('that is well above our budget'), id: 'r', resolved: true },
        ];
        const merged = mergeObjectionDelta(current, {
            new: [objection('so how many modules do we have'), objection('honestly that is well above our budget')],
            resolved: [],
        });
        expect(merged).toBe(current);
    });

    it('treats a Hindi quote by its words, not just its English loanwords', () => {
        expect(isNearDuplicate('अगर उनके पास app नहीं होगा', 'app')).toBe(false);
        expect(isNearDuplicate('अगर उनके पास app नहीं होगा', 'तो अगर उनके पास app नहीं होगा')).toBe(true);
    });

    it(`accepts at most ${MAX_NEW_PER_TICK} prospect objections per tick, follow-ups aside`, () => {
        const merged = mergeObjectionDelta([], {
            new: [
                objection('price is too high'),
                objection('we already use a competitor'),
                objection('I need my CFO to sign off'),
                objection('I will send the SOC 2 report', { type: 'ae_deferral', owner: 'ae' }),
            ],
            resolved: [],
        });
        expect(merged.map(o => o.quote)).toEqual([
            'price is too high', 'we already use a competitor', 'I will send the SOC 2 report',
        ]);
    });

    it(`keeps the newest ${MAX_ACTIVE_OBJECTIONS} open items and every resolved one`, () => {
        const current = Array.from({ length: MAX_ACTIVE_OBJECTIONS }, (_, i) => ({
            ...objection(`distinct concern number ${i} about topic ${i}`), id: `o${i}`,
        }));
        current.push({ ...objection('an old resolved concern'), id: 'res', resolved: true });
        const merged = mergeObjectionDelta(current, { new: [objection('a brand new pricing worry')], resolved: [] });
        const open = merged.filter(o => !o.resolved);
        expect(open).toHaveLength(MAX_ACTIVE_OBJECTIONS);
        expect(open[0].quote).toBe('a brand new pricing worry');
        expect(open.some(o => o.id === `o${MAX_ACTIVE_OBJECTIONS - 1}`)).toBe(false); // the oldest went
        expect(merged.some(o => o.id === 'res')).toBe(true);
    });
});

describe('quotesOverlap', () => {
    it('matches the same moment quoted with more of the turn around it', () => {
        expect(quotesOverlap(
            'Can you do better on the price?',
            'PatrolKart quoted us forty rupees per guard. Can you do better on the price?',
        )).toBe(true);
    });

    it('does not match different concerns that share a few words', () => {
        expect(quotesOverlap('the price is too high for us', 'we already use a competitor for us')).toBe(false);
        expect(quotesOverlap('', 'anything')).toBe(false);
    });
});
