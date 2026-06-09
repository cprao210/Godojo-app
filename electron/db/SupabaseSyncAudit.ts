// electron/db/SupabaseSyncAudit.ts
// Reconciliation pass: compares local SQLite records against Supabase to find
// records that exist locally but are missing remotely, then re-queues them for
// sync via SupabaseMirrorService.
//
// Why this exists:
//   The mirror is fire-and-forget. Rows written before credentials were set, or
//   whose outbox op was dropped after MAX_RETRY, can be silently absent from
//   Supabase even though SQLite (source-of-truth) has them. This audit detects
//   those gaps by diffing local IDs against remote IDs and re-enqueues the
//   missing rows.
//
// Usage:
//   SupabaseSyncAudit.run(db)  → returns per-table results.
//   Call periodically (e.g. on launch after backfill, or from a settings page).

import Database from 'better-sqlite3';
import { SupabaseClientManager } from './SupabaseClient';
import { SupabaseMirrorService } from './SupabaseMirrorService';

const PAGE = 1000;

export interface SyncAuditResult {
    table: string;
    localCount: number;
    remoteCount: number;
    gapsFound: number;
    gapsQueued: number;
}

interface TableSpec {
    table: string;
    /** Local primary-key column (also the remote id column to diff against). */
    pkCol: string;
    /** Transform a full local row before enqueueing (strip BLOBs etc.). */
    transform: (row: any) => any;
}

export class SupabaseSyncAudit {
    /**
     * Diff every audited table and re-queue locally-present, remotely-missing
     * rows. Each table is isolated in its own try/catch so one failure does not
     * abort the rest. Returns one result per table actually processed.
     */
    static async run(db: Database.Database): Promise<SyncAuditResult[]> {
        if (!SupabaseClientManager.isConfigured()) {
            console.log('[SupabaseSyncAudit] Supabase not configured / not signed in, skipping audit');
            return [];
        }

        const mirror = SupabaseMirrorService.getInstance();
        if (!mirror.isEnabled()) {
            console.log('[SupabaseSyncAudit] Mirror not enabled, skipping audit');
            return [];
        }

        const userId = SupabaseClientManager.getCurrentUserId();
        if (!userId) {
            console.log('[SupabaseSyncAudit] No current user id, skipping audit');
            return [];
        }

        // FK-safe order: meetings (parent) first so re-queued children always
        // have a parent present remotely by the time the outbox drains.
        // user_profile is special-cased below: local PK is INTEGER `id`, remote
        // PK is `user_id` (Firebase UID) — they can't be set-diffed, so we do a
        // presence check instead.
        const specs: TableSpec[] = [
            { table: 'meetings', pkCol: 'id', transform: this._sanitizeRow },
            { table: 'transcripts', pkCol: 'id', transform: this._sanitizeRow },
            { table: 'ai_interactions', pkCol: 'id', transform: this._sanitizeRow },
            { table: 'chunks', pkCol: 'id', transform: this._transformChunk },
            { table: 'chunk_summaries', pkCol: 'id', transform: this._transformSummary },
            { table: 'resume_nodes', pkCol: 'id', transform: this._sanitizeRow },
        ];

        const results: SyncAuditResult[] = [];
        for (const spec of specs) {
            try {
                const result = await this._auditTable(db, mirror, userId, spec);
                results.push(result);
            } catch (e) {
                console.error(`[SupabaseSyncAudit] ${spec.table} audit failed:`, e);
            }
        }

        // user_profile: presence check — if a local row exists but no remote row
        // exists for this user, re-queue it.
        try {
            const result = await this._auditUserProfile(db, mirror, userId);
            results.push(result);
        } catch (e) {
            console.error('[SupabaseSyncAudit] user_profile audit failed:', e);
        }

        return results;
    }

