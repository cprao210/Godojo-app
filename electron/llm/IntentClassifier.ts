// electron/llm/IntentClassifier.ts
// Lightweight intent classification for "What should I say?"
// Micro step that runs before answer generation
//
// Two-tier classification:
//   1. Regex fast-path (< 1ms) for common patterns
//   2. Local SLM fallback (zero-shot, ~10-50ms) for messy/ambiguous speech,
//      run in a worker thread (intentClassifierWorker.ts), never on main

import path from 'path';
import { Worker } from 'worker_threads';
import { app } from 'electron';

export type ConversationIntent =
    | 'clarification'      // "Can you explain that?"
    | 'follow_up'          // "What happened next?"
    | 'deep_dive'          // "Tell me more about X"
    | 'proof_request'      // "Do you have customers like us?" / case studies / references
    | 'example_request'    // "Can you give a concrete example?"
    | 'summary_probe'      // "So to summarize..."
    | 'technical'          // Integrations, API, security/compliance, deployment
    | 'general';           // Default fallback

export interface IntentResult {
    intent: ConversationIntent;
    confidence: number;
    answerShape: string;
}

/**
 * Answer shapes mapped to intents
 * This controls HOW the answer is structured, not just WHAT it says
 */
const INTENT_ANSWER_SHAPES: Record<ConversationIntent, string> = {
    clarification: 'Give a direct, focused 1-2 sentence clarification. No setup, no context-setting.',
    follow_up: 'Continue the narrative naturally. 1-2 sentences. No recap of what was already said.',
    deep_dive: 'Provide a structured but concise explanation. Use concrete specifics, not abstract concepts.',
    proof_request: 'Lead with the most relevant customer story or proof point from the provided context (similar industry, size or use case) and the outcome it achieved. Never invent customer names or numbers; if none are in context, say so and offer to follow up with a reference or case study.',
    example_request: 'Provide ONE concrete, detailed example. Make it realistic and specific.',
    summary_probe: 'Confirm the summary briefly and add one clarifying point if needed.',
    technical: 'Answer the technical question in plain, confident language the rep can say aloud: what is supported and how it works, in 2-3 sentences. Only state capabilities found in the provided context; if the detail is not there, say so and offer to bring in a solutions engineer or send documentation.',
    general: 'Respond naturally based on context. Keep it conversational and direct.'
};

// ========================
// Zero-Shot SLM Classifier
// ========================

/**
 * Candidate labels for zero-shot classification.
 * These map to ConversationIntent types.
 */
const ZERO_SHOT_LABELS: Record<string, ConversationIntent> = {
    'asking for clarification or explanation': 'clarification',
    'asking about what happened next or follow-up': 'follow_up',
    'requesting more detail or deeper explanation': 'deep_dive',
    'asking for customer proof, references or case studies': 'proof_request',
    'requesting a concrete example or instance': 'example_request',
    'summarizing or confirming understanding': 'summary_probe',
    'asking a technical, security or integration question': 'technical',
    'general conversation or question': 'general',
};

const ZERO_SHOT_LABEL_KEYS = Object.keys(ZERO_SHOT_LABELS);

/** Minimum confidence from the SLM to trust its classification */
const SLM_CONFIDENCE_THRESHOLD = 0.35;

/** Model load (first use) can take seconds on a slow CPU. */
const WORKER_LOAD_TIMEOUT_MS = 120_000;
/** A single classification; beyond this the context heuristic answers. */
const WORKER_CLASSIFY_TIMEOUT_MS = 5_000;
/**
 * If the model is still loading when a classification is requested, wait at
 * most this long before falling back to the context heuristic for that one
 * request (the load keeps going for the next one). The pre-worker code waited
 * for the whole load, stalling "What should I say" on a cold start.
 */
const COLD_LOAD_WAIT_MS = 8_000;

interface PendingRequest {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Singleton zero-shot classifier (Xenova/mobilebert-uncased-mnli — ~27 MB
 * quantized, ~10-50 ms inference). The model loads and runs in a worker
 * thread (llm/intentClassifierWorker.ts) so it never blocks the main process.
 */
class ZeroShotClassifier {
    private static instance: ZeroShotClassifier | null = null;
    private worker: Worker | null = null;
    private requestId = 0;
    private pending = new Map<number, PendingRequest>();
    private loaded = false;
    private loadingPromise: Promise<void> | null = null;
    private loadFailed = false;

    private constructor() { }

    static getInstance(): ZeroShotClassifier {
        if (!ZeroShotClassifier.instance) {
            ZeroShotClassifier.instance = new ZeroShotClassifier();
        }
        return ZeroShotClassifier.instance;
    }

