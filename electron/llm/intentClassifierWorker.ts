// electron/llm/intentClassifierWorker.ts
// Worker thread for the zero-shot intent classifier (Xenova/mobilebert-uncased-mnli
// via @xenova/transformers).
//
// WHY a worker: in Node, transformers.js runs on onnxruntime-node, whose model
// load (session creation) and inference run synchronously on the calling JS
// thread. On the Electron main thread that froze every window, IPC, and the
// audio/transcript pipeline while the ~27 MB model loaded — and on low-end
// machines that load was deliberately moved to meeting start, the busiest
// moment of the call. Same pattern as rag/localEmbeddingWorker.ts.
//
// Messages: { type: 'load' } → true; { type: 'classify', text, labels } →
// { labels: string[], scores: number[] } (transformers' zero-shot output).

import { parentPort, workerData } from 'worker_threads';

interface IntentWorkerData {
    /** true in packaged builds: bundled model only, no network. */
    localOnly: boolean;
    /** Packaged: resources/models. */
    localModelPath: string;
    /** Dev: HuggingFace download cache dir. */
    cacheDir: string;
}

interface LoadMessage { type: 'load'; requestId: number }
interface ClassifyMessage { type: 'classify'; requestId: number; text: string; labels: string[] }
type WorkerMessage = LoadMessage | ClassifyMessage;

if (!parentPort) {
    throw new Error('intentClassifierWorker must be run as a worker_threads Worker');
}

let pipe: any = null;
let loadingPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
    if (pipe) return;
    if (loadingPromise) {
        await loadingPromise;
        return;
    }

    loadingPromise = (async () => {
        // Force a true ESM dynamic import (a plain import() is rewritten to
        // require() under module:commonjs) — same as the pre-worker code.
        const { pipeline, env } = await (new Function("return import('@xenova/transformers')")()) as typeof import('@xenova/transformers');
        const cfg = workerData as IntentWorkerData;

        // In production, use bundled model. In dev, allow remote download.
        if (cfg.localOnly) {
            env.allowRemoteModels = false;
            env.localModelPath = cfg.localModelPath;
        } else {
            env.allowRemoteModels = true;
            env.cacheDir = cfg.cacheDir;
        }

        pipe = await pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli', {
            local_files_only: cfg.localOnly,
        });
    })();

    try {
        await loadingPromise;
    } catch (e) {
        loadingPromise = null; // let a later message retry
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
            case 'classify': {
                await ensureLoaded();
                const result = await pipe(message.text, message.labels, { multi_label: false });
                parentPort!.postMessage({
                    type: 'result',
                    requestId: message.requestId,
                    data: { labels: Array.from(result.labels), scores: Array.from(result.scores) },
                });
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
            error: error?.message ?? String(error),
        });
    }
});
