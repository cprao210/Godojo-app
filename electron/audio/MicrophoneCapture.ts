import { EventEmitter } from 'events';
import { loadNativeModule } from './nativeModuleLoader';

// RustMicCapture is the native Rust class (napi-rs) that captures microphone input.
// Uses eager init — the monitor is created in the constructor and kept alive across
// stop/restart cycles to avoid re-initialization latency.
const NativeModule: any = loadNativeModule();
const { MicrophoneCapture: RustMicCapture } = NativeModule || {};

export interface MicrophoneCaptureOptions {
    /**
     * When true, bypasses the local two-stage RMS + WebRTC VAD gate in the Rust
     * DSP thread and forwards every frame directly to JS (after 16 kHz resampling).
     *
     * WHY THIS EXISTS — the built-in mic + built-in speakers problem:
     *
     * When no external audio device is connected macOS activates Acoustic Echo
     * Cancellation (AEC) on the default input device.  AEC continuously tracks
     * what the speakers are playing and subtracts it from the microphone signal
     * to prevent feedback loops.  Because the app also captures system audio
     * (CoreAudio Tap / ScreenCaptureKit), macOS AEC classifies that playback as
     * "echo" and aggressively attenuates the user's voice — often by 20-40 dB.
     *
     * The local SilenceSuppressor then sees this low-amplitude signal, classifies
     * it as silence (RMS below adaptive threshold), and suppresses it entirely.
     * Result: the user's voice never reaches Deepgram even though the microphone
     * hardware is working correctly.
     *
     * With an external device (earbuds / headphones / USB mic) macOS deactivates
     * AEC because the playback and capture paths are physically separate.  Signal
     * levels are normal, and the local VAD gate provides useful noise suppression.
     *
     * Setting vadDisabled=true:
     *   - Bypasses local RMS + WebRTC VAD (Rust passthrough mode)
     *   - Still resamples to 16 kHz
     *   - Deepgram's cloud VAD handles silence detection
     *
     * TypeScript layer detects the "no external device" scenario and passes this
     * flag when constructing MicrophoneCapture (see main.ts detectBuiltinOnly).
     */
    vadDisabled?: boolean;
    /**
     * Echo pipeline mode passed down to the Rust gate:
     *   'legacy'      — original hard mute (SPEAKER_ACTIVE + warmup)
     *   'phase1'      — headphone bypass + short RMS-driven gate
     *   'full_duplex' — delay-aligned AEC3 + convergence-tracked soft gate (default)
     * Overrides the NATIVELY_ECHO_MODE env var when set.
     */
    echoMode?: string;
    /**
     * Persisted AEC alignment seed for the current output route (SIGNED ms:
     * positive = render delayed, negative = capture delayed). Lets the native
     * echo canceller start pre-aligned instead of re-estimating from scratch.
     * Ignored by pre-rework .node binaries.
     */
    echoAlignSeedMs?: number;
}

export class MicrophoneCapture extends EventEmitter {
    private monitor: any = null;
    private isRecording: boolean = false;
    private deviceId: string | null = null;
    private _sampleRateEmitted: boolean = false;
    private _vadDisabled: boolean = false;
    private _echoMode: string | undefined;
    private _echoAlignSeedMs: number | undefined;

    // VAD-lockout watchdog timers (only used when vadDisabled=false)
    private _vadResetTimer: NodeJS.Timeout | null = null;
    private _vadInnerTimer: NodeJS.Timeout | null = null;
    private _chunkCount: number = 0;

