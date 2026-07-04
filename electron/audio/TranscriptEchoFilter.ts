/**
 * TranscriptEchoFilter — transcript-level echo suppression, word-timestamp
 * based with an n-gram text fallback.
 *
 * When system audio plays through speakers, the mic physically hears it and
 * the other party's speech shows up on BOTH STT streams. The audio layer
 * (AEC3 + gate in the native module) removes most of it; this filter is the
 * safety net for whatever leaks through — especially once the gate runs
 * full-duplex and the mic stays open during far-end speech.
 *
 * Word path (Deepgram, word timestamps available):
 *   Client final words are kept in a rolling window (wall-clock ms, converted
 *   upstream by the provider's anchor ring). When a user (mic) final arrives,
 *   its words are greedily aligned against recent client words — normalized
 *   text match + a lag window (echo trails its source by ≈0 acoustically;
 *   the window absorbs cross-connection STT/anchor jitter). Runs of ≥3
 *   consecutive matched words count as echo:
 *     • coverage ≥ 80% of the mic words → DROP the segment
 *     • otherwise → TRIM the echoed spans, keep the genuine words
 *   Trimming is the improvement over the old behavior: a user interjecting
 *   over leaked far-end audio keeps their words instead of losing the whole
 *   segment.
 *
 * Fallback path (no word data — non-Deepgram providers, UtteranceEnd
 * flushes): the original n-gram precision check, ported verbatim from
 * main.ts `_isMicEcho` (drop-or-pass only; trimming needs timestamps).
 */

import { normalizeWordText, type SttWord } from './sttWordUtils';

export type EchoVerdict =
    | { action: 'pass' }
    | { action: 'drop'; matchRatio: number; method: 'words' | 'ngram' }
    | { action: 'trim'; text: string; keptWords: SttWord[]; matchRatio: number; method: 'words' };

export interface TranscriptEchoFilterOptions {
    /**
     * Whether acoustic echo is physically possible in this configuration.
     * Today: macOS only (Windows WASAPI setups have shown no bleed) — flips
     * cross-platform when the full-duplex audio work lands everywhere.
     */
    echoPossible?: boolean;
    /** Feature flag: use the word-timestamp path (falls back to n-gram when off). */
    useWordFilter?: () => boolean;
    /** Built-in mic+speakers mode lowers the n-gram threshold (more echo-prone). */
    isBuiltinOnly?: () => boolean;
    /** Clock injection for tests. */
    now?: () => number;
}

// Word-path tuning.
const CLIENT_WORD_WINDOW_MS = 15_000;
/** micStart - clientStart must fall in [-LAG_BEFORE, +LAG_AFTER]. */
const LAG_BEFORE_MS = 250;
const LAG_AFTER_MS = 1_500;
const MIN_ECHO_SPAN_WORDS = 3;
const DROP_COVERAGE = 0.8;

// n-gram fallback tuning (ported from main.ts _isMicEcho).
const NGRAM_WINDOW_MS = 6_000;
const NGRAM_SIMILARITY_THRESHOLD = 0.75;
const NGRAM_BUILTIN_THRESHOLD = 0.60;
const NGRAM_BIGRAM_FLOOR = 0.80;

/**
 * Backchannels and fillers that legitimately repeat the other party. A span
 * made ONLY of these never counts as echo (a genuine "yeah yeah okay" while
 * the client talks must survive).
 */
const COMMON_REPLIES = new Set([
    'yeah', 'yes', 'no', 'okay', 'ok', 'right', 'sure', 'exactly', 'correct',
    'true', 'great', 'good', 'nice', 'cool', 'wow', 'hmm', 'mhm', 'uhhuh',
    'got', 'it', 'i', 'see', 'thanks', 'thank', 'you', 'absolutely', 'definitely',
]);

interface ClientWordEntry {
    norm: string;
    startMs: number;
    endMs: number;
}

export class TranscriptEchoFilter {
    private clientWords: ClientWordEntry[] = [];
    private recentClientTexts: Array<{ text: string; ts: number }> = [];

    private readonly echoPossible: boolean;
    private readonly useWordFilter: () => boolean;
    private readonly isBuiltinOnly: () => boolean;
    private readonly now: () => number;

    constructor(opts: TranscriptEchoFilterOptions = {}) {
        this.echoPossible = opts.echoPossible ?? (process.platform === 'darwin');
        this.useWordFilter = opts.useWordFilter ?? (() => true);
        this.isBuiltinOnly = opts.isBuiltinOnly ?? (() => false);
        this.now = opts.now ?? Date.now;
    }

    public reset(): void {
        this.clientWords = [];
        this.recentClientTexts = [];
    }

    /** Record a final client (system-audio) transcript as echo reference. */
    public addClientFinal(text: string, words?: SttWord[]): void {
        if (!this.echoPossible) return;
        const now = this.now();
        this.recentClientTexts.push({ text, ts: now });
        this.recentClientTexts = this.recentClientTexts.filter(e => now - e.ts < NGRAM_WINDOW_MS);

        if (words && words.length > 0) {
            for (const w of words) {
                const norm = normalizeWordText(w.text);
                if (norm) this.clientWords.push({ norm, startMs: w.startMs, endMs: w.endMs });
            }
            // Keep the window bounded (words are appended in time order).
            const cutoff = now - CLIENT_WORD_WINDOW_MS;
            let firstKept = 0;
            while (firstKept < this.clientWords.length && this.clientWords[firstKept].endMs < cutoff) {
                firstKept++;
            }
            if (firstKept > 0) this.clientWords = this.clientWords.slice(firstKept);
        }
    }

