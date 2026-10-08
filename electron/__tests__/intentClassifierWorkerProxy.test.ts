import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// A fake worker_threads Worker whose behaviour each test controls.
type Mode = 'ok' | 'slow-load' | 'fail-load';
let mode: Mode = 'ok';
let instances: FakeWorker[] = [];

class FakeWorker extends EventEmitter {
    terminated = false;
    constructor(public file: string, public opts: any) {
        super();
        instances.push(this);
    }
    postMessage(msg: any) {
        const reply = (data: any, type = 'result') =>
            setTimeout(() => this.emit('message', { type, requestId: msg.requestId, data, error: type === 'error' ? 'boom' : undefined }), 0);
        if (msg.type === 'load') {
            if (mode === 'fail-load') return reply(null, 'error');
            if (mode === 'slow-load') return setTimeout(() => this.emit('message', { type: 'result', requestId: msg.requestId, data: true }), 60_000);
            return reply(true);
        }
        if (msg.type === 'classify') {
            return reply({ labels: ['asking for clarification or explanation', 'general conversation or question'], scores: [0.8, 0.2] });
        }
    }
    terminate() { this.terminated = true; return Promise.resolve(0); }
}

vi.mock('worker_threads', () => ({ Worker: FakeWorker }));
vi.mock('electron', () => ({ app: { isPackaged: true } }));

async function freshModule() {
    vi.resetModules();
    return await import('../llm/IntentClassifier');
}

describe('IntentClassifier worker proxy', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mode = 'ok';
        instances = [];
        (process as any).resourcesPath = 'C:/fake/resources';
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('classifies through the worker when regex does not match', async () => {
        const { classifyIntent } = await freshModule();
        const p = classifyIntent('hmm how would the onboarding look for our team', '', 0);
        await vi.runAllTimersAsync();
        const r = await p;
        expect(r.intent).toBe('clarification');
        expect(r.confidence).toBeCloseTo(0.8);
        expect(instances).toHaveLength(1);
        expect(instances[0].file).toMatch(/intentClassifierWorker\.js$/);
        expect(instances[0].opts.workerData.localOnly).toBe(true);
    });

    it('regex fast-path never touches the worker', async () => {
        const { classifyIntent } = await freshModule();
        const r = await classifyIntent('can you explain that part again', '', 0);
        expect(r.intent).toBe('clarification');
        expect(instances).toHaveLength(0);
    });

    it('while the model is still loading, falls back to the context heuristic after a bounded wait', async () => {
        mode = 'slow-load';
        const { classifyIntent } = await freshModule();
        const p = classifyIntent('hmm how would the onboarding look for our team', '', 0);
        await vi.advanceTimersByTimeAsync(8_000);
        const r = await p;
        expect(r.intent).toBe('general'); // heuristic default
    });

    it('a failed load degrades to regex/heuristic only and terminates the worker', async () => {
        mode = 'fail-load';
        const { classifyIntent, warmupIntentClassifier } = await freshModule();
        const w = warmupIntentClassifier();
        await vi.runAllTimersAsync();
        await expect(w).resolves.toBeUndefined(); // never rejects
        expect(instances[0].terminated).toBe(true);
        const r = await classifyIntent('hmm how would the onboarding look for our team', '', 0);
        expect(r.intent).toBe('general');
        expect(instances).toHaveLength(1); // no respawn after a load failure
    });

    it('warmup is idempotent (one load request)', async () => {
        const { warmupIntentClassifier } = await freshModule();
        const spy = vi.spyOn(FakeWorker.prototype, 'postMessage');
        const a = warmupIntentClassifier();
        const b = warmupIntentClassifier();
        await vi.runAllTimersAsync();
        await Promise.all([a, b]);
        expect(spy.mock.calls.filter(([m]) => (m as any).type === 'load')).toHaveLength(1);
    });
});
