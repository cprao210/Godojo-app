/**
 * MeetingPerformanceSampler.ts
 *
 * Lightweight FIELD diagnostics, in two phases:
 *   - startup: a few samples in the first minutes after launch (15 s, 60 s,
 *     180 s) — every one goes to PostHog as `perf_sample` with phase
 *     'startup', because "slow to open" reports need launch-time numbers;
 *   - meeting: every 60 seconds while a meeting is active; every 5th sample
 *     (≈5 min) goes to PostHog as `perf_sample` with phase 'meeting'.
 * Each sample also writes a one-line summary to godojo_debug.log (via the
 * intercepted console — main.ts pipes console.log into that file with
 * rotation). Samples carry Chromium's GPU feature status, so field data can
 * tell hardware-accelerated drawing apart from a software-rendering fallback.
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
    /** Sum of per-process percentCPUUsage (Electron reports % since the last
     *  getAppMetrics() call by ANY caller, so interleaved callers shorten the
     *  window — prefer cpuSecTotal for phase comparisons). */
    cpuTotal: number;
    /** Sum of cumulativeCPUUsage — CPU seconds used since each process started. */
    cpuSecTotal: number;
    /** Sum of workingSetSize across processes, MB. */
    memTotalMb: number;
    /** Sum of privateBytes (Windows only; 0 elsewhere), MB. */
    privateTotalMb: number;
    /** Per-process-type rollup, e.g. { Tab: {cpu: 12.1, cpuSec: 40.2, memMb: 210.3, count: 2} }. */
    byType: Record<string, { cpu: number; cpuSec: number; memMb: number; count: number }>;
    /** Top 3 processes by CPU — "pid:type cpu% memMB" strings for the log. */
    top: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const finiteOr0 = (n: number | undefined) => (Number.isFinite(n) ? (n as number) : 0);
/** Electron's MemoryInfo fields are KILOBYTES (verified: workingSetSize ≈ rss / 1024). */
const kbToMb = (kb: number | undefined) => round1(finiteOr0(kb) / 1024);

/** Pure — unit-testable without Electron. */
export function summarizeProcessMetrics(metrics: {
    pid: number;
    type: string;
    cpu: { percentCPUUsage?: number; cumulativeCPUUsage?: number } | undefined;
    memory: { workingSetSize?: number; privateBytes?: number } | undefined;
}[]): PerfSampleSummary {
    const byType: PerfSampleSummary['byType'] = {};
    let cpuTotal = 0;
    let cpuSecTotal = 0;
    let memMbTotal = 0;
    let privateMbTotal = 0;
    const rows: { pid: number; type: string; cpu: number; memMb: number }[] = [];

    for (const m of metrics) {
        // percentCPUUsage can come back slightly negative on Windows; clamp.
        const cpu = Math.max(0, finiteOr0(m.cpu?.percentCPUUsage));
        const cpuSec = Math.max(0, finiteOr0(m.cpu?.cumulativeCPUUsage));
        const memMb = kbToMb(m.memory?.workingSetSize);
        cpuTotal += cpu;
        cpuSecTotal += cpuSec;
        memMbTotal += memMb;
        privateMbTotal += kbToMb(m.memory?.privateBytes);
        const t = (byType[m.type] ??= { cpu: 0, cpuSec: 0, memMb: 0, count: 0 });
        t.cpu = round1(t.cpu + cpu);
        t.cpuSec = round1(t.cpuSec + cpuSec);
        t.memMb = round1(t.memMb + memMb);
        t.count += 1;
        rows.push({ pid: m.pid, type: m.type, cpu: round1(cpu), memMb });
    }

    rows.sort((a, b) => b.cpu - a.cpu);
    return {
        processCount: metrics.length,
        cpuTotal: round1(cpuTotal),
        cpuSecTotal: round1(cpuSecTotal),
        memTotalMb: round1(memMbTotal),
        privateTotalMb: round1(privateMbTotal),
        byType,
        top: rows.slice(0, 3).map(r => `${r.pid}:${r.type} ${r.cpu}% ${r.memMb}MB`),
    };
}

/** GPU facts for a sample. `softwareRendering` mirrors the renderer's rule in
 *  the get-gpu-performance-status IPC handler. */
export interface GpuStatusSummary {
    gpuCompositing: string | null;
    rasterization: string | null;
    softwareRendering: boolean;
}

/** Pure — takes app.getGPUFeatureStatus() output. */
export function summarizeGpuStatus(status: Record<string, string> | null | undefined): GpuStatusSummary {
    const gpuCompositing = status?.gpu_compositing ?? null;
    const rasterization = status?.rasterization ?? null;
    const isSoftware = (v?: string | null) => !!v && /software|disabled|unavailable/i.test(v);
    return {
        gpuCompositing,
        rasterization,
        softwareRendering: isSoftware(gpuCompositing) || isSoftware(rasterization) || isSoftware(status?.['2d_canvas']),
    };
}

