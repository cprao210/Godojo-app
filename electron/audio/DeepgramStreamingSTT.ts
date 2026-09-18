/**
 * DeepgramStreamingSTT - Streaming Speech-to-Text using @deepgram/sdk
 *
 * KEY FIX: Uses createConnection() + socket.connect() pattern instead of connect().
 *
 * The old connect() flow:
 *   listen.v1.connect() → async → .then(socket => socket.on('open', handler))
 * Problem: ReconnectingWebSocket._connect() fires in the constructor (even with
 * startClosed:true). By the time .then() runs and socket.on('open') is registered,
 * the WS 'open' event has already fired into V1Socket.handleOpen, which calls
 * eventHandlers.open — but that's still undefined. So 'Connected' is never logged
 * and the buffer flush never runs.
 *
 * The fix: createConnection() returns the socket BEFORE connecting. We register
 * all handlers synchronously, then call socket.connect() to initiate the WS.
 */

import { EventEmitter } from 'events';
import { DeepgramClient } from '@deepgram/sdk';
import { V1Socket } from '@deepgram/sdk/dist/cjs/api/resources/listen/resources/v1/client/Socket';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import {
    appendAnchor,
    convertStreamSecToWallMs,
    splitFinalBySpeaker,
    type SttWord,
    type TimeAnchor,
} from './sttWordUtils';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const KEEPALIVE_INTERVAL_MS = 5000;
// A connection must stay open at least this long to count as "stable" and reset
// the exponential-backoff counter. Shorter-lived connections keep escalating the
// delay so a flapping server / repeated 429 backs off instead of hammering at 1s.
const STABLE_CONNECTION_MS = 30000;
// Hard deadline on a single connect attempt. `isConnecting` is normally cleared
// by 'open' / 'close' / 'error', but if the WS handshake hangs without firing any
// of them the flag latches true forever and connect() no-ops at its guard — the
// STT then never recovers for the rest of the meeting, silently. This bounds that.
const CONNECT_TIMEOUT_MS = 15000;

export interface DeepgramSttOptions {
    /**
     * Enable Deepgram streaming diarization on this connection. Only useful on
     * the client (system-audio) stream — the mic is single-speaker by role.
     * NOTE: paid streaming add-on (~$0.002/min on top of Nova-3).
     */
    diarize?: boolean;
}

export class DeepgramStreamingSTT extends EventEmitter {
    private apiKey: string;
    private client: DeepgramClient;
    private socket: V1Socket | null = null;
    private isActive = false;
    private shouldReconnect = false;

    private sampleRate = 16000;
    private numChannels = 1;
    private languageCode = 'en';

    private reconnectAttempts = 0;
    private rateLimitedUntil = 0;
    // Wall-clock ms of the last successful 'open'. Backoff is only reset after a
    // connection proves STABLE (see STABLE_CONNECTION_MS) — resetting on every open
    // let a socket that accepts then immediately drops (server flap / post-open 429)
    // reconnect at the 1s floor forever, defeating exponential backoff.
    private _openedAt = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private connectTimeoutTimer: NodeJS.Timeout | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private buffer: Buffer[] = [];
    private isConnecting = false;

    private _lastIsFinalText: string = '';
    private _lastIsFinalConfidence: number = 1.0;
    private role: 'client' | 'user' = 'user';
    private _connectGeneration = 0;

    private diarize = false;
    // Per-connection audio clock → wall clock mapping. Word timestamps arrive
    // in stream-audio seconds; the anchor ring converts them to wall-clock ms
    // so cross-connection comparison (echo filtering) sees one time base.
    private _bytesSent = 0;
    private _anchors: TimeAnchor[] = [];

    constructor(apiKey: string, role: 'client' | 'user' = 'user', options?: DeepgramSttOptions) {
        super();
        this.apiKey = apiKey;
        this.role = role;
        this.diarize = options?.diarize ?? false;
        this.client = new DeepgramClient({ apiKey });
    }

    // =========================================================================
    // Configuration
    // =========================================================================

