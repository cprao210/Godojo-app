import { loadNativeModule } from './nativeModuleLoader';

// NativeModule may be null if the Rust binary isn't built yet (new clone without `npm run build:native`).
// All methods below handle this gracefully by returning empty arrays.
const NativeModule: any = loadNativeModule();
const { getInputDevices, getOutputDevices } = NativeModule || {};

export interface AudioDevice {
    id: string;
    name: string;
}

export class AudioDevices {
    public static getInputDevices(): AudioDevice[] {
        if (!getInputDevices) {
            console.warn('[AudioDevices] Native functionality not available');
            return [];
        }
        try {
            return getInputDevices();
        } catch (e) {
            console.error('[AudioDevices] Failed to get input devices:', e);
            return [];
        }
    }

    public static getOutputDevices(): AudioDevice[] {
        if (!getOutputDevices) {
            console.warn('[AudioDevices] Native functionality not available');
            return [];
        }
        try {
            return getOutputDevices();
        } catch (e) {
            console.error('[AudioDevices] Failed to get output devices:', e);
            return [];
        }
    }

    /**
     * Determines whether the user is operating with ONLY built-in audio
     * (built-in microphone + built-in speakers), with no external input or
     * output device selected.
     *
     * This is the key signal for deciding whether to enable VAD passthrough
     * on MicrophoneCapture.  When true, macOS Acoustic Echo Cancellation (AEC)
     * is active and attenuates the mic signal, so local VAD must be disabled.
     *
     * Detection heuristics (macOS):
     *   • Input device ID is null / "default" / missing
     *   • Input device name contains "Built-in" or "MacBook" (case-insensitive)
     *   • Output device ID is null / "default" / missing
     *   • Output device name contains "Built-in" or "MacBook" (case-insensitive)
     *
     * When an explicit external device ID is provided (e.g. from user settings),
     * we trust that value directly and skip enumeration.
     *
     * @param inputDeviceId  - The requested input device ID (from user settings)
     * @param outputDeviceId - The requested output device ID (from user settings)
     * @returns true if the session is built-in-only (VAD should be disabled on mic)
     */
    public static isBuiltinOnly(
        inputDeviceId?: string | null,
        outputDeviceId?: string | null
    ): boolean {
        const BUILTIN_PATTERNS = /built.?in|macbook|internal|speaker.*mac|mac.*speaker/i;
        const isDefaultOrEmpty = (id?: string | null) =>
            !id || id === 'default' || id.trim() === '';

        // If an explicit non-default device ID is set for EITHER channel, at
        // least one external device is in use — do NOT disable VAD.
        if (!isDefaultOrEmpty(inputDeviceId)) return false;
        if (!isDefaultOrEmpty(outputDeviceId)) return false;

        // Both channels are "default".  Check what the default actually resolves to
        // by inspecting the enumerated device names.
        try {
            const inputDevices = AudioDevices.getInputDevices();
            const outputDevices = AudioDevices.getOutputDevices();

            // If there are any non-built-in input devices in the system, the user
            // may have an external mic as the system default.  We cannot know for
            // certain without deeper CoreAudio inspection, so we conservatively
            // return false (keep VAD active) — better to have VAD gating than to
            // flood Deepgram with unfiltered audio when an external device exists.
            const hasExternalInput = inputDevices.some(
                d => !BUILTIN_PATTERNS.test(d.name) && d.id !== 'default'
            );
            const hasExternalOutput = outputDevices.some(
                d => !BUILTIN_PATTERNS.test(d.name) && d.id !== 'default'
            );

            if (hasExternalInput || hasExternalOutput) {
                console.log('[AudioDevices] isBuiltinOnly: external device detected — VAD will remain active');
                return false;
            }

            // No external devices found at all — definitely built-in only
            console.log('[AudioDevices] isBuiltinOnly: only built-in devices detected — VAD will be disabled on mic');
            return true;
        } catch (e) {
            console.warn('[AudioDevices] isBuiltinOnly: device enumeration failed, defaulting to false', e);
            // Fail safe: don't disable VAD if we can't determine device state
            return false;
        }
    }

    /**
     * Detects whether the effective microphone input is a loopback/virtual
     * device (BlackHole, Soundflower, VB-Cable, aggregate devices, ...).
     * Such devices feed far-end playback straight back into the mic stream,
     * so the other party's speech shows up as the user's own — the echo
     * pipeline cannot fix a fully wired loop.
     *
     * WARN ONLY: callers surface a message; capture is never refused and the
     * device is never switched automatically.
     *
     * @param inputDeviceId - The requested input device ID (from user settings)
     */
    public static detectLoopbackInput(
        inputDeviceId?: string | null
    ): { suspicious: boolean; deviceName?: string } {
        const LOOPBACK_PATTERNS = /blackhole|loopback|soundflower|aggregate|multi.?output|vb.?cable|vb.?audio|virtual|ishowu/i;
        const isDefaultOrEmpty = (id?: string | null) =>
            !id || id === 'default' || id.trim() === '';

        try {
            const inputDevices = AudioDevices.getInputDevices();

            // Resolve the effective device: an explicit ID wins; otherwise the
            // 'default' pseudo-entry — whose name the native enumeration
            // labels with the device the system default actually resolves to,
            // e.g. "Default Microphone (BlackHole 2ch)" (older .node builds
            // return the bare "Default Microphone" label, which simply never
            // matches — fail-open).
            let effective: AudioDevice | undefined;
            if (!isDefaultOrEmpty(inputDeviceId)) {
                effective = inputDevices.find(d => d.id === inputDeviceId)
                    // Device IDs are CPAL device names — test the ID itself
                    // when the device is not in the enumerated list.
                    ?? { id: inputDeviceId!, name: inputDeviceId! };
            } else {
                effective = inputDevices.find(d => d.id === 'default');
            }

            if (effective && LOOPBACK_PATTERNS.test(effective.name)) {
                return { suspicious: true, deviceName: effective.name };
            }
            return { suspicious: false };
        } catch (e) {
            console.warn('[AudioDevices] detectLoopbackInput: device check failed, assuming not suspicious', e);
            return { suspicious: false };
        }
    }
}