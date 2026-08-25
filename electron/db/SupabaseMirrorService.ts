// electron/db/SupabaseMirrorService.ts
// Central async mirror service: pushes every local write to Supabase without
// blocking the main thread.  SQLite is always source-of-truth; Supabase is a
// non-blocking copy.
//
// Architecture:
//   - All public methods are fire-and-forget (they never throw).
//   - An in-memory outbox queue retries failed ops with exponential back-off
//     so transient network issues don't silently drop data.
//   - Vector embeddings (Float32 BLOBs) are base64-encoded for transport and
//     stored in Supabase as text in vector-entity tables, alongside the plain
//     numeric array for pgvector columns.
//
// Supabase schema expected (run the SQL in supabase/migrations):
//   - Relational mirror: meetings, transcripts, ai_interactions, chunks,
//     chunk_summaries, embedding_queue, app_state, user_profile, resume_nodes
//   - Vector entities: rag_chunk_vectors_{dim} and rag_summary_vectors_{dim}
//     for each dimension tier (768, 1536, 3072).

import { SupabaseClientManager } from './SupabaseClient';
import { AuthManager } from '../services/AuthManager';
import Database from 'better-sqlite3';

const MAX_RETRY = 4;
const RETRY_BASE_MS = 1_500;

interface OutboxItem {
    id: number;
    op: 'upsert' | 'delete' | 'deleteVector' | 'upsertVector' | 'upsertBatch';
    table: string;
    payload: any;
    retries: number;
    // Captured once, at enqueue time. Related rows (e.g. a meeting + its
    // transcript batch, enqueued together in the same saveMeeting() call)
    // MUST share the same user_id even if the drain loop sends them at
    // different moments and the resolved uid shifts in between (token
    // refresh, re-auth, tenant switch) — otherwise one row lands under one
    // user_id and its FK-dependent sibling lands under another, and the
    // foreign key check fails permanently. Resolving fresh per-send (the
    // previous behavior) is what let that happen.
    ownerUid: string | null;
}

// Tables whose upserts should jump the queue ahead of everything else
// (besides 'users', which _upsertCurrentUserRow already prioritizes).
// 'meetings' specifically: it's the one row the UI is actively polling for
// right after a meeting ends, so it shouldn't sit behind a batch of
// transcript lines / ai_interactions / chunks that the user isn't staring
// at a spinner for.
const PRIORITY_TABLES = new Set(['meetings']);

export class SupabaseMirrorService {
    private static instance: SupabaseMirrorService;
    private outbox: OutboxItem[] = [];
    private draining = false;
    private counter = 0;
    private enabled = false;
    private db: Database.Database | null = null;

    private constructor() { }

    static getInstance(): SupabaseMirrorService {
        if (!this.instance) this.instance = new SupabaseMirrorService();
        return this.instance;
    }

    /** Called once on startup after credentials are loaded from app_state. */
    init(db: Database.Database): void {
        this.db = db;
        // We enable as soon as we have a SQLite handle: the outbox is
        // append-only and persisted locally regardless of network/auth state.
        // The send loop (_drain → _sendItem) is what actually gates on
        // SupabaseClientManager.isConfigured() (URL + key + signed-in user).
        this.enabled = true;
        this._loadOutboxFromDb();

        // Drain whenever the user signs in / token refreshes — the previously
        // queued offline writes can now be authenticated and pushed.
        const auth = AuthManager.getInstance();
        auth.on('signed-in', () => {
            // this._upsertCurrentUserRow();
            // if (!this.draining) this._drain();
            this._verifyThenUpsertCurrentUserRow();
        });
        auth.on('auth-changed', () => {
            if (!auth.isSignedIn()) return;
            // A signed-in session's profile can change after the initial
            // 'signed-in' event fires — most notably during sign-up, where
            // updateProfile(displayName) + a forced token refresh happen
            // *after* the first onIdTokenChanged (which carries a null
            // displayName). Re-upsert here so that corrected data actually
            // reaches Supabase instead of being silently dropped.
            this._upsertCurrentUserRow();
            if (!this.draining) this._drain();
        });

        // If a session is already active at init (e.g. silent token restore
        // completed before mirror.init), upsert the users row and drain now.
        if (auth.isSignedIn()) {
            // this._upsertCurrentUserRow();
            // if (!this.draining) this._drain();
            this._verifyThenUpsertCurrentUserRow();
        }
    }

