// Covers electron/utils/backendRagChunking — the durable backend RAG ingest
// trigger that replaced the fragile renderer transition-watch effect. The
// whole point is that a transient failure NEVER permanently drops a meeting's
// chunks, so these tests pin the queue/retry invariants:
//   - immediate success clears the queue
//   - "ingested:false" and thrown errors retry with backoff, then park
//   - 404 drops (meeting gone), 401 parks without burning retries
//   - drain clears on success, keeps on failure, gives up after the cap
//
// The queue is an in-memory ChunkQueueAdapter and `post`/`sleep` are injected,
// so nothing touches axios, auth, timers, or a real SQLite file.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    requestBackendChunking,
    drainChunkQueue,
    ChunkRequestError,
    type ChunkQueueAdapter,
} from '../utils/backendRagChunking';

interface FakeRow { meeting_id: string; tenant_id: string | null; attempts: number; }

function makeQueue(seed: FakeRow[] = []): ChunkQueueAdapter & { rows: FakeRow[] } {
    const rows: FakeRow[] = seed.map(r => ({ ...r }));
    return {
        rows,
        upsertChunkAttempt: (id, tenant) => {
            const existing = rows.find(r => r.meeting_id === id);
            if (existing) existing.tenant_id = tenant ?? null;
            else rows.push({ meeting_id: id, tenant_id: tenant ?? null, attempts: 0 });
        },
        bumpChunkAttempt: (id) => { const r = rows.find(x => x.meeting_id === id); if (r) r.attempts += 1; },
        getChunkAttempts: (id) => rows.find(r => r.meeting_id === id)?.attempts ?? 0,
        listChunkQueue: () => rows.map(r => ({ ...r })),
        removeChunkQueueItem: (id) => { const i = rows.findIndex(r => r.meeting_id === id); if (i >= 0) rows.splice(i, 1); },
    };
}

const noSleep = async () => { };

describe('requestBackendChunking', () => {
    it('clears any stale queue row and stops after one success', async () => {
        const q = makeQueue([{ meeting_id: 'm1', tenant_id: null, attempts: 0 }]);
        const post = vi.fn(async () => ({ ingested: true }));
        await requestBackendChunking('m1', null, { post, sleep: noSleep, queue: q });
        expect(post).toHaveBeenCalledTimes(1);
        expect(q.rows).toHaveLength(0);
    });

    it('retries on ingested:false then parks if every attempt fails', async () => {
        const q = makeQueue();
        const post = vi.fn(async () => ({ ingested: false }));
        await requestBackendChunking('m1', 't9', { post, sleep: noSleep, queue: q });
        // 3 immediate attempts total (1 + two backoff retries).
        expect(post).toHaveBeenCalledTimes(3);
        expect(q.rows.find(r => r.meeting_id === 'm1')?.tenant_id).toBe('t9');
    });

    it('succeeds on the second attempt and clears the queue (no park)', async () => {
        const q = makeQueue();
        let n = 0;
        const post = vi.fn(async () => { n += 1; return { ingested: n >= 2 }; });
        await requestBackendChunking('m1', null, { post, sleep: noSleep, queue: q });
        expect(post).toHaveBeenCalledTimes(2);
        expect(q.rows).toHaveLength(0);
    });

    it('drops the meeting on 404 without retrying', async () => {
        const q = makeQueue();
        const post = vi.fn(async () => { throw new ChunkRequestError('gone', 404); });
        await requestBackendChunking('m1', null, { post, sleep: noSleep, queue: q });
        expect(post).toHaveBeenCalledTimes(1);
        expect(q.rows).toHaveLength(0);
    });

    it('parks on 401 without exhausting the immediate retries', async () => {
        const q = makeQueue();
        const post = vi.fn(async () => { throw new ChunkRequestError('no token', 401); });
        await requestBackendChunking('m1', 't1', { post, sleep: noSleep, queue: q });
        // Returns after the first 401 — the remaining attempts are pointless.
        expect(post).toHaveBeenCalledTimes(1);
        expect(q.rows.find(r => r.meeting_id === 'm1')).toBeTruthy();
    });

    it('treats a thrown network error as retryable and parks after retries', async () => {
        const q = makeQueue();
        const post = vi.fn(async () => { throw new ChunkRequestError('ECONNRESET'); });
        await requestBackendChunking('m1', null, { post, sleep: noSleep, queue: q });
        expect(post).toHaveBeenCalledTimes(3);
        expect(q.rows).toHaveLength(1);
    });
});

describe('drainChunkQueue', () => {
    it('removes rows that succeed and keeps failing ones for the next drain', async () => {
        const q = makeQueue([
            { meeting_id: 'ok', tenant_id: null, attempts: 0 },
            { meeting_id: 'bad', tenant_id: null, attempts: 0 },
        ]);
        const post = vi.fn(async (id: string) => ({ ingested: id === 'ok' }));
        await drainChunkQueue({ post, queue: q });
        expect(q.rows.map(r => r.meeting_id)).toEqual(['bad']);
        expect(q.rows[0].attempts).toBe(1);
    });

    it('drops a 404 row and gives up on a row past the attempt cap', async () => {
        const q = makeQueue([
            { meeting_id: 'gone', tenant_id: null, attempts: 0 },
            { meeting_id: 'capped', tenant_id: null, attempts: 14 }, // next bump => 15 => give up
        ]);
        const post = vi.fn(async (id: string) => {
            if (id === 'gone') throw new ChunkRequestError('gone', 404);
            return { ingested: false };
        });
        await drainChunkQueue({ post, queue: q });
        expect(q.rows).toHaveLength(0);
    });

    it('stops early on 401 without burning attempts', async () => {
        const q = makeQueue([
            { meeting_id: 'a', tenant_id: null, attempts: 2 },
            { meeting_id: 'b', tenant_id: null, attempts: 3 },
        ]);
        const post = vi.fn(async () => { throw new ChunkRequestError('no token', 401); });
        await drainChunkQueue({ post, queue: q });
        // Both rows untouched: attempts unchanged, both still queued.
        expect(q.rows.map(r => r.attempts)).toEqual([2, 3]);
        expect(post).toHaveBeenCalledTimes(1); // bailed after the first 401
    });
});
