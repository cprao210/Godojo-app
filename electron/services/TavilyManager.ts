/**
 * tavilyService.ts
 *
 * Tavily Search API integration for live company/product intelligence.
 *
 * Responsibilities:
 *  - Accept a company query string
 *  - Call the Tavily Search API (with timeout + retry)
 *  - Parse and validate the raw API response
 *  - Normalize results into a typed CompanySearchResult
 *  - Expose loading/error state via TavilyServiceState
 *  - Graceful fallback when the API is unavailable or unconfigured
 *
 * NOT responsible for:
 *  - Deciding whether a query needs a web search (that's TavilyIntentDetector)
 *  - Injecting company context into LLM prompts (that's the LLM layer)
 *  - Caching (callers that want caching should wrap this service)
 */

import { CredentialsManager } from './CredentialsManager';

// ─────────────────────────────────────────────────────────────────
// ENVIRONMENT / CONFIGURATION
// ─────────────────────────────────────────────────────────────────

const TAVILY_API_URL = process.env.TAVILY_API_URL ?? 'https://api.tavily.com/search';

/**
 * Hard timeout (ms) for a single Tavily HTTP request.
 * Tavily's p99 is well under 5 s; this prevents long hangs.
 */
const REQUEST_TIMEOUT_MS = parseInt(process.env.TAVILY_TIMEOUT_MS ?? '8000', 10);

/**
 * Number of retry attempts after a transient failure.
 * Does NOT retry on 4xx (invalid key, quota) — only on network errors and 5xx.
 */
const MAX_RETRIES = parseInt(process.env.TAVILY_MAX_RETRIES ?? '2', 10);

/** Base delay (ms) before the first retry. Doubles on each subsequent attempt. */
const RETRY_BASE_DELAY_MS = parseInt(process.env.TAVILY_RETRY_BASE_DELAY_MS ?? '500', 10);

/** Maximum number of Tavily result snippets to include in the normalized output. */
const MAX_RESULTS = parseInt(process.env.TAVILY_MAX_RESULTS ?? '5', 10);

/** TTL for the in-process cache in milliseconds (default 20 minutes). */
const CACHE_TTL_MS = parseInt(process.env.TAVILY_CACHE_TTL_MS ?? String(20 * 60 * 1000), 10);

interface CacheEntry {
    data: CompanySearchResult | null;
    storedAt: number;
}

const _companyCache = new Map<string, CacheEntry>();

function isFresh(entry: CacheEntry): boolean {
    return Date.now() - entry.storedAt < CACHE_TTL_MS;
}

function evictStale(): void {
    for (const [key, entry] of _companyCache.entries()) {
        if (!isFresh(entry)) _companyCache.delete(key);
    }
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC TYPES
// ─────────────────────────────────────────────────────────────────

/** A single result snippet returned by Tavily and normalized for callers. */
export interface TavilySearchResult {
    /** Page title */
    title: string;
    /** Source URL */
    url: string;
    /** Extracted snippet / answer text */
    content: string;
    /** Tavily's relevance score (0–1). May be undefined on older API versions. */
    score?: number;
}

/**
 * Normalized company information assembled from Tavily search results.
 * All fields are optional — only what Tavily found is populated.
 */
export interface CompanySearchResult {
    /** The query string that was searched (for correlation / logging). */
    query: string;
    /**
     * Tavily's synthesized answer paragraph (populated when topic="general"
     * or when Tavily's answer engine fires).  Empty string when absent.
     */
    answer: string;
    /** Individual result snippets, ordered by Tavily's relevance score. */
    results: TavilySearchResult[];
    /** ISO timestamp of when this result was fetched. */
    fetchedAt: string;
    fromCache?: boolean;
}

/** Describes the current loading/error state of the service. */
export type TavilyServiceStatus =
    | 'idle'
    | 'loading'
    | 'success'
    | 'error'
    | 'no_api_key'
    | 'fallback'
    | 'cached';

export interface TavilyServiceState {
    status: TavilyServiceStatus;
    /** Human-readable message — useful for UI tooltips or debug logs. */
    message: string;
    /** Populated on success. */
    data?: CompanySearchResult;
    /** Populated on error. */
    error?: string;
}

// ─────────────────────────────────────────────────────────────────
// RAW API RESPONSE SHAPES  (internal — not exported)
// ─────────────────────────────────────────────────────────────────

interface TavilyRawResult {
    title?: string;
    url?: string;
    content?: string;
    score?: number;
}

interface TavilyRawResponse {
    answer?: string;
    results?: TavilyRawResult[];
    query?: string;
    // Tavily also returns images, follow_up_questions etc. — we ignore them.
}

// ─────────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────────

/** Thrown for HTTP 4xx responses that should NOT be retried. */
class TavilyClientError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string,
    ) {
        super(message);
        this.name = 'TavilyClientError';
    }
}

