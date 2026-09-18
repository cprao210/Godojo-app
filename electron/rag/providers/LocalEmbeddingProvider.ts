import path from 'path';
import { app } from 'electron';
import { Worker } from 'worker_threads';
import { IEmbeddingProvider } from './IEmbeddingProvider';

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LocalEmbeddingProvider implements IEmbeddingProvider {
  readonly name = 'local';
  readonly dimensions = 384; // all-MiniLM-L6-v2

  private modelPath: string;

  // Inference runs in a worker thread (WASM backend blocks its own thread
  // with no native thread pool — keeping it off the main thread avoids
  // stalling IPC/window responsiveness on every embed call).
  //
  // The worker and its request map are class-level (shared by every
  // instance), NOT per-instance: EmbeddingPipeline always eagerly constructs
  // its own LocalEmbeddingProvider as a standing fallback, and
  // EmbeddingProviderResolver separately constructs its own as the
  // last-resort candidate — so two instances routinely exist per pipeline
  // init. A per-instance worker would leak an orphaned, never-terminated
  // thread every time the discarded instance's worker was never referenced
  // again. Sharing also means the model only ever loads once, not twice.
  private static worker: Worker | null = null;
  private static requestId = 0;
  private static pendingRequests = new Map<number, PendingRequest>();
  private static readonly WORKER_TIMEOUT_MS = 30_000;

  constructor() {
    // Point to the bundled model inside the app's resources.
    // In dev: __dirname = dist-electron/electron/rag/providers → need 4 levels up to project root.
    // In prod: app.isPackaged = true → use process.resourcesPath (electron-builder extraResources).
    this.modelPath = path.join(
      app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../../resources'),
      'models'
    );
  }

  async isAvailable(): Promise<boolean> {
    // Local model is ALWAYS available after install — this is the guarantee
    try {
      await this.postToWorker({ type: 'load' });
      return true;
    } catch (e) {
      console.error('[LocalEmbeddingProvider] Model failed to load:', e);
      return false;
    }
  }

  private getWorker(): Worker {
    if (!LocalEmbeddingProvider.worker) {
      const workerPath = path.join(__dirname, '..', 'localEmbeddingWorker.js');
      const worker = new Worker(workerPath, { workerData: { modelPath: this.modelPath } });
      LocalEmbeddingProvider.worker = worker;

      worker.on('message', (msg: { type: string; requestId: number; data?: any; error?: string }) => {
        const pending = LocalEmbeddingProvider.pendingRequests.get(msg.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        LocalEmbeddingProvider.pendingRequests.delete(msg.requestId);

        if (msg.type === 'error') {
          pending.reject(new Error(msg.error || 'Worker error'));
        } else {
          pending.resolve(msg.data);
        }
      });

      worker.on('error', (err) => {
        console.error('[LocalEmbeddingProvider] Worker error:', err);
        LocalEmbeddingProvider.rejectAllPending(err);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          console.warn(`[LocalEmbeddingProvider] Worker exited with code ${code}`);
        }
        LocalEmbeddingProvider.worker = null;
        LocalEmbeddingProvider.rejectAllPending(new Error(`Worker exited with code ${code}`));
      });
    }
    return LocalEmbeddingProvider.worker;
  }

  private static rejectAllPending(err: Error): void {
    for (const [id, pending] of LocalEmbeddingProvider.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    LocalEmbeddingProvider.pendingRequests.clear();
  }

  private postToWorker<T>(message: any): Promise<T> {
    LocalEmbeddingProvider.requestId = (LocalEmbeddingProvider.requestId + 1) % Number.MAX_SAFE_INTEGER;
    const id = LocalEmbeddingProvider.requestId;
    message.requestId = id;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        LocalEmbeddingProvider.pendingRequests.delete(id);
        reject(new Error(`[LocalEmbeddingProvider] Worker request ${id} timed out after ${LocalEmbeddingProvider.WORKER_TIMEOUT_MS}ms`));
      }, LocalEmbeddingProvider.WORKER_TIMEOUT_MS);

      LocalEmbeddingProvider.pendingRequests.set(id, { resolve, reject, timer });
      this.getWorker().postMessage(message);
    });
  }

  async embed(text: string): Promise<number[]> {
    return this.postToWorker({ type: 'embed', text });
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text); // all-MiniLM-L6-v2 is symmetric
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.postToWorker({ type: 'embedBatch', texts });
  }
}
