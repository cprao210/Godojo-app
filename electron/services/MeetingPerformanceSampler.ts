/**
 * MeetingPerformanceSampler.ts
 *
 * Lightweight FIELD diagnostics for in-call performance: every 60 seconds
 * while a meeting is active, sample `app.getAppMetrics()` and write a
 * one-line summary to natively_debug.log (via the intercepted console —
 * main.ts pipes console.log into that file with rotation). Every 5th sample
 * (≈5 min) also goes to PostHog as a sampled `perf_sample` event.
 *
 * WHY: the low-end-Windows investigation had to be done from screenshots of
 * Task Manager. These lines let future customer machines be diagnosed from
 * the debug log alone — per-process CPU/memory, hardware class, and the
 * Performance Mode decision all in one place.
 *
 * PRIVACY: app metrics are numeric/enum process data only — no meeting
 * content, transcript text, user questions, document contents, or audio is
 * ever touched here, by construction.
 */

import { app } from 'electron';
import { posthogMain } from './PostHogMainService';
import { classifyPerformanceMode } from '../../utils/performanceClassification';
import * as os from 'os';

/** One aggregated sample, derived purely from Electron's ProcessMetric[]. */
export interface PerfSampleSummary {
    processCount: number;
    /** Sum of per-process percentCPU (Electron reports % since last call). */
    cpuTotal: number;
    /** Sum of workingSetSize across processes, MB. */
    memTotalMb: number;
    /** Per-process-type rollup, e.g. { Renderer: {cpu: 12.1, memMb: 210.3} }. */
    byType: Record<string, { cpu: number; memMb: number; count: number }>;
    /** Top 3 processes by CPU — "pid:type cpu% memMB" strings for the log. */
    top: string[];
}

/** Pure — unit-testable without Electron. */
export function summarizeProcessMetrics(metrics: {
    pid: number;
    type: string;
    cpu: { percentCPU?: number } | undefined;
    memory: { workingSetSize?: number } | undefined;
}[]): PerfSampleSummary {
    const byType: PerfSampleSummary['byType'] = {};
    let cpuTotal = 0;
    let memBytes = 0;
    const rows: { pid: number; type: string; cpu: number; memMb: number }[] = [];

    for (const m of metrics) {
        const cpu = Number.isFinite(m.cpu?.percentCPU) ? (m.cpu!.percentCPU as number) : 0;
        const memMb = Number.isFinite(m.memory?.workingSetSize)
            ? Math.round(((m.memory!.workingSetSize as number) / (1024 * 1024)) * 10) / 10
            : 0;
        cpuTotal += cpu;
        memBytes += memMb;
        const t = (byType[m.type] ??= { cpu: 0, memMb: 0, count: 0 });
        t.cpu = Math.round((t.cpu + cpu) * 10) / 10;
        t.memMb = Math.round((t.memMb + memMb) * 10) / 10;
        t.count += 1;
        rows.push({ pid: m.pid, type: m.type, cpu: Math.round(cpu * 10) / 10, memMb });
    }

    rows.sort((a, b) => b.cpu - a.cpu);
    return {
        processCount: metrics.length,
        cpuTotal: Math.round(cpuTotal * 10) / 10,
        memTotalMb: Math.round(memBytes * 10) / 10,
        byType,
        top: rows.slice(0, 3).map(r => `${r.pid}:${r.type} ${r.cpu}% ${r.memMb}MB`),
    };
}

class MeetingPerformanceSampler {
    private timer: ReturnType<typeof setInterval> | null = null;
    private tickCount = 0;
    private startedAt = 0;

    /** Hardware/perf-mode facts computed once — same rules as the renderer's
     *  auto-detection (utils/performanceClassification.ts). */
    private readonly classification = classifyPerformanceMode({
        cpuThreads: os.cpus()?.length || null,
        totalRamGB: os.totalmem() > 0 ? Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10 : null,
        gpuVendorId: null, // vendor arrives async via getGPUInfo; the summary line carries threads+RAM
        isSoftwareRendering: false,
    });

    start(): void {
        if (this.timer) return; // already sampling
        this.tickCount = 0;
        this.startedAt = Date.now();
        const tick = () => this.sample();
        tick(); // baseline immediately, then every 60s
        this.timer = setInterval(tick, 60_000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private sample(): void {
        try {
            this.tickCount += 1;
            const summary = summarizeProcessMetrics(app.getAppMetrics() as any);
            const elapsedMin = Math.round((Date.now() - this.startedAt) / 60000);
            const typeLine = Object.entries(summary.byType)
                .map(([type, v]) => `${type}×${v.count} ${v.cpu}%/${v.memMb}MB`)
                .join(' · ');
            // console.log is intercepted into natively_debug.log by main.ts.
            console.log(
                `[PERF-SAMPLE] t+${elapsedMin}min meeting: total ${summary.cpuTotal}% CPU / ${summary.memTotalMb} MB / ${summary.processCount} processes` +
                ` | ${typeLine}` +
                ` | top: ${summary.top.join(', ')}` +
                ` | perfMode(auto)=${this.classification.autoPerformanceMode ? 'on' : 'off'}` +
                (this.classification.reason ? ` (${this.classification.reason})` : '') +
                ` [${process.platform}/${os.release()}, ${this.classification.summary}]`,
            );

            // Sampled PostHog upload: every 5th minute of the call, not every
            // tick — enough to see the steady state without flooding quotas.
            // Numeric/enum fields only.
            if (this.tickCount % 5 === 0) {
                posthogMain.capture('perf_sample', {
                    elapsedMin,
                    cpuTotal: summary.cpuTotal,
                    memTotalMb: summary.memTotalMb,
                    processCount: summary.processCount,
                    byType: summary.byType,
                    perfModeAuto: this.classification.autoPerformanceMode,
                    perfModeReason: this.classification.reason,
                    platform: process.platform,
                    osRelease: os.release(),
                    hardware: this.classification.summary,
                });
            }
        } catch (err) {
            // Diagnostics must never disturb the call.
            console.warn('[PERF-SAMPLE] sample failed:', err);
        }
    }
}

export const meetingPerformanceSampler = new MeetingPerformanceSampler();