    private getWorker(): Worker {
        if (this.worker) return this.worker;
        const worker = new Worker(path.join(__dirname, 'intentClassifierWorker.js'), {
            workerData: {
                localOnly: app.isPackaged,
                localModelPath: app.isPackaged ? path.join(process.resourcesPath, 'models') : '',
                // Dev mode downloads from HuggingFace Hub into this cache — same
                // location the pre-worker code used (relative to this file).
                cacheDir: path.join(__dirname, '../../resources/models'),
            },
        });
        worker.on('message', (msg: { type: string; requestId: number; data?: any; error?: string }) => {
            const p = this.pending.get(msg.requestId);
            if (!p) return;
            clearTimeout(p.timer);
            this.pending.delete(msg.requestId);
            if (msg.type === 'error') p.reject(new Error(msg.error || 'Intent worker error'));
            else p.resolve(msg.data);
        });
        worker.on('error', (err) => {
            console.error('[IntentClassifier] Worker error:', err);
            this.rejectAll(err);
        });
        worker.on('exit', (code) => {
            if (code !== 0) console.warn(`[IntentClassifier] Worker exited with code ${code}`);
            // A new worker would have to load the model again.
            this.worker = null;
            this.loaded = false;
            this.loadingPromise = null;
            this.rejectAll(new Error(`Intent worker exited with code ${code}`));
        });
        this.worker = worker;
        return worker;
    }

    private rejectAll(err: Error): void {
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }

