// electron/db/SupabaseBackfill.ts
// One-time backfill of all existing local SQLite data to Supabase.
//
// Strategy:
//   1. Iterate all relational tables in FK-safe order.
//   2. Read each row, convert types (JSON strings → objects, Buffers → base64).
//   3. Batch-upsert to Supabase via SupabaseMirrorService.
//   4. For vectors, decode Float32 BLOBs from chunks.embedding and
//      chunk_summaries.embedding, determine dimension, upsert to correct table.
//   5. Checkpoint progress in app_state so a partial run can resume.
//
// Usage:
//   SupabaseBackfill.run(db)  → returns when done or throws on fatal error.
//   Call once on first app launch after mirror credentials are set.

import Database from 'better-sqlite3';
import { SupabaseMirrorService } from './SupabaseMirrorService';

const BATCH = 50;
const BACKFILL_DONE_KEY = 'supabase_backfill_done';
const BACKFILL_CURSOR_PREFIX = 'supabase_backfill_cursor_';

// Columns that exist locally (SQLite) but not yet in the Supabase schema.
// SELECT * pulls these in automatically; PostgREST rejects the ENTIRE upsert
// if any column is unrecognized (PGRST204), so every row silently fails to
// sync until these are stripped — matching what DatabaseManager.saveMeeting()
// already does for the live mirror path. TODO(supabase): once these columns
// are added to the cloud schema, delete the corresponding entry here.
const LOCAL_ONLY_COLUMNS: Record<string, string[]> = {
    meetings: ['meeting_types'],
    transcripts: ['speaker_index'],
};

function _stripLocalOnlyColumns(table: string, row: Record<string, any>): Record<string, any> {
    const drop = LOCAL_ONLY_COLUMNS[table];
    if (!drop) return row;
    const clean = { ...row };
    for (const col of drop) delete clean[col];
    return clean;
}

export class SupabaseBackfill {
    /**
     * Run a full incremental backfill.  Safe to call multiple times — already
     * completed tables are skipped via the cursor stored in app_state.
     */
    static async run(db: Database.Database): Promise<void> {
        const mirror = SupabaseMirrorService.getInstance();
        if (!mirror.isEnabled()) {
            console.log('[SupabaseBackfill] Mirror not enabled, skipping backfill');
            return;
        }

        const done = this._getState(db, BACKFILL_DONE_KEY);
        if (done === '1') {
            console.log('[SupabaseBackfill] Backfill already completed, skipping');
            return;
        }

        console.log('[SupabaseBackfill] Starting backfill...');

        try {
            await this._backfillMeetings(db, mirror);
            await this._backfillTable(db, mirror, 'transcripts', 'id');
            await this._backfillTable(db, mirror, 'ai_interactions', 'id');
            await this._backfillTable(db, mirror, 'chunks', 'id', this._transformChunk);
            await this._backfillTable(db, mirror, 'chunk_summaries', 'id', this._transformSummary);
            await this._backfillTable(db, mirror, 'embedding_queue', 'id');
            await this._backfillAppState(db, mirror);
            await this._backfillTable(db, mirror, 'user_profile', 'id');
            await this._backfillTable(db, mirror, 'resume_nodes', 'id');
            await this._backfillVectors(db, mirror);

            this._setState(db, BACKFILL_DONE_KEY, '1');
            console.log('[SupabaseBackfill] Backfill complete ✓');
        } catch (e) {
            console.error('[SupabaseBackfill] Backfill failed (will retry next launch):', e);
        }
    }

