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
 * Interims (mic partials) are judged by `filterUserInterim` with the same
 * alignment core — suppress-or-pass only, never trim (a suppressed interim is
 * simply superseded by the next one; a wrong trim would flicker in the UI).
 *
 * Ordering: client INTERIMS are recorded as a provisional reference
 * (`addClientInterim`) so an echo final/interim on the mic stream is caught
 * even when the corresponding client FINAL has not arrived yet (VAD-lockout
 * restarts delay client finals). A committed client final supersedes the
 * provisional entry — no double counting.
 *
 * Adaptive strictness: when native AEC telemetry says the speaker is actively
 * playing far-end audio and the AEC has NOT converged, leak residue is likely
 * and thresholds tighten (see STRICT_* constants). Missing or erroring
 * telemetry always fails open to the normal thresholds.
 *
 * Fallback path (no word data — non-Deepgram providers, UtteranceEnd
 * flushes): the original n-gram precision check, ported verbatim from
 * main.ts `_isMicEcho` (drop-or-pass only; trimming needs timestamps).
 */

import { normalizeWordText, type SttWord } from './sttWordUtils';

export type EchoVerdict =
    | { action: 'pass' }
    | { action: 'drop'; matchRatio: number; method: 'words' | 'ngram'; strict?: boolean }
    | { action: 'trim'; text: string; keptWords: SttWord[]; matchRatio: number; method: 'words'; strict?: boolean };

export type InterimVerdict =
    | { action: 'pass' }
    | { action: 'suppress'; matchRatio: number; method: 'words' | 'ngram' | 'prefix'; strict?: boolean };

/** Snapshot of the native echo pipeline relevant to filter strictness. */
export interface AecTelemetry {
    /** Native gate state: 'converged' | 'unconverged' | 'headphone_bypass' | 'legacy' | future values. */
    gateState: 'converged' | 'unconverged' | 'headphone_bypass' | 'legacy' | string;
    /** True while far-end audio recently played through the speakers. */
    speakerActive: boolean;
    erleDb?: number;
}

/** Cumulative verdict counters for the pipeline stats log line. */
export interface TranscriptEchoFilterStats {
    finalsDropped: number;
    finalsTrimmed: number;
    interimsSuppressed: number;
    retractionsEmitted: number;
    clientInterimsSeen: number;
    strictModeActive: boolean;
}

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
    /**
     * Live AEC telemetry from the native pipeline. Null / missing / throwing
     * → fail-open (normal thresholds, never strict).
     */
    getAecTelemetry?: () => AecTelemetry | null;
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

// Interim tuning: minimum length before an interim is judged at all, and the
// word-alignment coverage at which it is suppressed.
const INTERIM_MIN_WORDS = 3;
const INTERIM_SUPPRESS_COVERAGE = 0.6;

// Provisional (interim) client reference lifetime — covers mic echo that
// arrives BEFORE the corresponding client final (VAD-lockout ordering).
const PROVISIONAL_TTL_MS = 10_000;

// Strict-mode thresholds — active while far-end audio plays and the native
// AEC is unconverged (leak residue likely). COMMON_REPLIES exemption and the
// lag window stay active even in strict mode.
const STRICT_MIN_ECHO_SPAN_WORDS = 2;
const STRICT_DROP_COVERAGE = 0.5;
const STRICT_INTERIM_MIN_WORDS = 2;
const STRICT_INTERIM_SUPPRESS_COVERAGE = 0.4;
const STRICT_NGRAM_THRESHOLD = 0.60;

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

interface ProvisionalClient {
    text: string;
    words: ClientWordEntry[];
    ts: number;
}

export class TranscriptEchoFilter {
    private clientWords: ClientWordEntry[] = [];
    private recentClientTexts: Array<{ text: string; ts: number }> = [];
    /** Latest client INTERIM — provisional echo reference until a final supersedes it. */
    private provisionalClient: ProvisionalClient | null = null;

