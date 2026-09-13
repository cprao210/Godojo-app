import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable native-layer state the mocked module reads. Declared before vi.mock so
// the factory closes over it (vi.mock is hoisted above imports). AudioDevices
// destructures the native accessors at module load, so the factory has to hand
// back stable functions that read this object lazily.
const state = {
    inputs: [] as { id: string; name: string }[],
    outputs: [] as { id: string; name: string }[],
    route: null as { kind: string; transport: string; name: string } | null,
    /** When set, every native accessor throws this. */
    nativeError: null as Error | null,
};

vi.mock('../audio/nativeModuleLoader', () => ({
    loadNativeModule: () => ({
        getInputDevices() {
            if (state.nativeError) throw state.nativeError;
            return state.inputs;
        },
        getOutputDevices() {
            if (state.nativeError) throw state.nativeError;
            return state.outputs;
        },
        getOutputRoute() {
            if (state.nativeError) throw state.nativeError;
            return state.route;
        },
    }),
}));

import { AudioDevices } from '../audio/AudioDevices';

// list_input_devices() synthesizes the `default` entry with the resolved name
// embedded — this is the exact shape the native module emits.
const BUILTIN_MIC = { id: 'default', name: 'Default Microphone (MacBook Air Microphone)' };
const EXTERNAL_MIC = { id: 'default', name: 'Default Microphone (Jabra Evolve 65)' };
const BUILTIN_SPEAKERS = { kind: 'speakers', transport: 'built-in', name: 'MacBook Air Speakers' };
const AIRPODS = { kind: 'headphones', transport: 'bluetooth', name: 'AirPods Pro' };

const realPlatform = process.platform;
function setPlatform(platform: string) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
    setPlatform('darwin');
    state.inputs = [BUILTIN_MIC];
    state.outputs = [];
    state.route = BUILTIN_SPEAKERS;
    state.nativeError = null;
    // isBuiltinOnly narrates every decision; keep the suite output readable.
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });
});

afterEach(() => {
    setPlatform(realPlatform);
    vi.restoreAllMocks();
});

describe('AudioDevices.isBuiltinOnly — active-device resolution', () => {
    it('is true when both active devices are built-in', () => {
        expect(AudioDevices.isBuiltinOnly(undefined, undefined)).toBe(true);
    });

    it('stays true when unrelated external devices are merely attached', () => {
        // THE REGRESSION. A MacBook Air running on its own mic and speakers with
        // a monitor and a virtual device attached. The old existence-based check
        // returned false here, which kept the RMS+VAD gate on and discarded ~75%
        // of the user's frames (mic RMS 29-341 vs an adaptive threshold of
        // 227-268) — the mic transcript was empty for the whole meeting.
        state.inputs = [BUILTIN_MIC, { id: 'BlackHole 2ch', name: 'BlackHole 2ch' }];
        state.outputs = [
            { id: 'D1918H', name: 'D1918H' },
            { id: 'BlackHole 2ch', name: 'BlackHole 2ch' },
        ];
        expect(AudioDevices.isBuiltinOnly(undefined, undefined)).toBe(true);
    });

    it("ignores the 'sck' backend sentinel in the output slot", () => {
        // The meeting path sends outputDeviceId:'sck' to force the
        // ScreenCaptureKit capture backend. It is not a device selection, and
        // the old code treated it as one — so every SCK meeting kept VAD active
        // regardless of the hardware actually in use.
        expect(AudioDevices.isBuiltinOnly(undefined, 'sck')).toBe(true);
    });

    it('is false when the active input is external', () => {
        state.inputs = [EXTERNAL_MIC];
        expect(AudioDevices.isBuiltinOnly(undefined, undefined)).toBe(false);
    });

    it('is false when headphones are the active output', () => {
        // Headphones have no acoustic path back to the mic, so macOS is not
        // attenuating it and the local gate has nothing to fight.
        state.route = AIRPODS;
        expect(AudioDevices.isBuiltinOnly(undefined, undefined)).toBe(false);
    });

    it('resolves an explicitly selected device by name rather than assuming external', () => {
        state.inputs = [BUILTIN_MIC, { id: 'MacBook Air Microphone', name: 'MacBook Air Microphone' }];
        expect(AudioDevices.isBuiltinOnly('MacBook Air Microphone', undefined)).toBe(true);

        state.outputs = [{ id: 'Studio Display Speakers', name: 'Studio Display Speakers' }];
        expect(AudioDevices.isBuiltinOnly('MacBook Air Microphone', 'Studio Display Speakers')).toBe(false);
    });

    it('is false when an explicitly selected device does not resolve', () => {
        expect(AudioDevices.isBuiltinOnly('Some Unplugged Headset', undefined)).toBe(false);
    });

    it('is false when the output route is unavailable', () => {
        state.route = null;
        expect(AudioDevices.isBuiltinOnly(undefined, undefined)).toBe(false);
    });

    it('fails safe to false when the native layer throws', () => {
        state.nativeError = new Error('native module exploded');
        expect(AudioDevices.isBuiltinOnly(undefined, undefined)).toBe(false);
    });

    it('is false on every non-darwin platform', () => {
        // BUILTIN_PATTERNS matches real external Windows device names
        // ("Internal Microphone"), so the heuristic is darwin-only.
        setPlatform('win32');
        expect(AudioDevices.isBuiltinOnly(undefined, undefined)).toBe(false);
    });
});
