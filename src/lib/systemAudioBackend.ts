// Which native backend captures system audio (the far end) on macOS.
//
// ScreenCaptureKit (SCK) is the default. The CoreAudio process-tap backend is
// kept only as an opt-out escape hatch: on every Mac we have logs from, the tap
// delivers half the samples it reports (native-module/src/speaker/core_audio.rs
// assumes an interleaved-stereo buffer even when the tap is mono and averages
// sample pairs away), so the far-end audio reaches Deepgram at double speed and
// nothing is transcribed. SCK ran at the full rate on the same machines.
//
// This module is the ONLY place the stored preference is interpreted. Before,
// the Settings toggle and the meeting-start path each read localStorage with a
// different fallback — the toggle showed "on" when nothing was saved, while a
// meeting only used SCK when the key was literally "true" — so a fresh install
// displayed SCK as enabled and silently ran every meeting through the tap.

/** localStorage key. Kept for compatibility with installs that already saved it. */
export const SCK_BACKEND_PREF_KEY = 'useExperimentalSckBackend';

/**
 * Output-id sentinel the main process passes through to the native module,
 * which maps it to the SCK backend (speaker/macos.rs). It is not a device:
 * SCK captures the whole system mix regardless of the output route.
 */
export const SCK_OUTPUT_ID = 'sck';

export interface SystemAudioBackendInput {
    /** Raw value of SCK_BACKEND_PREF_KEY, or null when nothing was saved. */
    savedPreference: string | null;
    isMac: boolean;
    /** The user's chosen output device, if any (preferredOutputDeviceId). */
    preferredOutputDeviceId?: string | null;
}

export interface SystemAudioBackendDecision {
    /** True → SCK. False → CoreAudio tap (macOS) or the platform backend elsewhere. */
    useSck: boolean;
    /** What to send as `outputDeviceId` when starting a meeting or the audio test. */
    outputDeviceId: string | null;
}

/** SCK unless the user explicitly switched it off. Never SCK off macOS. */
export function resolveSckPreference(savedPreference: string | null, isMac: boolean): boolean {
    if (!isMac) return false;
    return savedPreference === null ? true : savedPreference === 'true';
}

export function resolveSystemAudioBackend(input: SystemAudioBackendInput): SystemAudioBackendDecision {
    const useSck = resolveSckPreference(input.savedPreference, input.isMac);
    return {
        useSck,
        outputDeviceId: useSck ? SCK_OUTPUT_ID : (input.preferredOutputDeviceId ?? null),
    };
}
