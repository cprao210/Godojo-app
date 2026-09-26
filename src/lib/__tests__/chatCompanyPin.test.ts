import { describe, it, expect } from 'vitest';
import { findMention, removeMention, pinFromHistory } from '../chatCompanyPin';

describe('findMention', () => {
    it('finds the company being typed after @ at the end of the input', () => {
        expect(findMention('@')).toEqual({ start: 0, query: '' });
        expect(findMention('@memb')).toEqual({ start: 0, query: 'memb' });
        expect(findMention('how was the call with @Membrane Gr')).toEqual({ start: 22, query: 'Membrane Gr' });
    });

    it('ignores emails, finished text, "@ " and long runs', () => {
        expect(findMention('mail arpit@membrane.in')).toBeNull();
        expect(findMention('no mention here')).toBeNull();
        expect(findMention('@ membrane')).toBeNull();
        expect(findMention('@' + 'x'.repeat(41))).toBeNull();
        expect(findMention('@acme\nnext line')).toBeNull();
    });
});

describe('removeMention', () => {
    it('drops the @text once a company is picked', () => {
        const text = 'how was the call with @Membrane Gr';
        expect(removeMention(text, findMention(text)!)).toBe('how was the call with ');
        expect(removeMention('@memb', findMention('@memb')!)).toBe('');
    });
});

describe('pinFromHistory', () => {
    const pin = { id: 'c1', name: 'Membrane Group' };
    it("restores the latest assistant turn's pin", () => {
        expect(pinFromHistory([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1', company_pin: { id: 'c0', name: 'Old' } },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2', company_pin: pin },
        ] as any)).toEqual(pin);
    });

    it('stays removed when the latest answer had no pin', () => {
        expect(pinFromHistory([
            { role: 'assistant', content: 'a1', company_pin: pin },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2', company_pin: null },
        ] as any)).toBeNull();
        expect(pinFromHistory([])).toBeNull();
    });
});