/** Thrown for network errors or HTTP 5xx — eligible for retry. */
class TavilyTransientError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TavilyTransientError';
    }
}

// ─────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds.
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap a fetch call with an AbortController-based timeout.
 * Throws TavilyTransientError on timeout or network failure.
 * Throws TavilyClientError on HTTP 4xx.
 * Throws TavilyTransientError on HTTP 5xx.
 */
async function fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
): Promise<TavilyRawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
        response = await fetch(url, { ...options, signal: controller.signal });
    } catch (err: any) {
        if (err.name === 'AbortError') {
            throw new TavilyTransientError(`Tavily request timed out after ${timeoutMs}ms`);
        }
        throw new TavilyTransientError(`Tavily network error: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (response.status >= 400 && response.status < 500) {
            throw new TavilyClientError(response.status, `Tavily API error ${response.status}: ${body}`);
        }
        throw new TavilyTransientError(`Tavily server error ${response.status}: ${body}`);
    }

    return response.json() as Promise<TavilyRawResponse>;
}

/**
 * Execute a single Tavily search request with exponential-backoff retries.
 * Only retries on TavilyTransientError; propagates TavilyClientError immediately.
 */
async function fetchWithRetry(
    url: string,
    options: RequestInit,
    timeoutMs: number,
    maxRetries: number,
    baseDelayMs: number,
): Promise<TavilyRawResponse> {
    let lastError: Error = new Error('unknown');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fetchWithTimeout(url, options, timeoutMs);
        } catch (err: any) {
            lastError = err;

            if (err instanceof TavilyClientError) {
                // 4xx — do not retry; surface immediately
                throw err;
            }

            if (attempt < maxRetries) {
                const backoff = baseDelayMs * Math.pow(2, attempt);
                console.warn(
                    `[TavilyService] Attempt ${attempt + 1} failed (${err.message}). Retrying in ${backoff}ms…`,
                );
                await delay(backoff);
            }
        }
    }

    throw lastError;
}

/**
 * Normalize the raw Tavily API response into a clean CompanySearchResult.
 * Filters out results that lack both title and content.
 */
function normalizeResponse(query: string, raw: TavilyRawResponse): CompanySearchResult {
    const rawResults: TavilyRawResult[] = Array.isArray(raw.results) ? raw.results : [];

    const results: TavilySearchResult[] = rawResults
        .filter(r => (r.title ?? '').trim() || (r.content ?? '').trim())
        .slice(0, MAX_RESULTS)
        .map(r => ({
            title: (r.title ?? '').trim(),
            url: (r.url ?? '').trim(),
            content: (r.content ?? '').trim(),
            ...(typeof r.score === 'number' ? { score: r.score } : {}),
        }));

    return {
        query,
        answer: (raw.answer ?? '').trim(),
        results,
        fetchedAt: new Date().toISOString(),
    };
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────

/**
 * Search for company/product information via the Tavily API.
 *
 * Always resolves — never throws.  Callers should inspect `state.status`:
 *
 *  - `'success'`    → `state.data` contains normalized results
 *  - `'no_api_key'` → Tavily key not configured; use `state.message` as hint
 *  - `'fallback'`   → API call failed after retries; `state.error` has details
 *  - `'error'`      → Unexpected failure; `state.error` has details
 *
 * @param query  Clean search query (ideally from TavilyIntentDetector.buildSearchQuery)
 */
export async function searchCompany(query: string, cacheKey?: string): Promise<TavilyServiceState> {

    evictStale();
    const resolvedKey = (cacheKey ?? query).toLowerCase().trim();

    const cached = _companyCache.get(resolvedKey);
    if (cached && isFresh(cached)) {
        if (cached.data) {
            return { status: 'cached', message: `Cached result for "${resolvedKey}"`, data: { ...cached.data, fromCache: true } };
        }
        return { status: 'fallback', message: 'Previous fetch failed; within TTL window.' };
    }

    // ── Resolve API key ──────────────────────────────────────────────
    const apiKey = CredentialsManager.getInstance().getTavilyApiKey();

    if (!apiKey) {
        console.warn('[TavilyService] No Tavily API key configured — skipping search.');
        return {
            status: 'no_api_key',
            message:
                'Tavily API key is not configured. Add your key in Settings → Integrations to enable live company research.',
        };
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
        return {
            status: 'error',
            message: 'Empty search query',
            error: 'Query must be a non-empty string.',
        };
    }

    // ── Build request ────────────────────────────────────────────────
    const body = JSON.stringify({
        query: trimmedQuery,
        topic: 'general',
        search_depth: 'basic',
        max_results: MAX_RESULTS,
        include_answer: true,
        include_raw_content: false,
    });

    const options: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body,
    };

    // ── Execute with retry ───────────────────────────────────────────
    console.log(`[TavilyService] Searching: "${trimmedQuery}"`);

    let raw: TavilyRawResponse;
    try {
        raw = await fetchWithRetry(
            TAVILY_API_URL,
            options,
            REQUEST_TIMEOUT_MS,
            MAX_RETRIES,
            RETRY_BASE_DELAY_MS,
        );
    } catch (err: any) {
        const isClientError = err instanceof TavilyClientError;
        const errorMessage: string = err.message ?? String(err);

        console.error('[TavilyService] Search failed:', errorMessage);

        if (isClientError && (err as TavilyClientError).statusCode === 401) {
            return {
                status: 'error',
                message: 'Invalid Tavily API key. Please check your key in Settings → Integrations.',
                error: errorMessage,
            };
        }

        _companyCache.set(resolvedKey, { data: null, storedAt: Date.now() });

        // All other failures → graceful fallback so the caller can still work
        return {
            status: 'fallback',
            message:
                'Tavily search unavailable right now. Proceeding without live company data.',
            error: errorMessage,
        };
    }

    // ── Normalize & return ───────────────────────────────────────────
    const data = normalizeResponse(trimmedQuery, raw);
    _companyCache.set(resolvedKey, { data, storedAt: Date.now() });
    console.log(
        `[TavilyService] Success — ${data.results.length} results, answer: ${data.answer ? 'yes' : 'no'}`,
    );

    return {
        status: 'success',
        message: `Found ${data.results.length} result(s) for "${trimmedQuery}"`,
        data,
    };
}

/**
 * Build a compact, LLM-readable context block from a CompanySearchResult.
 *
 * The block is appended to the existing transcript context so the LLM can
 * reference live company data without any prompt-template changes.
 *
 * Format:
 *   --- EXTERNAL COMPANY CONTEXT (via Tavily) ---
 *   Query: <query>
 *   Fetched: <ISO timestamp>
 *
 *   [Synthesized answer if present]
 *
 *   Sources:
 *   1. <title> — <url>
 *      <content snippet>
 *   ...
 *   --- END EXTERNAL CONTEXT ---
 *
 * @param data  Normalized CompanySearchResult from searchCompany()
 */
export function buildCompanyContextBlock(data: CompanySearchResult): string {
    const lines: string[] = [
        `--- EXTERNAL COMPANY CONTEXT (via Tavily) ---`,
        `Query: ${data.query}`,
        `Fetched: ${data.fetchedAt}`,
    ];

    if (data.answer) {
        lines.push('', data.answer);
    }

    if (data.results.length > 0) {
        lines.push('', 'Sources:');
        data.results.forEach((r, i) => {
            lines.push(`${i + 1}. ${r.title}${r.url ? ` — ${r.url}` : ''}`);
            if (r.content) {
                // Trim to ~300 chars to avoid flooding the context window
                const snippet = r.content.length > 300
                    ? `${r.content.slice(0, 297)}…`
                    : r.content;
                lines.push(`   ${snippet}`);
            }
        });
    }

    lines.push('--- END EXTERNAL CONTEXT ---');
    return lines.join('\n');
}

/**
 * Convenience helper that returns an initial idle state.
 * Useful for initializing React/renderer-side state before the first search.
 */
export function createInitialState(): TavilyServiceState {
    return { status: 'idle', message: 'Ready' };
}

export function clearCompanyCache(): void {
    _companyCache.clear();
}

export function invalidateCacheEntry(cacheKey: string): void {
    _companyCache.delete(cacheKey.toLowerCase().trim());
}

/**
 * Returns true when the Tavily integration is usable (key is present).
 * Safe to call synchronously in any context.
 */
export function isTavilyConfigured(): boolean {
    return !!CredentialsManager.getInstance().getTavilyApiKey();
}