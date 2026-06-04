// ============================================================================
// Frontend Logger Service  (renderer process)
//
// Usage:
//   import { logger } from '../lib/logger/frontend.logger';
//   logger.info('Deepgram', 'Connection established', { url });
//   logger.warn('SessionTracker', 'No transcript data');
//   logger.error('IPC', 'Failed to invoke handler', err);
//
// Dev-only: when NODE_ENV !== 'development' every call is a no-op,
// so there is zero overhead in production bundles.
// ============================================================================

import type { LogEntry, LogLevel } from './types';

const IS_DEV = import.meta.env.DEV;

export type LogListener = (entries: LogEntry[]) => void;

const MAX_LOGS = 5000;

/** Auto-incrementing counter so IDs are monotonic even within the same ms */
let _seq = 0;

function makeId(): string {
    return `f-${Date.now()}-${_seq++}`;
}

class FrontendLoggerService {
    private entries: LogEntry[] = [];
    private listeners: Set<LogListener> = new Set();

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

    // ── Subscription ─────────────────────────────────────────────────────────

    /**
     * Subscribe to log updates.
     * The listener is called immediately with the current snapshot,
     * then again on every new log entry.
     * Returns an unsubscribe function.
     */
    subscribe(listener: LogListener): () => void {
        if (!IS_DEV) return () => { };
        listener([...this.entries]);
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Return an immutable snapshot of all current entries */
    getEntries(): LogEntry[] {
        return [...this.entries];
    }

    clear(): void {
        this.entries = [];
        this._notify();
    }

    // ── Console interception ──────────────────────────────────────────────────

    /**
     * Monkey-patch the global console so that console.log / warn / error etc.
     * from anywhere in the renderer are captured as log entries.
     *
     * Call once from main entry point (index.tsx / App.tsx) in dev mode.
     * Does nothing in production.
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
                    origFn(...args);
                    // Extract source from first string argument if it looks like [Module]
                    let source = 'Console';
                    let message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

                    const srcMatch = message.match(/^\[([^\]]+)\]/);
                    if (srcMatch) {
                        source = srcMatch[1];
                        message = message.slice(srcMatch[0].length).trim();
                    }

                    const metadata = args.length > 1 && typeof args[args.length - 1] !== 'string'
                        ? args[args.length - 1]
                        : undefined;

                    this._emit(level, source, message, metadata, /* fromConsole */ true);
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

        // Bounded buffer — drop oldest entries beyond MAX_LOGS
        if (this.entries.length > MAX_LOGS) {
            this.entries = this.entries.slice(-MAX_LOGS);
        }

        this._notify();
    }

    private _notify(): void {
        const snapshot = [...this.entries];
        this.listeners.forEach(l => {
            try { l(snapshot); } catch { /* never crash the app over a debug listener */ }
        });
    }
}

// Singleton — import this everywhere
export const logger = IS_DEV ? new FrontendLoggerService() : new (class {
    debug() { }
    info() { }
    warn() { }
    error() { }
    subscribe() { return () => { }; }
    getEntries(): LogEntry[] { return []; }
    clear() { }
    interceptConsole() { }
})() as unknown as FrontendLoggerService;