/**
 * KnowledgeOrchestrator.ts
 *
 * Single in-memory source of truth for company knowledge context.
 *
 * Responsibilities:
 *  1. Hold the hydrated company snapshot (identity, value prop, assets,
 *     personas, competitors) in memory so every LLM call can read it without
 *     hitting the DB.
 *  2. Maintain an in-memory chunk index over all ingested asset documents so
 *     retrieval is a pure cosine-similarity pass against float vectors — no
 *     SQLite I/O on the hot path.
 *  3. Expose processQuestion() which LLMHelper calls when knowledge mode is
 *     active.  It classifies the question, retrieves the most relevant asset
 *     chunks, and returns a structured result that LLMHelper splices into the
 *     prompt.
 *  4. Expose ingestDocument() to register a new asset after chunking +
 *     embedding has been written to the DB by ipcHandlers.
 *  5. Expose hydrate() to atomically refresh the in-memory snapshot whenever
 *     company:saveContext is committed.
 *
 * API contract (matches the call sites already present in main.ts / ipcHandlers.ts):
 *
 *   new KnowledgeOrchestrator(knowledgeDb)
 *   orchestrator.setGenerateContentFn(fn)
 *   orchestrator.setEmbedFn(fn)
 *   orchestrator.setEmbedQueryFn(fn)           // optional
 *   orchestrator.setKnowledgeMode(enabled)
 *   orchestrator.isKnowledgeMode()
 *   orchestrator.hydrate(snapshot)
 *   orchestrator.getContext()
 *   orchestrator.getStatus()
 *   orchestrator.getProfileData()              // legacy compat for profile:get-profile
 *   orchestrator.ingestDocument(params)
 *   orchestrator.deleteDocumentsByType(type)
 *   orchestrator.processQuestion(message)
 *   orchestrator.feedForDepthScoring(message)
 *   orchestrator.feedInterviewerUtterance(text) // optional, no-op for company mode
 *   orchestrator.getNegotiationTracker()        // stub — not used in company mode
 *   orchestrator.resetNegotiationSession()      // stub
 *   orchestrator.getNegotiationScript()         // stub
 *   orchestrator.generateNegotiationScriptOnDemand() // stub
 *   orchestrator.getCompanyResearchEngine()     // stub
 */

import type { KnowledgeDatabaseManager, CompanyKnowledgeSnapshot } from './KnowledgeDatabaseManager';

// ─── Internal chunk record held in-memory ─────────────────────────────────────

interface IndexedChunk {
    assetId: string;
    assetType: string;   // 'sales_deck' | 'product_specs' | 'case_studies' | 'custom'
    assetLabel: string;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    embedding: number[] | null; // null when embedding is not yet available
}

// ─── processQuestion return shape (matches LLMHelper expectations) ─────────────

export interface KnowledgeResult {
    /** When present, LLMHelper short-circuits and returns this directly */
    isIntroQuestion?: boolean;
    introResponse?: string;

    /** Splice into the system prompt when knowledge mode is on */
    systemPromptInjection?: string;

    /** Prepend to the user-visible context block */
    contextBlock?: string;

    /** Negotiation coaching response (not used in company mode) */
    liveNegotiationResponse?: string | null;
}

// ─── ingestDocument params ────────────────────────────────────────────────────

export interface IngestParams {
    /** Asset record ID (matches company_assets.id) */
    id: string;
    type: string;
    label: string;
    mimeType?: string;
    /** Pre-extracted plain text from ipcHandlers — avoids double parsing */
    extractedText?: string;
}

// ─── Token budget for the retrieved context block ─────────────────────────────

const RETRIEVAL_BUDGET_TOKENS = 800;
const MIN_CHUNK_SIMILARITY = 0.20;   // fairly permissive — company docs are short
const TOP_K_CANDIDATES = 10;

// ─── System prompt injected when knowledge mode is active ─────────────────────

const KNOWLEDGE_MODE_SYSTEM_PROMPT = `You are a sales assistant with deep knowledge of the seller's own company, products, and competitive landscape. Use the <company_knowledge> block below as the authoritative source for any facts about the seller's company. When discussing competitors, reference the seller's differentiators. Be concise, accurate, and commercially focused.`;

export class KnowledgeOrchestrator {
    private readonly db: KnowledgeDatabaseManager;

    // ── In-memory state ───────────────────────────────────────────────────────
    private snapshot: CompanyKnowledgeSnapshot | null = null;
    private chunkIndex: IndexedChunk[] = [];
    private knowledgeModeActive = false;

