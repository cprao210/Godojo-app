import { describe, it, expect } from 'vitest';
import {
    buildCanonicalTranscript,
    formatOffset,
    isRepSpeaker,
    TRANSCRIPT_FORMAT_CONTRACT,
    type FormattableSegment,
} from '../transcript';

const T0 = 1_700_000_000_000;
const at = (s: number) => T0 + s * 1000;

const fixture: FormattableSegment[] = [
    { speaker: 'user', text: 'Thanks for making the time today.', timestamp: at(0) },
    { speaker: 'client', text: 'Happy to. We have about thirty minutes.', timestamp: at(6) },
    { speaker: 'user', text: 'What does your current process look like?', timestamp: at(14) },
    { speaker: 'client', text: 'We do the reconciliation manually, every month.', timestamp: at(21) },
    { speaker: 'user', text: 'And what is the budget range you are working with?', timestamp: at(95) },
    { speaker: 'client', text: 'We have forty thousand approved for this.', timestamp: at(103) },
];

describe('formatOffset', () => {
    it('formats mm:ss', () => {
        expect(formatOffset(0)).toBe('00:00');
        expect(formatOffset(9_000)).toBe('00:09');
        expect(formatOffset(65_000)).toBe('01:05');
    });

    it('formats h:mm:ss past an hour', () => {
        expect(formatOffset(3_725_000)).toBe('1:02:05');
    });
});

describe('isRepSpeaker', () => {
    it('recognizes every rep alias', () => {
        for (const s of ['user', 'USER', 'me', 'rep', 'sales', 'seller']) {
            expect(isRepSpeaker(s)).toBe(true);
        }
    });

    it('treats everything else as the prospect', () => {
        for (const s of ['client', 'them', 'prospect', 'Salesforce', '']) {
            expect(isRepSpeaker(s)).toBe(false);
        }
    });
});

