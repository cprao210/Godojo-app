// ============================================================================
// Backend Logger Service  (Electron main process)
//
// Usage:
//   import { backendLogger } from './logger/backend.logger';
//   backendLogger.info('Deepgram', 'Connection opened', { url });
//   backendLogger.error('AudioPipeline', 'Native module crash', err);
//
// Integrating into existing services:
//   Replace:  console.log('[Deepgram] Connected')
//   With:     backendLogger.info('Deepgram', 'Connected')
//   Or both:  console.log('[Deepgram] Connected');  backendLogger.info('Deepgram', 'Connected');
//
// The logger also patches console.* on the main process so existing
// console.log / console.error calls are automatically captured.
// Call backendLogger.interceptConsole() once at the top of main.ts.
//
// Dev-only: when NODE_ENV !== 'development' every call is a no-op.
// ============================================================================

import { BrowserWindow } from 'electron';
import type { LogEntry, LogLevel } from '../../src/lib/logger/types';
import { DEBUG_IPC } from '../../src/lib/logger/types';

const IS_DEV = process.env.NODE_ENV === 'development';

const MAX_LOGS = 5000;
/** Batch push interval — send accumulated logs to renderer every N ms */
const PUSH_INTERVAL_MS = 250;

let _seq = 0;
function makeId(): string {
    return `b-${Date.now()}-${_seq++}`;
}

class BackendLoggerService {
    private entries: LogEntry[] = [];
    /** Queue of entries not yet sent to the renderer */
    private pendingPush: LogEntry[] = [];
    private pushTimer: NodeJS.Timeout | null = null;

    // ── Public API ────────────────────────────────────────────────────────────

    debug(source: string, message: string, metadata?: unknown): void {
        this._emit('debug', source, message, metadata);
    }

    info(source: string, message: string, metadata?: unknown): void {
        this._emit('info', source, message, metadata);
    }

    warn(source: string, message: string, metadata?: unknown): void {
        this._emit('warn', source, message, metadata);
    }

    error(source: string, message: string, metadata?: unknown): void {
        this._emit('error', source, message, metadata);
    }

    getEntries(): LogEntry[] {
        return [...this.entries];
    }

    clear(): void {
        this.entries = [];
        this.pendingPush = [];
        // Push an empty array so the renderer clears its display immediately
        this._broadcastToAllWindows([]);
    }

    // ── IPC wiring ────────────────────────────────────────────────────────────

    /**
     * Register IPC handlers. Call once from ipcHandlers.ts or main.ts after
     * the app is ready. Safe to call multiple times (idempotent).
     */
    registerIpcHandlers(): void {
        if (!IS_DEV) return;

        const { ipcMain } = require('electron') as typeof import('electron');

        // Renderer requested full history (panel just opened)
        ipcMain.removeHandler(DEBUG_IPC.BACKEND_LOGS_REQUEST);
        ipcMain.handle(DEBUG_IPC.BACKEND_LOGS_REQUEST, () => this.getEntries());

        // Renderer asked to clear
        ipcMain.removeHandler(DEBUG_IPC.BACKEND_LOGS_CLEAR);
        ipcMain.handle(DEBUG_IPC.BACKEND_LOGS_CLEAR, () => { this.clear(); });
    }

    // ── Console interception ──────────────────────────────────────────────────

    /**
     * Monkey-patch the Node.js console so existing console.log / console.error
     * calls anywhere in the main process are automatically captured.
     *
     * Call ONCE at the top of main.ts (after the IS_DEV check).
     */
    interceptConsole(): void {
        if (!IS_DEV) return;

        const original = {
            log: console.log.bind(console),
            info: console.info.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            debug: console.debug.bind(console),
        };

        const capture =
            (level: LogLevel, origFn: (...args: unknown[]) => void) =>
                (...args: unknown[]) => {
                    // Always still call original so the terminal / DevTools console works
                    origFn(...args);

                    let source = 'Main';
                    let message = args
                        .map(a => {
                            if (typeof a === 'string') return a;
                            if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
                            try { return JSON.stringify(a); } catch { return String(a); }
                        })
                        .join(' ');

                    // Extract [Module] prefix pattern that existing code already uses
                    // e.g. "[MicrophoneCapture] Starting native capture..."
                    const srcMatch = message.match(/^\[([^\]]+)\]/);
                    if (srcMatch) {
                        source = srcMatch[1];
                        message = message.slice(srcMatch[0].length).trim();
                    }

                    const metadata = args.length > 1 && typeof args[0] === 'string' && typeof args[args.length - 1] !== 'string'
                        ? args[args.length - 1]
                        : undefined;

                    // _emit with fromConsole=true so we don't call console.* again (infinite loop guard)
                    this._emit(level, source, message, metadata, true);
                };

        console.log = capture('info', original.log);
        console.info = capture('info', original.info);
        console.warn = capture('warn', original.warn);
        console.error = capture('error', original.error);
        console.debug = capture('debug', original.debug);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private _emit(
        level: LogLevel,
        source: string,
        message: string,
        metadata?: unknown,
        _fromConsole = false,
    ): void {
        if (!IS_DEV) return;

        const entry: LogEntry = {
            id: makeId(),
            timestamp: Date.now(),
            level,
            source,
            message,
            metadata,
        };

        this.entries.push(entry);
        this.pendingPush.push(entry);

        if (this.entries.length > MAX_LOGS) {
            this.entries = this.entries.slice(-MAX_LOGS);
        }

        this._schedulePush();
    }

    /**
     * Debounced push — batches log entries so we don't saturate IPC on
     * high-volume audio pipeline logs (up to 50 logs/s during active calls).
     */
    private _schedulePush(): void {
        if (this.pushTimer) return;
        this.pushTimer = setTimeout(() => {
            this.pushTimer = null;
            if (this.pendingPush.length === 0) return;
            const batch = this.pendingPush.splice(0);
            this._broadcastToAllWindows(batch);
        }, PUSH_INTERVAL_MS);
    }

    private _broadcastToAllWindows(batch: LogEntry[]): void {
        try {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                if (!win.isDestroyed()) {
                    win.webContents.send(DEBUG_IPC.BACKEND_LOGS_PUSH, batch);
                }
            }
        } catch {
            // BrowserWindow may not be available yet during early startup — ignore
        }
    }
}

export const backendLogger = IS_DEV
    ? new BackendLoggerService()
    : new (class {
        debug() { }
        info() { }
        warn() { }
        error() { }
        getEntries(): LogEntry[] { return []; }
        clear() { }
        registerIpcHandlers() { }
        interceptConsole() { }
    })() as unknown as BackendLoggerService;