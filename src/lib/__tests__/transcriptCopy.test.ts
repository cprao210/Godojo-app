import { describe, expect, it } from 'vitest';

import { parseUploadTranscript } from '../../../electron/utils/uploadTranscriptParser';
import { formatCopyTimestamp, formatTranscriptForCopy } from '../transcriptLabels';

describe('formatCopyTimestamp', () => {
    it('uses MM:SS under an hour and HH:MM:SS from an hour', () => {
        expect(formatCopyTimestamp(0)).toBe('00:00');
        expect(formatCopyTimestamp(75_000)).toBe('01:15');
        expect(formatCopyTimestamp(3_725_000)).toBe('01:02:05');
    });
});

describe('formatTranscriptForCopy', () => {
    it('copies an uploaded (relative) transcript in the upload format', () => {
        const parsed = parseUploadTranscript('Alex (00:00): hello...\nDanieal (00:10): hi...');
        expect(formatTranscriptForCopy(parsed.segments, undefined)).toBe(
            'Alex (00:00): hello...\nDanieal (00:10): hi...',
        );
    });

    it('rebases live (epoch ms) rows onto the first row — no wall-clock time', () => {
        const t0 = 1_760_000_000_000;
        const out = formatTranscriptForCopy(
            [
                { speaker: 'user', displayName: 'Alex', text: 'hello...', timestamp: t0 },
                { speaker: 'client', displayName: 'Danieal', text: 'hi...', timestamp: t0 + 20_000 },
                { speaker: 'system', text: 'ignored', timestamp: t0 + 21_000 },
            ],
            undefined,
        );
        expect(out).toBe('Alex (00:00): hello...\nDanieal (00:20): hi...');
        expect(out).not.toMatch(/am|pm|\[/i);
    });

    it('omits timestamps when the source had none', () => {
        const parsed = parseUploadTranscript('Alex: hello\nDanieal: hi');
        expect(formatTranscriptForCopy(parsed.segments, undefined)).toBe('Alex: hello\nDanieal: hi');
    });

    it('round-trips through the upload parser for live and uploaded data', () => {
        const t0 = 1_760_000_000_000;
        const live = [
            { speaker: 'user', displayName: 'Alex', text: 'hello', timestamp: t0 },
            { speaker: 'client', displayName: 'Danieal', text: 'line one\nline two', timestamp: t0 + 3_700_000 },
        ];
        const copied = formatTranscriptForCopy(live, undefined);
        const back = parseUploadTranscript(copied);
        expect(back.segments.map(s => [s.displayName, s.text, s.timestamp])).toEqual([
            ['Alex', 'hello', 0],
            ['Danieal', 'line one\nline two', 3_700_000],
        ]);
        expect(formatTranscriptForCopy(back.segments, undefined)).toBe(copied);
    });
});