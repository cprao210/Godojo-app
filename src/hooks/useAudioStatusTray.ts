// Everything the launcher's AudioStatusTray needs beyond permission state:
// live levels for both channels, the device each channel will actually use, and
// an explicitly user-initiated probe for when no meeting is running.
//
// TWO LEVEL SOURCES, deliberately kept apart:
//
//   1. DURING A MEETING — 'audio-level' events, which main already broadcasts to
//      the launcher window. Free: the captures are running anyway, so the tray
//      meters are the real pipeline, not a simulation of it.
//
//   2. IDLE — a one-off `startAudioTest`, and ONLY when the user asks for it.
//      Never automatic, for two reasons. Opening the microphone because someone
//      clicked a permissions icon is a privacy surprise. And startAudioTest is a
//      main-process SINGLETON that Settings → Audio also drives, so an implicit
//      start here would silently kill the meters in that window (and vice
//      versa). A short, explicit, auto-expiring probe keeps that collision
//      inside a window the user opened on purpose.
//
// The probe is refused outright while a meeting is live: the meeting already
// publishes real levels, and a second MicrophoneCapture alongside it would
// double up on the same device for no gain.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveAudioLevels } from './useLiveAudioLevels';

/** Re-read the device list this often while the panel is open. */
const DEVICE_POLL_MS = 5000;

/** Coalesce the burst of `devicechange` events one USB headset produces. */
const DEVICE_CHANGE_DEBOUNCE_MS = 400;

/**
 * The probe stops itself after this long. A tray meter is for a quick "is my
 * headset working" check, and an unattended capture holding the audio-test
 * singleton indefinitely is exactly what breaks Settings → Audio.
 */
const TEST_DURATION_MS = 15_000;

/** Coarser than the meeting feed's 1/128 — a 6px bar cannot show more. */
const TEST_LEVEL_STEPS = 64;

const SYSTEM_DEFAULT_LABEL = 'System default';

interface NativeDevice {
    id: string;
    name: string;
}

export interface AudioChannelStatus {
    /** Raw 0–1 RMS level exactly as main publishes it — shape it for display. */
    level: number;
    /** Samples are arriving right now (live meeting, or the probe saw audio). */
    live: boolean;
    /** Device this channel will use, or null when the list is unavailable. */
    deviceName: string | null;
    /**
     * A saved device preference no longer exists — the headset it named was
     * unplugged, so capture has fallen back to the OS default.
     */
    deviceMissing: boolean;
}

export interface AudioStatusTrayState {
    mic: AudioChannelStatus;
    system: AudioChannelStatus;
    /** The live meeting pipeline is pushing levels for at least one channel. */
    meetingLive: boolean;
    /** The user-initiated probe is running. */
    testing: boolean;
    /** The probe could not start at all — a mic/permission failure. */
    testError: string | null;
    /**
     * The system-audio half of the probe failed. Reported separately because
     * main runs it independently of the mic: one can fail while the other works,
     * and blaming the wrong channel in the UI is worse than saying nothing.
     */
    systemError: string | null;
    startTest: () => void;
    stopTest: () => void;
}

const quantizeTestLevel = (v: number): number => {
    if (!Number.isFinite(v)) return 0;
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
    return Math.round(clamped * TEST_LEVEL_STEPS) / TEST_LEVEL_STEPS;
};

/**
 * Which device label to show, mirroring how the capture layer resolves one: a
 * saved id if it still exists, otherwise whatever the OS calls default.
 */
function resolveDevice(
    devices: NativeDevice[],
    preferredId: string | null,
): { name: string | null; missing: boolean } {
    // Empty means the native module could not enumerate (it fails soft to []),
    // so claiming "System default" would be inventing information.
    if (devices.length === 0) return { name: null, missing: false };
    if (!preferredId || preferredId === 'default') {
        return { name: SYSTEM_DEFAULT_LABEL, missing: false };
    }
    const match = devices.find((d) => d.id === preferredId);
    return match
        ? { name: match.name, missing: false }
        : { name: SYSTEM_DEFAULT_LABEL, missing: true };
}

/**
 * @param panelOpen whether the tray's panel is expanded. Device polling and the
 *   probe are both scoped to it — a closed tray costs one IPC listener.
 */