    /**
     * Confirms the current Firebase session is actually valid — not just
     * "we received a token object" — before writing a users row to Supabase.
     *
     * A silently-restored session from a stale/persisted refresh token
     * (app launch restore, see AuthManager.getPersistedIdentity) can fire
     * 'signed-in' even when the underlying account has since been disabled
     * or deleted; installSessionGuard only catches that *afterward*, on its
     * own async cycle. This does the same check first, so we never create a
     * Supabase user row for a session that's about to be invalidated.
     */
    private async _verifyThenUpsertCurrentUserRow(): Promise<void> {
        const auth = AuthManager.getInstance();
        const snap = auth.snapshot();
        const refreshToken = auth.getRefreshToken();
        if (!snap.uid || !refreshToken) return;

        try {
            const apiKey = process.env.VITE_FIREBASE_API_KEY;
            if (!apiKey) {
                console.warn('[SupabaseMirrorService] VITE_FIREBASE_API_KEY not set — skipping session verification, proceeding as-is');
            } else {
                const resp = await fetch(
                    `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
                    }
                );
                if (!resp.ok) {
                    console.warn('[SupabaseMirrorService] Session failed verification (account disabled/deleted/revoked) — skipping users row creation');
                    return;
                }
            }
        } catch (e) {
            console.warn('[SupabaseMirrorService] Session verification request failed — skipping users row creation:', e);
            return;
        }

        this._upsertCurrentUserRow();
        if (!this.draining) this._drain();
    }

    /**
     * Push a users-row upsert to the front of the outbox the first time the
     * mirror sees a signed-in session. Idempotent — Supabase will treat repeat
     * upserts as no-ops because firebase_uid is the conflict key.
     */
    private _upsertCurrentUserRow(): void {
        const snap = AuthManager.getInstance().snapshot();
        if (!snap.uid) return;

        const payload: Record<string, any> = {
            firebase_uid: snap.uid,
            last_seen_at: new Date().toISOString(),
        };
        if (snap.email) payload.email = snap.email;
        if (snap.displayName) payload.display_name = snap.displayName;
        if (snap.photoURL) payload.photo_url = snap.photoURL;

        this._enqueue({
            op: 'upsert',
            table: 'users',
            payload,
            retries: 0,
        });
    }

    /** Re-check enabled state (called after credentials are saved/changed). */
    refresh(): void {
        // `enabled` only reflects whether the local outbox is wired up — see init().
        // We just kick the drain loop so any in-flight credential change picks up.
        if (this.enabled && !this.draining) this._drain();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** Snapshot for the settings UI (`supabase:get-mirror-status`). */
    getStatus(): { outboxLength: number; lastSyncAt: number | null; lastError: string | null; draining: boolean } {
        return {
            outboxLength: this.outbox.length,
            lastSyncAt: this.lastSyncAt,
            lastError: this.lastError,
            draining: this.draining,
        };
    }

    private lastSyncAt: number | null = null;
    private lastError: string | null = null;

    // ============================================
    // Public fire-and-forget write API
    //
    // Enqueue is ALWAYS accepted (provided init() has been called).
    // Network send is gated on (a) Supabase URL/key configured and
    // (b) a Firebase user currently signed in. Until both are true items sit
    // in the local outbox and replay automatically on sign-in.
    // ============================================

    /**
     * Mirror a single row upsert to a Supabase table.
     *
     * @param ownerUid Pin the mirror row's user_id to this uid instead of
     *   re-resolving "the current signed-in user" at enqueue time. Callers
     *   that write the SAME logical entity across multiple, separated-in-time
     *   calls (e.g. a meeting's placeholder save, then its title/summary
     *   updates minutes later) MUST pass the uid captured when that entity
     *   was first created — otherwise a signed-in-user change in between
     *   (account switch, session handoff) stamps later writes with a
     *   different user_id and, for composite-PK tables like meetings
     *   (user_id, id), silently creates a second row instead of updating
     *   the first. Omit only for genuinely one-shot / first-write calls.
     */
    upsertRow(table: string, row: Record<string, any>, ownerUid?: string | null): void {
        if (!this.enabled) return;
        this._enqueue({ op: 'upsert', table, payload: row, retries: 0 }, ownerUid);
    }

    private _conflictTargetForTable(table: string, row: Record<string, any>): string | null {
        // NOTE: All scoped tables include `user_id` in the conflict target so that
        // two devices belonging to different users can never silently overwrite
        // each other if their local autoincrement IDs collide.
        switch (table) {
            case 'users':
                return row.firebase_uid != null ? 'firebase_uid' : null;
            case 'meetings':
                return row.id != null && row.user_id != null ? 'user_id,id' : (row.id != null ? 'id' : null);
            case 'transcripts':
                return row.id != null && row.user_id != null ? 'user_id,id' : (row.id != null ? 'id' : null);
            case 'ai_interactions':
                return row.id != null && row.user_id != null ? 'user_id,id' : (row.id != null ? 'id' : null);
            case 'chunks':
                return row.id != null && row.user_id != null ? 'user_id,id' : (row.id != null ? 'id' : null);
            case 'chunk_summaries':
                if (row.user_id != null && row.meeting_id != null) return 'user_id,meeting_id';
                return row.id != null ? 'id' : (row.meeting_id != null ? 'meeting_id' : null);
            case 'embedding_queue':
                if (row.user_id != null && row.meeting_id != null) return 'user_id,meeting_id,chunk_id';
                if (row.id != null) return 'id';
                if (row.meeting_id != null) return 'meeting_id,chunk_id';
                return null;
            case 'app_state':
                return row.user_id != null && row.key != null ? 'user_id,key' : (row.key != null ? 'key' : null);
            case 'user_profile':
                return row.user_id != null ? 'user_id' : (row.id != null ? 'id' : null);
            case 'resume_nodes':
                return row.id != null && row.user_id != null ? 'user_id,id' : (row.id != null ? 'id' : null);
            case 'company_context':
                return row.user_id != null ? 'user_id,id' : 'id';
            case 'company_assets':
                return row.user_id != null ? 'user_id,id' : 'id';
            case 'company_personas':
                return row.user_id != null ? 'user_id,id' : 'id';
            case 'company_competitors':
                return row.user_id != null ? 'user_id,id' : 'id';
            case 'company_asset_files':
                return row.user_id != null ? 'user_id,asset_id' : 'asset_id';
            case 'meeting_scorecards':
                return row.user_id != null ? 'user_id,meeting_id' : 'meeting_id';
            case 'scoring_criteria':
                return row.user_id != null ? 'user_id,id' : 'id';
            case 'company_asset_chunks':
                return row.user_id != null && row.asset_id != null && row.chunk_index != null
                    ? 'user_id,asset_id,chunk_index'
                    : (row.id != null ? 'id' : null);
            default:
                if (table.startsWith('rag_chunk_vectors_')) {
                    return row.user_id != null ? 'user_id,chunk_id' : 'chunk_id';
                }
                if (table.startsWith('rag_summary_vectors_')) {
                    return row.user_id != null ? 'user_id,summary_id' : 'summary_id';
                }
                return row.id != null ? 'id' : null;
        }
    }

    /** Mirror a row deletion (by primary key value). */
    deleteRow(table: string, pkColumn: string, pkValue: any): void {
        if (!this.enabled) return;
        this._enqueue({ op: 'delete', table, payload: { pkColumn, pkValue }, retries: 0 });
    }

    /** Upsert a vector row into a per-dimension table. dim = 768|1536|3072. */
    upsertVector(
        type: 'chunk' | 'summary',
        localId: number,
        meetingId: string,
        dim: number,
        embedding: number[],
        extraMeta?: Record<string, any>
    ): void {
        if (!this.enabled) return;
        const table = type === 'chunk' ? `rag_chunk_vectors_${dim}` : `rag_summary_vectors_${dim}`;
        this._enqueue({
            op: 'upsertVector',
            table,
            payload: { type, local_id: localId, meeting_id: meetingId, dim, embedding, ...extraMeta },
            retries: 0
        });
    }

    /** Delete a vector row from all per-dimension tables for a given id. */
    deleteVectors(type: 'chunk' | 'summary', localIds: number[], knownDims: readonly number[]): void {
        if (!this.enabled || localIds.length === 0) return;
        const pkCol = type === 'chunk' ? 'chunk_id' : 'summary_id';
        for (const dim of knownDims) {
            const table = type === 'chunk' ? `rag_chunk_vectors_${dim}` : `rag_summary_vectors_${dim}`;
            for (const id of localIds) {
                this._enqueue({ op: 'deleteVector', table, payload: { pkCol, id }, retries: 0 });
            }
        }
    }

    /**
     * Batch upsert rows in a SINGLE outbox item / single network request.
     * Previously this enqueued one item per row, meaning a 50-line meeting
     * transcript meant 50 sequential round trips (drain() sends one item at
     * a time) sitting in front of whatever was enqueued after — including,
     * on a later call within the same saveMeeting(), nothing, but on any
     * subsequent meeting the outbox could still have a prior meeting's
     * leftover transcript items ahead of it. A single batched upsert call
     * is both faster (one request) and can't block later items for long.
     */
    upsertRows(table: string, rows: Record<string, any>[], ownerUid?: string | null): void {
        if (!this.enabled || rows.length === 0) return;
        this._enqueue({ op: 'upsertBatch', table, payload: rows, retries: 0 }, ownerUid);
    }

    // ============================================
    // Private queue / drain machinery
    // ============================================

    private _enqueue(item: Omit<OutboxItem, 'id' | 'ownerUid'>, ownerUid?: string | null): void {
        const entry: OutboxItem = {
            id: ++this.counter,
            // Explicit ownerUid (passed by callers that must keep a multi-step
            // entity's writes under one identity) wins. Otherwise fall back to
            // resolving "current user" fresh — fine for genuine one-shot writes.
            ownerUid: item.table === 'users' ? null : (ownerUid ?? SupabaseClientManager.getCurrentUserId()),
            ...item,
        };
        this.outbox.push(entry);
        this._persistOutboxItem(entry);
        if (!this.draining) this._drain();
    }

    /**
     * Wait for all currently-queued mirror ops to actually reach Supabase.
     *
     * The outbox is normally fire-and-forget (by design, so local writes
     * never block on network). But some callers persist a change locally and
     * then immediately turn around and read it back FROM Supabase (e.g.
     * company:saveContext deleting an asset, followed by the Company
     * Context tab re-fetching on next tab switch via SupabaseReadService).
     * For those, the caller must await this after the local write so the
     * delete/upsert has actually landed before anything reads the cloud
     * copy again.
     *
     * Resolves once the outbox is empty, or after `timeoutMs` — we never want
     * to hang indefinitely (e.g. offline); the outbox keeps retrying on its
     * own regardless of whether anyone awaited this.
     */
    async flush(timeoutMs: number = 8000): Promise<void> {
        if (this.outbox.length === 0 && !this.draining) return;
        const start = Date.now();
        if (!this.draining) this._drain();
        while ((this.outbox.length > 0 || this.draining) && Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    /**
     * Pick the next item to send. A pending 'users' or PRIORITY_TABLES
     * (currently just 'meetings') upsert always wins over plain FIFO order:
     * every other mirrored table either FKs to users.firebase_uid, or is
     * bulk data (transcripts/ai_interactions/chunks) the UI isn't blocked
     * on, whereas the meetings row is exactly what the Launcher's list is
     * polling for right after "End Meeting". This is resolved at drain time
     * rather than enqueue time because outbox order after a restart comes
     * from _loadOutboxFromDb's created_at ASC, which doesn't know about
     * this priority either.
     */
    private _nextItem(): OutboxItem | undefined {
        const usersIdx = this.outbox.findIndex(i => i.table === 'users' && i.op === 'upsert');
        if (usersIdx > 0) return this.outbox[usersIdx];
        if (usersIdx === 0) return this.outbox[0];

        const priorityIdx = this.outbox.findIndex(i => PRIORITY_TABLES.has(i.table));
        if (priorityIdx > 0) return this.outbox[priorityIdx];

        return this.outbox[0];
    }

    private async _drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.outbox.length > 0) {
                // Gate the entire drain loop on a usable client + signed-in user.
                // If either is missing, leave the outbox intact and wait — we'll
                // be re-triggered by AuthManager 'signed-in' / refresh().
                if (!SupabaseClientManager.isConfigured()) {
                    return;
                }

                const item = this._nextItem();
                if (!item) return;
                const success = await this._sendItem(item);
                if (success) {
                    const idx = this.outbox.indexOf(item);
                    if (idx !== -1) this.outbox.splice(idx, 1);
                    this._deleteOutboxItem(item.id);
                    this.lastSyncAt = Date.now();
                    this.lastError = null;
                } else {
                    item.retries++;
                    if (item.retries >= MAX_RETRY) {
                        const isParentTable = item.table === 'users' || PRIORITY_TABLES.has(item.table);
                        if (isParentTable) {
                            // A dropped users/meetings upsert isn't just one lost row — every
                            // transcripts/ai_interactions/meeting_scorecards row that FKs to it
                            // will now fail too, and those failures are far more numerous and
                            // easy to mistake for the actual root cause. Flag this one loudly.
                            console.error(
                                `[SupabaseMirrorService] ⚠️ PARENT ROW DROPPED: ${item.op} on ${item.table} ` +
                                `(payload id/meeting_id=${(item.payload as any)?.id ?? (item.payload as any)?.meeting_id}) ` +
                                `after ${MAX_RETRY} retries. Any transcripts/scorecard rows referencing this ` +
                                `will now fail their FK check and be dropped too — check Supabase for the ` +
                                `actual cause (e.g. missing users.firebase_uid row) rather than chasing the ` +
                                `downstream failures alone.`
                            );
                        } else {
                            console.error(`[SupabaseMirrorService] Dropping op ${item.op} on ${item.table} after ${MAX_RETRY} retries`);
                        }
                        this.lastError = `Dropped ${item.op} on ${item.table} after ${MAX_RETRY} retries`;
                        const idx = this.outbox.indexOf(item);
                        if (idx !== -1) this.outbox.splice(idx, 1);
                        this._deleteOutboxItem(item.id);
                    } else {
                        const delay = RETRY_BASE_MS * Math.pow(2, item.retries - 1);
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
            }
        } finally {
            this.draining = false;
        }
    }

    private async _sendItem(item: OutboxItem): Promise<boolean> {
        const client = SupabaseClientManager.getClient();
        if (!client) return false;

        // Prefer the uid captured when this item (and its FK-related siblings,
        // e.g. a meeting + its transcript batch) was originally enqueued —
        // guarantees they all share one user_id even if the drain loop sends
        // them at different moments. Only fall back to resolving fresh here
        // for the "queued before anyone was signed in yet" case.
        const userId = item.ownerUid ?? SupabaseClientManager.getCurrentUserId();
        const needsUserId = item.table !== 'users';
        if (needsUserId && !userId) {
            // Not signed in — drain loop will re-check on next trigger.
            return false;
        }

        try {
            if (item.op === 'upsert') {
                // Stamp user_id at send time so items queued before sign-in are
                // attributed to the eventual signed-in user.
                const payload = needsUserId
                    ? { user_id: userId, ...item.payload }
                    : item.payload;
                const conflict = this._conflictTargetForTable(item.table, payload);
                const { error } = conflict
                    ? await client.from(item.table).upsert(payload, { onConflict: conflict })
                    : await client.from(item.table).insert(payload);
                // if (error) throw error;
                if (error) {
                    if (item.table === 'users' && error.code === '23505' && error.message?.includes('users_email_unique')) {
                        // A different firebase_uid already owns this email — not a
                        // transient failure, retrying won't help. Drop it and log
                        // loudly since this indicates a real identity conflict
                        // (e.g. account recreated with the same email) worth
                        // investigating, not routine outbox noise.
                        console.error(
                            `[SupabaseMirrorService] users row for firebase_uid=${payload.firebase_uid} ` +
                            `blocked — email "${payload.email}" is already owned by a different user. Not retrying.`
                        );
                        return true; // treat as "handled", remove from outbox
                    }
                    throw error;
                }

            } else if (item.op === 'upsertBatch') {
                // item.payload is an array of rows for the same table (see
                // upsertRows). Stamp user_id onto every row, then send as one
                // request instead of one-per-row — cuts N round trips to 1 and
                // stops a large transcript batch from blocking a later
                // higher-priority item (see _nextItem) for as long.
                const rows: Record<string, any>[] = (item.payload as Record<string, any>[]).map(row =>
                    needsUserId ? { user_id: userId, ...row } : row
                );
                if (rows.length === 0) return true;
                const conflict = this._conflictTargetForTable(item.table, rows[0]);
                const { error } = conflict
                    ? await client.from(item.table).upsert(rows, { onConflict: conflict })
                    : await client.from(item.table).insert(rows);
                if (error) throw error;

            } else if (item.op === 'delete') {
                const { pkColumn, pkValue } = item.payload;
                // Scope the delete to the current user so a stale local id
                // can never reach another tenant's row (RLS would block it
                // anyway, but belt-and-braces).
                let q: any = client.from(item.table).delete();
                if (needsUserId) q = q.eq('user_id', userId);
                // Request the deleted rows back. Supabase-js returns NO error
                // when a delete matches zero rows (whether because the row
                // is already gone, or — critically — because an RLS policy
                // silently excludes it from the DELETE). Without .select(),
                // that "0 rows affected" case is indistinguishable from a
                // real success, so a permission problem never surfaces —
                // it just looks like the row is stuck forever on the client.
                const { data, error } = await q.eq(pkColumn, pkValue).select('*');
                if (error) throw error;
                if (!data || data.length === 0) {
                    console.warn(
                        `[SupabaseMirrorService] delete on ${item.table} (${pkColumn}=${pkValue}, user_id=${userId}) ` +
                        `matched 0 rows. If the row is visible in the Supabase dashboard, this is almost ` +
                        `certainly a missing/incorrect RLS DELETE policy on "${item.table}", not a bug in ` +
                        `this client — the request succeeded but the database silently declined to remove anything.`
                    );
                }

            } else if (item.op === 'upsertVector') {
                const { type, local_id, meeting_id, dim, embedding, ...rest } = item.payload;
                const pkCol = type === 'chunk' ? 'chunk_id' : 'summary_id';
                const row: Record<string, any> = {
                    user_id: userId,
                    [pkCol]: local_id,
                    meeting_id,
                    embedding_dimensions: dim,
                    // Store as Postgres array string for pgvector: '[0.1,0.2,...]'
                    embedding: `[${embedding.join(',')}]`,
                    mirrored_at: new Date().toISOString(),
                    ...rest
                };
                const { error } = await client
                    .from(item.table)
                    .upsert(row, { onConflict: `user_id,${pkCol}` });
                if (error) throw error;

            } else if (item.op === 'deleteVector') {
                const { pkCol, id } = item.payload;
                const { error } = await (client.from(item.table).delete() as any)
                    .eq('user_id', userId)
                    .eq(pkCol, id);
                if (error) throw error;
            }
            return true;
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.lastError = msg;
            console.warn(`[SupabaseMirrorService] Failed op=${item.op} table=${item.table}:`, msg);
            return false;
        }
    }

    // ============================================
    // Outbox persistence (uses a dedicated SQLite table)
    // ============================================

    /** Ensure the local outbox persistence table exists. */
    ensureOutboxTable(): void {
        if (!this.db) return;
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS supabase_mirror_outbox (
                    id   INTEGER PRIMARY KEY,
                    op   TEXT NOT NULL,
                    tbl  TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    retries INTEGER DEFAULT 0,
                    owner_uid TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
            `);
            // Upgrade path for DBs created before owner_uid existed.
            try {
                this.db.exec(`ALTER TABLE supabase_mirror_outbox ADD COLUMN owner_uid TEXT;`);
            } catch (_) { /* column already exists — fine */ }
        } catch (e) {
            console.warn('[SupabaseMirrorService] Could not create outbox table:', e);
        }
    }

    private _persistOutboxItem(item: OutboxItem): void {
        if (!this.db) return;
        try {
            this.db.prepare(
                `INSERT OR IGNORE INTO supabase_mirror_outbox (id, op, tbl, payload, retries, owner_uid)
                 VALUES (?, ?, ?, ?, ?, ?)`
            ).run(item.id, item.op, item.table, JSON.stringify(item.payload), item.retries, item.ownerUid);
        } catch (_) { }
    }

    private _deleteOutboxItem(id: number): void {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM supabase_mirror_outbox WHERE id = ?').run(id);
        } catch (_) { }
    }

