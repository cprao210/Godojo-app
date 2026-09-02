import { EventEmitter } from 'events';
import { loadNativeModule } from './nativeModuleLoader';

// RustAudioCapture is the native Rust class (napi-rs) that captures system audio.
// May be null if the .node binary isn't available — constructor logs an error in that case.
const NativeModule: any = loadNativeModule();
const { SystemAudioCapture: RustAudioCapture } = NativeModule || {};

/**
 * Liveness snapshot for a capture channel.
 *
 * The main process polls this to tell "the device is fine, the room is quiet"
 * apart from "we are bound to an endpoint that no longer carries the meeting
 * audio". Amplitude alone cannot make that distinction — the native layer emits
 * bit-exact zeros both for keepalives and for a render endpoint that went idle
 * because playback moved to a different device.
 */
export interface CaptureHealth {
    recording: boolean;
    shouldBeRecording: boolean;
    chunkCount: number;
    msSinceLastChunk: number | null;
    msSinceLastNonSilent: number | null;
    restartAttempts: number;
    degraded: boolean;
}

// ── Supervisor tuning ────────────────────────────────────────────────────────
// The previous design was a one-way door: an error in the native data callback,
// or 5 stall-triggered restarts, left `_shouldBeRecording = false` with no timer
// armed. From then on only resumeMeeting() could revive capture — which is
// exactly why the field workaround was "pause and resume the meeting". This
// supervisor never stops trying while the caller wants audio: fast retries
// first, then an indefinite slow retry so a genuinely dead device stops
// thrashing (and stops re-raising macOS TCC prompts) without going silent
// for the rest of the meeting.
const SUPERVISOR_TICK_MS = 1000;
const FAST_BACKOFF_MS = [250, 500, 1000, 2000, 4000];
const SLOW_BACKOFF_MS = 30000;
// Retrying cannot fix a platform that has no system-audio backend at all.
const PERMANENT_ERROR_RE = /not supported on this platform/i;
// A chunk counts as non-silent once any sampled value exceeds this.
const NON_SILENT_THRESHOLD = 8;

export class SystemAudioCapture extends EventEmitter {
    private isRecording = false;
    private _shouldBeRecording = false;
    private deviceId: string | null = null;
    private detectedSampleRate = 48000;
    private monitor: any = null;
    private _echoMode: string | undefined;

    // ── Supervisor state ────────────────────────────────────────────────────
    private _supervisorTimer: NodeJS.Timeout | null = null;
    private _reopenTimer: NodeJS.Timeout | null = null;
    private _ratePollTimers: NodeJS.Timeout[] = [];
    private _chunkCount = 0;
    private _chunksAtOpen = 0;
    private _lastChunkAt = 0;
    private _lastNonSilentAt = 0;
    private _openedAt = 0;
    private _restartAttempts = 0;
    private _degraded = false;
    private _permanentlyFailed = false;
    private _lastEmittedOutputRate = 0;
    private readonly _featureLevel: number;
    private readonly _stallWindowMs: number;
    private readonly _startGraceMs: number;

    constructor(deviceId?: string | null, options?: { echoMode?: string }) {
        super();
        this.deviceId = deviceId || null;
        this._echoMode = options?.echoMode;
        this._featureLevel = typeof NativeModule?.getNativeFeatureLevel === 'function'
            ? (NativeModule.getNativeFeatureLevel() ?? 0)
            : 0;
        // A healthy channel emits ~10 chunks/s (100ms silence keepalives), so
        // "no chunks at all" is always a real fault. Binaries that keep the ring
        // fed during render-idle (level >= 2) get a long last-resort window;
        // older ones keep the aggressive default because they genuinely stall
        // when the far end goes quiet.
        this._stallWindowMs = this._featureLevel >= 2 ? 10000 : 3000;
        // macOS CoreAudio-tap / ScreenCaptureKit init takes 5-7s. Judging a
        // stall before that just restarts a capture that was still coming up.
        // Linux resolves its monitor source through a PulseAudio connection
        // handshake plus two introspection round-trips, so a sound server that
        // is slow to settle can push first audio past the 5s default.
        this._startGraceMs = process.platform === 'darwin'
            ? 12000
            : process.platform === 'linux'
                ? 8000
                : 5000;
        if (!RustAudioCapture) {
            console.error('[SystemAudioCapture] Rust class implementation not found.');
        } else {
            // LAZY INIT: constructing the native monitor here caused a ~1s audio
            // mute at app launch, so it is created on first start() instead.
            console.log(`[SystemAudioCapture] Initialized (lazy). Device: ${this.deviceId || 'default'}, featureLevel=${this._featureLevel}`);
        }
    }

