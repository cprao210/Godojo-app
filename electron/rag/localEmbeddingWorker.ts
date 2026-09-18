// electron/rag/localEmbeddingWorker.ts
// Worker thread for the bundled local embedding model (@xenova/transformers).
// Its WASM backend (onnxruntime-web — onnxruntime-node is disabled for this
// package) runs inference synchronously on the calling JS thread with no
// native thread pool, so running it on the Electron main thread stalls the
// whole app (IPC, window responsiveness) on every embed call. LiveRAGIndexer
// calls this on a 30s tick for the full duration of every meeting when the
// local model is in use, so it's offloaded here — mirrors the pattern
// already used by vectorSearchWorker.ts for JS-fallback vector search.

import { parentPort, workerData } from 'worker_threads';

const DIMENSIONS = 384; // all-MiniLM-L6-v2

interface LoadMessage { type: 'load'; requestId: number }
interface EmbedMessage { type: 'embed'; requestId: number; text: string }
interface EmbedBatchMessage { type: 'embedBatch'; requestId: number; texts: string[] }
type WorkerMessage = LoadMessage | EmbedMessage | EmbedBatchMessage;

if (!parentPort) {
  throw new Error('localEmbeddingWorker must be run as a worker_threads Worker');
}

let pipe: any = null;
let loadingPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (pipe) return;

  // If another message already kicked off loading, wait for that same
  // promise rather than launching a second concurrent pipeline() call.
  if (loadingPromise) {
    await loadingPromise;
    return;
  }

  loadingPromise = (async () => {
    // Use new Function() to force a true ESM dynamic import at runtime — see
    // the identical comment in the pre-worker LocalEmbeddingProvider for why
    // a plain await import() gets rewritten to require() under module:commonjs.
    const { pipeline, env } = await (new Function('return import("@xenova/transformers")')()) as typeof import('@xenova/transformers');

    env.allowRemoteModels = false;
    env.localModelPath = (workerData as { modelPath: string }).modelPath;

    pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      local_files_only: true,
    });
  })();

  try {
    await loadingPromise;
  } catch (e) {
    // Reset so a future message can retry
    loadingPromise = null;
    throw e;
  }
}

parentPort.on('message', async (message: WorkerMessage) => {
  try {
    switch (message.type) {
      case 'load': {
        await ensureLoaded();
        parentPort!.postMessage({ type: 'result', requestId: message.requestId, data: true });
        break;
      }

      case 'embed': {
        await ensureLoaded();
        const output = await pipe(message.text, { pooling: 'mean', normalize: true });
        parentPort!.postMessage({
          type: 'result',
          requestId: message.requestId,
          data: Array.from(output.data as Float32Array),
        });
        break;
      }

      case 'embedBatch': {
        await ensureLoaded();
        // transformers.js handles batching internally
        const output = await pipe(message.texts, { pooling: 'mean', normalize: true });
        const batchSize = message.texts.length;
        const result: number[][] = [];
        for (let i = 0; i < batchSize; i++) {
          result.push(Array.from(output.data.slice(i * DIMENSIONS, (i + 1) * DIMENSIONS)));
        }
        parentPort!.postMessage({ type: 'result', requestId: message.requestId, data: result });
        break;
      }

      default:
        parentPort!.postMessage({
          type: 'error',
          requestId: (message as any).requestId,
          error: `Unknown message type: ${(message as any).type}`,
        });
    }
  } catch (error: any) {
    parentPort!.postMessage({
      type: 'error',
      requestId: (message as any).requestId,
      error: error.message,
    });
  }
});