export function useAudioStatusTray(panelOpen: boolean): AudioStatusTrayState {
    // Always subscribed: these events only exist while a meeting is capturing,
    // so an idle launcher pays for one listener and one 200ms sweep.
    const { micLevel, systemLevel, micActive, systemActive } = useLiveAudioLevels(true);
    const meetingLive = micActive || systemActive;

    const [input, setInput] = useState<{ name: string | null; missing: boolean }>({
        name: null,
        missing: false,
    });
    const [output, setOutput] = useState<{ name: string | null; missing: boolean }>({
        name: null,
        missing: false,
    });

    const [testing, setTesting] = useState(false);
    const [testError, setTestError] = useState<string | null>(null);
    const [systemError, setSystemError] = useState<string | null>(null);
    const [testMicLevel, setTestMicLevel] = useState(0);
    const [testSystemLevel, setTestSystemLevel] = useState(0);
    const [testMicSeen, setTestMicSeen] = useState(false);
    const [testSystemSeen, setTestSystemSeen] = useState(false);

    // Read by callbacks that must stay referentially stable.
    const meetingLiveRef = useRef(meetingLive);
    meetingLiveRef.current = meetingLive;
    const testingRef = useRef(testing);
    testingRef.current = testing;
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const loadDevices = useCallback(async () => {
        const api = window.electronAPI;
        if (!api?.getInputDevices || !api?.getOutputDevices) return;
        try {
            const [inputs, outputs] = await Promise.all([
                api.getInputDevices(),
                api.getOutputDevices(),
            ]);
            if (!mountedRef.current) return;
            // Re-read the preferences every time: they are owned by the Settings
            // window, which cannot notify us directly.
            setInput(resolveDevice(inputs, localStorage.getItem('preferredInputDeviceId')));
            setOutput(resolveDevice(outputs, localStorage.getItem('preferredOutputDeviceId')));
        } catch (err) {
            console.warn('[useAudioStatusTray] device enumeration failed:', err);
        }
    }, []);

    // Hot-swap. Chromium raises `devicechange` in the renderer whenever the OS
    // audio device list changes, which covers the case this tray cares about —
    // a headset plugged in or pulled out mid-session — without needing the
    // main-process AudioDeviceWatcher (which only runs during a meeting and
    // keeps its events in main). Focus is the second trigger: it catches a
    // default-device switch made in the OS sound panel, which is not a device
    // list change and so fires nothing here.
    useEffect(() => {
        void loadDevices();

        let debounce: ReturnType<typeof setTimeout> | undefined;
        const refresh = () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => { void loadDevices(); }, DEVICE_CHANGE_DEBOUNCE_MS);
        };

        const media = navigator.mediaDevices;
        // Guarded: `mediaDevices` is undefined in a non-secure context, and this
        // component also renders under jsdom in tests.
        media?.addEventListener?.('devicechange', refresh);
        window.addEventListener('focus', refresh);

        return () => {
            if (debounce) clearTimeout(debounce);
            media?.removeEventListener?.('devicechange', refresh);
            window.removeEventListener('focus', refresh);
        };
    }, [loadDevices]);

    // Backstop for the one case neither event covers: a device swapped while a
    // *different* window had focus. Scoped to the open panel, like the
    // permission re-check next to it.
    useEffect(() => {
        if (!panelOpen) return;
        void loadDevices();
        const interval = setInterval(() => { void loadDevices(); }, DEVICE_POLL_MS);
        return () => clearInterval(interval);
    }, [panelOpen, loadDevices]);

    const stopTest = useCallback(() => {
        setTesting(false);
        setTestMicLevel(0);
        setTestSystemLevel(0);
        setTestMicSeen(false);
        setTestSystemSeen(false);
        setTestError(null);
        setSystemError(null);
        window.electronAPI?.stopAudioTest?.().catch((err: unknown) =>
            console.warn('[useAudioStatusTray] stopAudioTest failed:', err),
        );
    }, []);

    const startTest = useCallback(() => {
        // A live meeting is already feeding real levels; a second capture on the
        // same devices would add nothing and touches shared native state.
        if (meetingLiveRef.current) return;
        setTestError(null);
        setSystemError(null);
        setTestMicSeen(false);
        setTestSystemSeen(false);
        setTesting(true);
        const preferred = localStorage.getItem('preferredInputDeviceId') || undefined;
        window.electronAPI?.startAudioTest?.(preferred).catch((err: unknown) => {
            if (!mountedRef.current) return;
            const message = err instanceof Error ? err.message : String(err);
            setTestError(message || 'Could not start the audio check.');
            setTesting(false);
        });
    }, []);

    useEffect(() => {
        if (!testing) return;
        const api = window.electronAPI;
        const unsubs = [
            api?.onAudioTestLevel?.((level: number) => {
                setTestMicSeen(true);
                const next = quantizeTestLevel(level);
                setTestMicLevel((prev) => (prev === next ? prev : next));
            }),
            api?.onAudioTestSystemLevel?.((level: number) => {
                // Any sample means the probe is alive, so a stale error is wrong.
                setSystemError(null);
                setTestSystemSeen(true);
                const next = quantizeTestLevel(level);
                setTestSystemLevel((prev) => (prev === next ? prev : next));
            }),
            api?.onAudioTestSystemError?.((message: string) =>
                setSystemError(message || 'System audio could not be captured.'),
            ),
        ];
        const autoStop = setTimeout(stopTest, TEST_DURATION_MS);

        return () => {
            for (const unsub of unsubs) unsub?.();
            clearTimeout(autoStop);
        };
    }, [testing, stopTest]);

    // Close the panel or start a meeting and the probe has no reason to exist.
    useEffect(() => {
        if (!testing) return;
        if (!panelOpen || meetingLive) stopTest();
    }, [testing, panelOpen, meetingLive, stopTest]);

    // Never leave the singleton running for the next owner to find. Guarded on
    // testingRef so unmounting a tray that never probed cannot stop a test
    // Settings → Audio is running in its own window.
    useEffect(() => () => {
        if (!testingRef.current) return;
        window.electronAPI?.stopAudioTest?.().catch(() => { /* shutting down */ });
    }, []);

    return {
        mic: {
            level: micActive ? micLevel : testing ? testMicLevel : 0,
            live: micActive || (testing && testMicSeen),
            deviceName: input.name,
            deviceMissing: input.missing,
        },
        system: {
            level: systemActive ? systemLevel : testing ? testSystemLevel : 0,
            live: systemActive || (testing && testSystemSeen),
            deviceName: output.name,
            deviceMissing: output.missing,
        },
        meetingLive,
        testing,
        testError,
        systemError,
        startTest,
        stopTest,
    };
}
