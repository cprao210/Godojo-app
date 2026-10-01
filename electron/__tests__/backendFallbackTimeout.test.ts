// Covers electron/utils/backendFallbackTimeout — how long LLMHelper.callBackendFallback waits
// for the backend summary/score fallback. A flat 60s dropped the backend's answer on long
// uploads: the backend spends up to 120s per model (Flash, then Pro) on a context over 20k chars.

import { describe, it, expect } from 'vitest';
import {
    backendFallbackTimeoutMs,
    BACKEND_FALLBACK_LONG_TIMEOUT_MS,
    BACKEND_FALLBACK_TIMEOUT_MS,
    LONG_CONTEXT_CHARS,
} from '../utils/backendFallbackTimeout';

describe('backendFallbackTimeoutMs', () => {
    it('keeps 60s for short contexts, so a stuck backend still fails fast', () => {
        expect(backendFallbackTimeoutMs(0)).toBe(60_000);
        expect(backendFallbackTimeoutMs(LONG_CONTEXT_CHARS)).toBe(BACKEND_FALLBACK_TIMEOUT_MS);
    });

    it('waits 300s for long contexts — longer than the backend worst case (Flash 120s + Pro 120s)', () => {
        expect(backendFallbackTimeoutMs(LONG_CONTEXT_CHARS + 1)).toBe(BACKEND_FALLBACK_LONG_TIMEOUT_MS);
        expect(backendFallbackTimeoutMs(85_000)).toBe(300_000);
        expect(BACKEND_FALLBACK_LONG_TIMEOUT_MS).toBeGreaterThan(240_000);
    });
});
