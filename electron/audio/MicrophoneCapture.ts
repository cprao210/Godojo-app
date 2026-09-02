import { EventEmitter } from 'events';
import { loadNativeModule } from './nativeModuleLoader';
import type { CaptureHealth } from './SystemAudioCapture';

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

// ── Supervisor tuning ────────────────────────────────────────────────────────
// Mirrors SystemAudioCapture. A healthy mic channel emits ~10 chunks/s in EVERY
// mode: the Rust SilenceSuppressor sends a 100ms zero keepalive during confirmed
// silence, and the echo gate emits zeros (never nothing) when it mutes. So "no
// chunks at all" always means the native DSP thread or the CPAL stream died —
// it never means "the user is quiet".
const SUPERVISOR_TICK_MS = 1000;
const FAST_BACKOFF_MS = [250, 500, 1000, 2000, 4000];
const SLOW_BACKOFF_MS = 30000;
const LIVENESS_WINDOW_MS = 3000;
const START_GRACE_MS = 5000;

export class MicrophoneCapture extends EventEmitter {
    private monitor: any = null;
    private isRecording: boolean = false;
    private _shouldBeRecording: boolean = false;
    private deviceId: string | null = null;
    private _vadDisabled: boolean = false;
    private _echoMode: string | undefined;
    private _echoAlignSeedMs: number | undefined;

    // ── Supervisor state ────────────────────────────────────────────────────
    // Replaces the old two-timer VAD-lockout watchdog, which was armed only when
    // vadDisabled === false and whose callbacks returned early on `!isRecording`
    // without re-arming — so a dead mic in passthrough mode was never noticed,
    // and a dead mic in VAD mode stopped being watched after the first failure.
    private _supervisorTimer: NodeJS.Timeout | null = null;
    private _reopenTimer: NodeJS.Timeout | null = null;
    private _ratePollTimers: NodeJS.Timeout[] = [];
    private _chunkCount: number = 0;
    private _chunksAtOpen: number = 0;
    private _lastChunkAt = 0;
    private _openedAt = 0;
    private _restartAttempts = 0;
    private _degraded = false;
    private _lastEmittedOutputRate = 0;

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

    public getHealth(): CaptureHealth {
        const now = Date.now();
        return {
            recording: this.isRecording,
            shouldBeRecording: this._shouldBeRecording,
            chunkCount: this._chunkCount,
            msSinceLastChunk: this._lastChunkAt ? now - this._lastChunkAt : null,
            msSinceLastNonSilent: null,
            restartAttempts: this._restartAttempts,
            degraded: this._degraded,
        };
    }

    /**
     * Point capture at a different input device (headset plugged in, default
     * mic changed). The native monitor resolves its CPAL device at construction,
     * so the old one is released and rebuilt on the next open.
     */
    public setDeviceId(deviceId?: string | null): void {
        const next = deviceId || null;
        if (next === this.deviceId) return;
        console.log(`[MicrophoneCapture] Device ${this.deviceId ?? 'default'} → ${next ?? 'default'}`);
        this.deviceId = next;
        this._releaseNativeStream();
        this.monitor = null;
    }

    /**
     * Force the NEXT open to build a fresh native monitor instead of reusing the
     * cached one. Used when the device may have moved while capture was stopped
     * (a long pause): CPAL bound the device at construction, so reusing the
     * monitor would re-open the mic that was default back then.
     */
    public invalidateDeviceBinding(): void {
        this._releaseNativeStream();
        this.monitor = null;
    }

    /** Start capturing, and keep capture alive until stop()/destroy(). */
    public start(): void {
        if (this._shouldBeRecording && this.isRecording) return;
        this._shouldBeRecording = true;
        this._restartAttempts = 0;
        this._openNative();
        this._armSupervisor();
    }

    /**
     * Re-open native capture without touching the meeting or the STT socket.
     * The Rust DSP always emits 16kHz mono regardless of the input device, so a
     * mid-meeting mic swap does not need a Deepgram reconnect and the transcript
     * stays continuous.
     *
     * `rebindDevice` drops the native monitor first. CPAL resolves the input
     * device at construction, so a headset arriving (or the OS default moving)
     * is only picked up by building a new one.
     */
    public restart(reason: string, rebindDevice = false): void {
        if (!this._shouldBeRecording) return;
        console.warn(`[MicrophoneCapture] Restart requested: ${reason}${rebindDevice ? ' (rebinding device)' : ''}`);
        this._restartAttempts = 0;
        if (rebindDevice) {
            this._releaseNativeStream();
            this.monitor = null;
        }
        this._reopen(true);
    }

