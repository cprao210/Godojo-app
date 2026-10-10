// llmUsageBus.ts
//
// Observability for the LLM pipelines: every post-call summary generation
// (initial + regenerate), follow-up email, and the pre-call Sales Brief and
// Company Insights generations report which provider/model served them and
// the input/output token counts here.
//
// Two consumers:
//   1. PostHog (always on) — 'llm_generation_usage' with full metadata, for
//      pipeline analytics (cost per summary, provider mix, retry rates).
//   2. The renderer's dev-only usage chip — main.ts forwards every payload
//      to the window via the 'llm-usage' IPC channel (see preload.onLLMUsage).
//
// Token counts come from provider usage objects when available (Groq
// `usage`, Gemini `usageMetadata`) and fall back to the app's chars/4
// estimate — `estimated: true` marks those.

import { EventEmitter } from 'events';
import { posthogMain } from '../services/PostHogMainService';

export interface LLMUsageCall {
    /** e.g. 'groq' | 'gemini_flash' | 'gemini_pro' | 'custom:<name>' | 'backend_fallback' | 'electron_native (gemini→groq)' */
    provider: string;
    model?: string | null;
    inputTokens: number;
    outputTokens: number;
    /** true when counts are chars/4 estimates rather than provider-reported usage */
    estimated: boolean;
}

export type LLMUsageKind = 'summary_initial' | 'summary_regenerate' | 'followup_email' | 'company_insights' | 'sales_brief';

/** Tavily web-search usage behind a generation (company insights). Credits are an ESTIMATE:
 *  Tavily bills a basic search at 1 credit and an advanced one at 2, only for requests that
 *  returned; failed/retried requests are assumed unbilled. */
export interface TavilyUsage {
    /** logical searches issued (successful + failed) */
    searches: number;
    advanced: number;
    basic: number;
    failed: number;
    /** extra HTTP attempts beyond the first, across all searches */
    retries: number;
    creditsEstimated: number;
}

export interface LLMUsagePayload {
    /** Meeting id, or a synthetic key for non-meeting generations
     *  (company insights use "company:<domain-or-name>"; the pre-call
     *  sales brief uses the calendar event id). */
    meetingId: string;
    kind: LLMUsageKind;
    /** One entry per underlying LLM call (the verify loop can make several). */
    calls: LLMUsageCall[];
    totalInputTokens: number;
    totalOutputTokens: number;
    /** summary verify-loop attempts actually run, when known */
    attempts?: number;
    /** grounding confidence of the accepted summary (0-100), when known */
    confidence?: number | null;
    durationMs?: number;
    callType?: string | null;
    /** company name, for company_insights generations */
    company?: string | null;
    /** web-search usage that fed this generation, when it used Tavily */
    tavily?: TavilyUsage;
    at: number;
}

const bus = new EventEmitter();

/** Report a completed generation: forward to the renderer + capture PostHog. */
export function emitLLMUsage(payload: LLMUsagePayload): void {
    try {
        bus.emit('usage', payload);
    } catch (e) {
        console.warn('[llmUsageBus] listener failed:', e);
    }
    try {
        const lastCall = payload.calls[payload.calls.length - 1];
        console.log(
            `[llmUsageBus] ${payload.kind} usage: in=${payload.totalInputTokens} out=${payload.totalOutputTokens}` +
            `${payload.tavily ? ` tavily=${payload.tavily.searches}/${payload.tavily.creditsEstimated}cr` : ''} -> PostHog llm_generation_usage`,
        );
        posthogMain.capture('llm_generation_usage', {
            kind: payload.kind,
            meeting_id: payload.meetingId,
            providers: payload.calls.map((c) => c.provider).join(','),
            model: lastCall?.model ?? null,
            input_tokens: payload.totalInputTokens,
            output_tokens: payload.totalOutputTokens,
            total_tokens: payload.totalInputTokens + payload.totalOutputTokens,
            any_estimated: payload.calls.some((c) => c.estimated),
            llm_calls: payload.calls.length,
            attempts: payload.attempts ?? null,
            confidence: payload.confidence ?? null,
            duration_ms: payload.durationMs ?? null,
            call_type: payload.callType ?? null,
            company: payload.company ?? null,
            tavily_searches: payload.tavily?.searches ?? null,
            tavily_advanced: payload.tavily?.advanced ?? null,
            tavily_basic: payload.tavily?.basic ?? null,
            tavily_failed: payload.tavily?.failed ?? null,
            tavily_retries: payload.tavily?.retries ?? null,
            tavily_credits_estimated: payload.tavily?.creditsEstimated ?? null,
        });
    } catch (e) {
        // Analytics must never break generation.
        console.warn('[llmUsageBus] posthog capture failed:', e);
    }
}

/** Subscribe to usage payloads (used by main.ts to forward to the renderer). */
export function onLLMUsage(fn: (payload: LLMUsagePayload) => void): () => void {
    bus.on('usage', fn);
    return () => bus.off('usage', fn);
}