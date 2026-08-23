/**
 * TranscriptTranslator — renders non-English STT finals into English.
 *
 * Deepgram (and every other streaming provider here) transcribes in the language
 * that was spoken: Hindi speech comes back as Devanagari. When the user wants to
 * READ English while still SPEAKING Hindi, the translation has to happen on our
 * side, between the STT event and everything downstream of it.
 *
 * Scope, deliberately narrow:
 *  - Finals only. Interims fire 10+/sec and are superseded milliseconds later;
 *    translating them would burn tokens to render text nobody finishes reading.
 *  - Latin-script text is returned untouched without any network call, so an
 *    all-English meeting costs nothing and adds zero latency.
 *  - Failure and timeout both fall back to the original text. A transcript that
 *    is late or in the wrong language still beats a transcript that vanished.
 */

import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// Fast, cheap models — this runs on every foreign-language utterance in a live
// call, so latency matters far more than reasoning depth. Translation is the
// one task where the smallest instruct model is genuinely sufficient.
const GROQ_TRANSLATE_MODEL = 'llama-3.1-8b-instant';
const GEMINI_TRANSLATE_MODEL = 'gemini-3.1-flash-lite-preview';
const OPENAI_TRANSLATE_MODEL = 'gpt-5.4-mini';
const CLAUDE_TRANSLATE_MODEL = 'claude-haiku-4-5-20251001';

// Past this, a live caption is stale enough that the original text is the more
// useful thing to show. Tuned against Groq/Gemini p99 for one-sentence inputs.
const TRANSLATE_TIMEOUT_MS = 2500;

const CACHE_MAX_ENTRIES = 200;

const SYSTEM_PROMPT = [
    'You are a translation engine embedded in a live meeting transcript pipeline.',
    'Translate the user message into natural, conversational English.',
    'Rules:',
    '- Output ONLY the translation. No preamble, quotes, notes, or explanation.',
    '- Preserve proper nouns, company names, product names, and all numbers exactly.',
    '- Keep English words that already appear in the input as they are.',
    '- Preserve the speaker\'s tone and register; do not summarize, expand, or answer.',
    '- If the input is already entirely English, repeat it back verbatim.',
    '- Transcripts are fragments: translate incomplete sentences as-is without completing them.',
].join('\n');

type TranslateProvider = 'groq' | 'gemini' | 'openai' | 'claude';

export interface TranscriptTranslatorDeps {
    getGroqApiKey: () => string | undefined;
    getGeminiApiKey: () => string | undefined;
    getOpenaiApiKey: () => string | undefined;
    getClaudeApiKey: () => string | undefined;
}

/**
 * True when `text` carries letters outside the Latin script — Devanagari,
 * Cyrillic, CJK, Arabic, and friends. Hinglish ("मैं sales team में हूं") trips
 * this on its Devanagari span, which is what we want: the segment as a whole
 * needs translating even though part of it is already English.
 *
 * Digits, punctuation, and Latin letters alone never trigger a network call.
 */
export function hasNonLatinScript(text: string): boolean {
    // Allowed: Basic Latin, Latin-1 Supplement, Latin Extended-A/B (U+0000-U+024F),
    // general punctuation (U+2000-U+206F), currency (U+20A0-U+20CF), and letterlike
    // symbols (U+2100-U+214F). A character outside those is another script.
    return /[^\u0000-\u024F\u2000-\u206F\u20A0-\u20CF\u2100-\u214F]/.test(text);
}

export class TranscriptTranslator {
    private deps: TranscriptTranslatorDeps;

    private groqClient: Groq | null = null;
    private geminiClient: GoogleGenAI | null = null;
    private openaiClient: OpenAI | null = null;
    private claudeClient: Anthropic | null = null;

    // Clients are cached against the key that built them so a key change in
    // Settings takes effect on the next utterance without an app restart.
    private clientKeys: Partial<Record<TranslateProvider, string>> = {};

    private cache = new Map<string, string>();

    // Serializes finals per speaker. Without it two overlapping translations can
    // resolve out of order and the saved transcript records the utterances in the
    // wrong sequence — subtly wrong in a way nobody notices until they read it back.
    private queues: Record<string, Promise<void>> = {};

    private failureStreak = 0;
    private mutedUntil = 0;

    constructor(deps: TranscriptTranslatorDeps) {
        this.deps = deps;
    }

