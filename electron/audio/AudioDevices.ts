import { loadNativeModule } from './nativeModuleLoader';

// NativeModule may be null if the Rust binary isn't built yet (new clone without `npm run build:native`).
// All methods below handle this gracefully by returning empty arrays.
const NativeModule: any = loadNativeModule();
const { getInputDevices, getOutputDevices, getOutputRoute } = NativeModule || {};

/**
 * Names that identify Apple's built-in microphone / speakers. Deliberately
 * broad ("internal" catches some Macs), which is why the whole heuristic is
 * scoped to darwin — "Internal Microphone" is a common external-device name
 * on Windows.
 */
const BUILTIN_PATTERNS = /built.?in|macbook|internal|speaker.*mac|mac.*speaker/i;

/**
 * Output-device ids that are NOT device selections. The meeting path sends
 * `outputDeviceId: 'sck'` to force the ScreenCaptureKit capture backend (see
 * useMeetingSession.ts) — it is a backend selector, and says nothing at all
 * about which speaker the user is listening through.
 */
const NON_DEVICE_OUTPUT_IDS = new Set(['sck']);

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
     * The output route as the native layer resolves it — kind
     * ("headphones" | "speakers" | "unknown"), transport, and device name.
     *
     * `getOutputDevices()` has no `default` entry, so this is the ONLY signal
     * for which output device is actually in use. Same source
     * AudioDeviceWatcher._snapshot() reads.
     */
    public static getActiveOutputRoute(): { kind: string; transport: string; name: string } | null {
        if (typeof getOutputRoute !== 'function') return null;
        try {
            const r = getOutputRoute();
            if (!r) return null;
            return { kind: r.kind ?? '', transport: r.transport ?? '', name: r.name ?? '' };
        } catch (e) {
            console.error('[AudioDevices] Failed to read the output route:', e);
            return null;
        }
    }

    /**
     * Name of the device the OS default input currently resolves to.
     *
     * list_input_devices() synthesizes a `default` entry whose label embeds the
     * real device — "Default Microphone (MacBook Air Microphone)". That label is
     * the only default-input signal the native API exposes.
     */
    public static getActiveInputName(): string {
        return AudioDevices.getInputDevices().find(d => d.id === 'default')?.name ?? '';
    }

    /**
     * Whether the audio actually IN USE is built-in mic + built-in speakers.
     *
     * This is the signal for disabling the local VAD gate on MicrophoneCapture:
     * in that configuration macOS Acoustic Echo Cancellation attenuates the mic,
     * and the two-stage RMS+VAD gate then reads the quietened speech as silence
     * and discards it — the user's voice never reaches the transcriber.
     *
     * It asks about the ACTIVE devices, not what is plugged in. The previous
     * implementation returned false whenever ANY non-built-in device merely
     * existed on the system, or whenever an explicit id was set for either
     * channel. Both were wrong in the field: a MacBook Air running on its own
     * mic and speakers, with one unrelated device attached, kept VAD active and
     * lost ~75% of the user's frames to the RMS gate (mic RMS 29-341 against an
     * adaptive threshold of 227-268). The explicit-id shortcut had the same
     * effect on every meeting, because the meeting path passes the non-device
     * sentinel 'sck' as the output id.
     *
     * Fail-safe in every uncertain case: return false and leave VAD active.
     * Unfiltered audio costs money; discarded audio costs the transcript.
     *
     * @param inputDeviceId  - requested input id, or null/'default' for the OS default
     * @param outputDeviceId - requested output id, or null/'default' for the OS default
     * @returns true when both active devices are built-in (disable VAD on mic)
     */
    public static isBuiltinOnly(
        inputDeviceId?: string | null,
        outputDeviceId?: string | null
    ): boolean {
        // The rationale above is macOS-specific, and BUILTIN_PATTERNS matches
        // real external Windows device names ("Internal Microphone"). Every
        // other platform keeps the mic VAD active.
        if (process.platform !== 'darwin') {
            console.log('[AudioDevices] isBuiltinOnly: non-darwin — VAD remains active on mic');
            return false;
        }

        const isDefaultOrEmpty = (id?: string | null) =>
            !id || id === 'default' || id.trim() === '';

        try {
            // ── Active input ────────────────────────────────────────────────
            let inputName: string;
            if (isDefaultOrEmpty(inputDeviceId)) {
                inputName = AudioDevices.getActiveInputName();
            } else {
                const dev = AudioDevices.getInputDevices().find(d => d.id === inputDeviceId);
                // A selected device we cannot resolve is unknown, not built-in.
                if (!dev) {
                    console.log(
                        `[AudioDevices] isBuiltinOnly: input "${inputDeviceId}" did not resolve — VAD remains active`
                    );
                    return false;
                }
                inputName = dev.name;
            }

            if (!inputName || !BUILTIN_PATTERNS.test(inputName)) {
                console.log(
                    `[AudioDevices] isBuiltinOnly: active input "${inputName || 'unknown'}" is not built-in — VAD remains active`
                );
                return false;
            }

            // ── Active output ───────────────────────────────────────────────
            const outputIsSelectable =
                !isDefaultOrEmpty(outputDeviceId) &&
                !NON_DEVICE_OUTPUT_IDS.has(String(outputDeviceId));

            let outputName: string;
            if (outputIsSelectable) {
                const dev = AudioDevices.getOutputDevices().find(d => d.id === outputDeviceId);
                if (!dev) {
                    console.log(
                        `[AudioDevices] isBuiltinOnly: output "${outputDeviceId}" did not resolve — VAD remains active`
                    );
                    return false;
                }
                outputName = dev.name;
            } else {
                const route = AudioDevices.getActiveOutputRoute();
                if (!route) {
                    console.log('[AudioDevices] isBuiltinOnly: output route unavailable — VAD remains active');
                    return false;
                }
                // Headphones have no acoustic path back into the mic, so macOS
                // is not attenuating it and the gate has nothing to fight.
                if (route.kind === 'headphones') {
                    console.log('[AudioDevices] isBuiltinOnly: headphones active — VAD remains active');
                    return false;
                }
                // transport is the authoritative signal; the name is a fallback
                // for backends that do not report one.
                if (route.transport === 'built-in') {
                    console.log(
                        `[AudioDevices] isBuiltinOnly: built-in mic + built-in output ("${route.name}") — VAD will be disabled on mic`
                    );
                    return true;
                }
                outputName = route.name;
            }

            if (!outputName || !BUILTIN_PATTERNS.test(outputName)) {
                console.log(
                    `[AudioDevices] isBuiltinOnly: active output "${outputName || 'unknown'}" is not built-in — VAD remains active`
                );
                return false;
            }

            console.log('[AudioDevices] isBuiltinOnly: only built-in devices in use — VAD will be disabled on mic');
            return true;
        } catch (e) {
            console.warn('[AudioDevices] isBuiltinOnly: device resolution failed, defaulting to false', e);
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