    private counters = {
        finalsDropped: 0,
        finalsTrimmed: 0,
        interimsSuppressed: 0,
        retractionsEmitted: 0,
        clientInterimsSeen: 0,
    };

    private readonly echoPossible: boolean;
    private readonly useWordFilter: () => boolean;
    private readonly isBuiltinOnly: () => boolean;
    private readonly getAecTelemetry: (() => AecTelemetry | null) | null;
    private readonly now: () => number;

    constructor(opts: TranscriptEchoFilterOptions = {}) {
        this.echoPossible = opts.echoPossible ?? (process.platform === 'darwin');
        this.useWordFilter = opts.useWordFilter ?? (() => true);
        this.isBuiltinOnly = opts.isBuiltinOnly ?? (() => false);
        this.getAecTelemetry = opts.getAecTelemetry ?? null;
        this.now = opts.now ?? Date.now;
    }

    public reset(): void {
        this.clientWords = [];
        this.recentClientTexts = [];
        this.provisionalClient = null;
        this.counters = {
            finalsDropped: 0,
            finalsTrimmed: 0,
            interimsSuppressed: 0,
            retractionsEmitted: 0,
            clientInterimsSeen: 0,
        };
    }

    /** Record a final client (system-audio) transcript as echo reference. */
    public addClientFinal(text: string, words?: SttWord[]): void {
        if (!this.echoPossible) return;
        // A committed final supersedes the provisional interim reference —
        // keeping both would double-count the same client words.
        this.provisionalClient = null;
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

    /**
     * Record a client INTERIM as the provisional echo reference (latest wins).
     * Covers the ordering gap where mic echo arrives before the client final.
     */
    public addClientInterim(text: string, words?: SttWord[]): void {
        if (!this.echoPossible) return;
        this.counters.clientInterimsSeen++;
        const entries: ClientWordEntry[] = [];
        if (words && words.length > 0) {
            for (const w of words) {
                const norm = normalizeWordText(w.text);
                if (norm) entries.push({ norm, startMs: w.startMs, endMs: w.endMs });
            }
        }
        this.provisionalClient = { text, words: entries, ts: this.now() };
    }

    /** Judge a final user (mic) transcript: pass through, trim echo, or drop. */
    public filterUserFinal(text: string, words?: SttWord[]): EchoVerdict {
        if (!this.echoPossible) return { action: 'pass' };

        const strict = this.isStrict();
        const refWords = this.getReferenceWords();
        if (this.useWordFilter() && words && words.length > 0 && refWords.length > 0) {
            const verdict = this.filterByWords(words, refWords, strict);
            if (verdict.action === 'drop') this.counters.finalsDropped++;
            else if (verdict.action === 'trim') this.counters.finalsTrimmed++;
            return verdict;
        }
        // No word data (non-Deepgram provider, UtteranceEnd flush) — n-gram.
        if (this.isEchoByNgram(text, strict)) {
            this.counters.finalsDropped++;
            return { action: 'drop', matchRatio: 1, method: 'ngram', strict };
        }
        return { action: 'pass' };
    }

    /**
     * Judge an INTERIM (non-final) user transcript: pass or suppress — never
     * trim. Suppressed interims never reach the renderer or SessionTracker.
     */
    public filterUserInterim(text: string, words?: SttWord[]): InterimVerdict {
        if (!this.echoPossible) return { action: 'pass' };

        const strict = this.isStrict();
        const tokens = text.trim().split(/\s+/).filter(t => normalizeWordText(t));
        const minWords = strict ? STRICT_INTERIM_MIN_WORDS : INTERIM_MIN_WORDS;
        if (tokens.length < minWords) return { action: 'pass' };
        // A genuine "yeah yeah okay" while the client talks must survive.
        if (tokens.every(t => COMMON_REPLIES.has(normalizeWordText(t)))) return { action: 'pass' };

        // Word path — same greedy alignment as finals, coverage-only.
        const refWords = this.getReferenceWords();
        if (this.useWordFilter() && words && words.length > 0 && refWords.length > 0) {
            const matched = this.alignAgainstReference(words, refWords);
            const coverage = matched.filter(Boolean).length / words.length;
            const threshold = strict ? STRICT_INTERIM_SUPPRESS_COVERAGE : INTERIM_SUPPRESS_COVERAGE;
            if (coverage >= threshold) {
                this.counters.interimsSuppressed++;
                return { action: 'suppress', matchRatio: coverage, method: 'words', strict };
            }
        }

        // Text fallback (a): a mic interim that is a contiguous substring of a
        // reference text is the growing prefix of an echo.
        if (this.isSubstringOfReference(text)) {
            this.counters.interimsSuppressed++;
            return { action: 'suppress', matchRatio: 1, method: 'prefix', strict };
        }

        // Text fallback (b): n-gram precision (same check as final drops).
        if (this.isEchoByNgram(text, strict)) {
            this.counters.interimsSuppressed++;
            return { action: 'suppress', matchRatio: 1, method: 'ngram', strict };
        }

        return { action: 'pass' };
    }

    /** Called by main when it emits a retraction for a suppressed pending partial. */
    public noteRetractionEmitted(): void {
        this.counters.retractionsEmitted++;
    }

    /** Cumulative counters (zeroed by reset()) for the 5s pipeline stats log. */
    public getStats(): TranscriptEchoFilterStats {
        return { ...this.counters, strictModeActive: this.isStrict() };
    }

    // =========================================================================
    // Adaptive strictness
    // =========================================================================

    /**
     * Strict mode: far-end audio is playing while the native AEC is NOT
     * converged — leak residue is likely. Unknown gate states (new native
     * values like 'startup_hold') are treated as strict-eligible; only
     * converged* and headphone_bypass relax. Fail-open: missing or erroring
     * telemetry always means normal thresholds.
     */
    private isStrict(): boolean {
        if (!this.getAecTelemetry) return false;
        try {
            const t = this.getAecTelemetry();
            if (!t) return false;
            const state = String(t.gateState ?? '');
            if (state.startsWith('converged') || state === 'headphone_bypass') return false;
            return t.speakerActive === true;
        } catch {
            return false;
        }
    }

    // =========================================================================
    // Word-timestamp path
    // =========================================================================

    /** Committed client words + TTL-checked provisional interim words. */
    private getReferenceWords(): ClientWordEntry[] {
        const prov = this.getProvisional();
        if (!prov || prov.words.length === 0) return this.clientWords;
        return [...this.clientWords, ...prov.words];
    }

    private getProvisional(): ProvisionalClient | null {
        if (!this.provisionalClient) return null;
        if (this.now() - this.provisionalClient.ts > PROVISIONAL_TTL_MS) {
            this.provisionalClient = null;
            return null;
        }
        return this.provisionalClient;
    }

    /**
     * Greedy monotonic alignment: walk mic words in order, matching each
     * against the next unconsumed reference word with the same normalized
     * text whose start time is within the lag window. Shared by the final
     * (drop/trim) and interim (suppress) paths.
     */
    private alignAgainstReference(micWords: SttWord[], refWords: ClientWordEntry[]): boolean[] {
        const matched: boolean[] = new Array(micWords.length).fill(false);
        let refCursor = 0;
        for (let i = 0; i < micWords.length; i++) {
            const norm = normalizeWordText(micWords[i].text);
            if (!norm) continue;
            for (let j = refCursor; j < refWords.length; j++) {
                const cw = refWords[j];
                const lag = micWords[i].startMs - cw.startMs;
                if (lag > LAG_AFTER_MS) { refCursor = j + 1; continue; } // reference word too old for this and all later mic words? (mic words are ordered — safe to advance)
                if (lag < -LAG_BEFORE_MS) break; // reference word is in the future — later ones are too
                if (cw.norm === norm) {
                    matched[i] = true;
                    refCursor = j + 1;
                    break;
                }
            }
        }
        return matched;
    }

    private filterByWords(micWords: SttWord[], refWords: ClientWordEntry[], strict: boolean): EchoVerdict {
        // Single-word segments are almost always genuine replies.
        if (micWords.length < 2) return { action: 'pass' };

        const matched = this.alignAgainstReference(micWords, refWords);

        // Qualifying echo spans: ≥3 consecutive matched words (2 in strict
        // mode), not made entirely of common backchannel replies.
        const minSpanWords = strict ? STRICT_MIN_ECHO_SPAN_WORDS : MIN_ECHO_SPAN_WORDS;
        const isEchoWord: boolean[] = new Array(micWords.length).fill(false);
        let runStart = -1;
        const closeRun = (endExclusive: number) => {
            if (runStart < 0) return;
            const len = endExclusive - runStart;
            if (len >= minSpanWords) {
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
        const dropCoverage = strict ? STRICT_DROP_COVERAGE : DROP_COVERAGE;
        if (matchRatio >= dropCoverage) {
            return { action: 'drop', matchRatio, method: 'words', strict };
        }

        const keptWords = micWords.filter((_, i) => !isEchoWord[i]);
        if (keptWords.length === 0) {
            return { action: 'drop', matchRatio, method: 'words', strict };
        }
        const trimmedText = keptWords.map(w => w.punctuated ?? w.text).join(' ');
        return { action: 'trim', text: trimmedText, keptWords, matchRatio, method: 'words', strict };
    }

    // =========================================================================
    // Text fallbacks (no word data)
    // =========================================================================

    /** Recent client final texts + TTL-checked provisional interim text. */
    private getReferenceTexts(): string[] {
        const now = this.now();
        this.recentClientTexts = this.recentClientTexts.filter(e => now - e.ts < NGRAM_WINDOW_MS);
        const texts = this.recentClientTexts.map(e => e.text);
        const prov = this.getProvisional();
        if (prov && prov.text) texts.push(prov.text);
        return texts;
    }

    /**
     * True when the normalized mic text is a contiguous WORD-ALIGNED substring
     * of any reference text — the signature of an echo interim growing word by
     * word. Space-padding both sides anchors the match on word boundaries so a
     * genuine interim cannot be suppressed by a mid-word hit (e.g. "art of the"
     * must not match inside "restart of the process").
     */
    private isSubstringOfReference(micText: string): boolean {
        const normalise = (s: string) =>
            s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        const needle = normalise(micText);
        if (!needle) return false;
        const padded = ` ${needle} `;
        return this.getReferenceTexts().some(t => ` ${normalise(t)} `.includes(padded));
    }

    // =========================================================================
    // n-gram fallback (ported from main.ts _isMicEcho)
    // =========================================================================

    private isEchoByNgram(micText: string, strict = false): boolean {
        if (!micText) return false;
        const referenceTexts = this.getReferenceTexts();
        if (referenceTexts.length === 0) return false;

        const words = micText.trim().split(/\s+/);
        // Single-word responses ("yes", "no", "okay") are almost always genuine replies.
        if (words.length < 2) return false;

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

        for (const refText of referenceTexts) {
            const clientTg = ngrams(refText, gramSize);
            if (clientTg.size === 0) continue;
            const intersection = [...micTg].filter(t => clientTg.has(t)).length;
            // Mic-side precision: fraction of mic's n-grams present in the client text.
            const precision = intersection / micTg.size;
            const baseThreshold = strict
                ? STRICT_NGRAM_THRESHOLD
                : this.isBuiltinOnly() ? NGRAM_BUILTIN_THRESHOLD : NGRAM_SIMILARITY_THRESHOLD;
            const threshold = gramSize === 2 ? Math.max(baseThreshold, NGRAM_BIGRAM_FLOOR) : baseThreshold;
            if (precision >= threshold) return true;
        }
        return false;
    }
}
