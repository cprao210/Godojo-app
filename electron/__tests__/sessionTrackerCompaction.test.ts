import { describe, expect, it, vi } from 'vitest';
import { SessionTracker } from '../SessionTracker';

const seg = (i: number, speaker = i % 2 ? 'client' : 'user') => ({
    speaker, text: `line ${i}`, timestamp: 1_000 + i * 1_000, final: true,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('SessionTracker compaction keeps the saved transcript complete', () => {
    it('never drops lines from getFullTranscript on a long call', async () => {
        const t = new SessionTracker();
        t.setRecapLLM({ generate: vi.fn(async () => '- earlier bullets') } as any);
        const n = SessionTracker.COMPACT_THRESHOLD + SessionTracker.COMPACT_BATCH * 2 + 50;
        for (let i = 0; i < n; i++) {
            t.addTranscript(seg(i));
            await settle();
        }
        const saved = t.getFullTranscript();
        expect(saved).toHaveLength(n);                       // was: n minus 500 per compaction
        expect(saved[0].text).toBe('line 0');
        expect(saved[n - 1].text).toBe(`line ${n - 1}`);
    });

    it('still bounds the LLM context and prepends the epoch summaries', async () => {
        const t = new SessionTracker();
        t.setRecapLLM({ generate: vi.fn(async () => '- earlier bullets') } as any);
        const n = SessionTracker.COMPACT_THRESHOLD + 10;
        for (let i = 0; i < n; i++) {
            t.addTranscript(seg(i));
            await settle();
        }
        const ctx = t.getFullSessionContext();
        expect(ctx).toContain('[SESSION HISTORY - EARLIER DISCUSSION]');
        expect(ctx).toContain('- earlier bullets');
        expect(ctx).not.toContain(']: line 0\n');             // summarised, not re-sent
        expect(ctx).toContain(`line ${n - 1}`);
        const recent = ctx.split('[RECENT TRANSCRIPT]\n')[1].split('\n');
        expect(recent).toHaveLength(n - SessionTracker.COMPACT_BATCH);
    });

    it('a reset during a pending summary does not touch the next session', async () => {
        let release: (v: string) => void = () => {};
        const t = new SessionTracker();
        t.setRecapLLM({ generate: vi.fn(() => new Promise<string>((r) => { release = r; })) } as any);
        for (let i = 0; i <= SessionTracker.COMPACT_THRESHOLD; i++) t.addTranscript(seg(i));
        t.reset();
        t.addTranscript(seg(0));
        release('- stale summary');
        await settle();
        expect(t.getFullTranscript()).toHaveLength(1);
        expect(t.getFullSessionContext()).not.toContain('stale summary');
        expect(t.getFullSessionContext()).toContain('line 0');
    });
});