    /** Cursor-based table backfill. */
    private static async _backfillTable(
        db: Database.Database,
        mirror: SupabaseMirrorService,
        table: string,
        pkCol: string,
        transform?: (row: any) => any
    ): Promise<void> {
        const cursorKey = `${BACKFILL_CURSOR_PREFIX}${table}`;
        let cursor: number = parseInt(this._getState(db, cursorKey) || '0', 10);

        console.log(`[SupabaseBackfill] Backfilling ${table} from cursor=${cursor}`);

        while (true) {
            const rows: any[] = db.prepare(
                `SELECT * FROM ${table} WHERE ${pkCol} > ? ORDER BY ${pkCol} ASC LIMIT ?`
            ).all(cursor, BATCH);

            if (rows.length === 0) break;

            const mapped = rows.map(r => _stripLocalOnlyColumns(table, transform ? transform(r) : this._sanitizeRow(r)));
            mirror.upsertRows(table, mapped);

            cursor = rows[rows.length - 1][pkCol];
            this._setState(db, cursorKey, String(cursor));

            // Small yield to avoid starving the event loop
            await new Promise(r => setTimeout(r, 10));
        }

        console.log(`[SupabaseBackfill] ${table} done`);
    }

    /**
     * Backfill meetings. Special-cased because:
     *   - `meetings.id` is TEXT (e.g. a UUID), not an integer — so the generic
     *     numeric-cursor loop in _backfillTable would break after the first
     *     batch (parseInt of a UUID is NaN).
     *   - Mirroring meetings BEFORE any child rows (transcripts, ai_interactions,
     *     chunks, chunk_summaries, embedding_queue) is critical because the
     *     remote schema enforces FK constraints with ON DELETE CASCADE.
     */
    private static async _backfillMeetings(
        db: Database.Database,
        mirror: SupabaseMirrorService
    ): Promise<void> {
        const cursorKey = `${BACKFILL_CURSOR_PREFIX}meetings`;
        let cursor: string = this._getState(db, cursorKey) || '';

        console.log(`[SupabaseBackfill] Backfilling meetings from cursor='${cursor}'`);

        while (true) {
            const rows: any[] = db.prepare(
                `SELECT * FROM meetings WHERE id > ? ORDER BY id ASC LIMIT ?`
            ).all(cursor, BATCH);

            if (rows.length === 0) break;

            mirror.upsertRows('meetings', rows.map(r => _stripLocalOnlyColumns('meetings', this._sanitizeRow(r))));

            cursor = rows[rows.length - 1].id;
            this._setState(db, cursorKey, cursor);
            await new Promise(r => setTimeout(r, 10));
        }

        console.log('[SupabaseBackfill] meetings done');
    }

    /**
     * Backfill app_state. Special-cased because:
     *   - Its PK is `key TEXT`, not an integer — so the generic numeric-cursor
     *     loop in _backfillTable doesn't work.
     *   - Some keys are device-local (file paths, transient flags) and should
     *     never leave the device. We skip the backfill cursor keys themselves
     *     to avoid noise, but otherwise mirror everything; if you want stricter
     *     filtering, intersect with MIRRORED_APP_STATE_KEYS.
     */
    private static async _backfillAppState(
        db: Database.Database,
        mirror: SupabaseMirrorService
    ): Promise<void> {
        const cursorKey = `${BACKFILL_CURSOR_PREFIX}app_state`;
        let cursor: string = this._getState(db, cursorKey) || '';

        console.log(`[SupabaseBackfill] Backfilling app_state from cursor='${cursor}'`);

        while (true) {
            const rows: any[] = db.prepare(
                `SELECT key, value FROM app_state
                 WHERE key > ?
                   AND key NOT LIKE 'supabase_backfill_%'
                 ORDER BY key ASC LIMIT ?`
            ).all(cursor, BATCH);

            if (rows.length === 0) break;

            mirror.upsertRows('app_state', rows.map(r => ({ key: r.key, value: r.value })));

            cursor = rows[rows.length - 1].key;
            this._setState(db, cursorKey, cursor);
            await new Promise(r => setTimeout(r, 10));
        }

        console.log('[SupabaseBackfill] app_state done');
    }

