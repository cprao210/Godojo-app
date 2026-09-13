// Shared "test sound" beep, used by both Settings > Audio (AudioTab) and the
// bottom-of-launcher Audio status tray (AudioStatusTray) — one implementation
// so the two Test Sound buttons can never drift in tone/duration/behavior.

/**
 * Plays a short beep through the given output device (or the system default
 * if no deviceId is provided / setSinkId isn't supported), so the user can
 * confirm audio is actually reaching their speakers/headphones.
 */
export const playTestSound = async (deviceId?: string): Promise<void> => {
    try {
        const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextCtor) {
            console.error('[audioTest] Web Audio API not supported');
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

        if (deviceId && (ctx as any).setSinkId) {
            try {
                await (ctx as any).setSinkId(deviceId);
            } catch (e) {
                console.warn('[audioTest] Error setting sink for AudioContext:', e);
            }
        }

        oscillator.start();
        oscillator.stop(ctx.currentTime + 1.0);
    } catch (e) {
        console.error('[audioTest] Error playing test sound:', e);
    }
};