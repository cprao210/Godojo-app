// ============================================================================
// Shared Log Model
// Used by both the frontend logger (renderer) and backend logger (main process).
// Kept in src/ so it can be imported from both sides without circular deps.
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
    /** Unique ID — used as React key; avoids re-render flicker on new entries */
    id: string;
    /** Unix timestamp in ms */
    timestamp: number;
    level: LogLevel;
    /**
     * Module / service that emitted this log.
     * Examples: "Deepgram", "AudioPipeline", "SessionTracker", "IPC"
     */
    source: string;
    message: string;
    /** Any extra structured data attached to the log call */
    metadata?: unknown;
}

/** IPC channel names — single source of truth for both preload and main */
export const DEBUG_IPC = {
    /** Main → Renderer: push a batch of new backend log entries */
    BACKEND_LOGS_PUSH: 'debug:backend-logs-push',
    /** Renderer → Main: request full backend log history (e.g. on panel open) */
    BACKEND_LOGS_REQUEST: 'debug:backend-logs-request',
    /** Main → Renderer: response to the above request */
    BACKEND_LOGS_RESPONSE: 'debug:backend-logs-response',
    /** Renderer → Main: clear backend log buffer */
    BACKEND_LOGS_CLEAR: 'debug:backend-logs-clear',
} as const;