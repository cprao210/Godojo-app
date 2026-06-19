// electron/llm/types.ts
// Shared types for the Natively LLM system

import { GoogleGenAI } from "@google/genai";

/**
 * Generation configuration for Gemini calls
 */
export interface GenerationConfig {
    maxOutputTokens: number;
    temperature: number;
    topP: number;
}

/**
 * Per-mode output token caps.
 *
 * Rationale:
 *   - Live advisor modes (answer / assist / followUp / whatToAnswer /
 *     objectionHandler / discovery / whatAmIMissing): 512 tokens.
 *     A spoken sales response should be deliverable in ~30 seconds (~75 words).
 *     512 tokens is a hard ceiling that prevents runaway verbose responses
 *     during the most latency-sensitive path in the app.
 *
 *   - recap / summary / email: 2048 tokens.
 *     These are async, post-meeting tasks where completeness matters more
 *     than speed. 2048 tokens covers ~1500 words — enough for a full
 *     call summary or follow-up email without over-provisioning.
 *
 *   - structured (JSON generation): 4096 tokens.
 *     Used for structured outputs (resume parse, JD analysis, company research).
 *     4096 tokens gives headroom for large JSON objects while staying well
 *     under the 25s non-streaming timeout at typical generation speeds.
 *
 * The previous flat 65536 value was the API maximum — effectively unlimited.
 * It caused tail-latency spikes on live advisor calls and masked prompt
 * engineering issues that relied on the model self-terminating early.
 */
export const MODE_TOKEN_LIMITS = {
    // Live advisor modes — latency-critical
    answer:           512,
    assist:           512,
    followUp:         512,
    whatToAnswer:     512,
    objectionHandler: 512,
    discovery:        512,
    whatAmIMissing:   512,
    followUpQuestions: 512,

    // Async post-meeting modes — quality-critical
    recap:    2048,
    summary:  2048,
    email:    2048,

    // Structured JSON generation
    structured: 4096,
} as const;

/**
 * Mode-specific generation configurations.
 * maxOutputTokens now sourced from MODE_TOKEN_LIMITS above.
 */
export const MODE_CONFIGS = {
    answer: {
        maxOutputTokens: MODE_TOKEN_LIMITS.answer,
        temperature: 0.25,
        topP: 0.85,
    } as GenerationConfig,

    assist: {
        maxOutputTokens: MODE_TOKEN_LIMITS.assist,
        temperature: 0.25,
        topP: 0.85,
    } as GenerationConfig,

    followUp: {
        maxOutputTokens: MODE_TOKEN_LIMITS.followUp,
        temperature: 0.25,
        topP: 0.85,
    } as GenerationConfig,

    recap: {
        maxOutputTokens: MODE_TOKEN_LIMITS.recap,
        temperature: 0.25,
        topP: 0.85,
    } as GenerationConfig,

    followUpQuestions: {
        maxOutputTokens: MODE_TOKEN_LIMITS.followUpQuestions,
        temperature: 0.4, // Slightly higher creative freedom
        topP: 0.9,
    } as GenerationConfig,
} as const;

/**
 * Gemini content structure
 */
export interface GeminiContent {
    role: "user" | "model";
    parts: { text: string }[];
}

/**
 * LLM client interface for dependency injection
 */
export interface LLMClient {
    getGeminiClient(): GoogleGenAI | null;
}
