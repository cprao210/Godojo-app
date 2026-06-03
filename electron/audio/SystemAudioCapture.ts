import { EventEmitter } from 'events';
import { loadNativeModule } from './nativeModuleLoader';

// RustAudioCapture is the native Rust class (napi-rs) that captures system audio.
// May be null if the .node binary isn't available — constructor logs an error in that case.
const NativeModule: any = loadNativeModule();
const { SystemAudioCapture: RustAudioCapture } = NativeModule || {};

export class SystemAudioCapture extends EventEmitter {
    private isRecording: boolean = false;
    private _shouldBeRecording: boolean = false;
    private deviceId: string | null = null;
    private detectedSampleRate: number = 48000;
    private monitor: any = null;
    private _chunkCount: number = 0;
    private _vadResetTimer: NodeJS.Timeout | null = null;
    private _vadInnerTimer: NodeJS.Timeout | null = null; // BUG FIX: track inner timer so stop() can cancel it
    private _vadDisabled: boolean = false;
    private _sampleRateEmitted: boolean = false;

    constructor(deviceId?: string | null, options?: { disableVad?: boolean }) {
        super();
        this.deviceId = deviceId || null;
        this._vadDisabled = options?.disableVad ?? false;
        if (!RustAudioCapture) {
            console.error('[SystemAudioCapture] Rust class implementation not found.');
        } else {
            // LAZY INIT: Don't create native monitor here - it causes 1-second audio mute + quality drop
            // The monitor will be created in start() when the meeting actually begins
            console.log(`[SystemAudioCapture] Initialized (lazy). Device ID: ${this.deviceId || 'default'}`);
        }
    }

    public getSampleRate(): number {
        if (this.monitor && typeof this.monitor.getSampleRate === 'function') {
            const nativeRate = this.monitor.getSampleRate();
            if (nativeRate !== this.detectedSampleRate) {
                this.detectedSampleRate = nativeRate;
            }
            return nativeRate;
        }
        return this.detectedSampleRate;
    }

    // Returns the actual PCM output rate after DSP decimation.
    // The Rust SilenceSuppressor decimates by 3x (48000 → 16000).
    // Deepgram must be configured with THIS rate, not the native hardware rate.
    //
    // IMPORTANT: returns 0 when the native rate is not yet known (monitor not started,
    // or hardware hasn't reported a real value yet). The settle-poll in startMeeting()
    // uses 0 as a sentinel to know the rate hasn't settled — do NOT fall back to 16000
    // here, as that causes the poll to exit immediately at elapsed=0 before the hardware
    // reports its real rate, resulting in a mis-configured Deepgram connection.
    public getOutputSampleRate(): number {
        if (!this.monitor) return 0;
        if (typeof this.monitor.get_output_sample_rate === 'function') {
            return this.monitor.get_output_sample_rate();
        }
        // Fallback: infer from the known 3x decimation at 48000 Hz.
        // getSampleRate() returns 0 until CoreAudio/SCK reports the real rate — propagate that 0.
        const native = this.monitor.getSampleRate?.() ?? 0;
        if (native === 0) return 0;
        return native === 48000 ? 16000 : native;
    }

