import { describe, expect, it } from 'vitest';

import { formatDurationHuman } from '../transcriptLabels';

describe('formatDurationHuman', () => {
    it('formats stored m:ss / h:mm:ss strings', () => {
        expect(formatDurationHuman('0:01')).toBe('1s');
        expect(formatDurationHuman('1:04')).toBe('1m 4s');
        expect(formatDurationHuman('40:05')).toBe('40m 5s');
        expect(formatDurationHuman('1:02:05')).toBe('1h 2m 5s');
        expect(formatDurationHuman('0:00')).toBe('0s');
    });

    it('prefers durationMs when present', () => {
        expect(formatDurationHuman('3:22', 64_000)).toBe('1m 4s');
        expect(formatDurationHuman(undefined, 2_405_000)).toBe('40m 5s');
    });

    it('leaves unparseable values alone', () => {
        expect(formatDurationHuman('—')).toBe('—');
        expect(formatDurationHuman('42 min')).toBe('42 min');
        expect(formatDurationHuman(undefined)).toBe('');
    });
});