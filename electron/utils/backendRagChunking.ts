// backendRagChunking.ts
//
// Durable trigger for the backend RAG ingest: POST /meetings/:id/chunking,
// called the moment a meeting finishes processing in
// MeetingPersistence.processAndSaveMeeting, with immediate backoff retries
// and a SQLite queue for anything still failing.
//
// Replaces the old renderer transition-watch effect in useLauncher.ts, which
// only chunked meetings whose isProcessed flipped while the Launcher was
// mounted, seeded every other already-processed meeting as "handled" WITHOUT
// chunking it, and permanently swallowed the first error. That is why the
// live DB showed hundreds of is_processed=1 meetings with zero chunks — the
// chat/RAG can only answer from those chunks.
//
// Retrying is safe: the backend's upsert_chunks deletes the meeting's chunks
// then re-inserts (idempotent re-ingest).
//
// Why the queue even with a live trigger: the transcript rows reach Supabase
// through the mirror's async outbox, so the first attempt can legitimately
// find "No transcript found"; and a meeting can finish while offline.

const BACKEND_URL = process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

// The route embeds synchronously (chunk → embed → verify), so a long
// transcript can legitimately take minutes. The renderer's old 60s apiFetch
// ceiling was itself a silent-failure source; don't reproduce it here.
const CHUNK_TIMEOUT_MS = 5 * 60_000;

// Delays before the 2nd and 3rd immediate attempt (so 3 tries total inside
// ~35s — the window the transcript mirror usually needs to catch up).
const IMMEDIATE_RETRY_DELAYS_MS = [5_000, 30_000];

// Drains run every 10 minutes; a row that keeps failing through ~2.5h of
// drains is a real outage, not transient — drop it with an error log rather
// than retry forever.
const MAX_DRAIN_ATTEMPTS = 15;

/** Shape of one queue row (DatabaseManager.listChunkQueue). */
interface ChunkQueueRow { meeting_id: string; tenant_id: string | null; attempts: number; }

/**
 * Error shape thrown by postChunkingForMeeting: carries the HTTP status when
 * there was one, so callers can distinguish "gone" (404 — drop) and "signed
 * out" (401/absent token — defer without burning attempts).
 */
export class ChunkRequestError extends Error {
    constructor(message: string, public status?: number) {
        super(message);
        this.name = 'ChunkRequestError';
    }
}

/** One POST to the backend chunking route. Exported for tests to inject. */
export async function postChunkingForMeeting(
    meetingId: string,
    tenantId: string | null,
): Promise<{ ingested: boolean }> {
    const { AuthManager } = require('../services/AuthManager');
    const token: string | null = AuthManager.getInstance().getIdToken();
    if (!token) throw new ChunkRequestError('not-authenticated', 401);

    const { tenantContext } = require('../services/TenantContext');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const tenant = tenantId ?? tenantContext.get?.() ?? null;
    if (tenant) headers['X-Tenant-Id'] = tenant;

    const axios = require('axios');
    try {
        const res = await axios.post(
            `${BACKEND_URL}/api/v1/meetings/${encodeURIComponent(meetingId)}/chunking`,
            null,
            { headers, timeout: CHUNK_TIMEOUT_MS },
        );
        // The route answers 200 with ingested:false when the transcript isn't
        // on the backend yet (or embeddings were degraded) — NOT a success.
        return { ingested: res?.data?.ingested === true };
    } catch (err: any) {
        const status = err?.response?.status;
        const detail = err?.response?.data?.error?.message || err?.message || 'chunk request failed';
        throw new ChunkRequestError(String(detail), status);
    }
}

/** The subset of DatabaseManager the queue logic uses — injected so the
 *  retry/drain behaviour is unit-testable without a real SQLite file. */
export interface ChunkQueueAdapter {
    upsertChunkAttempt(meetingId: string, tenantId: string | null): void;
    bumpChunkAttempt(meetingId: string, error: string): void;
    getChunkAttempts(meetingId: string): number;
    listChunkQueue(): Array<{ meeting_id: string; tenant_id: string | null; attempts: number }>;
    removeChunkQueueItem(meetingId: string): void;
}

function defaultQueue(): ChunkQueueAdapter {
    const { DatabaseManager } = require('../db/DatabaseManager');
    return DatabaseManager.getInstance();
}

