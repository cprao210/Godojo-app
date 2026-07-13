/**
 * KnowledgeDatabaseManager.ts
 *
 * Thin data-access layer that wraps the shared better-sqlite3 Database instance
 * with all read/write operations needed by the KnowledgeOrchestrator.
 *
 * Design rules:
 *  - Receives the already-open `Database` object from DatabaseManager.getDb().
 *    Never opens its own connection — there is exactly one SQLite handle per process.
 *  - All queries are synchronous (better-sqlite3 is synchronous by design).
 *  - Never throws — callers get null / [] on any failure so the orchestrator
 *    degrades gracefully.
 *  - Mirrors nothing to Supabase — that is DatabaseManager's responsibility.
 *    KDM only reads/writes local SQLite rows that DatabaseManager already owns.
 */

import type Database from 'better-sqlite3';

// ─── Shape of the raw DB row from company_context ────────────────────────────
export interface CompanyContextRow {
    id: number;
    name: string;
    website: string;
    industry: string;
    persona_engine_enabled: number; // 0 | 1 — SQLite has no boolean
    core_value_proposition: string;
    data_completeness: number;
    updated_at: string;
}

export interface CompanyAssetRow {
    id: string;
    type: string;
    label: string;
    status: string;
    last_updated: string;
}

export interface CompanyPersonaRow {
    id: string;
    role: string;
    description: string;
    sort_order: number;
}

export interface CompanyCompetitorRow {
    id: string;
    name: string;
    moat: string;
    win_rate: number;
    sort_order: number;
}

export interface AssetChunkRow {
    id: number;
    asset_id: string;
    chunk_index: number;
    chunk_text: string;
    token_count: number;
    embedding: Buffer | null;
}

// ─── Hydration shape — what the orchestrator works with ──────────────────────
export interface CompanyKnowledgeSnapshot {
    identity: {
        name: string;
        website: string;
        industry: string;
        personaEngineEnabled: boolean;
    };
    coreValueProposition: string;
    assets: Array<{
        id: string;
        type: string;
        label: string;
        status: string;
        lastUpdated: string;
    }>;
    targetPersonas: Array<{
        id: string;
        role: string;
        description: string;
    }>;
    competitors: Array<{
        id: string;
        name: string;
        moat: string;
        winRate: number;
    }>;
}