    /**
     * Start capturing audio
     */
    public start(): void {
        if (this.isRecording) return;
        this._shouldBeRecording = true;
        this._chunkCount = 0;

        if (!RustAudioCapture) {
            console.error('[SystemAudioCapture] Cannot start: Rust module missing');
            return;
        }

        // LAZY INIT: Create monitor here when meeting starts (not in constructor)
        // This prevents the 1-second audio mute + quality drop at app launch
        if (!this.monitor) {
            console.log('[SystemAudioCapture] Creating native monitor (lazy init)...');
            try {
                // Pass null VAD threshold to disable silence suppression for system audio
                // System audio is clean speaker output — VAD causes false suppression
                this.monitor = new RustAudioCapture(this.deviceId, { vadDisabled: true });
            } catch (e) {
                console.error('[SystemAudioCapture] Failed to create native monitor:', e);
                this.emit('error', e);
                return;
            }
        }

        try {
            console.log('[SystemAudioCapture] Starting native capture...');

            this.isRecording = true; // Set BEFORE start() to prevent re-entrant calls

            this.monitor.start((err: Error | null, chunk: Buffer) => {
                // napi v3 ThreadsafeFunction passes (err, arg) format
                if (err) {
                    console.error('[SystemAudioCapture] Callback error:', err);
                    this.isRecording = false; // Allow recovery via restart
                    this.emit('error', err);
                    return;
                }
                if (chunk && chunk.length > 0) {
                    const buffer = Buffer.from(chunk);
                    this._chunkCount++;
                    if (Math.random() < 0.02) {
                        console.log(`[SystemAudioCapture] Emitting chunk: ${buffer.length} bytes to JS`);
                    }
                    this.emit('data', buffer);
                }
            }, (err: Error | null, _ended: boolean) => {
                // Speech-ended callback from Rust SilenceSuppressor.
                // _ended is always `true` when fired (Rust only invokes on speech→silence transition).
                if (err) {
                    console.error('[SystemAudioCapture] Speech ended callback error:', err);
                    return;
                }
                this.emit('speech_ended');
            });

            // VAD reset watchdog: if chunks stop flowing for >2s after DSP started,
            // the SilenceSuppressor has locked into suppression. Restart to reset VAD state.
            // Only arm when VAD is active — with vadDisabled=true the Rust DSP is in
            // passthrough mode and lockout is impossible. Running the watchdog anyway
            // causes spurious restarts on an SCK stream that is intentionally silent
            // (e.g. Screen Recording permission denied → zero-buffer PCM), which breaks
            // the Deepgram WebSocket connection unnecessarily.
            if (!this._vadDisabled) {
                const scheduleVadCheck = () => {
                    this._vadResetTimer = setTimeout(() => {
                        this._vadResetTimer = null;
                        if (!this.isRecording) return;
                        const countSnapshot = this._chunkCount;
                        this._vadInnerTimer = setTimeout(() => {
                            this._vadInnerTimer = null;
                            if (!this.isRecording) return; // BUG FIX: guard stale callback after stop()
                            if (this._chunkCount === countSnapshot) {
                                // No new chunks in 2s — VAD is suppressing. Restart capture.
                                console.warn('[SystemAudioCapture] VAD lockout detected — restarting capture to reset state');
                                try { this.monitor?.stop(); } catch { }
                                this.isRecording = false;
                                this._chunkCount = 0;
                                setTimeout(() => {
                                    if (this._shouldBeRecording) {
                                        this.start();
                                    }
                                }, 150);
                            } else {
                                scheduleVadCheck();
                            }
                        }, 2000);
                    }, 3000); // First check at 3s after DSP init
                };
                scheduleVadCheck();
            }

            // getSampleRate MUST be called AFTER start() — background init updates
            // the atomic once SCK/CoreAudio initialises (~5-7s). Reading before start()
            // always returns the constructor default (48000), not the real hardware rate.
            if (typeof this.monitor.getSampleRate === 'function') {
                const pollRate = (label: string) => {
                    const rate = this.monitor?.getSampleRate?.();
                    if (rate && rate !== this.detectedSampleRate) {
                        this.detectedSampleRate = rate;
                        // Use getOutputSampleRate() to get the TRUE post-DSP rate, not raw hardware.
                        // Rust decimates 48000→16000 (3x). For other native rates, use the method which
                        // may call get_output_sample_rate() from Rust if available.
                        const outputRate = this.getOutputSampleRate();
                        console.log(`[SystemAudioCapture] Native: ${rate}Hz → Output: ${outputRate}Hz (${label})`);
                        // Only emit sample-rate-detected if this is the first time we've
                        // seen a non-default rate. On VAD watchdog restart, detectedSampleRate
                        // is already correct — emitting again triggers an unnecessary Deepgram
                        // reconnect via setSampleRate → _reconnectWithNewConfig.
                        if (!this._sampleRateEmitted) {
                            this._sampleRateEmitted = true;
                            this.emit('sample-rate-detected', outputRate);
                        }
                    }
                };
                setTimeout(() => pollRate('1s'), 1000);
                setTimeout(() => pollRate('8s'), 8000);
            }

            this.emit('start');
        } catch (error) {
            console.error('[SystemAudioCapture] Failed to start:', error);
            this.isRecording = false;
            this.emit('error', error);
        }
    }

    /**
     * Stop capturing.
     *
     * FIX-8: Keep the native monitor alive so that resume() doesn't incur the
     * WASAPI/CoreAudio re-initialization latency (300–800ms on Windows).
     * The monitor is only released in destroy() for full teardown.
     * This mirrors the pattern already used by MicrophoneCapture.
     */
    public stop(): void {
        if (!this.isRecording) return;
        this._shouldBeRecording = false;
        if (this._vadResetTimer) { clearTimeout(this._vadResetTimer); this._vadResetTimer = null; }
        if (this._vadInnerTimer) { clearTimeout(this._vadInnerTimer); this._vadInnerTimer = null; } // BUG FIX

        console.log('[SystemAudioCapture] Stopping capture...');
        try {
            this.monitor?.stop();
        } catch (e) {
            console.error('[SystemAudioCapture] Error stopping:', e);
        }

        // FIX-8: Do NOT null out this.monitor here.
        // Keeping the monitor alive avoids the re-init latency on Windows WASAPI
        // (300–800ms) during pause/resume cycles.
        // this.monitor = null;  <-- removed

        this.isRecording = false;
        this.emit('stop');
    }

    /**
     * Permanently dispose this instance.
     * Stops capture, removes all event listeners, and releases the native monitor.
     * After destroy(), do not reuse this instance.
     */
    public destroy(): void {
        this._shouldBeRecording = false;
        this._sampleRateEmitted = false;
        if (this._vadResetTimer) { clearTimeout(this._vadResetTimer); this._vadResetTimer = null; }
        if (this._vadInnerTimer) { clearTimeout(this._vadInnerTimer); this._vadInnerTimer = null; } // BUG FIX
        this.stop();
        // Clear listeners BEFORE nulling monitor. In-flight Rust callbacks (e.g., data
        // or speech_ended delivered via napi scheduler) must not fire after disposal.
        this.removeAllListeners();
        this.monitor = null;
    }
}
