// electron/rag/LiveRAGIndexer.ts
// JIT RAG: Incrementally indexes transcript during a live meeting.
//
// Architecture:
// - Background timer (30s) chunks & embeds NEW transcript segments
// - Embedding is fire-and-forget — never blocks the query path
// - At query time, VectorStore already has indexed chunks for fast search
// - Falls back gracefully if embedding API unavailable

import { preprocessTranscript, RawSegment } from './TranscriptPreprocessor';
import { chunkTranscript, Chunk } from './SemanticChunker';
import { VectorStore } from './VectorStore';
import { EmbeddingPipeline } from './EmbeddingPipeline';

const INDEXING_INTERVAL_MS = 30_000;  // 30 seconds
// Performance Mode: the tick can run local (CPU-only, WASM) embedding inference for
// the whole meeting, competing with audio capture + STT on weak CPUs. Run it 3x less
// often instead of disabling it, so mid-meeting JIT RAG still works (just staler).
const PERF_MODE_INDEXING_INTERVAL_MS = 90_000;  // 90 seconds
const MIN_NEW_SEGMENTS = 3;           // Don't chunk unless we have enough new content

export class LiveRAGIndexer {
    private vectorStore: VectorStore;
    private embeddingPipeline: EmbeddingPipeline;
    private meetingId: string | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private allSegments: RawSegment[] = [];
    private indexedSegmentCount = 0;  // High-water mark: segments already chunked
    private chunkCounter = 0;         // Running chunk index
    private indexedChunkCount = 0;    // Total chunks with embeddings
    private isProcessing = false;     // Guard against concurrent ticks
    private isActive = false;
    /** The tick currently running, so stop() can wait for it to finish writing. */
    private inFlightTick: Promise<void> | null = null;

    constructor(vectorStore: VectorStore, embeddingPipeline: EmbeddingPipeline) {
        this.vectorStore = vectorStore;
        this.embeddingPipeline = embeddingPipeline;
    }

    /**
     * Start live indexing for a meeting.
     * Begins a background timer that periodically chunks & embeds new transcript.
     *
     * @param performanceMode true when Performance Mode is active — see
     *   isPerformanceModeActive() in utils/performanceModeMain.ts.
     */
    start(meetingId: string, performanceMode = false): void {
        if (this.isActive) {
            this.stop();
        }

        this.meetingId = meetingId;
        this.allSegments = [];
        this.indexedSegmentCount = 0;
        this.chunkCounter = 0;
        this.indexedChunkCount = 0;
        this.isProcessing = false;
        this.isActive = true;

        const intervalMs = performanceMode ? PERF_MODE_INDEXING_INTERVAL_MS : INDEXING_INTERVAL_MS;
        console.log(`[LiveRAGIndexer] Started for meeting ${meetingId} (interval=${intervalMs}ms, performanceMode=${performanceMode})`);

        this.timer = setInterval(() => {
            this.trackedTick().catch(err => {
                console.error('[LiveRAGIndexer] Tick error:', err);
            });
        }, intervalMs);
    }

    /** Run a tick, or join the one already running. */
    private trackedTick(): Promise<void> {
        if (this.inFlightTick) return this.inFlightTick;
        const p = this.tick().finally(() => {
            if (this.inFlightTick === p) this.inFlightTick = null;
        });
        this.inFlightTick = p;
        return p;
    }

    /**
     * Feed new transcript segments from the live meeting.
     * Called by SessionTracker whenever new transcript arrives.
     * This is append-only — segments are never modified after being fed.
     */
    feedSegments(segments: RawSegment[]): void {
        if (!this.isActive || !this.meetingId) return;
        this.allSegments.push(...segments);
    }

