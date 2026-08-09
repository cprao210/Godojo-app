import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptEchoFilter, type AecTelemetry } from '../audio/TranscriptEchoFilter';
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
// Mutable mock clock — advance `now` to test TTL expiry.
let now = NOW;
beforeEach(() => { now = NOW; });

const mkFilter = (over?: Partial<{ builtinOnly: boolean; wordFilter: boolean; aec: AecTelemetry | null }>) =>
    new TranscriptEchoFilter({
        echoPossible: true,
        useWordFilter: () => over?.wordFilter ?? true,
        isBuiltinOnly: () => over?.builtinOnly ?? false,
        getAecTelemetry: over && 'aec' in over ? () => over.aec ?? null : undefined,
        now: () => now,
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

describe('TranscriptEchoFilter — interims (filterUserInterim)', () => {
    it('suppresses via the word path at coverage ≥ 0.6', () => {
        const f = mkFilter();
        const clientText = 'we can offer a discount if you sign the annual contract today';
        f.addClientFinal(clientText, seq(clientText, NOW - 5000));
        // 5 echoed words + 3 genuine words → coverage 5/8 = 0.625.
        const echo = seq('we can offer a discount', NOW - 5000 + 300);
        const genuine = seq('is that monthly', NOW - 3800);
        const v = f.filterUserInterim('we can offer a discount is that monthly', [...echo, ...genuine]);
        expect(v.action).toBe('suppress');
        if (v.action === 'suppress') expect(v.method).toBe('words');
    });

    it('never trims — a mixed interim below coverage passes whole', () => {
        const f = mkFilter();
        const clientText = 'we can offer a discount if you sign the annual contract today';
        f.addClientFinal(clientText, seq(clientText, NOW - 5000));
        // 3 echoed + 5 genuine → coverage 3/8 = 0.375 < 0.6.
        const echo = seq('we can offer', NOW - 5000 + 300);
        const genuine = seq('let me check internally first', NOW - 3800);
        const v = f.filterUserInterim('we can offer let me check internally first', [...echo, ...genuine]);
        expect(v.action).toBe('pass');
    });

    it('suppresses growing text prefixes of a reference (method: prefix)', () => {
        const f = mkFilter();
        f.addClientFinal('we can offer a discount if you sign the annual contract today');
        for (const prefix of [
            'we can offer',
            'we can offer a discount',
            'we can offer a discount if you sign',
        ]) {
            const v = f.filterUserInterim(prefix);
            expect(v.action).toBe('suppress');
            if (v.action === 'suppress') expect(v.method).toBe('prefix');
        }
    });

    it('does not suppress a genuine interim on a mid-word substring hit (word-boundary anchored)', () => {
        const f = mkFilter();
        // "art of the deal" is a mid-word substring of "restART OF THE process"
        // — the prefix fallback must only match on word boundaries.
        f.addClientFinal('restart of the process now please everyone');
        expect(f.filterUserInterim('art of the deal').action).toBe('pass');
        // A real word-aligned growing prefix still suppresses.
        const v = f.filterUserInterim('restart of the process');
        expect(v.action).toBe('suppress');
        if (v.action === 'suppress') expect(v.method).toBe('prefix');
    });

    it('passes interims under INTERIM_MIN_WORDS even when identical to client text', () => {
        const f = mkFilter();
        f.addClientFinal('we can offer a discount if you sign today');
        expect(f.filterUserInterim('we can').action).toBe('pass');
    });

    it('passes interims made entirely of backchannels', () => {
        const f = mkFilter();
        f.addClientFinal('yeah okay right exactly that is the plan');
        expect(f.filterUserInterim('yeah okay right').action).toBe('pass');
    });

    it('passes genuine interims with no overlap', () => {
        const f = mkFilter();
        f.addClientFinal('tell me about your current workflow please');
        const v = f.filterUserInterim('we mostly use spreadsheets today',
            seq('we mostly use spreadsheets today', NOW - 1000));
        expect(v.action).toBe('pass');
    });

    it('is inert when echo is not physically possible', () => {
        const f = new TranscriptEchoFilter({ echoPossible: false, now: () => NOW });
        const clientText = 'identical text on both streams here';
        f.addClientFinal(clientText, seq(clientText, NOW - 1000));
        expect(f.filterUserInterim(clientText, seq(clientText, NOW - 800)).action).toBe('pass');
    });
});

describe('TranscriptEchoFilter — client interims as provisional reference (ordering)', () => {
    it('drops a mic final that echoes a client INTERIM before any client final (word path)', () => {
        const f = mkFilter();
        const text = 'our pricing starts at five thousand per month';
        f.addClientInterim(text, seq(text, NOW - 2000));
        const v = f.filterUserFinal(text, seq(text, NOW - 2000 + 300));
        expect(v.action).toBe('drop');
        if (v.action === 'drop') expect(v.method).toBe('words');
    });

    it('drops a text-only mic final against a text-only client interim (n-gram)', () => {
        const f = mkFilter();
        const text = 'our pricing starts at five thousand per month';
        f.addClientInterim(text);
        const v = f.filterUserFinal(text);
        expect(v.action).toBe('drop');
        if (v.action === 'drop') expect(v.method).toBe('ngram');
    });

    it('a committed client final supersedes the provisional interim', () => {
        const f = mkFilter();
        f.addClientInterim('alpha beta gamma delta engagement metrics');
        f.addClientFinal('completely different committed sentence here');
        // The provisional text must no longer act as reference.
        expect(f.filterUserInterim('alpha beta gamma delta engagement metrics').action).toBe('pass');
        expect(f.filterUserFinal('alpha beta gamma delta engagement metrics').action).toBe('pass');
    });

    it('expires the provisional reference after its TTL', () => {
        const text = 'the integration takes about two weeks to complete';

        // Control: within TTL the echo final is dropped.
        const fresh = mkFilter();
        fresh.addClientInterim(text, seq(text, NOW));
        expect(fresh.filterUserFinal(text, seq(text, NOW + 300)).action).toBe('drop');

        // Past TTL (>10s) the provisional is gone — the same final passes.
        const stale = mkFilter();
        stale.addClientInterim(text, seq(text, NOW));
        now = NOW + 11_000;
        expect(stale.filterUserFinal(text, seq(text, NOW + 300)).action).toBe('pass');
    });

    it('latest client interim wins', () => {
        const f = mkFilter();
        f.addClientInterim('first provisional utterance text');
        f.addClientInterim('second replacement provisional line');
        expect(f.filterUserInterim('first provisional utterance text').action).toBe('pass');
        expect(f.filterUserInterim('second replacement provisional line').action).toBe('suppress');
    });
});

describe('TranscriptEchoFilter — telemetry-adaptive strictness', () => {
    const STRICT_AEC: AecTelemetry = { gateState: 'unconverged', speakerActive: true };
    const clientText = 'the trial runs four hour sessions each day';

    /** Mic final "four hour" echoing the client's words within the lag window. */
    const twoWordEcho = (f: TranscriptEchoFilter) => {
        f.addClientFinal(clientText, seq(clientText, NOW - 3000));
        // "four" is client word idx 3 (NOW-2400); mic echoes it 300ms later.
        return f.filterUserFinal('four hour', seq('four hour', NOW - 2400 + 300));
    };

    it('drops a 2-word echo final in strict mode (span floor 2)', () => {
        expect(twoWordEcho(mkFilter({ aec: STRICT_AEC })).action).toBe('drop');
    });

    it('keeps the 3-word span floor when not strict', () => {
        expect(twoWordEcho(mkFilter()).action).toBe('pass');
        expect(twoWordEcho(mkFilter({ aec: null })).action).toBe('pass');
        expect(twoWordEcho(mkFilter({ aec: { gateState: 'converged', speakerActive: true } })).action).toBe('pass');
        expect(twoWordEcho(mkFilter({ aec: { gateState: 'unconverged', speakerActive: false } })).action).toBe('pass');
        expect(twoWordEcho(mkFilter({ aec: { gateState: 'headphone_bypass', speakerActive: true } })).action).toBe('pass');
    });

    it('treats unknown gate states as strict-eligible (startup_hold)', () => {
        expect(twoWordEcho(mkFilter({ aec: { gateState: 'startup_hold', speakerActive: true } })).action).toBe('drop');
    });

    it('drops (not trims) a ~0.55-coverage mixed final in strict mode', () => {
        const mixed = (f: TranscriptEchoFilter) => {
            const client = 'alpha beta gamma delta epsilon zeta';
            f.addClientFinal(client, seq(client, NOW - 4000));
            // 6 echoed + 5 genuine words → coverage 6/11 ≈ 0.55.
            const echo = seq(client, NOW - 4000 + 300);
            const genuine = seq('let me think about that', NOW - 2500);
            return f.filterUserFinal('...', [...echo, ...genuine]);
        };
        expect(mixed(mkFilter({ aec: STRICT_AEC })).action).toBe('drop');
        expect(mixed(mkFilter())).toMatchObject({ action: 'trim' });
    });

    it('lowers the interim suppress coverage to 0.4 in strict mode', () => {
        const halfEcho = (f: TranscriptEchoFilter) => {
            const client = 'we can offer a discount if you sign the annual contract today';
            f.addClientFinal(client, seq(client, NOW - 5000));
            // 4 echoed + 5 genuine → coverage 4/9 ≈ 0.44: strict-only suppress.
            const echo = seq('we can offer a', NOW - 5000 + 300);
            const genuine = seq('let me check internally first', NOW - 3800);
            return f.filterUserInterim('we can offer a let me check internally first', [...echo, ...genuine]);
        };
        expect(halfEcho(mkFilter({ aec: STRICT_AEC })).action).toBe('suppress');
        expect(halfEcho(mkFilter()).action).toBe('pass');
    });
});

describe('TranscriptEchoFilter — stats counters', () => {
    it('increments per verdict and zeroes on reset()', () => {
        const f = mkFilter();
        const clientText = 'we really need to improve our pipeline conversion rate this quarter';
        f.addClientFinal(clientText, seq(clientText, NOW - 4000));

        // Drop.
        expect(f.filterUserFinal(clientText, seq(clientText, NOW - 4000 + 300)).action).toBe('drop');
        // Trim.
        const echo = seq(clientText, NOW - 4000 + 250);
        const genuine = seq('let me check that with my manager first', NOW - 1500);
        expect(f.filterUserFinal('...', [...echo, ...genuine]).action).toBe('trim');
        // Interim suppress + client interim seen.
        f.addClientInterim('our pricing starts at five thousand per month');
        expect(f.filterUserInterim('our pricing starts at').action).toBe('suppress');
        // Retraction (counted by main).
        f.noteRetractionEmitted();

        expect(f.getStats()).toMatchObject({
            finalsDropped: 1,
            finalsTrimmed: 1,
            interimsSuppressed: 1,
            retractionsEmitted: 1,
            clientInterimsSeen: 1,
            strictModeActive: false,
        });

        f.reset();
        expect(f.getStats()).toMatchObject({
            finalsDropped: 0,
            finalsTrimmed: 0,
            interimsSuppressed: 0,
            retractionsEmitted: 0,
            clientInterimsSeen: 0,
        });
    });
});
