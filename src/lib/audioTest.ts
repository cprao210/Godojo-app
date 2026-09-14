// Shared "test sound" beep, used by both Settings > Audio (AudioTab) and the
// bottom-of-launcher Audio status tray (AudioStatusTray) — one implementation
// so the two Test Sound buttons can never drift in tone/duration/behavior.

/**
 * Resolve a Web Audio sink ID for a native (CoreAudio / WASAPI) device ID.
 *
 * The device IDs both callers hold come from the native module, whose namespace
 * differs from the one `setSinkId` expects: `setSinkId` only accepts a deviceId
 * from `navigator.mediaDevices.enumerateDevices()`. Passing the native ID
 * straight through always threw NotFoundError ("the device BuiltInSpeakerDevice
 * is not found"), so the beep silently played on the system default no matter
 * which device was selected. Bridge the two by label.
 *
 * Returns null when there is no confident match — the caller then leaves the
 * context on the default output instead of throwing.
 */
const resolveSinkId = async (nativeDeviceId: string): Promise<string | null> => {
    if (!nativeDeviceId || nativeDeviceId === 'default') return null;

    let nativeLabel: string | undefined;
    try {
        const outputs = (await window.electronAPI?.getOutputDevices?.()) ?? [];
        nativeLabel = outputs.find((d) => d.id === nativeDeviceId)?.name;
    } catch (e) {
        console.warn('[audioTest] Could not list native output devices:', e);
        return null;
    }
    if (!nativeLabel) return null;

    let sinks: MediaDeviceInfo[];
    try {
        sinks = (await navigator.mediaDevices.enumerateDevices()).filter(
            (d) => d.kind === 'audiooutput',
        );
    } catch (e) {
        console.warn('[audioTest] Could not enumerate output sinks:', e);
        return null;
    }

    // Labels are blank until the renderer holds a media permission. With no
    // labels there is nothing to match on, so stay on the default output.
    const named = sinks.filter((d) => d.label);
    if (named.length === 0) {
        console.debug('[audioTest] Output sink labels unavailable — test tone will use the default device.');
        return null;
    }

    const target = nativeLabel.trim().toLowerCase();
    const match =
        named.find((d) => d.label.trim().toLowerCase() === target) ??
        named.find((d) => {
            const label = d.label.trim().toLowerCase();
            return label.includes(target) || target.includes(label);
        });

    return match?.deviceId ?? null;
};

/**
 * Plays a short beep through the given output device (or the system default
 * if no deviceId is provided / setSinkId isn't supported), so the user can
 * confirm audio is actually reaching their speakers/headphones.
 */
export const playTestSound = async (deviceId?: string): Promise<void> => {
    let ctx: AudioContext | null = null;
    try {
        const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextCtor) {
            console.error('[audioTest] Web Audio API not supported');
            return;
        }

        ctx = new AudioContextCtor() as AudioContext;
        if (ctx.state === 'suspended') await ctx.resume();

        // Route BEFORE the tone starts so its first cycles are not emitted on
        // the previous sink. A failure here is not fatal: the beep still plays
        // on the system default, which is the useful fallback.
        if (deviceId && typeof (ctx as any).setSinkId === 'function') {
            const sinkId = await resolveSinkId(deviceId);
            if (sinkId) {
                try {
                    await (ctx as any).setSinkId(sinkId);
                } catch (e) {
                    console.warn(
                        '[audioTest] Could not route the test tone to the selected device — using the system default.',
                        e,
                    );
                }
            }
        }

        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(523.25, ctx.currentTime);
        gainNode.gain.setValueAtTime(0.5, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1.0);

        // Chromium caps concurrent AudioContexts per page and an earlier version
        // leaked one per click, so repeatedly tapping Test Sound eventually
        // stopped producing any tone at all.
        const contextToClose = ctx;
        oscillator.onended = () => {
            void contextToClose.close().catch(() => { });
        };

        oscillator.start();
        oscillator.stop(ctx.currentTime + 1.0);
    } catch (e) {
        console.error('[audioTest] Error playing test sound:', e);
        void ctx?.close().catch(() => { });
    }
};