    public getSampleRate(): number {
        return this.detectedSampleRate;
    }

    /** Rate the DSP actually emits (always 16kHz today), or 0 before init. */
    public getOutputSampleRate(): number {
        if (!this.monitor) return 0;
        try {
            return typeof this.monitor.getOutputSampleRate === 'function'
                ? this.monitor.getOutputSampleRate()
                : 16000;
        } catch {
            return 16000;
        }
    }

    public getHealth(): CaptureHealth {
        const now = Date.now();
        return {
            recording: this.isRecording,
            shouldBeRecording: this._shouldBeRecording,
            chunkCount: this._chunkCount,
            msSinceLastChunk: this._lastChunkAt ? now - this._lastChunkAt : null,
            msSinceLastNonSilent: this._lastNonSilentAt ? now - this._lastNonSilentAt : null,
            restartAttempts: this._restartAttempts,
            degraded: this._degraded,
        };
    }

    /**
     * Point capture at a different output device. The native monitor binds its
     * endpoint at construction, so the existing one is released; the next
     * (re)open builds a fresh monitor against the new id.
     */
    public setDeviceId(deviceId?: string | null): void {
        const next = deviceId || null;
        if (next === this.deviceId) return;
        console.log(`[SystemAudioCapture] Device ${this.deviceId ?? 'default'} → ${next ?? 'default'}`);
        this.deviceId = next;
        this._releaseMonitor();
    }

    /**
     * Force the NEXT open to build a fresh native monitor instead of reusing the
     * cached one. Used when the endpoint may have moved while capture was stopped
     * (a long pause): reusing the monitor would re-bind the endpoint that was
     * default when it was constructed.
     */
    public invalidateDeviceBinding(): void {
        this._releaseMonitor();
    }

    public start(): void {
        if (this._shouldBeRecording && this.isRecording) {
            console.log('[SystemAudioCapture] Already recording.');
            return;
        }
        this._shouldBeRecording = true;
        this._permanentlyFailed = false;
        this._restartAttempts = 0;
        this._openNative();
        this._armSupervisor();
    }

    /**
     * Re-open native capture without touching the meeting or the STT socket.
     * This is the device hot-swap entry point: the native DSP always emits
     * 16kHz mono whatever the endpoint is, so Deepgram stays connected and the
     * rolling transcript is continuous across the swap.
     *
     * `rebindDevice` drops the native monitor first, which is what actually
     * re-resolves the endpoint: the loopback client (WASAPI) and the CoreAudio
     * aggregate device are both bound at construction, so a default-output
     * change is only picked up by building a new one.
     */
    public restart(reason: string, rebindDevice = false): void {
        if (!this._shouldBeRecording) return;
        console.warn(`[SystemAudioCapture] Restart requested: ${reason}${rebindDevice ? ' (rebinding endpoint)' : ''}`);
        this._restartAttempts = 0;
        this._permanentlyFailed = false;
        if (rebindDevice) this._releaseMonitor();
        this._reopen(true);
    }