/**
 * Fresh-completion path: up to 3 immediate attempts with backoff. Anything
 * still failing at the end (other than 404) is parked in the durable queue.
 * Never throws — callers fire-and-forget from the meeting-save flow.
 */
export async function requestBackendChunking(
    meetingId: string,
    tenantId: string | null,
    opts: {
        post?: (id: string, tenant: string | null) => Promise<{ ingested: boolean }>;
        sleep?: (ms: number) => Promise<void>;
        queue?: ChunkQueueAdapter;
    } = {},
): Promise<void> {
    const post = opts.post ?? postChunkingForMeeting;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const db = opts.queue ?? defaultQueue();

    let lastError = 'unknown';
    for (let attempt = 0; attempt <= IMMEDIATE_RETRY_DELAYS_MS.length; attempt++) {
        try {
            const res = await post(meetingId, tenantId);
            if (res.ingested) {
                db.removeChunkQueueItem(meetingId);
                console.log(`[RagChunk] meeting ${meetingId} ingested into backend RAG`);
                return;
            }
            lastError = 'ingested=false (transcript not mirrored yet or embeddings degraded)';
        } catch (err: any) {
            const status = err instanceof ChunkRequestError ? err.status : undefined;
            if (status === 404) {
                // Meeting row is gone on the backend — nothing to chunk ever.
                console.warn(`[RagChunk] meeting ${meetingId} not found on backend — dropping`);
                db.removeChunkQueueItem(meetingId);
                return;
            }
            if (status === 401) {
                // Signed out (or token not restored): retrying now is pointless
                // and would burn attempts — park it; the next drain runs once
                // auth is back.
                db.upsertChunkAttempt(meetingId, tenantId);
                console.warn(`[RagChunk] not authenticated for ${meetingId} — queued`);
                return;
            }
            lastError = err?.message ?? String(err);
        }
        if (attempt < IMMEDIATE_RETRY_DELAYS_MS.length) {
            await sleep(IMMEDIATE_RETRY_DELAYS_MS[attempt]);
        }
    }

    db.upsertChunkAttempt(meetingId, tenantId);
    console.error(`[RagChunk] immediate retries failed for ${meetingId} (${lastError}) — queued for retry`);
}

/**
 * One drain pass over the durable queue: a single attempt per row (the
 * backoff loop belongs to the fresh-completion path; here the 10-min timer
 * IS the backoff). Called at startup and on an interval from main.ts.
 * Never throws.
 */
export async function drainChunkQueue(
    opts: {
        post?: (id: string, tenant: string | null) => Promise<{ ingested: boolean }>;
        queue?: ChunkQueueAdapter;
    } = {},
): Promise<void> {
    const post = opts.post ?? postChunkingForMeeting;
    const db = opts.queue ?? defaultQueue();

    const pending = db.listChunkQueue();
    for (const row of pending) {
        let failedReason: string | null = null;
        let succeeded = false;
        try {
            const res = await post(row.meeting_id, row.tenant_id);
            if (res.ingested) {
                succeeded = true;
            } else {
                failedReason = 'ingested=false (transcript not mirrored yet or embeddings degraded)';
            }
        } catch (err: any) {
            const status = err instanceof ChunkRequestError ? err.status : undefined;
            if (status === 404) {
                // Meeting row is gone on the backend — nothing to chunk.
                db.removeChunkQueueItem(row.meeting_id);
                continue;
            }
            if (status === 401) {
                // Signed out again — don't burn attempts, keep everything for
                // the next drain (also stops this pass early, since a later
                // row would hit the same wall).
                console.warn('[RagChunk] drain deferred — not authenticated');
                return;
            }
            failedReason = err?.message ?? String(err);
        }

        if (succeeded) {
            db.removeChunkQueueItem(row.meeting_id);
            console.log(`[RagChunk] queued ingest succeeded for ${row.meeting_id}`);
            continue;
        }

        db.bumpChunkAttempt(row.meeting_id, failedReason ?? 'unknown');
        if (db.getChunkAttempts(row.meeting_id) >= MAX_DRAIN_ATTEMPTS) {
            console.error(`[RagChunk] giving up on ${row.meeting_id} after ${MAX_DRAIN_ATTEMPTS} drain attempts`);
            db.removeChunkQueueItem(row.meeting_id);
        }
    }
}