    /** Diff one table and re-queue missing rows. */
    private static async _auditTable(
        db: Database.Database,
        mirror: SupabaseMirrorService,
        userId: string,
        spec: TableSpec
    ): Promise<SyncAuditResult> {
        const { table, pkCol, transform } = spec;

        const localIds: any[] = db
            .prepare(`SELECT ${pkCol} FROM ${table}`)
            .all()
            .map((r: any) => r[pkCol]);

        const remoteIds = await this._fetchRemoteIds(table, pkCol, userId);

        const missing = localIds.filter(id => !remoteIds.has(id));

        let queued = 0;
        for (const id of missing) {
            const row: any = db
                .prepare(`SELECT * FROM ${table} WHERE ${pkCol} = ?`)
                .get(id);
            if (!row) continue;
            mirror.upsertRow(table, transform(row));
            queued++;
        }

        const result: SyncAuditResult = {
            table,
            localCount: localIds.length,
            remoteCount: remoteIds.size,
            gapsFound: missing.length,
            gapsQueued: queued,
        };
        console.log(
            `[SupabaseSyncAudit] ${table}: local=${result.localCount} remote=${result.remoteCount} gaps=${result.gapsFound} queued=${result.gapsQueued}`
        );
        return result;
    }

    /** Fetch all remote PK values for the current user, paginated. */
    private static async _fetchRemoteIds(
        table: string,
        pkCol: string,
        userId: string
    ): Promise<Set<any>> {
        const remoteIds = new Set<any>();
        const client = SupabaseClientManager.getClient();
        if (!client) return remoteIds;

        let page = 0;
        while (true) {
            const { data, error } = await client
                .from(table)
                .select(pkCol)
                .eq('user_id', userId)
                .range(page * PAGE, (page + 1) * PAGE - 1);

            if (error) throw error;
            if (!data || data.length === 0) break;

            data.forEach((r: any) => remoteIds.add(r[pkCol]));

            if (data.length < PAGE) break;
            page++;
        }

        return remoteIds;
    }

    /**
     * user_profile presence check.
     * Local PK is INTEGER `id`; remote PK is `user_id` (Firebase UID).
     * The two schemas share no diffable key, so instead of a set-diff we just
     * check: does the remote have ANY row for this user? If not, re-queue.
     */
    private static async _auditUserProfile(
        db: Database.Database,
        mirror: SupabaseMirrorService,
        userId: string
    ): Promise<SyncAuditResult> {
        const localRows: any[] = db.prepare('SELECT * FROM user_profile').all();
        const localCount = localRows.length;

        const client = SupabaseClientManager.getClient();
        let remoteCount = 0;
        if (client) {
            const { data, error } = await client
                .from('user_profile')
                .select('user_id')
                .eq('user_id', userId)
                .limit(1);
            if (error) throw error;
            remoteCount = data?.length ?? 0;
        }

        let gapsQueued = 0;
        if (localCount > 0 && remoteCount === 0) {
            // Re-queue the most recent local row (last written wins)
            const row = localRows[localRows.length - 1];
            mirror.upsertRow('user_profile', this._sanitizeRow(row));
            gapsQueued = 1;
        }

        const gapsFound = localCount > 0 && remoteCount === 0 ? 1 : 0;
        console.log(
            `[SupabaseSyncAudit] user_profile: local=${localCount} remote=${remoteCount} gaps=${gapsFound} queued=${gapsQueued}`
        );
        return { table: 'user_profile', localCount, remoteCount, gapsFound, gapsQueued };
    }

    // ============================================
    // Helpers (mirrored from SupabaseBackfill)
    // ============================================

    /** Strip embedding BLOB before sending relational chunk row to Supabase. */
    private static _transformChunk(row: any): any {
        const { embedding, ...rest } = row;
        return SupabaseSyncAudit._sanitizeRow(rest);
    }

    /** Strip embedding BLOB before sending relational summary row to Supabase. */
    private static _transformSummary(row: any): any {
        const { embedding, ...rest } = row;
        return SupabaseSyncAudit._sanitizeRow(rest);
    }

    /** Convert Buffer values to null (BLOBs handled separately), parse JSON strings. */
    private static _sanitizeRow(row: any): any {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(row)) {
            if (Buffer.isBuffer(v)) {
                out[k] = null; // BLOBs excluded from relational mirror
            } else if (typeof v === 'string' && (k.endsWith('_json') || k === 'structured_json' || k === 'metadata_json')) {
                try { out[k] = JSON.parse(v); } catch { out[k] = v; }
            } else {
                out[k] = v;
            }
        }
        return out;
    }
}