    private _loadOutboxFromDb(): void {
        if (!this.db) return;
        try {
            this.ensureOutboxTable();
            const rows = this.db.prepare(
                'SELECT * FROM supabase_mirror_outbox ORDER BY created_at ASC'
            ).all() as any[];
            for (const row of rows) {
                this.outbox.push({
                    id: row.id,
                    op: row.op,
                    table: row.tbl,
                    payload: JSON.parse(row.payload),
                    retries: row.retries,
                    // Older rows saved before this column existed will be
                    // NULL — _sendItem falls back to resolving fresh in
                    // that case, same as the pre-fix behavior.
                    ownerUid: row.owner_uid ?? null,
                });
                if (row.id > this.counter) this.counter = row.id;
            }
            if (rows.length > 0) {
                console.log(`[SupabaseMirrorService] Restored ${rows.length} pending outbox items from last session`);
                this._drain();
            }
        } catch (e) {
            console.warn('[SupabaseMirrorService] Could not load outbox from DB:', e);
        }
    }

    // ============================================
    // SQL Schema helper (call once to set up Supabase)
    // ============================================

    /**
     * Returns the SQL that must be run once in Supabase to create mirror tables.
     * Log this during development or expose via a settings page.
     */
    static getSupabaseSchemaSql(): string {
        return `
-- ============================================================
-- Natively Mirror Schema for Supabase (Mode A + Firebase Auth + RLS)
-- Run this once in the Supabase SQL editor.
--
-- Prerequisites in Supabase Dashboard:
--   1. Database -> Extensions: enable "vector" (pgvector)
--   2. Authentication -> Third-party Auth: add Firebase
--        Issuer:   https://securetoken.google.com/<FIREBASE_PROJECT_ID>
--        Audience: <FIREBASE_PROJECT_ID>
--      Supabase verifies RS256 against Google's JWKS automatically.
--
-- All policies key off  auth.jwt() ->> 'sub'  which Firebase sets to the UID.
-- Every scoped table carries  user_id TEXT NOT NULL REFERENCES users(firebase_uid).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- USERS  (identity table; populated on first sign-in)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    firebase_uid  TEXT PRIMARY KEY,
    email         TEXT,
    display_name  TEXT,
    photo_url     TEXT,
    created_at    TIMESTAMPTZ DEFAULT now(),
    last_seen_at  TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_self ON users;
CREATE POLICY users_self ON users
    USING       (firebase_uid = auth.jwt() ->> 'sub')
    WITH CHECK  (firebase_uid = auth.jwt() ->> 'sub');

-- ============================================================
-- CORE RELATIONAL TABLES (each carries user_id)
-- ============================================================
CREATE TABLE IF NOT EXISTS meetings (
    user_id              TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    id                   TEXT NOT NULL,
    title                TEXT,
    start_time           BIGINT,
    end_time             BIGINT,
    total_paused_ms      BIGINT DEFAULT 0,
    duration_ms          BIGINT,
    summary_json         JSONB,
    created_at           TIMESTAMPTZ,
    calendar_event_id    TEXT,
    tenant_id            TEXT,
    source               TEXT,
    is_processed         INTEGER DEFAULT 1,
    embedding_provider   TEXT,
    embedding_dimensions INTEGER,
    calendar_event_metadata JSONB,
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_tenant ON meetings(tenant_id);

-- If this table already exists in your Supabase project, run instead:
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS tenant_id TEXT;
-- ALTER TABLE meetings ADD COLUMN IF NOT EXISTS calendar_event_metadata JSONB;
-- CREATE INDEX IF NOT EXISTS idx_meetings_tenant ON meetings(tenant_id);

CREATE TABLE IF NOT EXISTS transcripts (
    user_id       TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    id            BIGINT NOT NULL,
    meeting_id    TEXT NOT NULL,
    speaker       TEXT,
    content       TEXT,
    timestamp_ms  BIGINT,
    speaker_index INTEGER,
    display_name  TEXT,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id, meeting_id) REFERENCES meetings(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transcripts_user_meeting ON transcripts(user_id, meeting_id);

-- If this table already exists in your Supabase project, run instead:
-- ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS speaker_index INTEGER;
-- ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE TABLE IF NOT EXISTS ai_interactions (
    user_id       TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    id            BIGINT NOT NULL,
    meeting_id    TEXT NOT NULL,
    type          TEXT,
    timestamp     BIGINT,
    user_query    TEXT,
    ai_response   TEXT,
    metadata_json JSONB,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id, meeting_id) REFERENCES meetings(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_interactions_user_meeting ON ai_interactions(user_id, meeting_id, timestamp);

CREATE TABLE IF NOT EXISTS chunks (
    user_id            TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    id                 BIGINT NOT NULL,
    meeting_id         TEXT NOT NULL,
    chunk_index        INTEGER,
    speaker            TEXT,
    start_timestamp_ms BIGINT,
    end_timestamp_ms   BIGINT,
    cleaned_text       TEXT,
    token_count        INTEGER,
    created_at         TIMESTAMPTZ,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id, meeting_id) REFERENCES meetings(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_user_meeting ON chunks(user_id, meeting_id);

CREATE TABLE IF NOT EXISTS chunk_summaries (
    user_id      TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    id           BIGINT NOT NULL,
    meeting_id   TEXT NOT NULL,
    summary_text TEXT,
    created_at   TIMESTAMPTZ,
    PRIMARY KEY (user_id, id),
    UNIQUE      (user_id, meeting_id),
    FOREIGN KEY (user_id, meeting_id) REFERENCES meetings(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS embedding_queue (
    user_id       TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    id            BIGINT NOT NULL,
    meeting_id    TEXT,
    chunk_id      BIGINT,
    status        TEXT DEFAULT 'pending',
    retry_count   INTEGER DEFAULT 0,
    error_message TEXT,
    created_at    TIMESTAMPTZ,
    processed_at  TIMESTAMPTZ,
    PRIMARY KEY (user_id, id),
    UNIQUE      (user_id, meeting_id, chunk_id)
);

-- app_state: composite (user_id, key) so per-device/per-user values don't collide
CREATE TABLE IF NOT EXISTS app_state (
    user_id TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT,
    PRIMARY KEY (user_id, key)
);

-- user_profile: one row per user (PK is user_id directly)
CREATE TABLE IF NOT EXISTS user_profile (
    user_id          TEXT PRIMARY KEY REFERENCES users(firebase_uid) ON DELETE CASCADE,
    structured_json  JSONB,
    compact_persona  TEXT,
    intro_short      TEXT,
    intro_interview  TEXT,
    created_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS resume_nodes (
    user_id          TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    id               BIGINT NOT NULL,
    category         TEXT,
    title            TEXT,
    organization     TEXT,
    start_date       TEXT,
    end_date         TEXT,
    duration_months  INTEGER,
    text_content     TEXT,
    tags             TEXT,
    PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS company_asset_chunks (
    user_id     TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    id          BIGINT NOT NULL,
    asset_id    TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text  TEXT,
    token_count INTEGER,
    embedding   JSONB,
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_company_asset_chunks_asset
    ON company_asset_chunks(user_id, asset_id);

CREATE TABLE IF NOT EXISTS meeting_scorecards (
    user_id                TEXT        NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    meeting_id             TEXT        NOT NULL,
    overall_score          REAL        NOT NULL DEFAULT 0,
    detected_types         TEXT        NOT NULL DEFAULT '[]',
    scorecard_json         JSONB       NOT NULL,
    criteria_snapshot_json JSONB,
    generated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, meeting_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_scorecards_user_meeting
    ON meeting_scorecards(user_id, meeting_id);

CREATE TABLE IF NOT EXISTS scoring_criteria (
    user_id     TEXT        NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    id          INTEGER     NOT NULL DEFAULT 1,
    config_json JSONB       NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id)
);

-- ============================================================
-- PER-DIMENSION VECTOR TABLES (pgvector + HNSW cosine indexes)
-- ============================================================
CREATE TABLE IF NOT EXISTS rag_chunk_vectors_768 (
    user_id              TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    chunk_id             BIGINT NOT NULL,
    meeting_id           TEXT,
    embedding_dimensions INT DEFAULT 768,
    embedding            vector(768),
    mirrored_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_rag_chunk_vectors_768_hnsw
    ON rag_chunk_vectors_768 USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS rag_summary_vectors_768 (
    user_id              TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    summary_id           BIGINT NOT NULL,
    meeting_id           TEXT,
    embedding_dimensions INT DEFAULT 768,
    embedding            vector(768),
    mirrored_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, summary_id)
);
CREATE INDEX IF NOT EXISTS idx_rag_summary_vectors_768_hnsw
    ON rag_summary_vectors_768 USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS rag_chunk_vectors_1536 (
    user_id              TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    chunk_id             BIGINT NOT NULL,
    meeting_id           TEXT,
    embedding_dimensions INT DEFAULT 1536,
    embedding            vector(1536),
    mirrored_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_rag_chunk_vectors_1536_hnsw
    ON rag_chunk_vectors_1536 USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS rag_summary_vectors_1536 (
    user_id              TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    summary_id           BIGINT NOT NULL,
    meeting_id           TEXT,
    embedding_dimensions INT DEFAULT 1536,
    embedding            vector(1536),
    mirrored_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, summary_id)
);
CREATE INDEX IF NOT EXISTS idx_rag_summary_vectors_1536_hnsw
    ON rag_summary_vectors_1536 USING hnsw (embedding vector_cosine_ops);

-- NOTE: pgvector HNSW currently caps at 2000 dims, so vector(3072) cannot be
-- indexed with HNSW today. Sequential scan is acceptable for the few users on
-- text-embedding-3-large; revisit when pgvector lifts the limit.
CREATE TABLE IF NOT EXISTS rag_chunk_vectors_3072 (
    user_id              TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    chunk_id             BIGINT NOT NULL,
    meeting_id           TEXT,
    embedding_dimensions INT DEFAULT 3072,
    embedding            vector(3072),
    mirrored_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, chunk_id)
);
CREATE TABLE IF NOT EXISTS rag_summary_vectors_3072 (
    user_id              TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    summary_id           BIGINT NOT NULL,
    meeting_id           TEXT,
    embedding_dimensions INT DEFAULT 3072,
    embedding            vector(3072),
    mirrored_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, summary_id)
);

-- ============================================================
-- ROW LEVEL SECURITY  (applied to every scoped table)
-- ============================================================
-- Helper macro pattern: each table gets a uniform policy keyed on user_id.
-- We DROP-then-CREATE so this block is idempotent on re-runs.

DO $$
DECLARE
    tbl TEXT;
    scoped_tables TEXT[] := ARRAY[
        'meetings', 'transcripts', 'ai_interactions',
        'chunks', 'chunk_summaries', 'embedding_queue',
        'app_state', 'user_profile', 'resume_nodes',
        'company_asset_chunks',
        'meeting_scorecards',
        'scoring_criteria',
        'rag_chunk_vectors_768',   'rag_summary_vectors_768',
        'rag_chunk_vectors_1536',  'rag_summary_vectors_1536',
        'rag_chunk_vectors_3072',  'rag_summary_vectors_3072'
    ];
BEGIN
    FOREACH tbl IN ARRAY scoped_tables
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS %I_owner ON %I', tbl, tbl);
        EXECUTE format(
            'CREATE POLICY %I_owner ON %I
                USING       (user_id = auth.jwt() ->> ''sub'')
                WITH CHECK  (user_id = auth.jwt() ->> ''sub'')',
            tbl, tbl
        );
    END LOOP;
END $$;
`;
    }
}