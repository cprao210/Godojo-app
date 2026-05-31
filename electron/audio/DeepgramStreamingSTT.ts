/**
 * DeepgramStreamingSTT - Streaming Speech-to-Text using @deepgram/sdk v5
 *
 * Implements the same EventEmitter interface as GoogleSTT:
 *   Events: 'transcript' ({ text, isFinal, confidence }), 'error' (Error)
 *   Methods: start(), stop(), write(chunk), setSampleRate(), setAudioChannelCount()
 *
 * Uses deepgram.listen.v1.connect() — the official SDK v5 live-streaming API.
 * Sends raw PCM (linear16, 16-bit LE). No WAV header.
 */

import { EventEmitter } from 'events';
import { DeepgramClient } from '@deepgram/sdk';
import { RECOGNITION_LANGUAGES } from '../config/languages';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const KEEPALIVE_INTERVAL_MS = 5000;

export class DeepgramStreamingSTT extends EventEmitter {
    private apiKey: string;
    private client: DeepgramClient;
    private socket: any = null;
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

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
        this.client = new DeepgramClient({ apiKey });
    }

    // =========================================================================
    // Configuration (match GoogleSTT / RestSTT interface)
    // =========================================================================

    public get currentSampleRate(): number {
        return this.sampleRate;
    }

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        const wasActive = this.isActive;
        this.sampleRate = rate;
        console.log(`[DeepgramStreaming] Sample rate set to ${rate}`);
        if (wasActive) {
            console.log('[DeepgramStreaming] Sample rate changed while active — reconnecting...');
            this._reconnectWithNewConfig();
        }
    }

    public setAudioChannelCount(count: number): void {
        if (this.numChannels === count) return;
        const wasActive = this.isActive;
        this.numChannels = count;
        console.log(`[DeepgramStreaming] Channel count set to ${count}`);
        if (wasActive) {
            console.log('[DeepgramStreaming] Channel count changed while active — reconnecting...');
            this._reconnectWithNewConfig();
        }
    }

    public setRecognitionLanguage(key: string): void {
        const config = RECOGNITION_LANGUAGES[key];
        if (config) {
            this.languageCode = config.iso639;
            console.log(`[DeepgramStreaming] Language set to ${this.languageCode}`);
            if (this.isActive) {
                console.log('[DeepgramStreaming] Language changed while active — restarting...');
                const savedBuffer = [...this.buffer];
                this.stop();
                this.start();
                if (savedBuffer.length > 0) {
                    this.buffer = [...savedBuffer, ...this.buffer];
                }
            }
        }
    }

    /** No-op — no Google credentials needed */
    public setCredentials(_path: string): void { }

    /** Called by main.ts when native Rust silence suppressor signals speech end.
     *  Deepgram handles VAD server-side via vad_events + endpointing — no action needed. */
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
        this._closeSocket();
        this.isActive = false;
        this.isConnecting = false;
        this.buffer = [];
        console.log('[DeepgramStreaming] Stopped');
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
                console.log('[DeepgramStreaming] Socket not ready — lazy connecting...');
                this.connect();
            }
            return;
        }

        try {
            this.socket.sendMedia(chunk);
        } catch (err) {
            console.error('[DeepgramStreaming] sendMedia error:', err);
        }
    }

    // =========================================================================
    // Connection using official SDK v5
    // =========================================================================

    private async connect(): Promise<void> {
        if (this.isConnecting) return;
        this.isConnecting = true;

        console.log(`[DeepgramStreaming] Connecting (rate=${this.sampleRate}, ch=${this.numChannels}, lang=${this.languageCode})...`);

        try {
            // Step 1: client.listen.v1.connect() builds the ReconnectingWebSocket
            //         and wraps it in a V1Socket — but does NOT start the connection yet.

            // SDK v5: deepgram.listen.v1.connect(args)
            // Authorization must be passed in ConnectArgs (not just the constructor)
            const socket = await this.client.listen.v1.connect({
                Authorization: `Token ${this.apiKey}`,
                model: 'nova-3',
                encoding: 'linear16',
                sample_rate: this.sampleRate,
                channels: this.numChannels,
                language: this.languageCode,
                smart_format: "true",
                interim_results: "true",
                utterance_end_ms: 1000,
                vad_events: "true",
                endpointing: 300,
                reconnectAttempts: 0, // We manage reconnection ourselves
            });

            // Step 2: Register all event handlers BEFORE calling socket.connect()
            //         so no events are missed during the handshake.

            // ---- open ----
            socket.on('open', () => {
                this.isConnecting = false;
                this.reconnectAttempts = 0;
                console.log('[DeepgramStreaming] Connected');

                // Flush buffered audio accumulated during handshake
                while (this.buffer.length > 0) {
                    const chunk = this.buffer.shift();
                    if (chunk && this._isSocketOpen()) {
                        try { socket.sendMedia(chunk); } catch { /* ignore */ }
                    }
                }

                this.startKeepAlive();
            });

            // ---- message (Results, Metadata, UtteranceEnd, SpeechStarted) ----
            socket.on('message', (data: any) => {
                if (!data) return;

                if (data.type === 'SpeechStarted') {
                    console.log('[DeepgramStreaming] SpeechStarted');
                    return;
                }
                if (data.type === 'UtteranceEnd') {
                    console.log('[DeepgramStreaming] UtteranceEnd');
                    return;
                }
                if (data.type === 'Metadata') return;
                if (data.type !== 'Results') return;
                console.log("[DeepgramAudioCapture] Transcript data ", data?.channel?.alternatives);

                const transcript = data?.channel?.alternatives?.[0]?.transcript;
                if (!transcript || transcript.trim() === '') return;


                // speech_final = utterance boundary (true sentence end)
                // is_final     = audio window is stable
                // Emit both so the UI gets live interim updates AND final segments
                const isFinal = data.speech_final === true || data.is_final === true;

                this.emit('transcript', {
                    text: transcript,
                    isFinal,
                    confidence: data?.channel?.alternatives?.[0]?.confidence ?? 1.0,
                });
            });

            // ---- error ----
            socket.on('error', (err: Error) => {
                console.error('[DeepgramStreaming] Error:', err?.message ?? err);
                this.emit('error', err);
            });

            // ---- close ----
            socket.on('close', () => {
                this.isConnecting = false;
                this.clearKeepAlive();
                console.log('[DeepgramStreaming] Connection closed');
                if (this.shouldReconnect) {
                    this.scheduleReconnect();
                }
            });

            this.socket = socket;

            // Step 3: NOW start the WebSocket connection.
            //         This calls socket.reconnect() on the underlying ReconnectingWebSocket,
            //         which triggers the actual TCP + WS handshake and fires 'open'.
            socket.connect();

            // Step 4: Wait for the socket to be open before returning to the caller.
            await socket.waitForOpen();

        } catch (err: any) {
            console.error('[DeepgramStreaming] Failed to connect:', err?.message ?? err);
            this.isConnecting = false;
            this.emit('error', new Error(`Deepgram connect failed: ${err?.message ?? err}`));
            if (this.shouldReconnect) {
                this.scheduleReconnect();
            }
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private _isSocketOpen(): boolean {
        if (!this.socket) return false;
        try {
            // V1Socket.readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
            return this.socket.readyState === 1;
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
        this.isConnecting = false;
        this.buffer = [...savedBuffer, ...this.buffer];
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
        console.log(`[DeepgramStreaming] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
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
            if (this._isSocketOpen()) {
                try {
                    // SDK v5: sendKeepAlive() sends the {"type":"KeepAlive"} JSON frame
                    this.socket!.sendKeepAlive({ type: 'KeepAlive' });
                } catch { /* ignore */ }
            }
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