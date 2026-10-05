import { describe, expect, it } from 'vitest';

import { formatTranscriptTime, formatTranscriptTimestamp } from '../transcriptLabels';

describe('formatTranscriptTimestamp (relative / uploaded transcripts)', () => {
    it('writes offsets with unit letters, never as 3:13', () => {
        expect(formatTranscriptTimestamp(1_000, true)).toBe('1s');
        expect(formatTranscriptTimestamp(12_000, true)).toBe('12s');
        expect(formatTranscriptTimestamp(193_000, true)).toBe('3m 13s');
        expect(formatTranscriptTimestamp(311_000, true)).toBe('5m 11s');
        expect(formatTranscriptTimestamp(2_405_000, true)).toBe('40m 5s');
        expect(formatTranscriptTimestamp(3_725_000, true)).toBe('1h 2m 5s');
        expect(formatTranscriptTimestamp(500, true)).toBe('0s');
    });

    it('uses 0s for a missing relative timestamp', () => {
        expect(formatTranscriptTime(0, true)).toBe('0s');
    });
});