export class KnowledgeDatabaseManager {
    private readonly db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
    }

    // ─── Company context (identity + value prop) ──────────────────────────────

    /**
     * Load the full company knowledge snapshot from the database.
     * Returns null when no company context has been saved yet.
     */
    public loadSnapshot(): CompanyKnowledgeSnapshot | null {
        try {
            const identity = this.db
                .prepare('SELECT * FROM company_context WHERE id = 1')
                .get() as CompanyContextRow | undefined;

            if (!identity) return null;

            const assets = this.loadAssets();
            const personas = this.loadPersonas();
            const competitors = this.loadCompetitors();

            return {
                identity: {
                    name: identity.name ?? '',
                    website: identity.website ?? '',
                    industry: identity.industry ?? '',
                    personaEngineEnabled: !!identity.persona_engine_enabled,
                },
                coreValueProposition: identity.core_value_proposition ?? '',
                assets: assets.map(a => ({
                    id: a.id,
                    type: a.type,
                    label: a.label,
                    status: a.status,
                    lastUpdated: a.last_updated,
                })),
                targetPersonas: personas.map(p => ({
                    id: p.id,
                    role: p.role,
                    description: p.description ?? '',
                })),
                competitors: competitors.map(c => ({
                    id: c.id,
                    name: c.name,
                    moat: c.moat ?? '',
                    winRate: c.win_rate ?? 0,
                })),
            };
        } catch (err: any) {
            console.error('[KnowledgeDatabaseManager] loadSnapshot failed:', err.message);
            return null;
        }
    }

    // ─── Assets ───────────────────────────────────────────────────────────────

    public loadAssets(): CompanyAssetRow[] {
        try {
            return this.db
                .prepare('SELECT * FROM company_assets ORDER BY last_updated DESC')
                .all() as CompanyAssetRow[];
        } catch {
            return [];
        }
    }

    public loadAsset(assetId: string): CompanyAssetRow | null {
        try {
            return (this.db
                .prepare('SELECT * FROM company_assets WHERE id = ?')
                .get(assetId) as CompanyAssetRow) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Return all text chunks for an asset, in chunk_index order.
     * Used by the orchestrator to build in-memory chunk lists for retrieval.
     */
    public loadAssetChunks(assetId: string): AssetChunkRow[] {
        try {
            return this.db
                .prepare(
                    'SELECT id, asset_id, chunk_index, chunk_text, token_count, embedding ' +
                    'FROM company_asset_chunks WHERE asset_id = ? ORDER BY chunk_index ASC'
                )
                .all(assetId) as AssetChunkRow[];
        } catch {
            return [];
        }
    }

    /**
     * Return all chunks across all assets that have embeddings stored.
     * Used on startup to warm the in-memory retrieval index.
     */
    public loadAllChunksWithEmbeddings(): Array<AssetChunkRow & { asset_type: string }> {
        try {
            return this.db
                .prepare(`
                    SELECT c.id, c.asset_id, c.chunk_index, c.chunk_text, c.token_count, c.embedding,
                           a.type AS asset_type, a.label AS asset_label
                    FROM company_asset_chunks c
                    JOIN company_assets a ON a.id = c.asset_id
                    WHERE c.embedding IS NOT NULL
                    ORDER BY c.asset_id, c.chunk_index ASC
                `)
                .all() as Array<AssetChunkRow & { asset_type: string }>;
        } catch {
            return [];
        }
    }


    /**
     * Load chunks for a single asset from Supabase when local SQLite has none.
     * Returns [] when Supabase is unavailable or the query fails.
     */
    public async loadAssetChunksFromSupabase(assetId: string): Promise<AssetChunkRow[]> {
        try {
            const { SupabaseClientManager } = require('../../db/SupabaseClient');
            const client = SupabaseClientManager.getClient();
            if (!client) return [];

            const { AuthManager } = require('../../services/AuthManager');
            const token = AuthManager.getInstance().getIdToken();
            if (!token) {
                console.warn('[KnowledgeDatabaseManager] loadAssetChunksFromSupabase: no auth token — RLS will block query, skipping');
                return [];
            }

            const uid = AuthManager.getInstance().getUid();
            if (!uid) {
                console.warn('[KnowledgeDatabaseManager] loadAssetChunksFromSupabase: no uid — skipping');
                return [];
            }
            console.log(`[KnowledgeDatabaseManager] loadAssetChunksFromSupabase: querying asset=${assetId}, uid=${uid}, hasToken=${!!token}`);

            const { data, error } = await client
                .from('company_asset_chunks')
                .select('id, asset_id, chunk_index, chunk_text, token_count, embedding')
                .eq('user_id', uid)
                .eq('asset_id', assetId)
                .order('chunk_index', { ascending: true });

            if (error) {
                console.warn('[KnowledgeDatabaseManager] loadAssetChunksFromSupabase error:', error.code, error.message, error.details);
                return [];
            }

            console.log(`[KnowledgeDatabaseManager] loadAssetChunksFromSupabase: got ${(data ?? []).length} rows for ${assetId}, sample embedding type: ${typeof (data?.[0] as any)?.embedding}`)

            return (data ?? []).map((row: any) => {
                let embedding: Buffer | null = row.embedding
                    ? (() => {
                        try {
                            const arr: number[] = typeof row.embedding === 'string'
                                ? JSON.parse(row.embedding)
                                : Array.isArray(row.embedding)
                                    ? row.embedding
                                    : JSON.parse(String(row.embedding));
                            return Buffer.from(new Float32Array(arr).buffer);
                        } catch {
                            return null;
                        }
                    })()
                    : null
                return {
                    id: row.id,
                    asset_id: row.asset_id,
                    chunk_index: row.chunk_index,
                    chunk_text: row.chunk_text,
                    token_count: row.token_count,
                    embedding,
                };
            });
        } catch (err: any) {
            console.warn('[KnowledgeDatabaseManager] loadAssetChunksFromSupabase failed:', err.message);
            return [];
        }
    }

    /**
     * Load all chunks with embeddings from Supabase (startup warm fallback).
     * Returns [] when Supabase is unavailable or the query fails.
     */
    public async loadAllChunksWithEmbeddingsFromSupabase(): Promise<Array<AssetChunkRow & { asset_type: string }>> {
        try {
            const { SupabaseClientManager } = require('../../db/SupabaseClient');
            const client = SupabaseClientManager.getClient();
            if (!client) return [];

            const { AuthManager } = require('../../services/AuthManager');
            const token = AuthManager.getInstance().getIdToken();
            if (!token) {
                console.warn('[KnowledgeDatabaseManager] loadAssetChunksFromSupabase: no auth token — RLS will block query, skipping');
                return [];
            }

            const uid = AuthManager.getInstance().getUid();
            if (!uid) {
                console.warn('[KnowledgeDatabaseManager] loadAllChunksWithEmbeddingsFromSupabase: no uid — skipping');
                return [];
            }

            const { data, error } = await client
                .from('company_asset_chunks')
                .select('id, asset_id, chunk_index, chunk_text, token_count, embedding, company_assets(type, label)')
                .eq('user_id', uid)
                .not('embedding', 'is', null)
                .order('asset_id')
                .order('chunk_index', { ascending: true });

            if (error) {
                console.warn('[KnowledgeDatabaseManager] loadAllChunksWithEmbeddingsFromSupabase error:', error.message);
                return [];
            }

            return (data ?? []).map((row: any) => {
                let embedding: Buffer | null = row.embedding
                    ? (() => {
                        try {
                            const arr: number[] = typeof row.embedding === 'string'
                                ? JSON.parse(row.embedding)
                                : Array.isArray(row.embedding)
                                    ? row.embedding
                                    : JSON.parse(String(row.embedding));
                            return Buffer.from(new Float32Array(arr).buffer);
                        } catch {
                            return null;
                        }
                    })()
                    : null
                return {
                    id: row.id,
                    asset_id: row.asset_id,
                    chunk_index: row.chunk_index,
                    chunk_text: row.chunk_text,
                    token_count: row.token_count,
                    asset_type: row.company_assets?.type ?? 'custom',
                    asset_label: row.company_assets?.label ?? row.asset_id,
                    embedding,
                };
            });
        } catch (err: any) {
            console.warn('[KnowledgeDatabaseManager] loadAllChunksWithEmbeddingsFromSupabase failed:', err.message);
            return [];
        }
    }

    /**
     * Update a single asset's status (e.g. 'processing' → 'mapped' | 'error').
     */
    public setAssetStatus(assetId: string, status: string): void {
        try {
            this.db
                .prepare('UPDATE company_assets SET status = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?')
                .run(status, assetId);
        } catch (err: any) {
            console.error('[KnowledgeDatabaseManager] setAssetStatus failed:', err.message);
        }
    }

    // ─── Personas ─────────────────────────────────────────────────────────────

    public loadPersonas(): CompanyPersonaRow[] {
        try {
            return this.db
                .prepare('SELECT * FROM company_personas ORDER BY sort_order ASC')
                .all() as CompanyPersonaRow[];
        } catch {
            return [];
        }
    }

    // ─── Competitors ─────────────────────────────────────────────────────────

    public loadCompetitors(): CompanyCompetitorRow[] {
        try {
            return this.db
                .prepare('SELECT * FROM company_competitors ORDER BY sort_order ASC')
                .all() as CompanyCompetitorRow[];
        } catch {
            return [];
        }
    }
}