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

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const KEEPALIVE_INTERVAL_MS = 5000;

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
    private reconnectTimer: NodeJS.Timeout | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private buffer: Buffer[] = [];
    private isConnecting = false;

    private _lastIsFinalText: string = '';
    private _lastIsFinalConfidence: number = 1.0;
    private role: 'client' | 'user' = 'user';
    private _connectGeneration = 0;

    constructor(apiKey: string, role: 'client' | 'user' = 'user') {
        super();
        this.apiKey = apiKey;
        this.role = role;
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
                try { this.socket!.sendMedia(chunk); } catch { /* ignore */ }
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

        try {
            this.socket.sendMedia(chunk);
        } catch (err) {
            console.error(`[DeepgramStreaming:${this.role}] sendMedia error:`, err);
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

        console.log(`[DeepgramStreaming:${this.role}] Connecting (rate=${this.sampleRate}, ch=${this.numChannels}, lang=${this.languageCode})...`);

        const queryParams = {
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
                            try { socket.sendMedia(chunk); } catch { /* ignore */ }
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

                    const transcript = data?.channel?.alternatives?.[0]?.transcript;
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
                        const confidence = data?.channel?.alternatives?.[0]?.confidence ?? 1.0;
                        this.emit('transcript', {
                            text: transcript,
                            isFinal: true,
                            confidence,
                        });
                    } else {
                        // Interim result — live display only, will be revised.
                        this.emit('transcript', {
                            text: transcript,
                            isFinal: false,
                            confidence: data?.channel?.alternatives?.[0]?.confidence ?? 1.0,
                        });
                    }
                });

                // ---- error ----
                socket.on('error', (err: Error) => {
                    console.error(`[DeepgramStreaming:${this.role}] Error:`, err?.message ?? err);
                    this.emit('error', err);
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