    /**
     * Core indexing tick — processes only NEW segments since last tick.
     * 
     * Flow:
     * 1. Slice segments from high-water mark
     * 2. Preprocess (clean, merge speakers)
     * 3. Chunk (semantic boundaries, 200-400 tokens)
     * 4. Save chunks to VectorStore
     * 5. Embed each chunk via Gemini API
     * 6. Advance high-water mark
     */
    private async tick(): Promise<void> {
        if (!this.isActive || !this.meetingId) return;
        if (this.isProcessing) return;  // Skip if previous tick still running

        const newSegmentCount = this.allSegments.length - this.indexedSegmentCount;
        if (newSegmentCount < MIN_NEW_SEGMENTS) return;  // Not enough new content

        this.isProcessing = true;
        const meetingId = this.meetingId;

        try {
            // 1. Get only new segments
            const newSegments = this.allSegments.slice(this.indexedSegmentCount);

            // 2. Preprocess
            const cleaned = preprocessTranscript(newSegments);
            if (cleaned.length === 0) {
                this.indexedSegmentCount = this.allSegments.length;
                return;
            }

            // 3. Chunk with offset index
            const chunks = chunkTranscript(meetingId, cleaned);
            if (chunks.length === 0) {
                this.indexedSegmentCount = this.allSegments.length;
                return;
            }

            // Re-index chunks to continue from where we left off
            const indexedChunks: Chunk[] = chunks.map((chunk, i) => ({
                ...chunk,
                chunkIndex: this.chunkCounter + i,
            }));

            // 4. Save chunks to DB (without embeddings initially)
            const chunkIds = this.vectorStore.saveChunks(indexedChunks);
            this.chunkCounter += indexedChunks.length;

            console.log(`[LiveRAGIndexer] Saved ${indexedChunks.length} chunks (${this.chunkCounter} total) for meeting ${meetingId}`);

            // 5. Embed each chunk (fire-and-forget per chunk, but sequential to avoid rate limits)
            if (this.embeddingPipeline.isReady()) {
                let embeddedCount = 0;
                for (let i = 0; i < chunkIds.length; i++) {
                    try {
                        const embedding = await this.embeddingPipeline.getEmbedding(indexedChunks[i].text);
                        this.vectorStore.storeEmbedding(chunkIds[i], embedding);
                        embeddedCount++;
                    } catch (err) {
                        console.warn(`[LiveRAGIndexer] Failed to embed chunk ${chunkIds[i]}:`, err);
                        // Continue with remaining chunks — partial indexing is better than none
                    }
                }
                this.indexedChunkCount += embeddedCount;
                console.log(`[LiveRAGIndexer] Embedded ${embeddedCount}/${chunkIds.length} chunks (${this.indexedChunkCount} total with embeddings)`);
            } else {
                console.log('[LiveRAGIndexer] Embedding pipeline not ready, chunks saved without embeddings');
            }

            // 6. Advance high-water mark
            this.indexedSegmentCount = this.allSegments.length;

        } catch (err) {
            console.error('[LiveRAGIndexer] Processing error:', err);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Stop live indexing.
     *
     * flush (default true): chunk + embed any remaining segments first — used
     * on pause, where the JIT chunks keep serving live chat after resume.
     * flush false: skip that final pass — used when the meeting ENDS, because
     * the provisional 'live-meeting-current' chunks are deleted right after
     * and the finished meeting is re-indexed in full, so the final embed was
     * pure wasted CPU/network at the busiest moment.
     * Either way, a tick already in flight is awaited, so nothing is written
     * for this meeting after stop() resolves.
     */
    async stop(options: { flush?: boolean } = {}): Promise<void> {
        if (!this.isActive) return;
        const flush = options.flush ?? true;

        console.log(`[LiveRAGIndexer] Stopping for meeting ${this.meetingId}${flush ? '' : ' (no final flush)'}`);

        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        if (this.inFlightTick) await this.inFlightTick.catch(() => { });
        // Final flush — process any remaining segments
        if (flush) await this.trackedTick();

        const meetingId = this.meetingId;
        this.isActive = false;
        this.meetingId = null;
        this.allSegments = [];
        this.indexedSegmentCount = 0;
        this.chunkCounter = 0;
        this.indexedChunkCount = 0;

        console.log(`[LiveRAGIndexer] Stopped for meeting ${meetingId}`);
    }

    /**
     * Check if there are any queryable JIT chunks for the current meeting.
     */
    hasIndexedChunks(): boolean {
        return this.indexedChunkCount > 0;
    }

    /**
     * Get the number of chunks with embeddings (queryable).
     */
    getIndexedChunkCount(): number {
        return this.indexedChunkCount;
    }

    /**
     * Get the meeting ID currently being indexed.
     */
    getActiveMeetingId(): string | null {
        return this.meetingId;
    }

    /**
     * Check if actively indexing.
     */
    isRunning(): boolean {
        return this.isActive;
    }
}