import { describe, expect, it } from 'vitest';

import { resolveCoachCallType } from '../utils/coachCallType';

// The call-type resolver drives which coaching sections the summary prompt
// asks for. Priority: explicit rep selection > previously resolved
// coachCallType > scorecard detection > discovery default; and within a
// winning source negotiation > demo > discovery.

describe('resolveCoachCallType', () => {
    it('single explicit type resolves to itself', () => {
        expect(resolveCoachCallType(['discovery'])).toBe('discovery');
        expect(resolveCoachCallType(['demo'])).toBe('demo');
        expect(resolveCoachCallType(['negotiation'])).toBe('negotiation');
    });

    it('multiple types resolve negotiation > demo > discovery', () => {
        expect(resolveCoachCallType(['discovery', 'demo'])).toBe('demo');
        expect(resolveCoachCallType(['demo', 'discovery'])).toBe('demo');
        expect(resolveCoachCallType(['discovery', 'demo', 'negotiation'])).toBe('negotiation');
        expect(resolveCoachCallType(['demo', 'negotiation'])).toBe('negotiation');
    });

    it('no types at all defaults to discovery', () => {
        expect(resolveCoachCallType()).toBe('discovery');
        expect(resolveCoachCallType([])).toBe('discovery');
        expect(resolveCoachCallType(undefined, null)).toBe('discovery');
    });

    it('drops invalid values rather than failing', () => {
        expect(resolveCoachCallType(['bogus'])).toBe('discovery');
        expect(resolveCoachCallType(['bogus', 'demo'])).toBe('demo');
        expect(resolveCoachCallType([42, null, 'negotiation'])).toBe('negotiation');
    });

    it('the first source with any valid type wins (explicit beats detected)', () => {
        // Explicit demo selection must not be overridden by a scorecard that
        // detected negotiation.
        expect(resolveCoachCallType(['demo'], ['negotiation'])).toBe('demo');
        // No explicit selection → detected types are used.
        expect(resolveCoachCallType([], ['negotiation'])).toBe('negotiation');
        expect(resolveCoachCallType(undefined, ['demo', 'discovery'])).toBe('demo');
    });

    it('accepts a single type string as a source (persisted coachCallType)', () => {
        expect(resolveCoachCallType('negotiation')).toBe('negotiation');
        expect(resolveCoachCallType(undefined, 'demo')).toBe('demo');
        // A persisted resolution outranks later scorecard detection…
        expect(resolveCoachCallType(undefined, 'demo', ['discovery'])).toBe('demo');
        // …but explicit selection still outranks the persisted resolution.
        expect(resolveCoachCallType(['negotiation'], 'demo')).toBe('negotiation');
    });
});
