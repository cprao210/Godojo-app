import { describe, it, expect } from 'vitest';
import { TranscriptEchoFilter } from '../audio/TranscriptEchoFilter';
import type { SttWord } from '../audio/sttWordUtils';

/** Build a word sequence starting at t0, 200ms per word, 150ms voiced. */
function seq(text: string, t0: number, opts?: { punctuate?: boolean }): SttWord[] {
    return text.split(/\s+/).map((w, i) => ({
        text: w.toLowerCase().replace(/[^a-z0-9']/gi, ''),
        punctuated: opts?.punctuate === false ? undefined : w,
        startMs: t0 + i * 200,
        endMs: t0 + i * 200 + 150,
    }));
}

const NOW = 1_000_000;
const mkFilter = (over?: Partial<{ builtinOnly: boolean; wordFilter: boolean }>) =>
    new TranscriptEchoFilter({
        echoPossible: true,
        useWordFilter: () => over?.wordFilter ?? true,
        isBuiltinOnly: () => over?.builtinOnly ?? false,
        now: () => NOW,
    });

describe('TranscriptEchoFilter — word path', () => {
    it('drops a pure echo segment', () => {
        const f = mkFilter();
        const clientText = 'We really need to improve our pipeline conversion rate this quarter';
        f.addClientFinal(clientText, seq(clientText, NOW - 4000));
        // Mic hears the same words ~300ms later (echo lag + STT jitter).
        const v = f.filterUserFinal(clientText, seq(clientText, NOW - 4000 + 300));
        expect(v.action).toBe('drop');
    });

    it('trims a head echo and keeps the genuine tail', () => {
        const f = mkFilter();
        const clientText = 'our pricing starts at five thousand per month';
        f.addClientFinal(clientText, seq(clientText, NOW - 5000));
        // Mic segment: echoed client sentence + user's genuine follow-up.
        const echo = seq(clientText, NOW - 5000 + 250);
        const genuine = seq('let me check that with my manager first', NOW - 2000);
        const v = f.filterUserFinal(
            clientText + ' let me check that with my manager first',
            [...echo, ...genuine]
        );
        expect(v.action).toBe('trim');
        if (v.action === 'trim') {
            expect(v.text).toBe('let me check that with my manager first');
        }
    });

    it('trims a middle echo, keeping words on both sides', () => {
        const f = mkFilter();
        const clientText = 'the integration takes about two weeks to complete';
        f.addClientFinal(clientText, seq(clientText, NOW - 6000));
        const before = seq('so you said', NOW - 6200);
        const echo = seq(clientText, NOW - 6000 + 200);
        const after = seq('is that with our current setup', NOW - 3000);
        const v = f.filterUserFinal('...', [...before, ...echo, ...after]);
        expect(v.action).toBe('trim');
        if (v.action === 'trim') {
            expect(v.text).toContain('so you said');
            expect(v.text).toContain('is that with our current setup');
            expect(v.text).not.toContain('integration takes');
        }
    });

    it('keeps genuine words interleaved with echo (talk-over)', () => {
        const f = mkFilter();
        const clientText = 'we can offer a discount if you sign the annual contract today';
        f.addClientFinal(clientText, seq(clientText, NOW - 5000));
        const echo = seq('we can offer a discount if you sign', NOW - 5000 + 300);
        const talkover = seq('sorry to interrupt what discount exactly', NOW - 3500);
        const v = f.filterUserFinal('...', [...echo, ...talkover]);
        expect(v.action).toBe('trim');
        if (v.action === 'trim') {
            expect(v.text).toContain('sorry to interrupt');
        }
    });

    it('matches despite punctuation and case differences between streams', () => {
        const f = mkFilter();
        f.addClientFinal("Let's schedule a follow-up for Thursday, okay?",
            seq("Let's schedule a follow-up for Thursday, okay?", NOW - 3000));
        const v = f.filterUserFinal("let's schedule a follow up for thursday okay",
            seq("let's schedule a follow up for thursday okay", NOW - 3000 + 400, { punctuate: false }));
        // "follow-up" vs "follow up" tokenize differently — the rest matches
        // well above the drop threshold either way.
        expect(v.action).not.toBe('pass');
    });

    it('does NOT flag the user legitimately repeating the client outside the lag window', () => {
        const f = mkFilter();
        const clientText = 'the budget deadline is end of march';
        f.addClientFinal(clientText, seq(clientText, NOW - 10_000));
        // User repeats the phrase 8s later (taking notes aloud) — genuine.
        const v = f.filterUserFinal(clientText, seq(clientText, NOW - 2_000));
        expect(v.action).toBe('pass');
    });

    it('never suppresses segments under 2 words', () => {
        const f = mkFilter();
        f.addClientFinal('absolutely', seq('absolutely', NOW - 1000));
        const v = f.filterUserFinal('absolutely', seq('absolutely', NOW - 800));
        expect(v.action).toBe('pass');
    });

    it('never lets a run of pure backchannels count as echo', () => {
        const f = mkFilter();
        f.addClientFinal('yeah okay right exactly', seq('yeah okay right exactly', NOW - 2000));
        const v = f.filterUserFinal('yeah okay right exactly', seq('yeah okay right exactly', NOW - 1800));
        expect(v.action).toBe('pass');
    });

    it('passes when there is simply no overlap', () => {
        const f = mkFilter();
        f.addClientFinal('tell me about your current workflow', seq('tell me about your current workflow', NOW - 3000));
        const v = f.filterUserFinal('we mostly use spreadsheets today',
            seq('we mostly use spreadsheets today', NOW - 1500));
        expect(v.action).toBe('pass');
    });
});

describe('TranscriptEchoFilter — n-gram fallback (no word data)', () => {
    it('drops high-precision echo text', () => {
        const f = mkFilter();
        f.addClientFinal('we really need to improve our pipeline conversion rate this quarter');
        const v = f.filterUserFinal('we really need to improve our pipeline conversion rate this quarter');
        expect(v.action).toBe('drop');
        if (v.action === 'drop') expect(v.method).toBe('ngram');
    });

    it('passes short genuine replies', () => {
        const f = mkFilter();
        f.addClientFinal('do you have budget approval for this quarter');
        expect(f.filterUserFinal('yes').action).toBe('pass');
        expect(f.filterUserFinal('yes we do').action).toBe('pass'); // bigram floor 0.80
    });

    it('applies the lower 0.60 threshold in builtin-only mode', () => {
        // Mic shares 3 of its 5 trigrams with the client text (precision 0.60):
        // at the boundary of builtin-only, below the strict 0.75.
        const client = 'alpha beta gamma delta epsilon zeta';
        const mic = 'alpha beta gamma delta epsilon my question';
        const strict = mkFilter({ builtinOnly: false });
        strict.addClientFinal(client);
        expect(strict.filterUserFinal(mic).action).toBe('pass');

        const builtin = mkFilter({ builtinOnly: true });
        builtin.addClientFinal(client);
        expect(builtin.filterUserFinal(mic).action).toBe('drop');
    });

    it('word path falls back to n-gram when the feature flag is off', () => {
        const f = mkFilter({ wordFilter: false });
        const clientText = 'we really need to improve our pipeline conversion rate this quarter';
        f.addClientFinal(clientText, seq(clientText, NOW - 3000));
        const v = f.filterUserFinal(clientText, seq(clientText, NOW - 2700));
        expect(v.action).toBe('drop');
        if (v.action === 'drop') expect(v.method).toBe('ngram');
    });
});

describe('TranscriptEchoFilter — platform gate', () => {
    it('is inert when echo is not physically possible', () => {
        const f = new TranscriptEchoFilter({ echoPossible: false, now: () => NOW });
        const clientText = 'identical text on both streams';
        f.addClientFinal(clientText, seq(clientText, NOW - 1000));
        expect(f.filterUserFinal(clientText, seq(clientText, NOW - 800)).action).toBe('pass');
    });
});