    private _openNative(): void {
        if (!RustMicCapture) {
            console.error('[MicrophoneCapture] Cannot start: Rust module missing');
            return;
        }
        // Under normal flow the constructor created the monitor (and threw on
        // failure). It is null here after a device swap or an explicit release.
        if (!this.monitor) {
            try {
                this.monitor = new RustMicCapture(this.deviceId, this._vadDisabled, this._captureOptions());
            } catch (e) {
                this._onNativeError(e as Error);
                return;
            }
        }

        this._openedAt = Date.now();
        this._lastChunkAt = 0;
        this._chunksAtOpen = this._chunkCount;
        try {
            console.log('[MicrophoneCapture] Starting native capture...');

            this.isRecording = true; // Set BEFORE start() to prevent re-entrant calls

            this.monitor.start(
                (err: Error | null, chunk: Buffer) => {
                    // napi v3 ThreadsafeFunction passes (err, arg) format
                    if (err) { this._onNativeError(err); return; }
                    if (chunk && chunk.length > 0) {
                        this._chunkCount++;
                        this._lastChunkAt = Date.now();
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

            // Liveness is owned by the single self-re-arming supervisor tick
            // armed in start() — in BOTH vadDisabled modes. See _supervisorTick.
            this._armRatePoll();
            this.emit('start');
        } catch (error) {
            this._onNativeError(error as Error);
        }
    }

    /**
     * Single funnel for every native failure: the data-callback `err` argument,
     * a constructor throw, or a start() throw. Previously the callback path only
     * flipped isRecording and emitted 'error' with nothing scheduled to retry,
     * so a headset unplug or a dead DSP thread left the user channel silent
     * until the meeting was paused and resumed.
     */
    private _onNativeError(err: Error): void {
        const msg = err?.message ?? String(err);
        console.error('[MicrophoneCapture] Native error:', msg);
        this.isRecording = false;
        this.emit('error', err instanceof Error ? err : new Error(msg));
        // A failing open usually means the bound device vanished. Stop the native
        // object first (so the refcounted echo-control registration unwinds), then
        // drop it so the retry re-resolves the device instead of reusing a dead one.
        try { this.monitor?.stop(); } catch { /* already logged below */ }
        this.monitor = null;
        this._reopen(false);
    }

    private _reopen(force: boolean): void {
        if (!this._shouldBeRecording) return;
        if (this._reopenTimer) { clearTimeout(this._reopenTimer); this._reopenTimer = null; }
        const producedNothing = this._chunkCount === this._chunksAtOpen;
        this._releaseNativeStream();

        const attempt = this._restartAttempts;
        const delay = force
            ? 150
            : (attempt < FAST_BACKOFF_MS.length ? FAST_BACKOFF_MS[attempt] : SLOW_BACKOFF_MS);
        if (!force) this._restartAttempts = attempt + 1;

        // A stall-triggered reopen re-uses the existing monitor, which is right
        // when only the CPAL stream died. But when the previous open produced no
        // chunks at all the bound device is gone (headset unplugged), and CPAL
        // resolved it at construction — so re-starting the same object would keep
        // re-binding the dead device forever. Drop it and re-resolve.
        if (!force && producedNothing && attempt >= 1) {
            console.warn('[MicrophoneCapture] Previous open produced no audio — re-resolving the input device.');
            this.monitor = null;
        }

        // Warn the UI once when we leave the fast-retry tier, then keep trying.
        if (!force && this._restartAttempts > FAST_BACKOFF_MS.length && !this._degraded) {
            this._degraded = true;
            this.emit('capture-failed', {
                attempts: this._restartAttempts,
                maxAttempts: FAST_BACKOFF_MS.length,
                permanent: false,
            });
        }
        console.warn(`[MicrophoneCapture] Reopening in ${delay}ms (attempt ${this._restartAttempts})`);
        this._reopenTimer = setTimeout(() => {
            this._reopenTimer = null;
            if (this._shouldBeRecording) this._openNative();
        }, delay);
        this._reopenTimer.unref?.();
        this._armSupervisor();
    }

    private _armSupervisor(): void {
        if (this._supervisorTimer) return;
        this._supervisorTimer = setInterval(() => this._supervisorTick(), SUPERVISOR_TICK_MS);
        this._supervisorTimer.unref?.();
    }

    /**
     * Liveness check, re-armed unconditionally by setInterval and active in both
     * VAD modes. Keepalives make a chunk gap unambiguous: >3s of nothing means
     * the CPAL stream or the DSP thread is gone, never that the user is quiet.
     */
    private _supervisorTick(): void {
        if (!this._shouldBeRecording) { this._clearSupervisor(); return; }
        const now = Date.now();

        if (!this.isRecording) {
            if (!this._reopenTimer) this._reopen(false);
            return;
        }
        if (now - this._openedAt < START_GRACE_MS) return;

        const since = now - (this._lastChunkAt || this._openedAt);
        if (since > LIVENESS_WINDOW_MS) {
            console.warn(`[MicrophoneCapture] Stalled: no chunks for ${since}ms — reopening`);
            this._reopen(false);
            return;
        }

        if (this._restartAttempts > 0 || this._degraded) {
            console.log('[MicrophoneCapture] Healthy again — clearing restart state');
            this._restartAttempts = 0;
            if (this._degraded) {
                this._degraded = false;
                this.emit('capture-recovered');
            }
        }
    }

    private _armRatePoll(): void {
        this._clearRatePoll();
        if (typeof this.monitor?.getSampleRate !== 'function') return;
        const pollMicRate = (label: string) => {
            if (!this.isRecording || !this.monitor) return;
            let rate = 0;
            try { rate = this.monitor.getSampleRate?.() ?? 0; } catch { return; }
            if (!rate) return;
            // The Rust DSP always resamples to 16kHz regardless of native rate,
            // so the DECLARED STT rate comes from getOutputSampleRate().
            const outputRate = this.getOutputSampleRate() || 16000;
            // Emit only on an actual change. The old `_sampleRateEmitted` latch
            // fired at most once per instance, so a rate change after a device
            // hot-swap never re-synced the STT config.
            if (outputRate === this._lastEmittedOutputRate) return;
            this._lastEmittedOutputRate = outputRate;
            console.log(`[MicrophoneCapture] Native: ${rate}Hz → Output: ${outputRate}Hz (${label})`);
            this.emit('sample-rate-detected', outputRate);
        };
        const t1 = setTimeout(() => pollMicRate('1s'), 1000);
        const t2 = setTimeout(() => pollMicRate('3s'), 3000);
        t1.unref?.(); t2.unref?.();
        this._ratePollTimers.push(t1, t2);
    }

    private _clearRatePoll(): void {
        for (const t of this._ratePollTimers) clearTimeout(t);
        this._ratePollTimers = [];
    }

    private _clearSupervisor(): void {
        if (this._supervisorTimer) { clearInterval(this._supervisorTimer); this._supervisorTimer = null; }
    }

    private _clearTimers(): void {
        this._clearSupervisor();
        this._clearRatePoll();
        if (this._reopenTimer) { clearTimeout(this._reopenTimer); this._reopenTimer = null; }
    }

    /** Stop the native stream but keep the monitor for a fast restart. */
    private _releaseNativeStream(): void {
        this._clearRatePoll();
        if (this.monitor && this.isRecording) {
            try { this.monitor.stop(); } catch (e) { console.error('[MicrophoneCapture] stop() failed:', e); }
        }
        this.isRecording = false;
    }

    /** Stop capturing. Clears intent, so the supervisor stands down too. */
    public stop(): void {
        this._shouldBeRecording = false;
        this._clearTimers();
        const wasRecording = this.isRecording;
        if (wasRecording) {
            console.log('[MicrophoneCapture] Stopping capture...');
            try { this.monitor?.stop(); } catch (e) { console.error('[MicrophoneCapture] Error stopping:', e); }
        }
        this.isRecording = false;
        this._restartAttempts = 0;
        this._degraded = false;
        // DO NOT null the monitor here — keeping it alive makes the next start()
        // seamless. Native start() re-resolves the CPAL device (stop() sets
        // input = None), so no stale device binding survives a restart.
        this.emit('stop');
    }

    public destroy(): void {
        this._shouldBeRecording = false;
        this._clearTimers();
        this._lastEmittedOutputRate = 0;
        this.stop();
        // Remove all listeners BEFORE nulling monitor.
        // In-flight Rust callbacks may still arrive (via napi's scheduler)
        // after stop() returns. Clearing listeners prevents them from emitting
        // events on an object the caller considers dead.
        this.removeAllListeners();
        this.monitor = null;
    }
}