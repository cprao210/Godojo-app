import { describe, expect, it } from 'vitest';

import {
    INTEL_GPU_VENDOR_ID,
    classifyPerformanceMode,
    type HardwareSnapshot,
} from '../../utils/performanceClassification';

const hw = (over: Partial<HardwareSnapshot> = {}): HardwareSnapshot => ({
    cpuThreads: 8,
    totalRamGB: 16,
    gpuVendorId: '0x10de', // NVIDIA by default — a capable machine
    isSoftwareRendering: false,
    ...over,
});

describe('classifyPerformanceMode', () => {
    it('Rule A: <=4 CPU threads → auto ON (the i3-10110U laptop: 2c/4t)', () => {
        const r = classifyPerformanceMode(hw({ cpuThreads: 4 }));
        expect(r.autoPerformanceMode).toBe(true);
        expect(r.reason).toContain('4 CPU threads');
    });

    it('>4 CPU threads alone → auto OFF', () => {
        expect(classifyPerformanceMode(hw({ cpuThreads: 6 })).autoPerformanceMode).toBe(false);
    });

    it('Rule B: Intel GPU + <=8 GB RAM → auto ON (Intel UHD + 8 GB)', () => {
        const r = classifyPerformanceMode(hw({ cpuThreads: 8, totalRamGB: 8, gpuVendorId: INTEL_GPU_VENDOR_ID }));
        expect(r.autoPerformanceMode).toBe(true);
        expect(r.reason).toContain('Intel integrated GPU');
        expect(r.reason).toContain('8 GB');
    });

    it('Intel GPU + >8 GB RAM → auto OFF (capable iGPU desktop)', () => {
        const r = classifyPerformanceMode(hw({ cpuThreads: 12, totalRamGB: 16, gpuVendorId: INTEL_GPU_VENDOR_ID }));
        expect(r.autoPerformanceMode).toBe(false);
        expect(r.reason).toBeNull();
    });

    it('non-Intel GPU + <=8 GB RAM → auto OFF (RAM alone never triggers — protects 8 GB Macs)', () => {
        // Apple Silicon reports Apple's vendor id (0x106b), not Intel's —
        // even though the RAM would match, it must stay OFF.
        const r = classifyPerformanceMode(hw({ cpuThreads: 8, totalRamGB: 8, gpuVendorId: '0x106b' }));
        expect(r.autoPerformanceMode).toBe(false);
    });

    it('software rendering → auto ON even with strong hardware facts', () => {
        const r = classifyPerformanceMode(hw({ cpuThreads: 16, totalRamGB: 32, isSoftwareRendering: true }));
        expect(r.autoPerformanceMode).toBe(true);
        expect(r.reason).toContain('software rendering');
    });

    it('unknown facts never trigger — all-null hardware stays OFF (fail-safe)', () => {
        const r = classifyPerformanceMode({ cpuThreads: null, totalRamGB: null, gpuVendorId: null, isSoftwareRendering: false });
        expect(r.autoPerformanceMode).toBe(false);
        expect(r.reason).toBeNull();
    });

    it('vendor id matching is case-insensitive (0X8086)', () => {
        const r = classifyPerformanceMode(hw({ cpuThreads: 8, totalRamGB: 7.5, gpuVendorId: '0X8086' }));
        expect(r.autoPerformanceMode).toBe(true);
    });

    it('summary carries every known fact for logs/telemetry', () => {
        const r = classifyPerformanceMode(hw({ cpuThreads: 4, totalRamGB: 8, gpuVendorId: INTEL_GPU_VENDOR_ID }));
        expect(r.summary).toBe('4 threads, 8 GB RAM, GPU 0x8086');
    });
});

// The explicit user On/Off override living in usePerformanceMode (renderer)
// is behavioral: preference 'on' → true, 'off' → false, regardless of the
// classification above. Those two cases are pinned here at the pure level by
// asserting the classification never claims to BE the user's choice:
describe('classifyPerformanceMode contract with the user override', () => {
    it('never invents a reason when OFF — the settings UI can show "your choice" vs "auto" honestly', () => {
        const off = classifyPerformanceMode(hw());
        expect(off.autoPerformanceMode).toBe(false);
        expect(off.reason).toBeNull();
    });
});
