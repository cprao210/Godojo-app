// backendFallbackTimeout.ts
//
// How long LLMHelper.callBackendFallback waits for POST /api/v1/llm/fallback/generate.
//
// The backend gives a long context (over LONG_CONTEXT_CHARS, the same cut-off as
// `generate_fallback` in godojo-apis app/services/llm_fallback.py) 120s per model — Flash,
// then Pro — plus a few jittered retries on a 429. A flat 60s here dropped the answer on a
// 514-turn upload even when the backend produced it: the backend logged a 200, the desktop
// had already given up. Short contexts keep 60s so a stuck backend still fails fast.

export const BACKEND_FALLBACK_TIMEOUT_MS = 60_000;
export const BACKEND_FALLBACK_LONG_TIMEOUT_MS = 300_000;
export const LONG_CONTEXT_CHARS = 20_000;

export function backendFallbackTimeoutMs(contextLength: number): number {
    return contextLength > LONG_CONTEXT_CHARS ? BACKEND_FALLBACK_LONG_TIMEOUT_MS : BACKEND_FALLBACK_TIMEOUT_MS;
}
