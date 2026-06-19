// electron/rag/liveAdvisorRAG.ts
//
// Helpers for injecting past-call RAG context into live advisor modes
// (runWhatShouldISay, runObjectionHandler).
//
// Design notes:
//   - buildLiveAdvisorRAGBlock formats retrieved chunks into the agreed XML
//     envelope without depending on RAGManager — it receives already-scored
//     chunks so callers control the retrieval parameters.
//   - retrieveLiveAdvisorContext wraps RAGManager.retriever.retrieve() with
//     the live-advisor-specific options (global scope, higher topK, tighter
//     budget) and returns an empty array on any error so callers can
//     fall through silently.
//   - estimateTokens is re-used from TranscriptPreprocessor (no reimplementation).

import { ScoredChunk } from './VectorStore';
import { estimateTokens } from './TranscriptPreprocessor';
import { RAGManager } from './RAGManager';

// Agreed token budget for the <past_call_context> block (600 tokens).
export const LIVE_ADVISOR_RAG_BUDGET = 600;

// Minimum similarity score to include a chunk in the live advisor block.
// Set slightly higher than the default retriever floor (0.25) so only
// substantively relevant history reaches the live prompt.
const MIN_SIMILARITY = 0.30;

/**
 * Format a relative date label for a chunk's meeting timestamp.
 *
 * Returns compact human-readable strings like "today", "yesterday",
 * "3 days ago", or "2 weeks ago" — short enough to fit in the XML header
 * without burning tokens on full ISO strings.
 */
function relativeDate(startMs: number): string {
    const diffMs = Date.now() - startMs;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    const diffWeeks = Math.floor(diffDays / 7);
    if (diffWeeks === 1) return '1 week ago';
    if (diffWeeks < 5) return `${diffWeeks} weeks ago`;
    const diffMonths = Math.floor(diffDays / 30);
    return diffMonths <= 1 ? '1 month ago' : `${diffMonths} months ago`;
}

/**
 * Build the agreed <past_call_context> XML block from a list of scored chunks.
 *
 * Chunks must arrive sorted by finalScore descending (best match first) — the
 * caller is responsible for that ordering.  This function iterates in the
 * provided order, accumulates token cost, and stops once the budget is reached.
 *
 * Returns an empty string when chunks is empty or all chunks are filtered out,
 * so callers can use a simple truthy check before prepending to the prompt.
 *
 * @param chunks   - ScoredChunks sorted by finalScore DESC
 * @param budget   - Maximum token spend (default: LIVE_ADVISOR_RAG_BUDGET = 600)
 */
export function buildLiveAdvisorRAGBlock(
    chunks: ScoredChunk[],
    budget: number = LIVE_ADVISOR_RAG_BUDGET
): string {
    if (chunks.length === 0) return '';

    const lines: string[] = [];
    let tokensUsed = 0;

    // The XML open/close tags cost a fixed ~10 tokens — reserve them upfront
    // so the budget arithmetic stays accurate.
    const TAG_OVERHEAD = 10;
    const contentBudget = budget - TAG_OVERHEAD;

    for (const chunk of chunks) {
        // Hard filter: skip chunks below the similarity floor even if budget allows
        if (chunk.similarity < MIN_SIMILARITY) continue;

        // Build the line BEFORE checking budget so we can measure it accurately
        const meetingTitle = chunk.meetingId ?? 'Past Meeting';
        const date = relativeDate(chunk.startMs);
        const header = `[Meeting: ${meetingTitle} | ${date}]`;
        const body = `${chunk.speaker}: ${chunk.text}`;
        const entry = `${header}\n${body}`;

        const entryCost = estimateTokens(entry);
        if (tokensUsed + entryCost > contentBudget) {
            // Over budget — stop; higher-ranked chunks have already been included
            break;
        }

        lines.push(entry);
        tokensUsed += entryCost;
    }

    if (lines.length === 0) return '';

    return `<past_call_context>\n${lines.join('\n\n')}\n</past_call_context>`;
}

/**
 * Retrieve past-call context for live advisor modes via RAGManager.
 *
 * Performs a global (cross-meeting) similarity search using the last client
 * turn as the query, then returns chunks sorted by finalScore descending so
 * buildLiveAdvisorRAGBlock can budget-trim from the top.
 *
 * Always returns an empty array on any error — callers must never let a RAG
 * failure disrupt the live mode response path.
 *
 * @param ragManager  - RAGManager instance (may be null if RAG not initialised)
 * @param query       - Text to embed and search against (typically last client turn)
 * @param topK        - Candidate retrieval count before budget trimming (default 12)
 */
export async function retrieveLiveAdvisorContext(
    ragManager: RAGManager | null,
    query: string,
    topK: number = 12
): Promise<ScoredChunk[]> {
    if (!ragManager) return [];

    // Guard: embedding pipeline must be ready.  If no provider is configured
    // (e.g. first launch with no API keys) skip silently.
    if (!ragManager.getEmbeddingPipeline().isReady()) return [];

    // Require a non-trivial query so we don't send single-word embeddings
    const trimmed = query.trim();
    if (trimmed.length < 10) return [];

    try {
        // Use the internal retriever directly via the public getter on EmbeddingPipeline.
        // We call retrieveGlobal() (cross-meeting) because the live advisor should surface
        // relevant context from *any* past call, not just the current session.
        //
        // Options:
        //   topK * 2  — over-fetch so the re-ranker has material to work with
        //   recencyWeight 0.35 — slightly higher than the default 0.3 to bias
        //                        toward recent calls in a live sales context
        //   maxTokens 1200 — generous retrieval budget; buildLiveAdvisorRAGBlock
        //                    will trim to the agreed 600-token limit
        const result = await (ragManager as any).retriever.retrieveGlobal(trimmed, {
            topK: topK * 2,
            recencyWeight: 0.35,
            maxTokens: 1200,
        });

        // result.chunks come back sorted by timestamp (RAGRetriever.retrieveGlobal
        // sorts within meeting by timestamp for coherent reading).  Re-sort by
        // finalScore descending so buildLiveAdvisorRAGBlock gets the best matches first.
        const chunks: ScoredChunk[] = result.chunks ?? [];
        chunks.sort((a: ScoredChunk, b: ScoredChunk) =>
            ((b.finalScore ?? b.similarity) - (a.finalScore ?? a.similarity))
        );

        return chunks;
    } catch (err) {
        // Any failure (embedding error, DB error, no chunks) is non-fatal.
        console.warn('[liveAdvisorRAG] retrieval failed (non-fatal):', (err as Error).message);
        return [];
    }
}