describe('buildCanonicalTranscript', () => {
    it('emits an unambiguous role token on every line', () => {
        const { text } = buildCanonicalTranscript(fixture);
        for (const line of text.split('\n')) {
            expect(line).toMatch(/^\[\d{2}:\d{2}\] (REP|PROSPECT)(\s\(.+\))?: /);
        }
    });

    it('puts a known human name in parentheses, never in place of the role', () => {
        const { text } = buildCanonicalTranscript(fixture, {
            speakerNames: { user: 'Chandra', client: 'Priya' },
        });
        expect(text).toContain('REP (Chandra): Thanks for making the time today.');
        expect(text).toContain('PROSPECT (Priya): Happy to.');
        // The role token must survive even with names present.
        expect(text).not.toContain('\nChandra:');
        expect(text).not.toContain('\nPriya:');
    });

    it('ignores generic placeholder names', () => {
        const { text } = buildCanonicalTranscript(fixture, {
            speakerNames: { user: 'Me', client: 'Them' },
        });
        expect(text).toContain('REP: Thanks');
        expect(text).toContain('PROSPECT: Happy to.');
    });

    it('sorts by speech time, not array order', () => {
        // A rep reply that ARRIVED first but was SPOKEN second.
        const outOfOrder: FormattableSegment[] = [
            { speaker: 'user', text: 'REPLY', timestamp: at(20) },
            { speaker: 'client', text: 'QUESTION', timestamp: at(10) },
        ];
        const { turns } = buildCanonicalTranscript(outOfOrder);
        expect(turns.map(t => t.text)).toEqual(['QUESTION', 'REPLY']);
    });

    it('excludes system/ai/assistant/model speakers and chat-sourced turns', () => {
        const withNoise: FormattableSegment[] = [
            ...fixture,
            { speaker: 'assistant', text: 'SHOULD NOT APPEAR', timestamp: at(30) },
            { speaker: 'system', text: 'ALSO NOT', timestamp: at(31) },
            { speaker: 'user', text: 'CHAT PANEL', timestamp: at(32), source: 'chat' },
        ];
        const { text } = buildCanonicalTranscript(withNoise);
        expect(text).not.toContain('SHOULD NOT APPEAR');
        expect(text).not.toContain('ALSO NOT');
        expect(text).not.toContain('CHAT PANEL');
    });

    it('drops empty and whitespace-only turns', () => {
        const { turns } = buildCanonicalTranscript([
            { speaker: 'user', text: '   ', timestamp: at(1) },
            { speaker: 'client', text: 'real', timestamp: at(2) },
        ]);
        expect(turns).toHaveLength(1);
    });

    it('adds a Speaker marker ONLY when 2+ far-end speakers were diarized', () => {
        const one: FormattableSegment[] = [
            { speaker: 'client', text: 'a', timestamp: at(1), speakerIndex: 0 },
            { speaker: 'client', text: 'b', timestamp: at(2), speakerIndex: 0 },
        ];
        expect(buildCanonicalTranscript(one).text).not.toContain('Speaker');

        const two: FormattableSegment[] = [
            { speaker: 'client', text: 'a', timestamp: at(1), speakerIndex: 0 },
            { speaker: 'client', text: 'b', timestamp: at(2), speakerIndex: 1 },
        ];
        const r = buildCanonicalTranscript(two);
        expect(r.multiClientSpeakers).toBe(true);
        expect(r.text).toContain('PROSPECT (Speaker 1): a');
        expect(r.text).toContain('PROSPECT (Speaker 2): b');
    });

    it('offsets timestamps from the first turn, not the epoch', () => {
        const { turns } = buildCanonicalTranscript(fixture);
        expect(turns[0].offsetMs).toBe(0);
        expect(turns[1].offsetMs).toBe(6000);
    });

    it('prepends epoch summaries in a fenced block when compaction occurred', () => {
        const r = buildCanonicalTranscript(fixture, {
            epochSummaries: ['- Rep introduced the product', '- Prospect described their team'],
        });
        expect(r.hasEpochSummaries).toBe(true);
        expect(r.text).toContain('<earlier_call_summary>');
        expect(r.text).toContain('[Epoch 1] - Rep introduced the product');
        expect(r.text).toContain('[Epoch 2] - Prospect described their team');
        expect(r.text.indexOf('<earlier_call_summary>')).toBeLessThan(r.text.indexOf('REP:'));
    });

    it('omits the epoch block entirely when nothing was compacted', () => {
        const r = buildCanonicalTranscript(fixture);
        expect(r.hasEpochSummaries).toBe(false);
        expect(r.text).not.toContain('earlier_call_summary');
    });

    it('honours maxChars and reports truncation', () => {
        const r = buildCanonicalTranscript(fixture, { maxChars: 60 });
        expect(r.truncated).toBe(true);
        expect(r.text.length).toBeLessThanOrEqual(60);
    });

    it('can omit timestamps for the title path', () => {
        const { text } = buildCanonicalTranscript(fixture, { includeTimestamps: false });
        expect(text).not.toMatch(/^\[\d{2}:\d{2}\]/m);
        expect(text.split('\n')[0]).toBe('REP: Thanks for making the time today.');
    });

    it('handles an empty transcript without throwing', () => {
        const r = buildCanonicalTranscript([]);
        expect(r.text).toBe('');
        expect(r.turns).toEqual([]);
    });

    // THE PARITY LOCK: the four entry points (live / upload / regenerate /
    // recover) previously each built their own label scheme, so regenerating a
    // summary produced systematically different output from the same transcript.
    it('produces byte-identical output for all four entry-point shapes', () => {
        const names = { user: 'Chandra', client: 'Priya' };

        // live: SessionTracker segments carry `final` and `confidence`
        const live = fixture.map(s => ({ ...s, final: true, confidence: 0.95 }));
        // upload: parsed lines, synthetic timestamps preserved from the fixture
        const upload = fixture.map(s => ({ speaker: s.speaker, text: s.text, timestamp: s.timestamp }));
        // regenerate / recover: rows read back from the DB
        const fromDb = fixture.map(s => ({
            speaker: s.speaker,
            text: s.text,
            timestamp: s.timestamp,
            speakerIndex: undefined as number | undefined,
        }));

        const a = buildCanonicalTranscript(live as any, { speakerNames: names }).text;
        const b = buildCanonicalTranscript(upload, { speakerNames: names }).text;
        const c = buildCanonicalTranscript(fromDb, { speakerNames: names }).text;

        expect(b).toBe(a);
        expect(c).toBe(a);
    });
});

describe('TRANSCRIPT_FORMAT_CONTRACT', () => {
    it('states which side is the seller — the thing no prompt used to say', () => {
        expect(TRANSCRIPT_FORMAT_CONTRACT).toContain('REP');
        expect(TRANSCRIPT_FORMAT_CONTRACT).toContain('PROSPECT');
        expect(TRANSCRIPT_FORMAT_CONTRACT.toLowerCase()).toContain('salesperson');
    });
});
