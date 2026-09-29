/**
 * performanceClassification.ts
 *
 * PURE hardware classification for automatic Performance Mode — no Electron
 * imports, fully unit-testable, shared by the main process (which gathers
 * the hardware facts) and anything that needs to re-derive the decision.
 *
 * Rules (first match wins for the reason; RAM alone NEVER triggers):
 *   1. Chromium software-rendering fallback        → auto ON
 *   2. CPU thread count <= 4                       → auto ON  (2c/4t-class laptops)
 *   3. Intel integrated GPU (vendor 0x8086) AND
 *      total RAM <= 8 GB                           → auto ON  (weak-but-functional iGPU)
 *   otherwise                                      → auto OFF
 *
 * Unknown facts (null) never trigger a rule — fail-safe means full visual
 * fidelity, never silently degrading a capable machine.
 */

export interface HardwareSnapshot {
    /** Logical CPU cores (os.cpus().length). null = unknown. */
    cpuThreads: number | null;
    /** Total system RAM in GB, rounded to 1 decimal. null = unknown. */
    totalRamGB: number | null;
    /** PCI vendor id of the active GPU, e.g. "0x8086" (Intel). null = unknown. */
    gpuVendorId: string | null;
    /** Chromium fell back to software compositing/rasterization. */
    isSoftwareRendering: boolean;
}

export interface PerformanceClassification {
    /** Whether 'auto' preference should resolve to Performance Mode ON. */
    autoPerformanceMode: boolean;
    /** Why it turned on — null when OFF (never fabricate a reason). */
    reason: string | null;
    /** Human-readable facts line for logs/telemetry, e.g. "4 threads, 8 GB RAM, GPU 0x8086". */
    summary: string;
}

/** Intel's PCI vendor id — the integrated-graphics signal. */
export const INTEL_GPU_VENDOR_ID = '0x8086';

const WEAK_CPU_THREADS = 4;
const WEAK_IGPU_RAM_GB = 8;

/** RAM-only threshold for MEMORY-lifecycle behavior (window pre-creation,
 *  destroy-on-close). Deliberately independent of Performance Mode: RAM
 *  alone never triggers the reduced VISUAL mode (an 8 GB Apple Silicon Mac
 *  keeps full fidelity), but it is a valid signal for "don't keep spare
 *  renderer processes alive" — each hidden window costs real memory. */
const LOW_MEMORY_RAM_GB = 8;

export function isLowMemoryMachine(totalRamGB: number | null): boolean {
    return totalRamGB != null && totalRamGB <= LOW_MEMORY_RAM_GB;
}

export function readTotalRamGB(totalMemBytes: number): number | null {
    return totalMemBytes > 0 ? Math.round((totalMemBytes / (1024 ** 3)) * 10) / 10 : null;
}

/** SYNC, GPU-probe-free "is this a weak machine" check for deferring heavy background work */
export function isLowEndMachine(hw: Pick<HardwareSnapshot, 'cpuThreads' | 'totalRamGB'>): boolean {
    return isLowMemoryMachine(hw.totalRamGB)
        || (hw.cpuThreads != null && hw.cpuThreads <= WEAK_CPU_THREADS);
}

export function classifyPerformanceMode(hw: HardwareSnapshot): PerformanceClassification {
    // Facts line — every known value participates, so logs/telemetry carry
    // the full picture even when the decision is OFF.
    const facts: string[] = [];
    if (hw.cpuThreads != null) facts.push(`${hw.cpuThreads} threads`);
    if (hw.totalRamGB != null) facts.push(`${hw.totalRamGB} GB RAM`);
    if (hw.gpuVendorId) facts.push(`GPU ${hw.gpuVendorId}`);
    const summary = facts.join(', ');

    if (hw.isSoftwareRendering) {
        return { autoPerformanceMode: true, reason: 'Chromium software rendering fallback', summary };
    }
    if (hw.cpuThreads != null && hw.cpuThreads <= WEAK_CPU_THREADS) {
        return { autoPerformanceMode: true, reason: `${hw.cpuThreads} CPU threads (<= ${WEAK_CPU_THREADS})`, summary };
    }
    const isIntelGpu = !!hw.gpuVendorId && hw.gpuVendorId.toLowerCase() === INTEL_GPU_VENDOR_ID;
    if (isIntelGpu && hw.totalRamGB != null && hw.totalRamGB <= WEAK_IGPU_RAM_GB) {
        return { autoPerformanceMode: true, reason: `Intel integrated GPU + ${hw.totalRamGB} GB RAM`, summary };
    }
    return { autoPerformanceMode: false, reason: null, summary };
}
