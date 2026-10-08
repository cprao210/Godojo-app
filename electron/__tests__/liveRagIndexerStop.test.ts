import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// VectorStore / EmbeddingPipeline pull in SQLite + network code; only their
// shapes matter here, so stub the modules and pass fakes in.
vi.mock('../rag/VectorStore', () => ({ VectorStore: class { } }));
vi.mock('../rag/EmbeddingPipeline', () => ({ EmbeddingPipeline: class { } }));

import { LiveRAGIndexer } from '../rag/LiveRAGIndexer';

const seg = (i: number) => ({
    speaker: i % 2 ? 'user' : 'interviewer',
    text: `Segment number ${i} talks about pricing tiers, onboarding timelines and the security review in enough words to chunk.`,
    timestamp: 1_000 * i,
});

function makeIndexer(embedDelayMs = 0) {
    let nextId = 0;
    const saved: string[] = [];
    const vectorStore = {
        saveChunks: vi.fn((chunks: any[]) => chunks.map(() => { const id = ++nextId; saved.push(String(id)); return id; })),
        storeEmbedding: vi.fn(),
    };
    const embeddingPipeline = {
        isReady: () => true,
        getEmbedding: vi.fn(() => new Promise<number[]>((r) => setTimeout(() => r([0.1, 0.2]), embedDelayMs))),
    };
    const indexer = new LiveRAGIndexer(vectorStore as any, embeddingPipeline as any);
    return { indexer, vectorStore, embeddingPipeline };
}

describe('LiveRAGIndexer.stop', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('default stop flushes remaining segments (pause path unchanged)', async () => {
        const { indexer, vectorStore } = makeIndexer();
        indexer.start('live-meeting-current');
        indexer.feedSegments([0, 1, 2, 3, 4, 5].map(seg));
        const p = indexer.stop();
        await vi.runAllTimersAsync();
        await p;
        expect(vectorStore.saveChunks).toHaveBeenCalled();
    });

    it('stop({ flush: false }) skips the final chunk + embed pass', async () => {
        const { indexer, vectorStore, embeddingPipeline } = makeIndexer();
        indexer.start('live-meeting-current');
        indexer.feedSegments([0, 1, 2, 3, 4, 5].map(seg));
        await indexer.stop({ flush: false });
        expect(vectorStore.saveChunks).not.toHaveBeenCalled();
        expect(embeddingPipeline.getEmbedding).not.toHaveBeenCalled();
    });

    it('stop waits for a tick already in flight, so nothing is written afterwards', async () => {
        const { indexer, vectorStore } = makeIndexer(5_000);
        indexer.start('live-meeting-current', true); // 90 s interval
        indexer.feedSegments([0, 1, 2, 3, 4, 5].map(seg));
        await vi.advanceTimersByTimeAsync(90_000); // tick starts; embedding is slow
        expect(vectorStore.saveChunks).toHaveBeenCalledTimes(1);

        let stopped = false;
        const p = indexer.stop({ flush: false }).then(() => { stopped = true; });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(stopped).toBe(false); // still waiting for the in-flight embed
        await vi.runAllTimersAsync();
        await p;
        const embedsAtStop = vectorStore.storeEmbedding.mock.calls.length;
        await vi.runAllTimersAsync();
        expect(vectorStore.storeEmbedding.mock.calls.length).toBe(embedsAtStop);
    });
});