    /**
     * Run `task` after every previously queued task for `key` has finished.
     * Returns a promise for this task alone; a rejection never poisons the chain.
     */
    public enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
        const prior = this.queues[key] ?? Promise.resolve();
        const run: Promise<T> = prior.then(task, task);
        this.queues[key] = run.then((): void => undefined, (): void => undefined);
        return run;
    }

    /**
     * Translate to English, or return `text` unchanged when translation is
     * unnecessary, unavailable, too slow, or failing. Never throws.
     */
    public async translate(text: string): Promise<string> {
        const trimmed = text.trim();
        if (!trimmed || !hasNonLatinScript(trimmed)) return text;

        const cached = this.cache.get(trimmed);
        if (cached !== undefined) return cached;

        // After repeated failures (bad key, no network, provider outage) stop
        // paying the timeout on every single utterance for a while.
        if (Date.now() < this.mutedUntil) return text;

        const provider = this.pickProvider();
        if (!provider) return text;

        try {
            const translated = await this.withTimeout(this.callProvider(provider, trimmed));
            const clean = this.sanitize(translated);
            if (!clean) return text;

            this.failureStreak = 0;
            this.remember(trimmed, clean);
            return clean;
        } catch (err) {
            this.failureStreak++;
            if (this.failureStreak >= 3) {
                this.mutedUntil = Date.now() + 60_000;
                console.warn('[TranscriptTranslator] 3 consecutive failures — pausing translation for 60s');
            }
            console.warn(`[TranscriptTranslator] ${provider} failed:`, err instanceof Error ? err.message : err);
            return text;
        }
    }

    /** True when at least one provider key is configured. */
    public isAvailable(): boolean {
        return this.pickProvider() !== null;
    }

    // =========================================================================
    // Internals
    // =========================================================================

    /** Fastest provider whose key is present. Ordered by observed latency. */
    private pickProvider(): TranslateProvider | null {
        if (this.deps.getGroqApiKey()) return 'groq';
        if (this.deps.getGeminiApiKey()) return 'gemini';
        if (this.deps.getOpenaiApiKey()) return 'openai';
        if (this.deps.getClaudeApiKey()) return 'claude';
        return null;
    }

    private async withTimeout<T>(work: Promise<T>): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                work,
                new Promise<T>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`translation timed out after ${TRANSLATE_TIMEOUT_MS}ms`)),
                        TRANSLATE_TIMEOUT_MS,
                    );
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async callProvider(provider: TranslateProvider, text: string): Promise<string> {
        switch (provider) {
            case 'groq': return this.callGroq(text);
            case 'gemini': return this.callGemini(text);
            case 'openai': return this.callOpenai(text);
            case 'claude': return this.callClaude(text);
        }
    }

    private async callGroq(text: string): Promise<string> {
        const key = this.deps.getGroqApiKey()!;
        if (!this.groqClient || this.clientKeys.groq !== key) {
            this.groqClient = new Groq({ apiKey: key });
            this.clientKeys.groq = key;
        }
        const res = await this.groqClient.chat.completions.create({
            model: GROQ_TRANSLATE_MODEL,
            temperature: 0,
            max_tokens: 512,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: text },
            ],
        });
        return res.choices[0]?.message?.content ?? '';
    }

    private async callGemini(text: string): Promise<string> {
        const key = this.deps.getGeminiApiKey()!;
        if (!this.geminiClient || this.clientKeys.gemini !== key) {
            this.geminiClient = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: 'v1alpha' } });
            this.clientKeys.gemini = key;
        }
        const res = await this.geminiClient.models.generateContent({
            model: GEMINI_TRANSLATE_MODEL,
            contents: [{ role: 'user', parts: [{ text }] }],
            config: {
                systemInstruction: SYSTEM_PROMPT,
                temperature: 0,
                maxOutputTokens: 512,
            },
        });
        return res.text || '';
    }

    private async callOpenai(text: string): Promise<string> {
        const key = this.deps.getOpenaiApiKey()!;
        if (!this.openaiClient || this.clientKeys.openai !== key) {
            this.openaiClient = new OpenAI({ apiKey: key });
            this.clientKeys.openai = key;
        }
        const res = await this.openaiClient.chat.completions.create({
            model: OPENAI_TRANSLATE_MODEL,
            temperature: 0,
            max_completion_tokens: 512,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: text },
            ],
        });
        return res.choices[0]?.message?.content ?? '';
    }

    private async callClaude(text: string): Promise<string> {
        const key = this.deps.getClaudeApiKey()!;
        if (!this.claudeClient || this.clientKeys.claude !== key) {
            this.claudeClient = new Anthropic({ apiKey: key });
            this.clientKeys.claude = key;
        }
        const res = await this.claudeClient.messages.create({
            model: CLAUDE_TRANSLATE_MODEL,
            max_tokens: 512,
            temperature: 0,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: text }],
        });
        const block = res.content[0];
        return block && block.type === 'text' ? block.text : '';
    }

    /**
     * Strip the wrappers small models add despite instructions: surrounding
     * quotes and "Translation:" / "English:" prefixes.
     */
    private sanitize(raw: string): string {
        let out = raw.trim();
        if (!out) return '';
        out = out.replace(/^(?:translation|english|translated)\s*:\s*/i, '').trim();
        if (out.length >= 2 && /^["'“”]/.test(out) && /["'“”]$/.test(out)) {
            out = out.slice(1, -1).trim();
        }
        return out;
    }

    private remember(source: string, translated: string): void {
        if (this.cache.size >= CACHE_MAX_ENTRIES) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(source, translated);
    }
}