    /** Judge a final user (mic) transcript: pass through, trim echo, or drop. */
    public filterUserFinal(text: string, words?: SttWord[]): EchoVerdict {
        if (!this.echoPossible) return { action: 'pass' };

        if (this.useWordFilter() && words && words.length > 0 && this.clientWords.length > 0) {
            return this.filterByWords(text, words);
        }
        // No word data (non-Deepgram provider, UtteranceEnd flush) — n-gram.
        return this.isEchoByNgram(text)
            ? { action: 'drop', matchRatio: 1, method: 'ngram' }
            : { action: 'pass' };
    }

    // =========================================================================
    // Word-timestamp path
    // =========================================================================

    private filterByWords(text: string, micWords: SttWord[]): EchoVerdict {
        // Single-word segments are almost always genuine replies.
        if (micWords.length < 2) return { action: 'pass' };

        // Greedy monotonic alignment: walk mic words in order, matching each
        // against the next unconsumed client word with the same normalized
        // text whose start time is within the lag window.
        const matched: boolean[] = new Array(micWords.length).fill(false);
        let clientCursor = 0;
        for (let i = 0; i < micWords.length; i++) {
            const norm = normalizeWordText(micWords[i].text);
            if (!norm) continue;
            for (let j = clientCursor; j < this.clientWords.length; j++) {
                const cw = this.clientWords[j];
                const lag = micWords[i].startMs - cw.startMs;
                if (lag > LAG_AFTER_MS) { clientCursor = j + 1; continue; } // client word too old for this and all later mic words? (mic words are ordered — safe to advance)
                if (lag < -LAG_BEFORE_MS) break; // client word is in the future — later ones are too
                if (cw.norm === norm) {
                    matched[i] = true;
                    clientCursor = j + 1;
                    break;
                }
            }
        }

        // Qualifying echo spans: ≥3 consecutive matched words, not made
        // entirely of common backchannel replies.
        const isEchoWord: boolean[] = new Array(micWords.length).fill(false);
        let runStart = -1;
        const closeRun = (endExclusive: number) => {
            if (runStart < 0) return;
            const len = endExclusive - runStart;
            if (len >= MIN_ECHO_SPAN_WORDS) {
                let allCommon = true;
                for (let k = runStart; k < endExclusive; k++) {
                    if (!COMMON_REPLIES.has(normalizeWordText(micWords[k].text))) { allCommon = false; break; }
                }
                if (!allCommon) {
                    for (let k = runStart; k < endExclusive; k++) isEchoWord[k] = true;
                }
            }
            runStart = -1;
        };
        for (let i = 0; i < micWords.length; i++) {
            if (matched[i]) {
                if (runStart < 0) runStart = i;
            } else {
                closeRun(i);
            }
        }
        closeRun(micWords.length);

        const echoCount = isEchoWord.filter(Boolean).length;
        if (echoCount === 0) return { action: 'pass' };

        const matchRatio = echoCount / micWords.length;
        if (matchRatio >= DROP_COVERAGE) {
            return { action: 'drop', matchRatio, method: 'words' };
        }

        const keptWords = micWords.filter((_, i) => !isEchoWord[i]);
        if (keptWords.length === 0) {
            return { action: 'drop', matchRatio, method: 'words' };
        }
        const trimmedText = keptWords.map(w => w.punctuated ?? w.text).join(' ');
        return { action: 'trim', text: trimmedText, keptWords, matchRatio, method: 'words' };
    }

    // =========================================================================
    // n-gram fallback (ported from main.ts _isMicEcho)
    // =========================================================================

    private isEchoByNgram(micText: string): boolean {
        if (!micText || this.recentClientTexts.length === 0) return false;

        const words = micText.trim().split(/\s+/);
        // Single-word responses ("yes", "no", "okay") are almost always genuine replies.
        if (words.length < 2) return false;

        const now = this.now();
        this.recentClientTexts = this.recentClientTexts.filter(e => now - e.ts < NGRAM_WINDOW_MS);

        const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        const ngrams = (s: string, n: number): Set<string> => {
            const ws = normalise(s).split(/\s+/);
            const tg = new Set<string>();
            for (let i = 0; i + n - 1 < ws.length; i++) tg.add(ws.slice(i, i + n).join(' '));
            return tg;
        };

        // For 2–3 word segments trigrams don't exist — use bigrams instead.
        const gramSize = words.length <= 3 ? 2 : 3;
        const micTg = ngrams(micText, gramSize);
        if (micTg.size === 0) return false;

        for (const entry of this.recentClientTexts) {
            const clientTg = ngrams(entry.text, gramSize);
            if (clientTg.size === 0) continue;
            const intersection = [...micTg].filter(t => clientTg.has(t)).length;
            // Mic-side precision: fraction of mic's n-grams present in the client text.
            const precision = intersection / micTg.size;
            const baseThreshold = this.isBuiltinOnly() ? NGRAM_BUILTIN_THRESHOLD : NGRAM_SIMILARITY_THRESHOLD;
            const threshold = gramSize === 2 ? Math.max(baseThreshold, NGRAM_BIGRAM_FLOOR) : baseThreshold;
            if (precision >= threshold) return true;
        }
        return false;
    }
}
