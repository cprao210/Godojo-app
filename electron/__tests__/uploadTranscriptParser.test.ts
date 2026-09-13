import { describe, expect, it } from 'vitest';

import { parseUploadTranscript } from '../utils/uploadTranscriptParser';

// ── Format 1 — timestamped transcript ──────────────────────────────────────
describe('parseUploadTranscript — timestamped format', () => {
    const TS_TRANSCRIPT = [
        '[00:00:12] SALES PERSON: Hello, how are you?',
        '[00:00:14] CLIENT: I\'m good.',
        '[00:00:20] SALES PERSON: Great. I wanted to show you how our solution works.',
        '[00:00:25] CLIENT: Sure, go ahead.',
    ].join('\n');

    it('keeps the original labels as displayName (no flattening to Other Party)', () => {
        const { segments } = parseUploadTranscript(TS_TRANSCRIPT);
        expect(segments.map(s => s.displayName)).toEqual(['SALES PERSON', 'CLIENT', 'SALES PERSON', 'CLIENT']);
        expect(segments.map(s => s.text)).toEqual([
            'Hello, how are you?',
            'I\'m good.',
            'Great. I wanted to show you how our solution works.',
            'Sure, go ahead.',
        ]);
    });

    it('maps sales-side labels to user and prospect-side labels to client', () => {
        const { segments } = parseUploadTranscript(TS_TRANSCRIPT);
        expect(segments.map(s => s.speaker)).toEqual(['user', 'client', 'user', 'client']);
    });

    it('uses the parsed timestamps without inventing any', () => {
        const { segments } = parseUploadTranscript(TS_TRANSCRIPT);
        expect(segments.map(s => s.timestamp)).toEqual([12_000, 14_000, 20_000, 25_000]);
    });

    it('derives duration from the last timestamp', () => {
        expect(parseUploadTranscript(TS_TRANSCRIPT).durationMs).toBe(25_000);
    });

    it('supports [MM:SS] brackets too', () => {
        const { segments, durationMs } = parseUploadTranscript(
            '[01:30] REP: hi\n[02:00] CLIENT: hello'
        );
        expect(segments[0].timestamp).toBe(90_000);
        expect(segments[1].timestamp).toBe(120_000);
        expect(durationMs).toBe(120_000);
    });
});

// ── Format 2 — speaker-name transcript, no timestamps ─────────────────────
const NAME_TRANSCRIPT = `Alex: Thanks for making time, Daniel. Last time we spoke you mentioned dispatch
was your biggest headache — still the case?

Daniel: Yeah, dispatch and driver scheduling. We're using spreadsheets
and it falls apart whenever someone calls in sick.

Alex: Makes sense. Let me show you how auto-reassignment works when a driver
drops out. ... See how it re-routes the nearest available driver automatically?

Daniel: That's exactly the problem. How long does it take to set up for our
fleet size — we've got about forty trucks?`;

describe('parseUploadTranscript — speaker-name format (no timestamps)', () => {
    it('preserves genuine person names as labels', () => {
        const { segments } = parseUploadTranscript(NAME_TRANSCRIPT);
        expect(segments.map(s => s.displayName)).toEqual(['Alex', 'Daniel', 'Alex', 'Daniel']);
    });

    it('maps the opening speaker to the mic user and the other to the client', () => {
        const { segments } = parseUploadTranscript(NAME_TRANSCRIPT);
        expect(segments.map(s => s.speaker)).toEqual(['user', 'client', 'user', 'client']);
    });

    it('merges multi-line messages into one turn per label', () => {
        const { segments } = parseUploadTranscript(NAME_TRANSCRIPT);
        expect(segments).toHaveLength(4);
        expect(segments[0].text).toBe(
            'Thanks for making time, Daniel. Last time we spoke you mentioned dispatch\nwas your biggest headache — still the case?'
        );
    });

    it('never invents timestamps, and leaves duration unknown', () => {
        const { segments, durationMs } = parseUploadTranscript(NAME_TRANSCRIPT);
        expect(segments.every(s => s.timestamp === 0)).toBe(true);
        expect(durationMs).toBeNull();
    });

    it('first speaker becomes the mic user, every other distinct speaker the client side', () => {
        const { segments } = parseUploadTranscript([
            'SALES: pitch',
            'SELLER: follow-up',
            'REP: summary',
            'CLIENT: concern',
            'CUSTOMER: pricing?',
            'BUYER: timeline',
        ].join('\n'));
        // Role follows APPEARANCE ORDER, not the keyword meaning — "SELLER"
        // appears second, so it is client-side in this transcript.
        expect(segments.map(s => s.speaker)).toEqual(['user', 'client', 'client', 'client', 'client', 'client']);
        expect(segments.map(s => s.displayName)).toEqual(['SALES', 'SELLER', 'REP', 'CLIENT', 'CUSTOMER', 'BUYER']);
    });
});