    /** Backfill vector embeddings from BLOB columns. */
    private static async _backfillVectors(
        db: Database.Database,
        mirror: SupabaseMirrorService
    ): Promise<void> {
        const cursorKey = `${BACKFILL_CURSOR_PREFIX}vectors_chunk`;
        let cursor: number = parseInt(this._getState(db, cursorKey) || '0', 10);

        console.log('[SupabaseBackfill] Backfilling chunk vectors from cursor=', cursor);
        while (true) {
            const rows: any[] = db.prepare(`
                SELECT c.id, c.meeting_id, c.embedding, m.embedding_dimensions
                FROM chunks c
                JOIN meetings m ON c.meeting_id = m.id
                WHERE c.embedding IS NOT NULL AND c.id > ?
                ORDER BY c.id ASC LIMIT ?
            `).all(cursor, BATCH);

            if (rows.length === 0) break;

            for (const row of rows) {
                const dim = this._detectDim(row.embedding as Buffer, row.embedding_dimensions);
                if (!dim) continue;
                const embedding = this._blobToArray(row.embedding as Buffer, dim);
                mirror.upsertVector('chunk', row.id, row.meeting_id, dim, embedding);
            }

            cursor = rows[rows.length - 1].id;
            this._setState(db, cursorKey, String(cursor));
            await new Promise(r => setTimeout(r, 10));
        }

        // Summary vectors
        const sumCursorKey = `${BACKFILL_CURSOR_PREFIX}vectors_summary`;
        let sumCursor: number = parseInt(this._getState(db, sumCursorKey) || '0', 10);

        console.log('[SupabaseBackfill] Backfilling summary vectors from cursor=', sumCursor);
        while (true) {
            const rows: any[] = db.prepare(`
                SELECT s.id, s.meeting_id, s.embedding, m.embedding_dimensions
                FROM chunk_summaries s
                JOIN meetings m ON s.meeting_id = m.id
                WHERE s.embedding IS NOT NULL AND s.id > ?
                ORDER BY s.id ASC LIMIT ?
            `).all(sumCursor, BATCH);

            if (rows.length === 0) break;

            for (const row of rows) {
                const dim = this._detectDim(row.embedding as Buffer, row.embedding_dimensions);
                if (!dim) continue;
                const embedding = this._blobToArray(row.embedding as Buffer, dim);
                mirror.upsertVector('summary', row.id, row.meeting_id, dim, embedding);
            }

            sumCursor = rows[rows.length - 1].id;
            this._setState(db, sumCursorKey, String(sumCursor));
            await new Promise(r => setTimeout(r, 10));
        }

        console.log('[SupabaseBackfill] Vector backfill done');
    }

    // ============================================
    // Helpers
    // ============================================

    /** Detect dimension from Buffer length (Float32 = 4 bytes) and optional metadata. */
    private static _detectDim(blob: Buffer, hintDim?: number): number | null {
        if (!blob || !Buffer.isBuffer(blob)) return null;
        const dimFromBlob = Math.floor(blob.byteLength / 4);
        if (dimFromBlob <= 0 || blob.byteLength % 4 !== 0) return null;
        // Prefer the stored metadata dimension; fall back to blob-inferred dim
        if (hintDim && hintDim === dimFromBlob) return dimFromBlob;
        return dimFromBlob;
    }

    /** Decode little-endian Float32 buffer to number array. */
    private static _blobToArray(blob: Buffer, dim: number): number[] {
        const arr: number[] = new Array(dim);
        for (let i = 0; i < dim; i++) {
            arr[i] = blob.readFloatLE(i * 4);
        }
        return arr;
    }

    /** Strip embedding BLOB before sending relational chunk row to Supabase. */
    private static _transformChunk(row: any): any {
        const { embedding, ...rest } = row;
        return SupabaseBackfill._sanitizeRow(rest);
    }

    /** Strip embedding BLOB before sending relational summary row to Supabase. */
    private static _transformSummary(row: any): any {
        const { embedding, ...rest } = row;
        return SupabaseBackfill._sanitizeRow(rest);
    }

    /** Convert Buffer values to null (BLOBs are handled separately), parse JSON strings. */
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

    private static _getState(db: Database.Database, key: string): string | null {
        try {
            const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as any;
            return row?.value ?? null;
        } catch (_) {
            return null;
        }
    }

    private static _setState(db: Database.Database, key: string, value: string): void {
        try {
            db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run(key, value);
        } catch (_) {
            // non-fatal
        }
    }
}