    private _openNative(): void {
        if (!RustAudioCapture) {
            // Missing .node binary is not a transient fault — do not spin on it.
            this._onNativeError(new Error('System audio capture is not supported on this platform (native module unavailable)'));
            return;
        }
        if (!this.monitor) {
            try {
                // System audio is clean speaker output, so the Rust side runs its
                // permissive for_system_audio() suppressor; echoMode selects the
                // mic-gate pipeline (CaptureOptions is shared by both ctors).
                this.monitor = new RustAudioCapture(this.deviceId, {
                    vadDisabled: true,
                    echoMode: this._echoMode,
                });
            } catch (e) {
                this._onNativeError(e as Error);
                return;
            }
        }
        this._openedAt = Date.now();
        this._lastChunkAt = 0;
        this._chunksAtOpen = this._chunkCount;
        try {
            console.log('[SystemAudioCapture] Starting native capture...');
            // Set before start() so a synchronous native callback cannot race a
            // re-entrant open.
            this.isRecording = true;
            this.monitor.start(
                (err: Error | null, chunk: Buffer) => {
                    if (err) { this._onNativeError(err); return; }
                    if (!chunk || chunk.length === 0) return;
                    const buffer = Buffer.from(chunk);
                    this._chunkCount++;
                    this._lastChunkAt = Date.now();
                    if (this._isNonSilent(buffer)) this._lastNonSilentAt = this._lastChunkAt;
                    this.emit('data', buffer);
                },
                (err: Error | null) => {
                    if (err) {
                        console.error('[SystemAudioCapture] speech-ended callback error:', err);
                        return;
                    }
                    this.emit('speech_ended');
                }
            );
            this._armRatePoll();
            this.emit('start');
        } catch (error) {
            this._onNativeError(error as Error);
        }
    }

    /**
     * Single funnel for every native failure: the data-callback `err` argument
     * (how the Rust background thread reports init failure), a constructor
     * throw, or a start() throw. Previously the data-callback path only set
     * isRecording = false and emitted 'error' — nothing restarted, and the
     * watchdog chain died with it, so the channel stayed dead for the rest of
     * the meeting.
     */
    private _onNativeError(err: Error): void {
        const msg = err?.message ?? String(err);
        console.error('[SystemAudioCapture] Native error:', msg);
        this.isRecording = false;
        this.emit('error', err instanceof Error ? err : new Error(msg));
        if (PERMANENT_ERROR_RE.test(msg)) {
            // No backend exists on this platform — retrying would just loop.
            this._permanentlyFailed = true;
            this._shouldBeRecording = false;
            this._clearTimers();
            this.emit('capture-failed', {
                attempts: this._restartAttempts,
                maxAttempts: FAST_BACKOFF_MS.length,
                permanent: true,
                message: msg,
            });
            return;
        }
        this._reopen(false);
    }

