// The rolling strings feed a strip that forces a synchronous layout on every
// update, so their length is a live-call performance property, not cosmetics.
// The cut must land on a segment boundary: the transcript updaters locate the
// pending partial with `lastIndexOf(ROLLING_SEPARATOR)` and rebuild the tail
// from it, so a mid-segment cut would corrupt the next partial or final.

import { describe, expect, it } from 'vitest';

import { boundRolling, ROLLING_MAX_CHARS, ROLLING_SEPARATOR } from '@/lib/rollingTranscript';

/** A rolling string of `count` segments, each `len` characters of filler. */
const segments = (count: number, len: number): string =>
    Array.from({ length: count }, (_, i) => String(i % 10).repeat(len)).join(ROLLING_SEPARATOR);

describe('boundRolling', () => {
    it('returns a string under the cap unchanged', () => {
        const s = segments(4, 20);
        expect(s.length).toBeLessThan(ROLLING_MAX_CHARS);
        expect(boundRolling(s)).toBe(s);
    });

    it('returns a string exactly at the cap unchanged', () => {
        const s = 'x'.repeat(ROLLING_MAX_CHARS);
        expect(boundRolling(s)).toBe(s);
    });

    it('drops leading segments once over the cap', () => {
        const s = segments(30, 40); // ~1300 chars
        const out = boundRolling(s);
        expect(out.length).toBeLessThan(s.length);
        expect(s.endsWith(out)).toBe(true);
    });

    it('cuts only at a separator, so no partial segment survives at the head', () => {
        const out = boundRolling(segments(30, 40));
        // The head of the result is a whole segment: the character before it in
        // the source was the end of a separator, never mid-word.
        expect(out.startsWith(' ')).toBe(false);
        expect(out.startsWith('·')).toBe(false);
        // Every segment in the result is full length (40) — nothing was sliced.
        for (const seg of out.split(ROLLING_SEPARATOR)) {
            expect(seg.length).toBe(40);
        }
    });

    it('keeps the newest segment intact', () => {
        const s = segments(30, 40);
        const newest = s.slice(s.lastIndexOf(ROLLING_SEPARATOR) + ROLLING_SEPARATOR.length);
        expect(boundRolling(s).endsWith(newest)).toBe(true);
    });

    it('leaves the tail addressable by lastIndexOf(separator)', () => {
        // What the updaters rely on: the pending-partial tail is still findable
        // and stripping it yields the accumulated head plus its separator.
        const out = boundRolling(segments(30, 40) + ROLLING_SEPARATOR + 'live partial');
        const at = out.lastIndexOf(ROLLING_SEPARATOR);
        expect(at).toBeGreaterThan(-1);
        expect(out.slice(at + ROLLING_SEPARATOR.length)).toBe('live partial');
    });

    it('leaves a single oversized segment intact rather than slicing mid-word', () => {
        const s = 'y'.repeat(ROLLING_MAX_CHARS + 200);
        expect(boundRolling(s)).toBe(s);
    });

    it('drains an oversized segment as soon as a newer one arrives', () => {
        const huge = 'y'.repeat(ROLLING_MAX_CHARS + 200);
        expect(boundRolling(huge + ROLLING_SEPARATOR + 'next')).toBe('next');
    });

    it('is idempotent — re-bounding an already bounded string is a no-op', () => {
        const once = boundRolling(segments(30, 40));
        expect(boundRolling(once)).toBe(once);
    });

    it('handles an empty string', () => {
        expect(boundRolling('')).toBe('');
    });
});