    constructor(deviceId?: string | null, options?: MicrophoneCaptureOptions) {
        super();
        this.deviceId = deviceId || null;
        this._vadDisabled = options?.vadDisabled ?? false;
        this._echoMode = options?.echoMode;
        this._echoAlignSeedMs = options?.echoAlignSeedMs;

        if (!RustMicCapture) {
            console.error('[MicrophoneCapture] Rust class implementation not found.');
        } else {
            console.log(
                `[MicrophoneCapture] Initialized wrapper. Device: ${this.deviceId || 'default'}, vadDisabled: ${this._vadDisabled}, echoMode: ${this._echoMode || 'default'}`
            );
            try {
                console.log('[MicrophoneCapture] Creating native monitor (Eager Init)...');
                // Rust signature: new(device_id, vad_disabled, options?: CaptureOptions)
                // The trailing options object is ignored by pre-rework .node binaries.
                this.monitor = new RustMicCapture(this.deviceId, this._vadDisabled, this._captureOptions());
            } catch (e) {
                console.error('[MicrophoneCapture] Failed to create native monitor:', e);
                // Re-throw so callers (e.g. reconfigureAudio) can catch and fall back to
                // the default device. Without this the constructor returns a broken
                // instance (monitor=null) and the fallback try/catch in main.ts is
                // never reached, leaving the user with zero microphone capture.
                throw e;
            }
        }
    }

    /**
     * Options object for the native constructor. Typed loosely on purpose:
     * the native CaptureOptions grows fields (echoAlignSeedMs) that may not
     * exist in the local .d.ts until the concurrent napi rebuild lands —
     * older binaries simply ignore unknown keys.
     */
    private _captureOptions(): any {
        return {
            echoMode: this._echoMode,
            echoAlignSeedMs: this._echoAlignSeedMs,
        };
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
        // Touch getSampleRate() so its native-rate log stays consistent.
        this.getSampleRate();
        // Return 0 if monitor hasn't started yet so the startMeeting settle poll
        // knows the rate is not yet available.
        if (!this.monitor) return 0;
        // napi-rs exposes Rust's get_output_sample_rate() as camelCase
        // getOutputSampleRate() (native-module/index.d.ts). The old snake_case check
        // never matched and fell through to `native === 48000 ? 16000 : native`,
        // which leaked non-48000 native rates (e.g. WASAPI 44100 on Windows) as the
        // declared Deepgram sample_rate even though the Rust DSP always outputs 16kHz.
        if (typeof this.monitor.getOutputSampleRate === 'function') {
            return this.monitor.getOutputSampleRate();
        }
        // Fallback for older native builds: DSP always resamples output to 16kHz.
        return 16000;
    }

