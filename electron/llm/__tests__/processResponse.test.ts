/**
 * Guards the `filterFallback` gate on LLMHelper.processResponse.
 *
 * processResponse THROWS when the model output contains "I don't know" /
 * "It depends" / "I'm not sure" / "I can't answer". That behaviour exists for
 * the live-advisor modes, where a hedging answer IS the failure.
 *
 * But the post-call summary prompts instruct the model to quote prospect
 * evidence VERBATIM. So a prospect saying "it depends on seat count" made a
 * perfectly good summary throw — and because each processResponse call sits
 * inside its provider's try block, the throw was classified as a provider
 * failure and cascaded through the entire ladder (Groq → Flash ×3 → Pro ×5 →
 * backend), ending in a silently empty summary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
    app: {
        getPath: (): string => '/tmp/sales-ai-test',
        isPackaged: false,
        getVersion: (): string => '0.0.0-test',
        on: (): undefined => undefined,
    },
    BrowserWindow: { getAllWindows: (): unknown[] => [] },
    ipcMain: { handle: (): undefined => undefined, on: (): undefined => undefined },
    safeStorage: { isEncryptionAvailable: (): boolean => false },
}));

let helper: any;
/** processResponse is private; reach it directly for a unit test. */
const call = (text: string, opts?: { filterFallback?: boolean }) =>
    (helper as any).processResponse(text, opts);

beforeEach(async () => {
    const { LLMHelper } = await import('../../LLMHelper');
    helper = new LLMHelper();
});

describe('processResponse — default (live advisor) behaviour', () => {
    it('still throws on a hedging reply', () => {
        expect(() => call("I'm not sure what they meant.")).toThrow(/fallback/i);
        expect(() => call('It depends on the situation.')).toThrow(/fallback/i);
        expect(() => call("I can't answer that.")).toThrow(/fallback/i);
        expect(() => call("I don't know.")).toThrow(/fallback/i);
    });

    it('is case-insensitive', () => {
        expect(() => call('IT DEPENDS on the seat count')).toThrow(/fallback/i);
    });

    it('passes a normal reply through', () => {
        expect(call('Ask about their renewal date.')).toBe('Ask about their renewal date.');
    });
});

describe('processResponse — filterFallback: false (structured/JSON tasks)', () => {
    it('lets a summary quoting a hedging prospect through', () => {
        const json = '{"keyPoints":["Prospect said \\"I\'m not sure we have budget this quarter\\""]}';
        expect(() => call(json, { filterFallback: false })).not.toThrow();
        expect(call(json, { filterFallback: false })).toBe(json);
    });

    it('lets each banned phrase through when the gate is off', () => {
        for (const phrase of ["I'm not sure", 'It depends', "I can't answer", "I don't know"]) {
            const json = `{"overview":"The prospect said: ${phrase}."}`;
            expect(() => call(json, { filterFallback: false })).not.toThrow();
        }
    });

    it('still strips code fences when the gate is off', () => {
        expect(call('```json\n{"a":1}\n```', { filterFallback: false })).toBe('{"a":1}');
    });
});