    private post<T>(message: Record<string, unknown>, timeoutMs: number): Promise<T> {
        this.requestId = (this.requestId + 1) % Number.MAX_SAFE_INTEGER;
        const requestId = this.requestId;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`Intent worker request timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer });
            this.getWorker().postMessage({ ...message, requestId });
        });
    }

    /** Load the model in the worker (idempotent). Never throws. */
    private ensureLoaded(): Promise<void> {
        if (this.loaded || this.loadFailed) return Promise.resolve();
        if (this.loadingPromise) return this.loadingPromise;

        console.log('[IntentClassifier] Loading zero-shot classifier (mobilebert-uncased-mnli) in worker...');
        const startedAt = Date.now();
        this.loadingPromise = this.post<boolean>({ type: 'load' }, WORKER_LOAD_TIMEOUT_MS)
            .then(() => {
                this.loaded = true;
                console.log(`[IntentClassifier] Zero-shot classifier loaded in ${Date.now() - startedAt} ms.`);
            })
            .catch((e) => {
                console.warn('[IntentClassifier] Failed to load zero-shot model, regex-only fallback:', e);
                this.loadFailed = true;
                void this.worker?.terminate();
            });
        return this.loadingPromise;
    }

    /**
     * Classify text using the zero-shot model.
     * Returns null if the model isn't loaded or classification fails.
     */
    async classify(text: string): Promise<IntentResult | null> {
        if (!this.loaded) {
            const load = this.ensureLoaded();
            let waitTimer: ReturnType<typeof setTimeout> | undefined;
            const timedOut = await Promise.race([
                load.then(() => false),
                new Promise<boolean>((r) => { waitTimer = setTimeout(() => r(true), COLD_LOAD_WAIT_MS); }),
            ]);
            clearTimeout(waitTimer);
            if (timedOut) {
                console.log('[IntentClassifier] Model still loading — using context heuristic for this request.');
                return null;
            }
            if (!this.loaded) return null;
        }

        try {
            const result = await this.post<{ labels: string[]; scores: number[] }>(
                { type: 'classify', text, labels: ZERO_SHOT_LABEL_KEYS },
                WORKER_CLASSIFY_TIMEOUT_MS,
            );

            // result has { labels: string[], scores: number[] }
            const topLabel = result.labels[0];
            const topScore = result.scores[0];

            if (topScore < SLM_CONFIDENCE_THRESHOLD) {
                return null; // Not confident enough
            }

            const intent = ZERO_SHOT_LABELS[topLabel] || 'general';
            console.log(`[IntentClassifier] SLM classified as "${intent}" (${(topScore * 100).toFixed(1)}%): "${text.substring(0, 60)}..."`);

            return {
                intent,
                confidence: topScore,
                answerShape: INTENT_ANSWER_SHAPES[intent],
            };
        } catch (e) {
            console.warn('[IntentClassifier] SLM classification error:', e);
            return null;
        }
    }

    /**
     * Warm up the model in the worker (non-blocking for the main process).
     * Resolves when loading has finished or failed; never rejects.
     */
    warmup(): Promise<void> {
        return this.ensureLoaded();
    }
}

// ========================
// Regex Fast-Path
// ========================

/**
 * Pattern-based intent detection (fast, no model call)
 * For common patterns this is sufficient
 */
function detectIntentByPattern(lastClientTurn: string): IntentResult | null {
    const text = lastClientTurn.toLowerCase().trim();

    // Clarification patterns
    if (/(can you explain|what do you mean|clarify|could you elaborate on that specific)/i.test(text)) {
        return { intent: 'clarification', confidence: 0.9, answerShape: INTENT_ANSWER_SHAPES.clarification };
    }

    // Follow-up patterns  
    if (/(what happened|then what|and after that|what.s next|how did that go)/i.test(text)) {
        return { intent: 'follow_up', confidence: 0.85, answerShape: INTENT_ANSWER_SHAPES.follow_up };
    }

    // Deep dive patterns
    if (/(tell me more|dive deeper|explain further|walk me through|how does that work)/i.test(text)) {
        return { intent: 'deep_dive', confidence: 0.85, answerShape: INTENT_ANSWER_SHAPES.deep_dive };
    }

    // Proof / social-proof patterns
    if (/(case stud|customers like (us|ours)|companies like (us|ours)|anyone (else )?like us|who else (uses|is using)|\breferences?\b|success stor|track record|similar (companies|customers|teams)|other customers in)/i.test(text)) {
        return { intent: 'proof_request', confidence: 0.9, answerShape: INTENT_ANSWER_SHAPES.proof_request };
    }

    // Example request patterns
    if (/(for example|concrete example|specific instance|like what|such as)/i.test(text)) {
        return { intent: 'example_request', confidence: 0.85, answerShape: INTENT_ANSWER_SHAPES.example_request };
    }

    // Summary probe patterns
    if (/(so to summarize|in summary|so basically|so you.re saying|let me make sure)/i.test(text)) {
        return { intent: 'summary_probe', confidence: 0.85, answerShape: INTENT_ANSWER_SHAPES.summary_probe };
    }

    // Technical / integration / security patterns
    if (/(integrat|\bapis?\b|\bsso\b|single sign|\bsaml\b|soc ?2|\bgdpr\b|\bhipaa\b|iso ?27001|encrypt|data residency|where is (the|our) data|on-?prem|self-?host|architecture|tech stack|webhook|sandbox|uptime|\bsla\b|works with|connect (to|with))/i.test(text)) {
        return { intent: 'technical', confidence: 0.9, answerShape: INTENT_ANSWER_SHAPES.technical };
    }

    return null; // No clear pattern detected
}

// ========================
// Context-Aware Fallback
// ========================

/**
 * Context-aware intent detection
 * Looks at conversation flow, not just the last turn
 */
function detectIntentByContext(
    recentTranscript: string,
    assistantMessageCount: number
): IntentResult {
    // If we've given multiple answers and client is probing, likely follow_up
    if (assistantMessageCount >= 2) {
        // Check if client is drilling down
        const lines = recentTranscript.split('\n');
        const clientLines = lines.filter(l => l.includes('[CLIENT'));

        // Short client prompts after long exchanges = follow-up probe
        const lastClientLine = clientLines[clientLines.length - 1] || '';
        if (lastClientLine.length < 50 && assistantMessageCount >= 2) {
            return { intent: 'follow_up', confidence: 0.7, answerShape: INTENT_ANSWER_SHAPES.follow_up };
        }
    }

    // Default to general
    return { intent: 'general', confidence: 0.5, answerShape: INTENT_ANSWER_SHAPES.general };
}

// ========================
// Public API
// ========================

/**
 * Main intent classification function (async)
 *
 * Three-tier priority:
 *   1. Regex fast-path (< 1ms, high confidence)
 *   2. Zero-shot SLM fallback (~10-50ms, medium-high confidence)
 *   3. Context-based heuristic (0ms, low confidence)
 */
export async function classifyIntent(
    lastClientTurn: string | null,
    recentTranscript: string,
    assistantMessageCount: number
): Promise<IntentResult> {
    // Tier 1: Try regex-based first (high confidence, instant)
    if (lastClientTurn) {
        const patternResult = detectIntentByPattern(lastClientTurn);
        if (patternResult) {
            return patternResult;
        }

        // Tier 2: Try zero-shot SLM (if regex didn't match)
        if (lastClientTurn.trim().length > 5) {
            const slmResult = await ZeroShotClassifier.getInstance().classify(lastClientTurn);
            if (slmResult) {
                return slmResult;
            }
        }
    }

    // Tier 3: Fall back to context-based heuristic
    return detectIntentByContext(recentTranscript, assistantMessageCount);
}

/**
 * Get answer shape guidance for prompt injection
 */
export function getAnswerShapeGuidance(intent: ConversationIntent): string {
    return INTENT_ANSWER_SHAPES[intent];
}

/**
 * Pre-warm the SLM model in its worker thread. Resolves when the load has
 * finished or failed (never rejects), so callers may await it or not.
 */
export function warmupIntentClassifier(): Promise<void> {
    return ZeroShotClassifier.getInstance().warmup();
}
