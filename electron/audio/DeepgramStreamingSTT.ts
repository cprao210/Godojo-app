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
    private reconnectTimer: NodeJS.Timeout | null = null;
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
            this.languageCode = config.iso639;
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
            endpointing: "500",
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
                    return;
                }

                this.socket = socket;

                // ---- open ----
                // Registered BEFORE socket.connect() fires the WS handshake.
                // No race condition possible.
                socket.on('open', () => {
                    this.isConnecting = false;
                    this.reconnectAttempts = 0;
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
                        this.emit('transcript', {
                            text: transcript,
                            isFinal: false,
                            confidence: alternative?.confidence ?? 1.0,
                        });
                    }
                });

                // ---- error ----
                socket.on('error', (err: Error) => {
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
                    this._closeSocket();
                });

                // ---- close ----
                socket.on('close', () => {
                    this.isConnecting = false;
                    this.clearKeepAlive();
                    console.log(`[DeepgramStreaming:${this.role}] Connection closed`);
                    if (this.shouldReconnect) {
                        this.scheduleReconnect();
                    }
                });

                // NOW initiate the WebSocket handshake — all handlers are registered.
                socket.connect();

            }).catch((err: any) => {
                console.error(`[DeepgramStreaming:${this.role}] Failed to create connection:`, err?.message ?? err);
                this.isConnecting = false;
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
        if (!this.socket) return false;
        try {
            return this.socket.readyState === 1; // 1 = OPEN
        } catch {
            return false;
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
        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
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
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}