// ── Edge cases ─────────────────────────────────────────────────────────────
describe('parseUploadTranscript — edge cases', () => {
    it('a leading line with no label becomes an unlabelled fallback segment', () => {
        const { segments } = parseUploadTranscript('Unattributed opening line.\nAlex: hi there\nDaniel: hello');
        expect(segments[0].displayName).toBeUndefined();
        expect(segments[0].text).toBe('Unattributed opening line.');
        expect(segments[1].displayName).toBe('Alex');
    });

    it('does not treat URLs or colon-heavy prose as speaker labels', () => {
        const { segments } = parseUploadTranscript([
            'Alex: check out https://acme.com:8080 and also',
            'this keeps talking about pricing: it matters',
        ].join('\n'));
        expect(segments).toHaveLength(1);
        expect(segments[0].text).toContain('https://acme.com:8080');
        expect(segments[0].text).toContain('this keeps talking about pricing: it matters');
    });

    it('rejects prose-shaped labels (too many words / lowercase)', () => {
        const { segments } = parseUploadTranscript([
            'Alex: first turn',
            'and then the next few words that look like a sentence: not a new speaker',
            'some lowercase: definitely not a label',
        ].join('\n'));
        expect(segments).toHaveLength(1);
        expect(segments[0].text).toContain('not a new speaker');
        expect(segments[0].text).toContain('definitely not a label');
    });

    it('SPEAKER 1 / SPEAKER 2 style labels are preserved verbatim', () => {
        const { segments } = parseUploadTranscript('[00:00:01] SPEAKER 1: hi\n[00:00:05] SPEAKER 2: hello');
        expect(segments.map(s => s.displayName)).toEqual(['SPEAKER 1', 'SPEAKER 2']);
        expect(segments.map(s => s.speaker)).toEqual(['user', 'client']);
    });

    it('is case-insensitive for known keywords', () => {
        const { segments } = parseUploadTranscript('rep: hi\nclient: hey');
        expect(segments.map(s => s.speaker)).toEqual(['user', 'client']);
    });

    it('three or more distinct speakers: first = user, all others = client, labels kept', () => {
        const { segments } = parseUploadTranscript([
            'Alex: thanks for joining',
            'Daniel: good to be here',
            'Lara: quick question on pricing',
            'Alex: sure — Daniel, want to walk through it?',
        ].join('\n'));
        expect(segments.map(s => [s.speaker, s.displayName])).toEqual([
            ['user', 'Alex'],
            ['client', 'Daniel'],
            ['client', 'Lara'],
            ['user', 'Alex'],
        ]);
    });

    it('role follows order even when the opening label says CLIENT', () => {
        const { segments } = parseUploadTranscript('CLIENT: hello?\nSALES PERSON: hi there');
        expect(segments.map(s => s.speaker)).toEqual(['user', 'client']);
        expect(segments.map(s => s.displayName)).toEqual(['CLIENT', 'SALES PERSON']);
    });
});