    public get currentSampleRate(): number { return this.sampleRate; }

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        const wasActive = this.isActive;
        this.sampleRate = rate;
        console.log(`[DeepgramStreaming:${this.role}] Sample rate set to ${rate}`);
        if (wasActive) this._reconnectWithNewConfig();
    }

    public setAudioChannelCount(count: number): void {
        if (this.numChannels === count) return;
        const wasActive = this.isActive;
        this.numChannels = count;
        console.log(`[DeepgramStreaming:${this.role}] Channel count set to ${count}`);
        if (wasActive) this._reconnectWithNewConfig();
    }

    public setRecognitionLanguage(key: string): void {
        const config = RECOGNITION_LANGUAGES[key];
        if (config) {
            this.languageCode = config.deepgram ?? config.iso639;
            console.log(`[DeepgramStreaming:${this.role}] Language set to ${this.languageCode}`);
            if (this.isActive) {
                const savedBuffer = [...this.buffer];
                this.stop();
                this.start();
                this.buffer = savedBuffer;
            }
        }
    }

    public setCredentials(_path: string): void { }
    public notifySpeechEnded(): void { }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    public start(): void {
        if (this.isActive) return;
        this.isActive = true;
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.connect();
    }

    public stop(): void {
        this.shouldReconnect = false;
        this.clearTimers();

        if (this._isSocketOpen() && this.buffer.length > 0) {
            for (const chunk of this.buffer) {
                this._sendTracked(this.socket!, chunk);
            }
        }

        this._closeSocket();
        this.isActive = false;
        this.isConnecting = false;
        this.buffer = [];
        this._lastIsFinalText = '';
        this._lastIsFinalConfidence = 1.0;
        console.log(`[DeepgramStreaming:${this.role}] Stopped`);
    }

    // =========================================================================
    // Audio Data
    // =========================================================================

    public write(chunk: Buffer): void {
        if (!this.isActive) return;

        if (!this.socket || !this._isSocketOpen()) {
            this.buffer.push(chunk);
            if (this.buffer.length > 500) this.buffer.shift();
            if (!this.isConnecting && this.shouldReconnect && !this.reconnectTimer) {
                console.log(`[DeepgramStreaming:${this.role}] Socket not ready — lazy connecting...`);
                this.connect();
            }
            return;
        }

        this._sendTracked(this.socket, chunk, true);
    }

    /**
     * Single choke point for sendMedia: advances the per-connection audio
     * clock (_bytesSent) and records a {streamSec, wallMs} anchor so word
     * timestamps can be mapped back to wall time.
     */
    private _sendTracked(socket: V1Socket, chunk: Buffer, logErrors = false): void {
        try {
            socket.sendMedia(chunk);
            this._bytesSent += chunk.length;
            const bytesPerSec = this.sampleRate * 2 * this.numChannels; // s16le
            if (bytesPerSec > 0) {
                appendAnchor(this._anchors, this._bytesSent / bytesPerSec, Date.now());
            }
        } catch (err) {
            if (logErrors) console.error(`[DeepgramStreaming:${this.role}] sendMedia error:`, err);
        }
    }

    // =========================================================================
    // Connection
    //
    // Uses createConnection() + socket.connect() so we can register all event
    // handlers BEFORE the WebSocket handshake begins, eliminating the race where
    // the 'open' event fires before socket.on('open', handler) is called.
    // =========================================================================

    private connect(): void {
        if (this.isConnecting) return;
        this.isConnecting = true;
        const generation = ++this._connectGeneration;  // capture current generation

        // A single close/error pair must produce exactly ONE reconnect. The 'error'
        // handler calls _closeSocket(), but the WS has usually fired 'close' already
        // — so 'close' ran once naturally and once synthetically, each scheduling a
        // reconnect. The second scheduleReconnect() overwrote reconnectTimer and
        // LEAKED the first timer, which then fired one backoff later and tore down
        // the socket the first timer had just established (observed in the field as
        // `Reconnecting in 2000ms (attempt 2)` + `Reconnecting in 4000ms (attempt 3)`
        // logged in the same millisecond, followed 4s later by `Stale socket closed
        // (gen 3 vs 4)`). This per-socket latch makes 'close' idempotent.
        let closeHandled = false;

        this._armConnectDeadline(generation);

        // Defensively tear down any prior socket before opening a new one. Without
        // this, the previous socket's internal ReconnectingWebSocket (maxRetries:
        // Infinity) keeps retrying in the background forever — a zombie connection
        // that never backs off. Accumulated zombies pin Deepgram's concurrency
        // count and turn a transient 429 into a permanent one.
        this._closeSocket();

        // New websocket = new stream-audio clock. Reset the anchor ring so word
        // timestamps from this connection map against its own byte count.
        this._bytesSent = 0;
        this._anchors = [];
        if (this.diarize && this.reconnectAttempts > 0) {
            // Diarization speaker indices are per-connection: after a reconnect
            // they restart from 0 and may not match the previous assignment.
            console.warn(`[DeepgramStreaming:${this.role}] Reconnecting with diarize on — speaker indices will reset`);
        }

        console.log(`[DeepgramStreaming:${this.role}] Connecting (rate=${this.sampleRate}, ch=${this.numChannels}, lang=${this.languageCode}, diarize=${this.diarize})...`);

        const queryParams: Record<string, unknown> = {
            Authorization: `Token ${this.apiKey}`,
            model: 'nova-3',
            encoding: 'linear16',
            sample_rate: this.sampleRate,
            channels: this.numChannels,
            language: this.languageCode,
            smart_format: "true",
            interim_results: "true",
            utterance_end_ms: "1500",
            vad_events: "true",
            // Deepgram recommends endpointing=100 for multilingual code-switching
            endpointing: this.languageCode === 'multi' ? "100" : "500",
        };
        if (this.diarize) {
            queryParams.diarize = "true";
        }

        // createConnection() returns an unconnected socket — safe to register
        // handlers before any WS event can fire.
        (this.client.listen.v1 as any).createConnection(queryParams)
            .then((socket: V1Socket) => {

                // If a newer connect() call was made while this promise was pending,
                // discard this stale socket entirely.
                if (generation !== this._connectGeneration) {
                    console.log(`[DeepgramStreaming:${this.role}] Discarding stale socket (gen ${generation} vs ${this._connectGeneration})`);
                    try { socket.close(); } catch { /* ignore */ }
                    // Do NOT clear isConnecting here: a newer connect() owns that flag
                    // now and clearing it would let a third connect() race in. The
                    // newer generation's own handlers/deadline manage it.
                    return;
                }

                this.socket = socket;

                // ---- open ----
                // Registered BEFORE socket.connect() fires the WS handshake.
                // No race condition possible.
                socket.on('open', () => {
                    // A newer connect() may have superseded this socket while its WS
                    // handshake was in flight. If so, ignore its events entirely — the
                    // 'close' guard below is the important one: without it, this stale
                    // socket's async close schedules a reconnect that tears down the
                    // healthy current socket, whose close then schedules another... a
                    // self-sustaining 1s connect/close loop (seen on Windows after the
                    // rate resync triggered _reconnectWithNewConfig).
                    if (generation !== this._connectGeneration) return;
                    this.isConnecting = false;
                    this._clearConnectDeadline();
                    // Do NOT reset reconnectAttempts here — only reset once the
                    // connection proves stable (see 'close' handler) or once it has
                    // actually delivered a transcript (see 'message'). Record when it
                    // opened so 'close' can measure how long it survived.
                    this._openedAt = Date.now();
                    console.log(`[DeepgramStreaming:${this.role}] Connected`);

                    // Flush audio buffered during the handshake
                    while (this.buffer.length > 0) {
                        const chunk = this.buffer.shift();
                        if (chunk) {
                            this._sendTracked(socket, chunk);
                        }
                    }

                    this.startKeepAlive();
                });

                // ---- message ----
                socket.on('message', (data: any) => {
                    // Drop messages from a socket that a newer connect() superseded —
                    // its transcripts belong to a dead connection and its anchor ring
                    // (_anchors/_bytesSent) now describes the current socket's clock.
                    if (generation !== this._connectGeneration) return;
                    if (!data) return;

                    if (data.type === 'SpeechStarted') {
                        console.log(`[DeepgramStreaming:${this.role}] SpeechStarted`);
                        return;
                    }

                    if (data.type === 'UtteranceEnd') {
                        console.log(`[DeepgramStreaming:${this.role}] UtteranceEnd`);
                        // UtteranceEnd is a belt-and-suspenders flush. In practice it only
                        // fires reliably on the user (mic) socket. On the client (system
                        // audio) socket, VAD lockout restarts interrupt the stream before
                        // Deepgram can send it. Since is_final windows already emit
                        // isFinal:true directly (see below), _lastIsFinalText should normally
                        // be empty here. This guard handles any edge case where it isn't.
                        if (this._lastIsFinalText) {
                            this.emit('transcript', {
                                text: this._lastIsFinalText,
                                isFinal: true,
                                confidence: this._lastIsFinalConfidence,
                            });
                            this._lastIsFinalText = '';
                            this._lastIsFinalConfidence = 1.0;
                        }

                        return;
                    }

                    if (data.type === 'Metadata') return;
                    if (data.type !== 'Results') return;

                    const alternative = data?.channel?.alternatives?.[0];
                    const transcript = alternative?.transcript;
                    if (!transcript || transcript.trim() === '') return;

                    // A socket that has delivered a real transcript is working, whatever
                    // its uptime. Reset the backoff here as well as on the 30s stability
                    // rule: without this, a reconnect chain that had escalated to the
                    // 30s cap keeps paying 30s per subsequent blip even though the
                    // connection is demonstrably healthy — up to 30s of missing
                    // transcript each time. A socket that opens but never produces a
                    // transcript still escalates, so genuine server flap is unaffected.
                    this.reconnectAttempts = 0;

                    const isWindowFinal: boolean = data.is_final === true;

                    // Deepgram field semantics:
                    //
                    //   is_final=true    → Deepgram has committed this window's transcript;
                    //                      it will not revise it. Arrives mid-utterance for
                    //                      long speech, and always together with speech_final.
                    //
                    //   speech_final=true → Deepgram detected an endpoint (VAD/silence).
                    //                       Always arrives together with is_final=true; never
                    //                       arrives alone.
                    //
                    // Key insight from logs: on the CLIENT (system audio) socket, VAD lockout
                    // restarts kill the audio stream mid-utterance, so Deepgram never sees the
                    // closing silence → UtteranceEnd and speech_final never fire for client.
                    // is_final=true DOES arrive (Deepgram commits the window regardless), so
                    // it must be treated as the authoritative final signal for both sockets.
                    //
                    // Strategy:
                    //   is_final=true  → emit isFinal:true immediately (stable, won't revise).
                    //                    Also clear _lastIsFinalText since we've already emitted.
                    //   interim only   → emit isFinal:false for live rolling display.
                    //   UtteranceEnd   → flush _lastIsFinalText if somehow still set (safety net).

                    if (isWindowFinal) {
                        // Covers both speech_final+is_final and is_final-only cases.
                        // The transcript is committed — emit as final immediately.
                        this._lastIsFinalText = '';
                        this._lastIsFinalConfidence = 1.0;
                        const confidence = alternative?.confidence ?? 1.0;

                        // Word-level metadata (timestamps in stream-audio sec,
                        // speaker ints when diarize=true) → wall-clock SttWords.
                        // Consumed by the transcript echo filter and speaker
                        // labeling in the main process; stripped before IPC.
                        const words = this._parseWords(alternative?.words);

                        // Committed windows can span a speaker change. Split into
                        // contiguous same-speaker runs (single-speaker windows —
                        // the common case — pass through verbatim). Interims are
                        // never split or labeled: their speaker ints are unstable
                        // and would flicker in the UI.
                        const segments = splitFinalBySpeaker(words, transcript);
                        for (const seg of segments) {
                            this.emit('transcript', {
                                text: seg.text,
                                isFinal: true,
                                confidence,
                                speakerIndex: seg.speakerIndex,
                                words: seg.words.length > 0 ? seg.words : undefined,
                            });
                        }
                    } else {
                        // Interim result — live display only, will be revised.
                        // Words are parsed here too: the echo filter judges mic
                        // interims and uses client interims as provisional
                        // reference. Stripped before IPC like final words.
                        const words = this._parseWords(alternative?.words);
                        this.emit('transcript', {
                            text: transcript,
                            isFinal: false,
                            confidence: alternative?.confidence ?? 1.0,
                            words: words.length > 0 ? words : undefined,
                        });
                    }
                });

                // ---- error ----
                socket.on('error', (err: Error) => {
                    // Errors from a superseded socket must not mutate shared reconnect
                    // state (rateLimitedUntil) or tear down the current socket.
                    if (generation !== this._connectGeneration) return;
                    const msg = err?.message ?? String(err);
                    console.error(`[DeepgramStreaming:${this.role}] Error:`, msg);
                    this.emit('error', err);

                    // A 429 means Deepgram is rejecting connections (concurrency / rate
                    // limit). Retrying within 1s only makes it worse — apply a long
                    // backoff floor so we stop hammering the upgrade endpoint.
                    if (msg.includes('429')) {
                        this.rateLimitedUntil = Date.now() + RECONNECT_MAX_DELAY_MS;
                        console.warn(`[DeepgramStreaming:${this.role}] Rate limited (429) — backing off ${RECONNECT_MAX_DELAY_MS}ms`);
                    }

                    // Close this socket so the SDK's internal ReconnectingWebSocket
                    // (maxRetries: Infinity) stops its own retry loop. Our backoff
                    // becomes the single source of truth for reconnection; the 'close'
                    // handler below schedules it.
                    //
                    // Only force the close while the socket is still CONNECTING (0) or
                    // OPEN (1). Once it is CLOSING/CLOSED the 'close' event is already
                    // in flight or delivered, and forcing another one only produced the
                    // duplicate close that leaked reconnect timers. (closeHandled below
                    // makes that harmless either way — this just avoids the pointless
                    // synthetic event.)
                    const rs = this._socketReadyState();
                    if (rs === 0 || rs === 1) {
                        this._closeSocket();
                    }
                });

                // ---- close ----
                socket.on('close', () => {
                    // If a newer connect() already superseded this socket (rate/config
                    // change, or an explicit reconnect), its close is expected teardown
                    // — do NOT schedule a reconnect. Scheduling here would kill the
                    // healthy current socket and start an endless connect/close loop.
                    // We also must not touch isConnecting/keepAlive, which now belong to
                    // the current socket.
                    if (generation !== this._connectGeneration) {
                        console.log(`[DeepgramStreaming:${this.role}] Stale socket closed (gen ${generation} vs ${this._connectGeneration}) — no reconnect`);
                        return;
                    }
                    // Exactly one reconnect per socket death (see closeHandled above).
                    if (closeHandled) return;
                    closeHandled = true;
                    this.isConnecting = false;
                    this._clearConnectDeadline();
                    this.clearKeepAlive();
                    console.log(`[DeepgramStreaming:${this.role}] Connection closed`);
                    // Reset backoff only if this connection was open long enough to be
                    // considered stable. A socket that opened then dropped quickly keeps
                    // its (growing) attempt count so scheduleReconnect() escalates.
                    if (this._openedAt > 0 && Date.now() - this._openedAt >= STABLE_CONNECTION_MS) {
                        this.reconnectAttempts = 0;
                    }
                    this._openedAt = 0;
                    if (this.shouldReconnect) {
                        this.scheduleReconnect();
                    }
                });

                // NOW initiate the WebSocket handshake — all handlers are registered.
                socket.connect();

            }).catch((err: any) => {
                console.error(`[DeepgramStreaming:${this.role}] Failed to create connection:`, err?.message ?? err);
                // A newer generation owns isConnecting/the deadline now — leave them be.
                if (generation !== this._connectGeneration) return;
                this.isConnecting = false;
                this._clearConnectDeadline();
                this.socket = null;
                this.emit('error', new Error(`Deepgram connect failed: ${err?.message ?? err}`));
                if (this.shouldReconnect) {
                    this.scheduleReconnect();
                }
            });
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    /**
     * Convert raw Deepgram words (stream-audio seconds) into wall-clocked
     * SttWords via the anchor ring. Returns [] when word data or anchors are
     * missing (consumers fall back to text-only handling).
     */
    private _parseWords(rawWords: any[] | undefined): SttWord[] {
        if (!Array.isArray(rawWords) || rawWords.length === 0) return [];
        const out: SttWord[] = [];
        for (const w of rawWords) {
            if (!w || typeof w.word !== 'string') continue;
            const startMs = convertStreamSecToWallMs(this._anchors, Number(w.start) || 0);
            const endMs = convertStreamSecToWallMs(this._anchors, Number(w.end) || 0);
            if (startMs === null || endMs === null) return []; // no anchors — no usable timing
            out.push({
                text: w.word,
                punctuated: typeof w.punctuated_word === 'string' ? w.punctuated_word : undefined,
                startMs,
                endMs,
                speaker: typeof w.speaker === 'number' ? w.speaker : undefined,
                confidence: typeof w.confidence === 'number' ? w.confidence : undefined,
            });
        }
        return out;
    }

    private _isSocketOpen(): boolean {
        return this._socketReadyState() === 1; // 1 = OPEN
    }

    /** WS readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED, -1 unknown/absent. */
    private _socketReadyState(): number {
        if (!this.socket) return -1;
        try {
            const rs = this.socket.readyState;
            return typeof rs === 'number' ? rs : -1;
        } catch {
            return -1;
        }
    }

    /**
     * Bound a single connect attempt. If the handshake neither opens nor errors
     * nor closes within CONNECT_TIMEOUT_MS, isConnecting would latch true and
     * connect() would no-op forever at its guard — the STT dying silently for the
     * rest of the meeting. Generation-checked so a superseded attempt's deadline
     * cannot disturb the current one.
     */
    private _armConnectDeadline(generation: number): void {
        this._clearConnectDeadline();
        this.connectTimeoutTimer = setTimeout(() => {
            this.connectTimeoutTimer = null;
            if (generation !== this._connectGeneration) return;
            if (!this.isConnecting) return; // already resolved by open/close/error
            console.warn(`[DeepgramStreaming:${this.role}] Connect attempt timed out after ${CONNECT_TIMEOUT_MS}ms — forcing retry`);
            this.isConnecting = false;
            this._closeSocket();
            if (this.shouldReconnect) this.scheduleReconnect();
        }, CONNECT_TIMEOUT_MS);
    }

    private _clearConnectDeadline(): void {
        if (this.connectTimeoutTimer) {
            clearTimeout(this.connectTimeoutTimer);
            this.connectTimeoutTimer = null;
        }
    }

    private _closeSocket(): void {
        if (!this.socket) return;
        try {
            if (this._isSocketOpen()) {
                this.socket.sendCloseStream({ type: 'CloseStream' });
            }
            this.socket.close();
        } catch { /* ignore */ }
        this.socket = null;
    }

    private _reconnectWithNewConfig(): void {
        const savedBuffer = [...this.buffer];
        this.clearTimers();
        this._closeSocket();
        this._connectGeneration++;
        this.isConnecting = false;
        this.buffer = savedBuffer;
        if (this.shouldReconnect) {
            this.connect();
        }
    }

    // =========================================================================
    // Reconnection
    // =========================================================================

    private scheduleReconnect(): void {
        if (!this.shouldReconnect) return;
        // Never leak a previously armed timer. A leaked timer fires one backoff
        // after the reconnect that already succeeded and tears that healthy socket
        // down (its connect() bumps the generation), producing an endless flap.
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const backoffDelay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
        // Honor the 429 rate-limit floor: after a 429 the error handler sets
        // rateLimitedUntil so we stop hammering Deepgram's upgrade endpoint. Without
        // this, a 429 would still schedule at the ~1s backoff floor.
        const rateLimitFloor = Math.max(0, this.rateLimitedUntil - Date.now());
        const delay = Math.max(backoffDelay, rateLimitFloor);
        this.reconnectAttempts++;
        console.log(`[DeepgramStreaming:${this.role}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) this.connect();
        }, delay);
    }

    // =========================================================================
    // Keep-alive
    // =========================================================================

    private startKeepAlive(): void {
        this.clearKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            if (!this.isActive || !this._isSocketOpen()) return;
            try {
                this.socket!.sendKeepAlive({ type: 'KeepAlive' });
            } catch { /* ignore */ }
        }, KEEPALIVE_INTERVAL_MS);
    }

    private clearKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    private clearTimers(): void {
        this.clearKeepAlive();
        this._clearConnectDeadline();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}