    private _reopen(force: boolean): void {
        if (!this._shouldBeRecording || this._permanentlyFailed) return;
        if (this._reopenTimer) { clearTimeout(this._reopenTimer); this._reopenTimer = null; }
        const producedNothing = this._chunkCount === this._chunksAtOpen;
        this._releaseNativeStream();

        const attempt = this._restartAttempts;
        const delay = force
            ? 150
            : (attempt < FAST_BACKOFF_MS.length ? FAST_BACKOFF_MS[attempt] : SLOW_BACKOFF_MS);
        if (!force) this._restartAttempts = attempt + 1;

        // Ladder: the first retry re-opens the existing monitor, which is enough
        // when only the stream died. If that open produced no chunks at all the
        // endpoint itself is gone (unplugged, default moved), and re-starting the
        // same native object just re-binds the same dead endpoint — so drop it and
        // let the next open resolve the device again. Deferred to the second
        // attempt because rebuilding costs a CoreAudio/SCK re-init on macOS.
        if (!force && producedNothing && attempt >= 1) {
            console.warn('[SystemAudioCapture] Previous open produced no audio — rebinding the endpoint.');
            this.monitor = null;
        }

        // Crossing out of the fast tier is worth telling the UI about — once.
        // Unlike the old code we keep retrying afterwards, so this is a warning,
        // not a terminal state.
        if (!force && this._restartAttempts > FAST_BACKOFF_MS.length && !this._degraded) {
            this._degraded = true;
            this.emit('capture-failed', {
                attempts: this._restartAttempts,
                maxAttempts: FAST_BACKOFF_MS.length,
                permanent: false,
            });
        }
        console.warn(`[SystemAudioCapture] Reopening in ${delay}ms (attempt ${this._restartAttempts})`);
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
     * The single place that decides whether capture is alive, re-armed
     * unconditionally by setInterval. The old chained-setTimeout watchdog began
     * every tick with `if (!this.isRecording) return;` and never re-armed, so
     * the self-healing loop stopped at exactly the moment it was needed.
     */
    private _supervisorTick(): void {
        if (!this._shouldBeRecording) { this._clearSupervisor(); return; }
        const now = Date.now();

        if (!this.isRecording) {
            // Not recording and no reopen pending = we lost the chain somewhere.
            if (!this._reopenTimer) this._reopen(false);
            return;
        }

        // Still inside the native init window — not a stall yet.
        if (now - this._openedAt < this._startGraceMs) return;

        const since = now - (this._lastChunkAt || this._openedAt);
        if (since > this._stallWindowMs) {
            console.warn(`[SystemAudioCapture] Stalled: no chunks for ${since}ms — reopening`);
            this._reopen(false);
            return;
        }

        // Chunks are flowing again.
        if (this._restartAttempts > 0 || this._degraded) {
            console.log('[SystemAudioCapture] Healthy again — clearing restart state');
            this._restartAttempts = 0;
            if (this._degraded) {
                this._degraded = false;
                this.emit('capture-recovered');
            }
        }
    }

    /** Cheap peak probe; the native layer emits bit-exact zeros for keepalives. */
    private _isNonSilent(buf: Buffer): boolean {
        for (let i = 0; i + 1 < buf.length; i += 64) {
            if (Math.abs(buf.readInt16LE(i)) > NON_SILENT_THRESHOLD) return true;
        }
        return false;
    }

    private _armRatePoll(): void {
        this._clearRatePoll();
        const pollRate = (label: string) => {
            if (!this.isRecording || !this.monitor) return;
            let rate = 0;
            try { rate = this.monitor.getSampleRate?.() ?? 0; } catch { return; }
            if (rate) this.detectedSampleRate = rate;
            const outputRate = this.getOutputSampleRate();
            if (!outputRate) return;
            // Emit only when the DECLARED output rate actually changes. The old
            // `_sampleRateEmitted` latch fired at most once per instance, so a
            // rate change after a hot-swap never reached the STT; emitting on
            // every poll instead would force needless Deepgram reconnects.
            if (outputRate === this._lastEmittedOutputRate) return;
            this._lastEmittedOutputRate = outputRate;
            console.log(`[SystemAudioCapture] Native ${rate}Hz → output ${outputRate}Hz (${label})`);
            this.emit('sample-rate-detected', outputRate);
        };
        const t1 = setTimeout(() => pollRate('1s'), 1000);
        const t2 = setTimeout(() => pollRate('8s'), 8000);
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

    /** Stop the native stream but keep the monitor object (see FIX-8 in stop()). */
    private _releaseNativeStream(): void {
        this._clearRatePoll();
        if (this.monitor && this.isRecording) {
            try { this.monitor.stop(); } catch (e) { console.error('[SystemAudioCapture] stop() failed:', e); }
        }
        this.isRecording = false;
    }

    private _releaseMonitor(): void {
        this._releaseNativeStream();
        this.monitor = null;
    }

    public stop(): void {
        // Clear intent FIRST so a callback landing during teardown cannot
        // schedule a reopen behind our back.
        this._shouldBeRecording = false;
        this._clearTimers();
        const wasRecording = this.isRecording;
        if (wasRecording) {
            console.log('[SystemAudioCapture] Stopping capture...');
            try { this.monitor?.stop(); } catch (e) { console.error('[SystemAudioCapture] Error stopping:', e); }
        }
        this.isRecording = false;
        this._restartAttempts = 0;
        this._degraded = false;
        // FIX-8: deliberately keep `this.monitor` so a later start() reuses the
        // native object instead of paying construction cost again. start()
        // re-resolves the device inside the native thread, so a stale endpoint
        // binding is not carried across a restart.
        this.emit('stop');
    }

    /** Full teardown — after this the instance must not be reused. */
    public destroy(): void {
        this._shouldBeRecording = false;
        this._permanentlyFailed = true;
        this._clearTimers();
        try { this.stop(); } catch { /* already logged */ }
        this.removeAllListeners();
        this.monitor = null;
    }
}
