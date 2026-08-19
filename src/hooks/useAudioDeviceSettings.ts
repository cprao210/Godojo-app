// Audio tab: available input/output devices, the user's saved preference for
// each, the live mic-level meter (native test path so device IDs stay
// consistent with the actual meeting runtime), and the experimental
// ScreenCaptureKit backend toggle.

import { useEffect, useState } from 'react';
import { isMac } from '@/../utils/platformUtils';

interface UseAudioDeviceSettingsArgs {
    isOpen: boolean;
    /** Only runs the live mic test while this tab is the active one. */
    activeTab: string;
}

export function useAudioDeviceSettings({ isOpen, activeTab }: UseAudioDeviceSettingsArgs) {
    const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedInput, setSelectedInput] = useState('');
    const [selectedOutput, setSelectedOutput] = useState('');
    const [micLevel, setMicLevel] = useState(0);
    // The system-audio side of the same test. Separate from micLevel because the
    // two can fail independently — a denied Screen Recording grant leaves the mic
    // meter working perfectly, which is exactly how users concluded audio was fine.
    const [systemAudioLevel, setSystemAudioLevel] = useState(0);
    const [systemAudioError, setSystemAudioError] = useState<string | null>(null);
    const [micError, setMicError] = useState<string | null>(null);
    const [useExperimentalSck, setUseExperimentalSck] = useState(isMac);

    // ── Load devices + saved preferences whenever the overlay opens ─────────
    useEffect(() => {
        if (!isOpen) return;

        const loadDevices = async () => {
            try {
                const [inputs, outputs] = await Promise.all([
                    window.electronAPI?.getInputDevices() ?? Promise.resolve([]),
                    window.electronAPI?.getOutputDevices() ?? Promise.resolve([]),
                ]);

                // Map to a shape compatible with CustomSelect (expects MediaDeviceInfo-like objects).
                const formatDevices = (devs: any[]) => devs.map((d) => ({
                    deviceId: d.id,
                    label: d.name,
                    kind: 'audioinput' as MediaDeviceKind,
                    groupId: '',
                    toJSON: () => d,
                }));

                setInputDevices(formatDevices(inputs));
                setOutputDevices(formatDevices(outputs));

                const savedInput = localStorage.getItem('preferredInputDeviceId');
                const savedOutput = localStorage.getItem('preferredOutputDeviceId');

                if (savedInput && inputs.find((d: any) => d.id === savedInput)) {
                    setSelectedInput(savedInput);
                } else if (inputs.length > 0 && !selectedInput) {
                    setSelectedInput(inputs[0].id);
                }

                if (savedOutput && outputs.find((d: any) => d.id === savedOutput)) {
                    setSelectedOutput(savedOutput);
                } else if (outputs.length > 0 && !selectedOutput) {
                    setSelectedOutput(outputs[0].id);
                }
            } catch (e) {
                console.error('[useAudioDeviceSettings] Error loading native devices:', e);
            }
        };
        loadDevices();

        const savedSckPref = localStorage.getItem('useExperimentalSckBackend');
        setUseExperimentalSck(savedSckPref !== null ? savedSckPref === 'true' : isMac);
        // Re-run if isOpen changes, or if a selected device was cleared elsewhere.
    }, [isOpen, selectedInput, selectedOutput]);

    // ── Live mic + system-audio test, only while the Audio tab is visible ───
    //
    // One startAudioTest drives both meters: the main process runs a mic capture
    // and an independent system-audio probe, reporting them on separate channels.
    useEffect(() => {
        if (!(isOpen && activeTab === 'audio')) {
            setMicLevel(0);
            setSystemAudioLevel(0);
            setSystemAudioError(null);
            setMicError(null);
            window.electronAPI?.stopAudioTest?.().catch((error) =>
                console.error('[useAudioDeviceSettings] Error stopping microphone test:', error),
            );
            return;
        }

        const unsubscribe = window.electronAPI?.onAudioTestLevel?.((level: number) => {
            setMicLevel(Math.max(0, Math.min(100, level * 100)));
        });
        const unsubscribeSystemLevel = window.electronAPI?.onAudioTestSystemLevel?.((level: number) => {
            // Any sample arriving means the probe is alive, so clear a stale error.
            setSystemAudioError(null);
            setSystemAudioLevel(Math.max(0, Math.min(100, level * 100)));
        });
        const unsubscribeSystemError = window.electronAPI?.onAudioTestSystemError?.((message: string) => {
            setSystemAudioError(message);
            setSystemAudioLevel(0);
        });

        window.electronAPI?.startAudioTest(selectedInput || undefined).catch((error) => {
            console.error('[useAudioDeviceSettings] Error starting microphone test:', error);
            setMicLevel(0);
            // Surface it instead of silently flatlining the meter — a mic-denied
            // rejection used to look identical to a muted microphone.
            setMicError(error?.message || 'Microphone test failed to start.');
        });

        return () => {
            unsubscribe?.();
            unsubscribeSystemLevel?.();
            unsubscribeSystemError?.();
            window.electronAPI?.stopAudioTest?.().catch((error) =>
                console.error('[useAudioDeviceSettings] Error stopping microphone test:', error),
            );
            setMicLevel(0);
            setSystemAudioLevel(0);
        };
    }, [isOpen, activeTab, selectedInput]);

    const selectInputDevice = (deviceId: string) => {
        setSelectedInput(deviceId);
        localStorage.setItem('preferredInputDeviceId', deviceId);
    };

    const selectOutputDevice = (deviceId: string) => {
        setSelectedOutput(deviceId);
        localStorage.setItem('preferredOutputDeviceId', deviceId);
    };

    const toggleExperimentalSck = () => {
        const next = !useExperimentalSck;
        setUseExperimentalSck(next);
        localStorage.setItem('useExperimentalSckBackend', String(next));
    };

    /** Plays a short beep through the selected output device, so the user can confirm it's the right one. */
    const playTestSound = async () => {
        try {
            const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioContextCtor) {
                console.error('[useAudioDeviceSettings] Web Audio API not supported');
                return;
            }

            const ctx = new AudioContextCtor();
            if (ctx.state === 'suspended') await ctx.resume();

            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);

            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(523.25, ctx.currentTime);
            gainNode.gain.setValueAtTime(0.5, ctx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1.0);

            if (selectedOutput && (ctx as any).setSinkId) {
                try {
                    await (ctx as any).setSinkId(selectedOutput);
                } catch (e) {
                    console.warn('[useAudioDeviceSettings] Error setting sink for AudioContext:', e);
                }
            }

            oscillator.start();
            oscillator.stop(ctx.currentTime + 1.0);
        } catch (e) {
            console.error('[useAudioDeviceSettings] Error playing test sound:', e);
        }
    };

    return {
        inputDevices,
        outputDevices,
        selectedInput,
        selectedOutput,
        micLevel,
        micError,
        systemAudioLevel,
        systemAudioError,
        useExperimentalSck,
        selectInputDevice,
        selectOutputDevice,
        toggleExperimentalSck,
        playTestSound,
    };
}