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

export class FrontendLoggerService {
    private entries: LogEntry[] = [];
    private listeners: Set<LogListener> = new Set();
    private _intercepted = false;
    private _originals: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'> | null = null;
    /** Safely convert any value to a string, handling circular refs, BigInt, Errors, etc. */
    private _safeStringify(a: unknown): string {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.message}${a.stack ? `\n${a.stack}` : ''}`;
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    }

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
        if (!IS_DEV || this._intercepted) return;
        this._intercepted = true;

        const originals = {
            log: console.log.bind(console),
            info: console.info.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            debug: console.debug.bind(console),
        };
        this._originals = originals;

        const capture = (level: LogLevel, origFn: (...args: unknown[]) => void) => (...args: unknown[]) => {
            origFn(...args);
            try {
                let source = 'Console';
                let message = args.map(a => this._safeStringify(a)).join(' ');

                const srcMatch = message.match(/^\[([^\]]+)\]/);
                if (srcMatch) {
                    source = srcMatch[1];
                    message = message.slice(srcMatch[0].length).trim();
                }

                const metadata = args.length > 1 && typeof args[args.length - 1] !== 'string'
                    ? args[args.length - 1]
                    : undefined;

                this._emit(level, source, message, metadata, /* fromConsole */ true);
            } catch {
                // Never let log capture crash the caller
            }
        };

        console.log = capture('info', originals.log);
        console.info = capture('info', originals.info);
        console.warn = capture('warn', originals.warn);
        console.error = capture('error', originals.error);
        console.debug = capture('debug', originals.debug);
    }

    restoreConsole(): void {
        if (!IS_DEV || !this._intercepted || !this._originals) return;
        console.log = this._originals.log;
        console.info = this._originals.info;
        console.warn = this._originals.warn;
        console.error = this._originals.error;
        console.debug = this._originals.debug;
        this._originals = null;
        this._intercepted = false;
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