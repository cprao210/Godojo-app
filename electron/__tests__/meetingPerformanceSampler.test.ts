import { describe, expect, it, vi } from 'vitest';

// The service module imports `electron` (app) and the PostHog main client at
// the top level — neither exists under vitest's node environment. Only the
// PURE summarizer is under test here, so stub both module side effects.
vi.mock('electron', () => ({ app: { getAppMetrics: (): unknown[] => [] } }));
vi.mock('../services/PostHogMainService', () => ({ posthogMain: { capture: vi.fn() } }));

import { summarizeGpuStatus, summarizeProcessMetrics } from '../services/MeetingPerformanceSampler';

// Shape matches Electron's real ProcessMetric: `percentCPUUsage` /
// `cumulativeCPUUsage`, and memory in KILOBYTES (not bytes).
const proc = (pid: number, type: string, cpu: number, mb: number, cpuSec = 0, privateMb = 0) => ({
    pid,
    type,
    cpu: { percentCPUUsage: cpu, cumulativeCPUUsage: cpuSec },
    memory: { workingSetSize: mb * 1024, privateBytes: privateMb * 1024 },
});

describe('summarizeProcessMetrics', () => {
    it('aggregates CPU, memory, and process count across processes', () => {
        const s = summarizeProcessMetrics([
            proc(1, 'Browser', 2.5, 100),
            proc(2, 'GPU', 30, 200),
            proc(3, 'Renderer', 12.3, 150.4),
        ]);
        expect(s.processCount).toBe(3);
        expect(s.cpuTotal).toBeCloseTo(44.8, 1);
        expect(s.memTotalMb).toBeCloseTo(450.4, 1);
    });

    it('rolls up by process type with counts', () => {
        const s = summarizeProcessMetrics([
            proc(1, 'Renderer', 5, 80),
            proc(2, 'Renderer', 7, 90),
            proc(3, 'GPU', 9, 150),
        ]);
        expect(s.byType.Renderer).toEqual({ cpu: 12, cpuSec: 0, memMb: 170, count: 2 });
        expect(s.byType.GPU).toEqual({ cpu: 9, cpuSec: 0, memMb: 150, count: 1 });
    });

    it('top-3 lists the highest-CPU processes with pid:type cpu% memMB', () => {
        const s = summarizeProcessMetrics([
            proc(1, 'Browser', 1, 50),
            proc(2, 'GPU', 40, 200),
            proc(3, 'Renderer', 20, 100),
            proc(4, 'Utility', 0.5, 30),
        ]);
        expect(s.top).toHaveLength(3);
        expect(s.top[0]).toContain('2:GPU 40% 200MB');
        expect(s.top[1]).toContain('3:Renderer');
        expect(s.top.some(t => t.startsWith('4:'))).toBe(false);
    });

    it('tolerates missing cpu/memory fields (0, not NaN)', () => {
        const s = summarizeProcessMetrics([
            { pid: 9, type: 'Utility', cpu: undefined, memory: undefined },
        ]);
        expect(s.cpuTotal).toBe(0);
        expect(s.memTotalMb).toBe(0);
        expect(Number.isFinite(s.cpuTotal)).toBe(true);
    });

    it('reads Electron kilobyte memory and real field names (regression)', () => {
        // Values as Electron actually reports them: 95656 KB ≈ 93.4 MB.
        const s = summarizeProcessMetrics([
            { pid: 1, type: 'Browser', cpu: { percentCPUUsage: 6.9, cumulativeCPUUsage: 1.33 }, memory: { workingSetSize: 95656, privateBytes: 68336 } },
        ]);
        expect(s.cpuTotal).toBeCloseTo(6.9, 1);
        expect(s.cpuSecTotal).toBeCloseTo(1.3, 1);
        expect(s.memTotalMb).toBeCloseTo(93.4, 1);
        expect(s.privateTotalMb).toBeCloseTo(66.7, 1);
    });

    it('sums cumulative CPU seconds and clamps negative percentCPUUsage', () => {
        const s = summarizeProcessMetrics([
            proc(1, 'Browser', 3, 100, 7.2, 60),
            proc(2, 'GPU', -0.07, 120, 477, 90), // Windows can report tiny negatives
        ]);
        expect(s.cpuTotal).toBeCloseTo(3, 1);
        expect(s.byType.GPU.cpu).toBe(0);
        expect(s.cpuSecTotal).toBeCloseTo(484.2, 1);
        expect(s.byType.GPU.cpuSec).toBe(477);
        expect(s.privateTotalMb).toBe(150);
    });
});

describe('summarizeGpuStatus', () => {
    it('reports hardware acceleration as not software', () => {
        const g = summarizeGpuStatus({ gpu_compositing: 'enabled', rasterization: 'enabled', '2d_canvas': 'enabled' });
        expect(g).toEqual({ gpuCompositing: 'enabled', rasterization: 'enabled', softwareRendering: false });
    });

    it('flags a software-rendering fallback', () => {
        expect(summarizeGpuStatus({ gpu_compositing: 'disabled_software', rasterization: 'disabled_software' }).softwareRendering).toBe(true);
        expect(summarizeGpuStatus({ gpu_compositing: 'enabled', rasterization: 'unavailable_software' }).softwareRendering).toBe(true);
    });

    it('tolerates a missing status object', () => {
        expect(summarizeGpuStatus(null)).toEqual({ gpuCompositing: null, rasterization: null, softwareRendering: false });
    });
});
