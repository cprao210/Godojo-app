import { EventEmitter } from 'events';
import { loadNativeModule } from './nativeModuleLoader';

// RustMicCapture is the native Rust class (napi-rs) that captures microphone input.
// Uses eager init — the monitor is created in the constructor and kept alive across
// stop/restart cycles to avoid re-initialization latency.
const NativeModule: any = loadNativeModule();
const { MicrophoneCapture: RustMicCapture } = NativeModule || {};

export class MicrophoneCapture extends EventEmitter {
    private monitor: any = null;
    private isRecording: boolean = false;
    private deviceId: string | null = null;
    private _sampleRateEmitted: boolean = false;

    constructor(deviceId?: string | null) {
        super();
        this.deviceId = deviceId || null;
        if (!RustMicCapture) {
            console.error('[MicrophoneCapture] Rust class implementation not found.');
        } else {
            console.log(`[MicrophoneCapture] Initialized wrapper. Device ID: ${this.deviceId || 'default'}`);
            try {
                console.log('[MicrophoneCapture] Creating native monitor (Eager Init)...');
                this.monitor = new RustMicCapture(this.deviceId);
            } catch (e) {
                console.error('[MicrophoneCapture] Failed to create native monitor:', e);
                // Re-throw so callers (e.g. reconfigureAudio) can catch and fall back to
                // the default device. Without this, the constructor returns a broken
                // instance (monitor=null) and the fallback try/catch in main.ts is
                // never reached, leaving the user with zero microphone capture.
                throw e;
            }
        }
    }

    public getSampleRate(): number {
        if (this.monitor && typeof this.monitor.getSampleRate === 'function') {
            const nativeRate = this.monitor.getSampleRate();
            console.log(`[MicrophoneCapture] Real native rate: ${nativeRate}`);
            return nativeRate;
        }
        return 48000; // Safe default for most modern mics before native initialization
    }

    public getOutputSampleRate(): number {
        const native = this.getSampleRate();
        if (this.monitor && typeof this.monitor.get_output_sample_rate === 'function') {
            return this.monitor.get_output_sample_rate();
        }
        if (!this.monitor) return 0;
        return native === 48000 ? 16000 : native;
    }

    /**
     * Start capturing microphone audio
     */
    public start(): void {
        if (this.isRecording) return;

        if (!RustMicCapture) {
            console.error('[MicrophoneCapture] Cannot start: Rust module missing');
            return;
        }

        // Defensive fallback: under normal flow the constructor always
        // creates this.monitor (and throws on failure). This branch only
        // fires if someone constructs the class with RustMicCapture present,
        // then the native object is externally freed (edge case).
        if (!this.monitor) {
            console.log('[MicrophoneCapture] Monitor not initialized. Re-initializing...');
            try {
                this.monitor = new RustMicCapture(this.deviceId);
            } catch (e) {
                this.emit('error', e);
                return;
            }
        }

        try {
            console.log('[MicrophoneCapture] Starting native capture...');

            this.isRecording = true; // Set BEFORE start() to prevent re-entrant calls

            this.monitor.start((err: Error | null, chunk: Buffer) => {
                // napi v3 ThreadsafeFunction passes (err, arg) format
                if (err) {
                    console.error('[MicrophoneCapture] Callback error:', err);
                    this.isRecording = false; // Allow recovery via restart
                    this.emit('error', err);
                    return;
                }
                if (chunk && chunk.length > 0) {
                    // Debug: log occasionally
                    if (Math.random() < 0.05) {
                        console.log(`[MicrophoneCapture] Emitting chunk: ${chunk.length} bytes to JS`);
                    }
                    this.emit('data', Buffer.from(chunk));
                }
            }, (err: Error | null, _ended: boolean) => {
                // Speech-ended callback from Rust SilenceSuppressor.
                // _ended is always `true` when fired (Rust only invokes on speech→silence transition).
                if (err) {
                    console.error('[MicrophoneCapture] Speech ended callback error:', err);
                    return;
                }
                this.emit('speech_ended');
            });

            // FIX-5: Emit sample-rate-detected so main.ts can sync the User STT
            // sample rate after the native device has fully initialized.
            // Mirrors the SystemAudioCapture poll-at-1s/3s pattern.
            if (typeof this.monitor?.getSampleRate === 'function') {
                const pollMicRate = (label: string) => {
                    if (!this.isRecording) return; // Guard: don't fire after stop()
                    const rate = this.monitor?.getSampleRate?.();
                    if (rate) {
                        const outputRate = rate === 48000 ? 16000 : rate;
                        console.log(`[MicrophoneCapture] Native: ${rate}Hz → Output: ${outputRate}Hz (${label})`);
                        if (!this._sampleRateEmitted) {
                            this._sampleRateEmitted = true;
                            this.emit('sample-rate-detected', outputRate);
                        }
                    }
                };
                setTimeout(() => pollMicRate('1s'), 1000);
                setTimeout(() => pollMicRate('3s'), 3000);
            }

            this.emit('start');
        } catch (error) {
            console.error('[MicrophoneCapture] Failed to start:', error);
            this.isRecording = false;
            this.emit('error', error);
        }
    }

    /**
     * Stop capturing
     */
    public stop(): void {
        if (!this.isRecording) return;

        console.log('[MicrophoneCapture] Stopping capture...');
        try {
            this.monitor?.stop();
        } catch (e) {
            console.error('[MicrophoneCapture] Error stopping:', e);
        }

        // DO NOT destroy monitor here. Keep it alive for seamless restart.
        // this.monitor = null;

        this.isRecording = false;
        this.emit('stop');
    }

    public destroy(): void {
        this._sampleRateEmitted = false;
        this.stop();
        // Remove all listeners BEFORE nulling monitor.
        // In-flight Rust callbacks may still arrive (via napi's scheduler)
        // after stop() returns. Clearing listeners prevents them from emitting
        // events on an object the caller considers dead.
        this.removeAllListeners();
        this.monitor = null;
    }
}