/** Seconds after launch at which startup samples are taken. */
export const STARTUP_SAMPLE_OFFSETS_SEC = [15, 60, 180];

class MeetingPerformanceSampler {
    private timer: ReturnType<typeof setInterval> | null = null;
    private tickCount = 0;
    private startedAt = 0;
    private startupScheduled = false;
    /** PCI vendor id ("0x8086" = Intel), fetched once — getGPUInfo is async. */
    private gpuVendorId: string | null = null;

    /** Starts the launch-time samples. Call once, after the first window is
     *  created; idempotent. Timers are unref'd so they never hold the app open. */
    startStartupSampling(): void {
        if (this.startupScheduled) return;
        this.startupScheduled = true;
        app.getGPUInfo('basic')
            .then((info: any) => { this.gpuVendorId = info?.vendorId || null; })
            .catch(() => { /* vendor unknown — classification degrades gracefully */ });
        const uptimeSec = process.uptime();
        for (const offset of STARTUP_SAMPLE_OFFSETS_SEC) {
            const delayMs = Math.max(0, (offset - uptimeSec) * 1000);
            setTimeout(() => this.sample('startup'), delayMs).unref?.();
        }
    }

    start(): void {
        if (this.timer) return; // already sampling
        this.tickCount = 0;
        this.startedAt = Date.now();
        const tick = () => this.sample('meeting');
        tick(); // baseline immediately, then every 60s
        this.timer = setInterval(tick, 60_000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private sample(phase: 'startup' | 'meeting'): void {
        try {
            if (phase === 'meeting') this.tickCount += 1;
            const summary = summarizeProcessMetrics(app.getAppMetrics() as any);
            const gpu = summarizeGpuStatus(app.getGPUFeatureStatus() as unknown as Record<string, string>);
            // Same rules as the renderer's auto-detection
            // (utils/performanceClassification.ts), now with the live GPU facts.
            const classification = classifyPerformanceMode({
                cpuThreads: os.cpus()?.length || null,
                totalRamGB: os.totalmem() > 0 ? Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10 : null,
                gpuVendorId: this.gpuVendorId,
                isSoftwareRendering: gpu.softwareRendering,
            });
            const sinceLaunchSec = Math.round(process.uptime());
            const elapsedMin = phase === 'meeting' ? Math.round((Date.now() - this.startedAt) / 60000) : null;
            const typeLine = Object.entries(summary.byType)
                .map(([type, v]) => `${type}×${v.count} ${v.cpu}%/${v.cpuSec}s/${v.memMb}MB`)
                .join(' · ');
            const when = phase === 'meeting' ? `t+${elapsedMin}min meeting` : `startup t+${sinceLaunchSec}s`;
            // console.log is intercepted into godojo_debug.log by main.ts.
            console.log(
                `[PERF-SAMPLE] ${when}: total ${summary.cpuTotal}% CPU / ${summary.cpuSecTotal}s CPU since start` +
                ` / ${summary.memTotalMb} MB (${summary.privateTotalMb} MB private) / ${summary.processCount} processes` +
                ` | ${typeLine}` +
                ` | top: ${summary.top.join(', ')}` +
                ` | gpu: compositing=${gpu.gpuCompositing ?? 'unknown'} raster=${gpu.rasterization ?? 'unknown'}` +
                `${gpu.softwareRendering ? ' (SOFTWARE RENDERING)' : ''} vendor=${this.gpuVendorId ?? 'unknown'}` +
                ` | perfMode(auto)=${classification.autoPerformanceMode ? 'on' : 'off'}` +
                (classification.reason ? ` (${classification.reason})` : '') +
                ` [${process.platform}/${os.release()}, ${classification.summary}]`,
            );

            // PostHog: every startup sample (only 3 per launch); during a
            // meeting every 5th minute, not every tick — enough to see the
            // steady state without flooding quotas. Numeric/enum fields only.
            if (phase === 'startup' || this.tickCount % 5 === 0) {
                posthogMain.capture('perf_sample', {
                    phase,
                    elapsedMin,
                    sinceLaunchSec,
                    cpuTotal: summary.cpuTotal,
                    cpuSecTotal: summary.cpuSecTotal,
                    memTotalMb: summary.memTotalMb,
                    privateTotalMb: summary.privateTotalMb,
                    processCount: summary.processCount,
                    byType: summary.byType,
                    gpuCompositing: gpu.gpuCompositing,
                    gpuRasterization: gpu.rasterization,
                    softwareRendering: gpu.softwareRendering,
                    gpuVendorId: this.gpuVendorId,
                    meetingActive: this.timer !== null,
                    perfModeAuto: classification.autoPerformanceMode,
                    perfModeReason: classification.reason,
                    platform: process.platform,
                    osRelease: os.release(),
                    hardware: classification.summary,
                });
            }
        } catch (err) {
            // Diagnostics must never disturb the app or the call.
            console.warn('[PERF-SAMPLE] sample failed:', err);
        }
    }
}

export const meetingPerformanceSampler = new MeetingPerformanceSampler();
