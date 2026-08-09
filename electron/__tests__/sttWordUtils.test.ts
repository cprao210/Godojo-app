import { describe, it, expect } from 'vitest';
import {
    appendAnchor,
    convertStreamSecToWallMs,
    normalizeWordText,
    splitFinalBySpeaker,
    type SttWord,
    type TimeAnchor,
} from '../audio/sttWordUtils';

const word = (over: Partial<SttWord> & { text: string }): SttWord => ({
    startMs: 0,
    endMs: 0,
    ...over,
});

describe('convertStreamSecToWallMs', () => {
    it('returns null with no anchors', () => {
        expect(convertStreamSecToWallMs([], 1.0)).toBeNull();
    });

    it('is exact for live 1x cadence', () => {
        // Audio starts at wall T=100_000, sent in real time.
        const anchors: TimeAnchor[] = [];
        for (let s = 0.5; s <= 10; s += 0.5) {
            appendAnchor(anchors, s, 100_000 + s * 1000);
        }
        // Word ending at streamSec 3.2 was heard at wall 103_200.
        expect(convertStreamSecToWallMs(anchors, 3.2)).toBe(103_200);
        // Word exactly on an anchor.
        expect(convertStreamSecToWallMs(anchors, 5.0)).toBe(105_000);
    });

    it('projects back correctly through a handshake burst flush', () => {
        // 5s of audio buffered during connect, flushed at wall T=200_000 in one
        // burst. The burst collapses into ONE trailing anchor (5.0, 200_000);
        // buffered audio is a real-time recording, so back-projection from the
        // burst end recovers true capture times: audio second 2.0 was heard
        // 3s before the flush completed.
        const anchors: TimeAnchor[] = [];
        for (let s = 0.5; s <= 5; s += 0.5) {
            appendAnchor(anchors, s, 200_000);
        }
        expect(anchors).toHaveLength(1);
        expect(convertStreamSecToWallMs(anchors, 2.0)).toBe(197_000);
        expect(convertStreamSecToWallMs(anchors, 4.5)).toBe(199_500);
        // After the flush, live cadence resumes and projection stays exact:
        appendAnchor(anchors, 5.5, 200_500);
        appendAnchor(anchors, 6.0, 201_000);
        expect(convertStreamSecToWallMs(anchors, 5.8)).toBe(200_800);
    });

    it('bounds error across suppression gaps to anchor spacing, not gap length', () => {
        const anchors: TimeAnchor[] = [];
        // 2s of audio sent live starting at wall 300_000...
        appendAnchor(anchors, 0.5, 300_500);
        appendAnchor(anchors, 1.0, 301_000);
        appendAnchor(anchors, 1.5, 301_500);
        appendAnchor(anchors, 2.0, 302_000);
        // ...then 10 SECONDS of silence suppressed (no bytes sent)...
        // ...then audio resumes: streamSec 2.5 sent at wall 312_500.
        appendAnchor(anchors, 2.5, 312_500);
        appendAnchor(anchors, 3.0, 313_000);

        // A word ending at streamSec 2.7 (after the gap) → truly heard ~312_700.
        expect(convertStreamSecToWallMs(anchors, 2.7)).toBe(312_700);
        // A word ending at streamSec 1.8 (before the gap) → truly heard ~301_800.
        expect(convertStreamSecToWallMs(anchors, 1.8)).toBe(301_800);
        // Worst case: word at 2.2, just inside the span that contains the gap.
        // Projection from anchor 2.5 (wall 312_500) gives 312_200 — off from the
        // true ~302_200 by the gap, but the span is only one anchor interval;
        // with 0.5s spacing at most 0.5s of stream time can hide a gap.
        const w = convertStreamSecToWallMs(anchors, 2.2)!;
        expect(w).toBe(312_200);
    });

    it('extrapolates past the last anchor', () => {
        const anchors: TimeAnchor[] = [{ streamSec: 10, wallMs: 500_000 }];
        expect(convertStreamSecToWallMs(anchors, 10.4)).toBe(500_400);
    });

    it('anchor ring extends contiguous sends and caps history', () => {
        const anchors: TimeAnchor[] = [];
        appendAnchor(anchors, 0.1, 1);
        appendAnchor(anchors, 0.2, 2); // wall-contiguous — extends, no new entry
        expect(anchors).toHaveLength(1);
        expect(anchors[0]).toEqual({ streamSec: 0.2, wallMs: 2 });
        for (let s = 1; s <= 200; s += 0.5) {
            appendAnchor(anchors, s, s * 1000); // 500ms apart — one anchor each
        }
        expect(anchors.length).toBeLessThanOrEqual(120);
        // Ring keeps the most recent anchors.
        expect(anchors[anchors.length - 1].streamSec).toBe(200);
    });
});

describe('normalizeWordText', () => {
    it('strips punctuation and case', () => {
        expect(normalizeWordText("Pricing,")).toBe('pricing');
        expect(normalizeWordText("it's")).toBe('its');
        expect(normalizeWordText('$1,000.')).toBe('1000');
    });
});

describe('splitFinalBySpeaker', () => {
    it('passes through verbatim when there are no words', () => {
        const segs = splitFinalBySpeaker([], 'Hello there.');
        expect(segs).toHaveLength(1);
        expect(segs[0].text).toBe('Hello there.');
        expect(segs[0].speakerIndex).toBeUndefined();
    });

    it('passes through verbatim when words lack speaker data (diarize off)', () => {
        const words = [word({ text: 'hello' }), word({ text: 'there' })];
        const segs = splitFinalBySpeaker(words, 'Hello there.');
        expect(segs).toHaveLength(1);
        expect(segs[0].text).toBe('Hello there.');
        expect(segs[0].speakerIndex).toBeUndefined();
    });

    it('keeps the verbatim transcript for a single-speaker window', () => {
        const words = [
            word({ text: 'so', speaker: 0, punctuated: 'So' }),
            word({ text: 'anyway', speaker: 0, punctuated: 'anyway,' }),
        ];
        const segs = splitFinalBySpeaker(words, 'So anyway,');
        expect(segs).toHaveLength(1);
        expect(segs[0].text).toBe('So anyway,'); // verbatim, not reconstructed
        expect(segs[0].speakerIndex).toBe(0);
    });

    it('splits a two-speaker window into runs with reconstructed text', () => {
        const words = [
            word({ text: 'i', speaker: 0, punctuated: 'I' }),
            word({ text: 'agree', speaker: 0, punctuated: 'agree.' }),
            word({ text: 'great', speaker: 1, punctuated: 'Great,' }),
            word({ text: 'thanks', speaker: 1, punctuated: 'thanks.' }),
        ];
        const segs = splitFinalBySpeaker(words, 'I agree. Great, thanks.');
        expect(segs).toHaveLength(2);
        expect(segs[0]).toMatchObject({ text: 'I agree.', speakerIndex: 0 });
        expect(segs[1]).toMatchObject({ text: 'Great, thanks.', speakerIndex: 1 });
    });

    it('handles A-B-A alternation and words without speaker inherit the run', () => {
        const words = [
            word({ text: 'yes', speaker: 0 }),
            word({ text: 'um' }), // diarizer skipped — inherits speaker 0
            word({ text: 'no', speaker: 1 }),
            word({ text: 'wait', speaker: 0 }),
        ];
        const segs = splitFinalBySpeaker(words, 'yes um no wait');
        expect(segs.map(s => s.speakerIndex)).toEqual([0, 1, 0]);
        expect(segs[0].words).toHaveLength(2);
    });
});
