import { describe, it, expect } from 'vitest';
import {
    TranscriptTranslator,
    hasNonLatinScript,
    type TranscriptTranslatorDeps,
} from '../services/TranscriptTranslator';

const noKeys: TranscriptTranslatorDeps = {
    getGroqApiKey: (): string | undefined => undefined,
    getGeminiApiKey: (): string | undefined => undefined,
    getOpenaiApiKey: (): string | undefined => undefined,
    getClaudeApiKey: (): string | undefined => undefined,
};

describe('hasNonLatinScript', () => {
    it('passes plain English through', () => {
        expect(hasNonLatinScript('What is the purpose of your selling')).toBe(false);
    });

    it('treats accented Latin, punctuation and currency as Latin', () => {
        expect(hasNonLatinScript('Café naïve résumé')).toBe(false);
        expect(hasNonLatinScript('Revenue was $1,200 — up 15% (Q3)…')).toBe(false);
    });

    it('detects Devanagari', () => {
        expect(hasNonLatinScript('नमस्ते आप कैसे हैं')).toBe(true);
    });

    it('detects Hinglish where only part of the segment is Devanagari', () => {
        expect(hasNonLatinScript('मैं sales team में हूं')).toBe(true);
    });

    it('detects other non-Latin scripts', () => {
        expect(hasNonLatinScript('Здравствуйте')).toBe(true);
        expect(hasNonLatinScript('こんにちは')).toBe(true);
    });

    it('ignores empty and numeric-only text', () => {
        expect(hasNonLatinScript('')).toBe(false);
        expect(hasNonLatinScript('42')).toBe(false);
    });
});

describe('TranscriptTranslator.translate', () => {
    it('returns English text unchanged without needing a provider', async () => {
        const t = new TranscriptTranslator(noKeys);
        const text = 'What is the purpose of your selling';
        expect(await t.translate(text)).toBe(text);
    });

    it('returns the original when no provider key is configured', async () => {
        const t = new TranscriptTranslator(noKeys);
        const hindi = 'नमस्ते आप कैसे हैं';
        expect(await t.translate(hindi)).toBe(hindi);
    });

    it('reports unavailable with no keys and available once one exists', () => {
        expect(new TranscriptTranslator(noKeys).isAvailable()).toBe(false);
        expect(new TranscriptTranslator({ ...noKeys, getGeminiApiKey: () => 'k' }).isAvailable()).toBe(true);
    });
});

describe('TranscriptTranslator.enqueue', () => {
    it('runs tasks for one speaker in order even when the first is slower', async () => {
        const t = new TranscriptTranslator(noKeys);
        const done: string[] = [];

        const slow = t.enqueue('client', async () => {
            await new Promise((r) => setTimeout(r, 30));
            done.push('first');
            return 'first';
        });
        const fast = t.enqueue('client', async () => {
            done.push('second');
            return 'second';
        });

        await Promise.all([slow, fast]);
        expect(done).toEqual(['first', 'second']);
    });

    it('keeps separate speakers independent', async () => {
        const t = new TranscriptTranslator(noKeys);
        const done: string[] = [];

        const clientTask = t.enqueue('client', async () => {
            await new Promise((r) => setTimeout(r, 30));
            done.push('client');
        });
        const userTask = t.enqueue('user', async () => {
            done.push('user');
        });

        await Promise.all([clientTask, userTask]);
        // The user queue must not wait behind the slow client task.
        expect(done).toEqual(['user', 'client']);
    });

    it('does not let a rejected task block the queue behind it', async () => {
        const t = new TranscriptTranslator(noKeys);
        const failing = t.enqueue('client', async () => {
            throw new Error('boom');
        });
        await expect(failing).rejects.toThrow('boom');

        await expect(t.enqueue('client', async () => 'ok')).resolves.toBe('ok');
    });
});
