import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The regex fast-path must answer these without touching the zero-shot
// worker, so a worker that never replies is enough here.
vi.mock('worker_threads', () => ({
    Worker: class {
        on() { return this; }
        postMessage() { /* never replies */ }
        terminate() { return Promise.resolve(0); }
    },
}));
vi.mock('electron', () => ({ app: { isPackaged: true } }));

describe('IntentClassifier sales intents (regex fast-path)', () => {
    beforeEach(() => {
        (process as any).resourcesPath = 'C:/fake/resources';
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
    });
    afterEach(() => vi.restoreAllMocks());

    const classify = async (text: string) => {
        const { classifyIntent } = await import('../llm/IntentClassifier');
        return classifyIntent(text, '', 0);
    };

    it.each([
        'Do you have any customers like us in logistics?',
        'Could you share a case study from a similar company?',
        'Who else is using this in healthcare?',
        'Can we talk to a couple of references?',
    ])('"%s" → proof_request', async (text) => {
        const r = await classify(text);
        expect(r.intent).toBe('proof_request');
        expect(r.answerShape).toMatch(/Never invent customer names/);
    });

    it.each([
        'Does it integrate with Salesforce?',
        'Do you support SSO through Okta?',
        'Are you SOC 2 compliant?',
        'Is there an API we can use for our data warehouse?',
        'Can we self-host it on our own servers?',
    ])('"%s" → technical', async (text) => {
        const r = await classify(text);
        expect(r.intent).toBe('technical');
        expect(r.answerShape).toMatch(/solutions engineer/);
    });

    it('does not treat "preferences" as a reference request', async () => {
        // No pattern matches, so this falls through to the (silent) worker and
        // then the context heuristic — fake timers skip the cold-load wait.
        vi.useFakeTimers();
        try {
            const p = classify('We set our notification preferences per team member, is that okay?');
            await vi.runAllTimersAsync();
            const r = await p;
            expect(r.intent).not.toBe('proof_request');
        } finally {
            vi.useRealTimers();
        }
    });

    it('no longer produces the interview intents', async () => {
        const { getAnswerShapeGuidance } = await import('../llm/IntentClassifier');
        expect(() => getAnswerShapeGuidance('coding' as any)).not.toThrow();
        expect(getAnswerShapeGuidance('coding' as any)).toBeUndefined();
        expect(getAnswerShapeGuidance('behavioral' as any)).toBeUndefined();
    });
});
