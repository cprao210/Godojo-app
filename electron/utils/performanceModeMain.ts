// Main-process answer to "should CPU-heavy BACKGROUND work scale back right now?".
// Synchronous on purpose (no GPU probe) so call sites like meeting start stay simple.
//
//   'on' / 'off' -> the user's explicit choice, mirrored from the renderer via the
//                   'set-performance-mode-preference' IPC (see ipcHandlers.ts).
//   'auto'       -> weak-machine check: <= 8 GB RAM or <= 4 CPU threads (the same
//                   isLowEndMachine() signal already used to defer warmups), or a
//                   Chromium software-rendering fallback.
//
// Fails safe: any error resolves to false (full behaviour, no throttling).

import { app } from 'electron';
import * as os from 'os';
import { SettingsManager } from '../services/SettingsManager';
import { isLowEndMachine, readTotalRamGB } from '../../utils/performanceClassification';

export function isPerformanceModeActive(): boolean {
    try {
        const preference = SettingsManager.getInstance().get('performanceModePreference') ?? 'auto';
        if (preference === 'on') return true;
        if (preference === 'off') return false;

        const status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
        const isSoftware = (f?: string) => !!f && /software|disabled|unavailable/i.test(f);
        const softwareRendering =
            isSoftware(status.gpu_compositing) || isSoftware(status.rasterization) || isSoftware(status['2d_canvas']);

        return softwareRendering || isLowEndMachine({
            cpuThreads: os.cpus()?.length || null,
            totalRamGB: readTotalRamGB(os.totalmem()),
        });
    } catch {
        return false;
    }
}