    /**
     * Start capturing microphone audio.
     */
    public start(): void {
        if (this.isRecording) return;

        if (!RustMicCapture) {
            console.error('[MicrophoneCapture] Cannot start: Rust module missing');
            return;
        }

        // Defensive fallback: under normal flow the constructor always creates
        // this.monitor (and throws on failure).  This branch only fires if the
        // native object is externally freed (edge case).
        if (!this.monitor) {
            console.log('[MicrophoneCapture] Monitor not initialized. Re-initializing...');
            try {
                this.monitor = new RustMicCapture(this.deviceId, this._vadDisabled, this._captureOptions());
            } catch (e) {
                this.emit('error', e);
                return;
            }
        }

        try {
            console.log('[MicrophoneCapture] Starting native capture...');

            this._chunkCount = 0;
            this.isRecording = true; // Set BEFORE start() to prevent re-entrant calls

            this.monitor.start(
                (err: Error | null, chunk: Buffer) => {
                    // napi v3 ThreadsafeFunction passes (err, arg) format
                    if (err) {
                        console.error('[MicrophoneCapture] Callback error:', err);
                        this.isRecording = false; // Allow recovery via restart
                        this.emit('error', err);
                        return;
                    }
                    if (chunk && chunk.length > 0) {
                        this._chunkCount++;
                        if (Math.random() < 0.05) {
                            console.log(`[MicrophoneCapture] Emitting chunk: ${chunk.length} bytes to JS`);
                        }
                        this.emit('data', Buffer.from(chunk));
                    }
                },
                (err: Error | null, _ended: boolean) => {
                    // Speech-ended callback from Rust SilenceSuppressor.
                    // _ended is always `true` when fired (Rust only invokes on speech→silence transition).
                    if (err) {
                        console.error('[MicrophoneCapture] Speech ended callback error:', err);
                        return;
                    }
                    this.emit('speech_ended');
                }
            );

            // ── VAD-lockout watchdog ──────────────────────────────────────────
            // Only arm the watchdog when VAD is active (vadDisabled=false).
            // In passthrough mode chunks always flow — there is nothing to watch.
            //
            // If the SilenceSuppressor locks into suppression (no new chunks in
            // 2 s after the 3 s grace period), restart the native capture to
            // reset VAD state.  This mirrors the identical watchdog in
            // SystemAudioCapture.
            if (!this._vadDisabled) {
                const scheduleVadCheck = () => {
                    this._vadResetTimer = setTimeout(() => {
                        this._vadResetTimer = null;
                        if (!this.isRecording) return;
                        const countSnapshot = this._chunkCount;
                        this._vadInnerTimer = setTimeout(() => {
                            this._vadInnerTimer = null;
                            if (!this.isRecording) return;
                            if (this._chunkCount === countSnapshot) {
                                // No new chunks in 2 s — VAD is suppressing. Restart.
                                console.warn('[MicrophoneCapture] VAD lockout detected — restarting capture to reset state');
                                try { this.monitor?.stop(); } catch { /* ignore */ }
                                this.isRecording = false;
                                this._chunkCount = 0;
                                setTimeout(() => {
                                    if (!this.isRecording) {
                                        // Recreate monitor and restart
                                        try {
                                            this.monitor = new RustMicCapture(this.deviceId, this._vadDisabled, this._captureOptions());
                                        } catch (e) {
                                            this.emit('error', e);
                                            return;
                                        }
                                        this.start();
                                    }
                                }, 150);
                            } else {
                                // Still getting chunks — keep watching
                                scheduleVadCheck();
                            }
                        }, 2000);
                    }, 3000); // First check 3 s after DSP init
                };
                scheduleVadCheck();
            }

            // ── Sample rate detection poll ────────────────────────────────────
            // Emit 'sample-rate-detected' once the hardware reports a real rate.
            // Matches the SystemAudioCapture poll-at-1s/3s pattern.
            if (typeof this.monitor?.getSampleRate === 'function') {
                const pollMicRate = (label: string) => {
                    if (!this.isRecording) return;
                    const rate = this.monitor?.getSampleRate?.();
                    if (rate) {
                        // Use getOutputSampleRate() — the Rust DSP always resamples to
                        // 16kHz regardless of native rate. The old `rate === 48000 ? 16000
                        // : rate` leaked non-48000 native rates (e.g. WASAPI 44100 on
                        // Windows) as the emitted output rate, misconfiguring the user STT
                        // channel (setSampleRate(44100) on 16kHz audio → garbled transcripts).
                        const outputRate = this.getOutputSampleRate() || 16000;
                        console.log(
                            `[MicrophoneCapture] Native: ${rate}Hz → Output: ${outputRate}Hz (${label})`
                        );
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
     * Stop capturing.
     */
    public stop(): void {
        if (!this.isRecording) return;

        console.log('[MicrophoneCapture] Stopping capture...');

        // Cancel watchdog timers before stopping
        if (this._vadResetTimer) { clearTimeout(this._vadResetTimer); this._vadResetTimer = null; }
        if (this._vadInnerTimer) { clearTimeout(this._vadInnerTimer); this._vadInnerTimer = null; }

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
        if (this._vadResetTimer) { clearTimeout(this._vadResetTimer); this._vadResetTimer = null; }
        if (this._vadInnerTimer) { clearTimeout(this._vadInnerTimer); this._vadInnerTimer = null; }
        this.stop();
        // Remove all listeners BEFORE nulling monitor.
        // In-flight Rust callbacks may still arrive (via napi's scheduler)
        // after stop() returns. Clearing listeners prevents them from emitting
        // events on an object the caller considers dead.
        this.removeAllListeners();
        this.monitor = null;
    }
}