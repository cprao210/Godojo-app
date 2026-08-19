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
    private _stallOuterTimer: NodeJS.Timeout | null = null;
    private _stallInnerTimer: NodeJS.Timeout | null = null; // tracked so stop() can cancel it
    // Consecutive stall-triggered restarts. Capped so a permanently broken
    // capture (revoked permission, missing device) stops silently thrashing and
    // instead reports itself once. Reset whenever chunks flow again.
    private _stallRestartAttempts: number = 0;
    private static readonly MAX_STALL_RESTARTS = 5;
    private _sampleRateEmitted: boolean = false;
    private _echoMode: string | undefined;

    constructor(deviceId?: string | null, options?: { echoMode?: string }) {
        super();
        this.deviceId = deviceId || null;
        this._echoMode = options?.echoMode;
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
    public getOutputSampleRate(): number {
        // Touch getSampleRate() so detectedSampleRate stays current for logging.
        this.getSampleRate();
        // Return 0 if monitor hasn't started yet so callers (poll in startMeeting)
        // know the rate is not settled.
        if (!this.monitor) return 0;
        // The napi-rs binding exposes Rust's get_output_sample_rate() as camelCase
        // getOutputSampleRate() (see native-module/index.d.ts). The old snake_case
        // check never matched, so this always fell through to the buggy fallback
        // below — which leaked WASAPI's 44100 mix rate on Windows and declared the
        // wrong sample_rate to Deepgram (macOS's 48000 masked it via the ternary).
        if (typeof this.monitor.getOutputSampleRate === 'function') {
            return this.monitor.getOutputSampleRate();
        }
        // Fallback for older native builds without the method: the Rust DSP always
        // resamples output to 16kHz regardless of native rate, so 16000 is correct.
        return 16000;
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
                // System audio is clean speaker output — the Rust side always runs
                // the permissive for_system_audio() suppressor; echoMode selects the
                // mic-gate pipeline (CaptureOptions is shared by both constructors).
                this.monitor = new RustAudioCapture(this.deviceId, { vadDisabled: true, echoMode: this._echoMode });
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

            // Capture-stall watchdog: if the native layer stops emitting chunks,
            // restart capture. The recovery target is a dead native capture thread —
            // on Windows the WASAPI event-driven loopback thread can exit during
            // far-end silence on older native builds. It is ALWAYS armed (a healthy
            // pipeline emits SendSilence keepalives continuously, so this only fires on
            // genuine capture death). The window is chosen by native feature level:
            // binaries that synthesize silence during render-idle (level >= 2) keep
            // chunks flowing, so a long last-resort window suffices; older binaries
            // keep the aggressive default so recovery stays fast.
            const featureLevel = (typeof NativeModule?.getNativeFeatureLevel === 'function')
                ? (NativeModule.getNativeFeatureLevel() ?? 0)
                : 0;
            const stallWindowMs = featureLevel >= 2 ? 10000 : 2000;
            console.log(`[SystemAudioCapture] Capture-stall watchdog armed (featureLevel=${featureLevel} window=${stallWindowMs}ms)`);
            const scheduleStallCheck = () => {
                this._stallOuterTimer = setTimeout(() => {
                    this._stallOuterTimer = null;
                    if (!this.isRecording) return;
                    const countSnapshot = this._chunkCount;
                    this._stallInnerTimer = setTimeout(() => {
                        this._stallInnerTimer = null;
                        if (!this.isRecording) return; // guard stale callback after stop()
                        if (this._chunkCount === countSnapshot) {
                            // No new chunks in the window — native capture has stalled/died.
                            if (this._stallRestartAttempts >= SystemAudioCapture.MAX_STALL_RESTARTS) {
                                // Restarting is not helping. Something structural is wrong
                                // (permission revoked, device gone), so stop thrashing and
                                // say so once — an unbounded retry loop just hides the cause.
                                console.error(`[SystemAudioCapture] Capture stalled after ${this._stallRestartAttempts} restart attempts — giving up.`);
                                try { this.monitor?.stop(); } catch { }
                                this.isRecording = false;
                                this._shouldBeRecording = false;
                                this.emit('capture-failed', {
                                    attempts: this._stallRestartAttempts,
                                    maxAttempts: SystemAudioCapture.MAX_STALL_RESTARTS,
                                });
                                return;
                            }
                            this._stallRestartAttempts++;
                            console.warn(`[SystemAudioCapture] Capture stall detected (no chunks in ${stallWindowMs}ms, featureLevel=${featureLevel}) — restarting capture (attempt ${this._stallRestartAttempts}/${SystemAudioCapture.MAX_STALL_RESTARTS})`);
                            try { this.monitor?.stop(); } catch { }
                            this.isRecording = false;
                            this._chunkCount = 0;
                            setTimeout(() => {
                                if (this._shouldBeRecording) {
                                    this.start();
                                }
                            }, 150);
                        } else {
                            // Chunks flowing again — the capture recovered, so forget the
                            // earlier attempts and keep watching (always re-arm).
                            this._stallRestartAttempts = 0;
                            scheduleStallCheck();
                        }
                    }, stallWindowMs);
                }, 3000); // First check 3s after DSP init
            };
            scheduleStallCheck();

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
        if (this._stallOuterTimer) { clearTimeout(this._stallOuterTimer); this._stallOuterTimer = null; }
        if (this._stallInnerTimer) { clearTimeout(this._stallInnerTimer); this._stallInnerTimer = null; }

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
        if (this._stallOuterTimer) { clearTimeout(this._stallOuterTimer); this._stallOuterTimer = null; }
        if (this._stallInnerTimer) { clearTimeout(this._stallInnerTimer); this._stallInnerTimer = null; }
        this.stop();
        // Clear listeners BEFORE nulling monitor. In-flight Rust callbacks (e.g., data
        // or speech_ended delivered via napi scheduler) must not fire after disposal.
        this.removeAllListeners();
        this.monitor = null;
    }
}