    // ── Injected async functions (wired in AppState.initializeRAGManager) ─────
    private generateContentFn: ((contents: Array<{ text: string }>) => Promise<string>) | null = null;
    private embedFn: ((text: string) => Promise<number[]>) | null = null;
    private embedQueryFn: ((text: string) => Promise<number[]>) | null = null;

    constructor(db: KnowledgeDatabaseManager) {
        this.db = db;
        // Warm the chunk index from persisted embeddings on construction.
        // This runs synchronously on the first tick — embeddings are already in DB
        // so no async work is needed here.
        this._warmChunkIndex().catch(err =>
            console.warn('[KnowledgeOrchestrator] constructor _warmChunkIndex error:', err.message)
        );
    }

    // ─── Function injection ───────────────────────────────────────────────────

    public setGenerateContentFn(fn: (contents: Array<{ text: string }>) => Promise<string>): void {
        this.generateContentFn = fn;
    }

    public setEmbedFn(fn: (text: string) => Promise<number[]>): void {
        this.embedFn = fn;
    }

    public setEmbedQueryFn(fn: (text: string) => Promise<number[]>): void {
        this.embedQueryFn = fn;
    }

    // ─── Knowledge mode toggle ────────────────────────────────────────────────

    public setKnowledgeMode(enabled: boolean): void {
        this.knowledgeModeActive = enabled;
        console.log(`[KnowledgeOrchestrator] Knowledge mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }

    public isKnowledgeMode(): boolean {
        return this.knowledgeModeActive;
    }

    // ─── Hydration ────────────────────────────────────────────────────────────

    /**
     * Atomically replace the in-memory snapshot.
     * Called by:
     *  - AppState.initializeRAGManager() on startup (after loading from DB)
     *  - ipcHandlers company:saveContext (after each DB save)
     *
     * Does NOT re-ingest asset documents — that is orchestrator.ingestDocument's job.
     * Does NOT rebuild the chunk index — chunks stay stable; only identity /
     * value prop / personas / competitors change here.
     */
    public hydrate(snapshot: CompanyKnowledgeSnapshot): void {
        this.snapshot = snapshot;

        // Re-label any indexed chunks whose asset metadata may have changed
        if (snapshot.assets) {
            const assetMap = new Map(snapshot.assets.map(a => [a.id, a]));
            for (const chunk of this.chunkIndex) {
                const asset = assetMap.get(chunk.assetId);
                if (asset) {
                    chunk.assetType = asset.type;
                    chunk.assetLabel = asset.label;
                }
            }
        }

        console.log(
            `[KnowledgeOrchestrator] Hydrated — company: "${snapshot.identity?.name}", ` +
            `assets: ${snapshot.assets?.length ?? 0}, ` +
            `personas: ${snapshot.targetPersonas?.length ?? 0}, ` +
            `competitors: ${snapshot.competitors?.length ?? 0}, ` +
            `personaEngine: ${snapshot.identity?.personaEngineEnabled}`
        );
    }

    /**
     * Return the current in-memory snapshot (used by companyKnowledge.ts to
     * build the prompt block without hitting the DB).
     */
    public getContext(): CompanyKnowledgeSnapshot | null {
        return this.snapshot;
    }

    // ─── Status / profile (legacy compat for profile:get-status, profile:get-profile) ──

    public getStatus(): {
        hasResume: boolean;
        activeMode: boolean;
        resumeSummary: null;
    } {
        return {
            hasResume: !!(this.snapshot?.identity?.name),
            activeMode: this.knowledgeModeActive,
            resumeSummary: null,
        };
    }

    public getProfileData(): null {
        // Company knowledge orchestrator does not manage resume/JD profile data.
        return null;
    }

    // ─── Document ingestion ───────────────────────────────────────────────────

    /**
     * Register an asset document in the in-memory chunk index after it has
     * been chunked, embedded, and written to the DB by ipcHandlers.
     *
     * Two modes:
     *   A) extractedText provided → chunk in-memory and attempt to build
     *      embeddings on-the-fly (best-effort; falls back to text-only index).
     *   B) No extractedText → load chunks + embeddings from DB (they were
     *      already written by the ipcHandlers embedding loop).
     */
    public async ingestDocument(params: IngestParams): Promise<{ success: boolean; error?: string }> {
        try {
            const { id, type, label, extractedText } = params;

            // Remove any previously indexed chunks for this asset (re-ingestion)
            this._evictChunks(id);

            if (extractedText && extractedText.trim().length > 0) {
                // Mode A — build chunks from text
                const rawChunks = this._chunkText(extractedText);
                const assetLabel = label ?? type;

                for (let i = 0; i < rawChunks.length; i++) {
                    let embedding: number[] | null = null;
                    try {
                        if (this.embedFn) {
                            embedding = await this.embedFn(rawChunks[i].text);
                        }
                    } catch {
                        // Embedding failure is non-fatal — chunk is still useful for keyword retrieval
                    }

                    this.chunkIndex.push({
                        assetId: id,
                        assetType: type,
                        assetLabel: assetLabel,
                        chunkIndex: i,
                        text: rawChunks[i].text,
                        tokenCount: rawChunks[i].tokenCount,
                        embedding,
                    });
                }

                console.log(`[KnowledgeOrchestrator] Ingested ${rawChunks.length} chunks (from text) for asset ${id}`);
            } else {
                // Mode B — load from DB (chunking + embedding already done)
                await this._loadChunksFromDb(id, type, label);
            }

            return { success: true };
        } catch (err: any) {
            console.error('[KnowledgeOrchestrator] ingestDocument failed:', err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Remove all indexed chunks for assets of a given type.
     * Used by profile:delete / profile:delete-jd handlers (company mode: not typically called,
     * but provided for API completeness).
     */
    public deleteDocumentsByType(type: string): void {
        const before = this.chunkIndex.length;
        this.chunkIndex = this.chunkIndex.filter(c => c.assetType !== type);
        console.log(
            `[KnowledgeOrchestrator] deleteDocumentsByType(${type}): removed ${before - this.chunkIndex.length} chunks`
        );
    }

    // ─── Question processing (called by LLMHelper) ────────────────────────────

    /**
     * Process a user question when knowledge mode is active.
     *
     * Returns a KnowledgeResult that LLMHelper splices into the prompt:
     *  - systemPromptInjection  → replaces / augments the system prompt
     *  - contextBlock           → prepended to the user-visible context
     *
     * Always returns a result (never null) when knowledge mode is on so
     * LLMHelper always gets at minimum the company system prompt.
     */
    public async processQuestion(message: string): Promise<KnowledgeResult | null> {
        try {
            // Build the static company context block from in-memory snapshot
            const companyBlock = this._buildStaticContextBlock();

            // Retrieve semantically relevant asset chunks for the question
            const retrievedBlock = await this._retrieveRelevantChunks(message);

            console.log(`[KO] processQuestion — chunkIndex size: ${this.chunkIndex.length}, retrievedBlock length: ${retrievedBlock.length}`);

            const contextParts: string[] = [];
            if (companyBlock) contextParts.push(companyBlock);
            if (retrievedBlock) contextParts.push(retrievedBlock);

            const contextBlock = contextParts.join('\n\n') || undefined;

            return {
                systemPromptInjection: KNOWLEDGE_MODE_SYSTEM_PROMPT,
                contextBlock,
                liveNegotiationResponse: null,
            };
        } catch (err: any) {
            console.warn('[KnowledgeOrchestrator] processQuestion failed:', err.message);
            return null;
        }
    }

    /**
     * Feed a message to the depth scorer. In this company-mode orchestrator,
     * depth scoring is not implemented — this is a no-op that satisfies the
     * interface expected by LLMHelper.
     */
    public feedForDepthScoring(_message: string): void {
        // No-op in company knowledge mode.
    }

    /**
     * Feed an interviewer/prospect utterance. No-op in company mode —
     * this interface exists for the recruiter/interview version of the orchestrator.
     */
    public feedInterviewerUtterance(_text: string): void {
        // No-op in company knowledge mode.
    }

    // ─── Negotiation stubs (interface compat with premium profile orchestrator) ──

    public getNegotiationTracker(): { getState: () => null; isActive: () => false } {
        return { getState: () => null, isActive: () => false as const };
    }

    public resetNegotiationSession(): void { /* no-op */ }

    public getNegotiationScript(): null { return null; }

    public async generateNegotiationScriptOnDemand(): Promise<null> { return null; }

    // ─── Company research engine stub ─────────────────────────────────────────

    public getCompanyResearchEngine(): {
        setSearchProvider: (_p: any) => void;
        researchCompany: (_name: string, _ctx: any, _force: boolean) => Promise<null>;
    } {
        return {
            setSearchProvider: (_p: any) => { /* no-op */ },
            researchCompany: async (_name, _ctx, _force) => null,
        };
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * On construction, load all chunks that already have embeddings from the DB
     * so warm restarts don't lose the retrieval index.
     */

    private async _warmChunkIndex(): Promise<void> {
        try {
            // Always load from Supabase only — no local SQLite fallback
            console.log('[KnowledgeOrchestrator] _warmChunkIndex: loading from Supabase...');
            const rows = await this.db.loadAllChunksWithEmbeddingsFromSupabase();

            const assetMeta = new Map<string, { type: string; label: string }>();

            for (const row of rows) {
                if (!assetMeta.has(row.asset_id)) {
                    assetMeta.set(row.asset_id, {
                        type: row.asset_type,
                        label: (row as any).asset_label ?? row.asset_id,
                    });
                }
            }

            for (const row of rows) {
                const meta = assetMeta.get(row.asset_id)!;
                let embedding: number[] | null = null;

                if (row.embedding && row.embedding.byteLength > 0) {
                    try {
                        embedding = Array.from(new Float32Array(
                            (row.embedding as Buffer).buffer,
                            (row.embedding as Buffer).byteOffset,
                            (row.embedding as Buffer).byteLength / 4
                        ));
                    } catch {
                        embedding = null;
                    }
                }

                this.chunkIndex.push({
                    assetId: row.asset_id,
                    assetType: meta.type,
                    assetLabel: meta.label,
                    chunkIndex: row.chunk_index,
                    text: row.chunk_text,
                    tokenCount: row.token_count,
                    embedding,
                });
            }

            console.log(
                `[KnowledgeOrchestrator] Chunk index warmed from Supabase: ${this.chunkIndex.length} chunks ` +
                `across ${assetMeta.size} assets`
            );
        } catch (err: any) {
            console.warn('[KnowledgeOrchestrator] _warmChunkIndex failed (non-fatal):', err.message);
        }
    }

    /** Load chunks for a single asset from the DB and add to the in-memory index. */

    private async _loadChunksFromDb(assetId: string, type: string, label: string): Promise<void> {
        // Always fetch from Supabase — do not fall back to local SQLite
        console.log(`[KnowledgeOrchestrator] _loadChunksFromDb: fetching from Supabase for ${assetId}...`);
        const rows = await this.db.loadAssetChunksFromSupabase(assetId);

        const withEmbeddings = rows.filter(r => r.embedding && (r.embedding as Buffer).byteLength > 0).length;
        console.log(`[KnowledgeOrchestrator] _loadChunksFromDb: asset ${assetId} — ${rows.length} chunks total, ${withEmbeddings} with embeddings`);

        for (const row of rows) {
            let embedding: number[] | null = null;

            if (row.embedding && (row.embedding as Buffer).byteLength > 0) {
                try {
                    embedding = Array.from(new Float32Array(
                        (row.embedding as Buffer).buffer,
                        (row.embedding as Buffer).byteOffset,
                        (row.embedding as Buffer).byteLength / 4
                    ));
                } catch {
                    embedding = null;
                }
            }

            this.chunkIndex.push({
                assetId,
                assetType: type,
                assetLabel: label,
                chunkIndex: row.chunk_index,
                text: row.chunk_text,
                tokenCount: row.token_count,
                embedding,
            });
        }

        console.log(`[KnowledgeOrchestrator] Loaded ${rows.length} chunks from Supabase for asset ${assetId}`);
    }

    /** Remove all indexed chunks for a given assetId. */
    private _evictChunks(assetId: string): void {
        const before = this.chunkIndex.length;
        this.chunkIndex = this.chunkIndex.filter(c => c.assetId !== assetId);
        if (before !== this.chunkIndex.length) {
            console.log(`[KnowledgeOrchestrator] Evicted ${before - this.chunkIndex.length} chunks for asset ${assetId}`);
        }
    }

    /**
     * Simple sentence-boundary chunker — mirrors the chunking logic already
     * in ipcHandlers company:saveContext so chunk sizes are consistent.
     */
    private _chunkText(text: string): Array<{ text: string; tokenCount: number }> {
        const MAX_TOKENS = 400;
        const sentences = text.split(/(?<=[.!?])\s+/);
        const chunks: Array<{ text: string; tokenCount: number }> = [];

        let current = '';
        for (const sentence of sentences) {
            const combined = current ? `${current} ${sentence}` : sentence;
            const tokens = this._estimateTokens(combined);

            if (tokens > MAX_TOKENS && current) {
                chunks.push({ text: current.trim(), tokenCount: this._estimateTokens(current) });
                current = sentence;
            } else {
                current = combined;
            }
        }
        if (current.trim()) {
            chunks.push({ text: current.trim(), tokenCount: this._estimateTokens(current) });
        }

        return chunks;
    }

    /** Approximate token count — same heuristic used throughout the codebase. */
    private _estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    /**
     * Build the static company context block from the in-memory snapshot.
     * This covers identity, value prop, personas (if enabled), and competitors.
     * Retrieved asset chunks are handled separately by _retrieveRelevantChunks.
     */
    private _buildStaticContextBlock(): string {
        if (!this.snapshot) return '';

        const { identity, coreValueProposition, targetPersonas, competitors } = this.snapshot;
        if (!identity?.name) return '';

        const lines: string[] = [
            '<company_knowledge>',
        ];

        lines.push(`Company: ${identity.name}`);
        if (identity.industry) lines.push(`Industry: ${identity.industry}`);
        if (identity.website) lines.push(`Website: ${identity.website}`);

        if (coreValueProposition?.trim()) {
            lines.push('');
            lines.push('Value Proposition:');
            lines.push(`  ${coreValueProposition.trim()}`);
        }

        // Personas — only when persona engine is enabled (Req 4)
        if (identity.personaEngineEnabled && targetPersonas?.length) {
            lines.push('');
            lines.push('Target Buyer Personas:');
            for (const p of targetPersonas) {
                lines.push(`  • ${p.role}${p.description ? `: ${p.description}` : ''}`);
            }
        }

        // Competitors
        if (competitors?.length) {
            lines.push('');
            lines.push('Competitive Landscape:');
            for (const c of competitors) {
                const wr = c.winRate != null && c.winRate > 0 ? ` (win rate: ${c.winRate}%)` : '';
                lines.push(`  • vs ${c.name}${c.moat ? ` — differentiator: ${c.moat}` : ''}${wr}`);
            }
        }

        lines.push('</company_knowledge>');
        return lines.join('\n');
    }

    /**
     * Embed the user's question and perform cosine similarity retrieval over
     * the in-memory chunk index.
     *
     * Returns a formatted <company_assets> block, or '' when no relevant
     * chunks are found or embeddings are unavailable.
     *
     * Retrieval is scoped exclusively to uploaded company assets (sales_deck,
     * product_specs, case_studies, custom) — no transcript chunks, no Tavily
     * data. (Req 5)
     */
    private async _retrieveRelevantChunks(query: string): Promise<string> {
        if (this.chunkIndex.length === 0) return '';

        console.log(`[KO] _retrieveRelevantChunks — total chunks in index: ${this.chunkIndex.length}, chunks with embeddings: ${this.chunkIndex.filter(c => !!c.embedding).length}`);

        // Get the embed function — prefer query-specific variant
        const embedder = this.embedQueryFn ?? this.embedFn;
        if (!embedder) return '';

        let queryVec: number[];
        try {
            queryVec = await embedder(query);
        } catch {
            return '';  // Embedding not ready — degrade gracefully
        }

        // Score all chunks with embeddings
        const scored: Array<{ chunk: IndexedChunk; score: number }> = [];

        for (const chunk of this.chunkIndex) {
            if (!chunk.embedding) continue;

            const score = this._cosineSimilarity(queryVec, chunk.embedding);
            if (score >= MIN_CHUNK_SIMILARITY) {
                scored.push({ chunk, score });
            }
        }

        console.log(`[KO] similarity scores — scored: ${scored.length}, top scores: ${scored.slice(0, 3).map(s => s.score.toFixed(3)).join(', ')} (threshold: ${MIN_CHUNK_SIMILARITY})`);

        if (scored.length === 0) return '';

        // Sort descending and take top-K
        scored.sort((a, b) => b.score - a.score);
        const topChunks = scored.slice(0, TOP_K_CANDIDATES);

        // Budget trim
        const lines: string[] = ['<company_assets>'];
        let tokensUsed = 0;

        for (const { chunk } of topChunks) {
            if (tokensUsed + chunk.tokenCount > RETRIEVAL_BUDGET_TOKENS) break;

            lines.push(`[${chunk.assetLabel} (${chunk.assetType})]`);
            lines.push(chunk.text);
            lines.push('');
            tokensUsed += chunk.tokenCount;
        }

        if (lines.length <= 1) return ''; // nothing added

        lines.push('</company_assets>');
        console.log("(KnowlegeOrchestrator) _retrieveRelevantChunks: ", lines);
        return lines.join('\n');
    }

    /** Standard cosine similarity between two equal-length float vectors. */
    private _cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length || a.length === 0) return 0;

        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }
}