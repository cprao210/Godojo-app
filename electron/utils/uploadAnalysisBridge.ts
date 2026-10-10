// uploadAnalysisBridge.ts
//
// Main's half of the uploaded-transcript call analysis.
//
// The analysis itself is produced by the backend's live analysis v2 end-of-call
// pass (/intelligence/live-analysis/v2/end) — the same producer a live call ends
// with — but that API lives in the
// renderer and cannot be lifted into main: src/lib/apiClient reads
// import.meta.env, the Firebase web SDK's currentUser and window.electronAPI.
// Re-implementing the call here would mean a second client to keep in step with
// the first (its 401 refresh-and-retry, its error envelope, its base URL), and
// that is exactly the hand-maintained-mirror problem this change set out to
// remove. So main asks the launcher window to make the call and waits for the
// answer — see src/hooks/useUploadAnalysisBridge.
//
// Failure is expected and survivable: no window, no answer in time, a signed-out
// renderer or an exhausted backend budget all reject, and MeetingPersistence
// falls back to the local analyser in ./uploadAnalysis. A meeting is never lost
// or saved with a partial analysis presented as a whole one.

import { randomUUID } from 'crypto';
import { readEnv } from './env';
import { LiveAnalysisData } from '../../src/types';

/** A turn as the route wants it — the shape src/types calls LiveAnalysisTurn. */
export interface UploadAnalysisTurn {
    speaker: string;
    text: string;
}

export interface UploadAnalysisResultPayload {
    requestId?: string;
    ok?: boolean;
    data?: LiveAnalysisData | null;
    error?: string;
}

/**
 * Ceiling on one request: the renderer's own v2 end-of-call HTTP timeout is
 * 60s, so a healthy renderer answers well inside this. Generous because
 * nothing is waiting on it (this runs inside background meeting processing),
 * but bounded, because a renderer that navigated away or wedged must not hold
 * a meeting in its processing state forever.
 */
export const UPLOAD_ANALYSIS_TIMEOUT_MS = 10 * 60_000;

export class UploadAnalysisBridgeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UploadAnalysisBridgeError';
    }
}

interface PendingRequest {
    resolve: (data: LiveAnalysisData | null) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    /** Drops the window listener this request registered. */
    cleanup: () => void;
}

const pending = new Map<string, PendingRequest>();

/**
 * Is the local (pre-backend) analysis path forced on?
 *
 * Read at call time, not at module load, so a test or a relaunch-free toggle
 * takes effect. `GODOJO_UPLOAD_ANALYSIS_LOCAL=1` pins uploads to
 * ./uploadAnalysis and never asks the renderer — the behaviour every build
 * before this one had, kept reachable for offline use and for A/B-ing the two
 * producers against the same transcript.
 */
export function isLocalUploadAnalysisForced(): boolean {
    return readEnv('UPLOAD_ANALYSIS_LOCAL') === '1';
}

/**
 * Settle the request a renderer is answering. Wired to the
 * `upload-analysis-result` channel in ipcHandlers.
 *
 * An unknown requestId is normal, not an error: the request may already have
 * timed out or been rejected when its window went away, and a late answer to it
 * must be dropped rather than resolve something else.
 */
export function handleUploadAnalysisResult(payload: UploadAnalysisResultPayload): void {
    const requestId = payload?.requestId;
    if (!requestId) return;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.cleanup();
    if (payload.ok) entry.resolve(payload.data ?? null);
    else entry.reject(new UploadAnalysisBridgeError(payload.error || 'renderer analysis failed'));
}

/** Injected in tests so nothing here touches Electron or real timers. */
export interface UploadAnalysisDeps {
    /** The window that should run the analysis. Defaults to the launcher window. */
    getWindow?: () => { isDestroyed?: () => boolean; webContents?: any } | null | undefined;
    timeoutMs?: number;
}

function defaultGetWindow() {
    try {
        const { AppState } = require('../main');
        return AppState.getInstance()?.getWindowHelper?.()?.getLauncherWindow?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Ask the renderer to analyse an uploaded transcript and wait for the result.
 *
 * Resolves `null` when there was nothing analysable in the transcript; rejects
 * when no window could answer, the window went away mid-run, the renderer
 * reported a failure, or the ceiling elapsed.
 */
export async function requestUploadAnalysis(
    turns: UploadAnalysisTurn[],
    meetingTypes: ('discovery' | 'demo' | 'negotiation')[],
    deps: UploadAnalysisDeps = {},
): Promise<LiveAnalysisData | null> {
    if (turns.length === 0) return null;

    const win: any = (deps.getWindow ?? defaultGetWindow)();
    if (!win || win.isDestroyed?.() || !win.webContents) {
        throw new UploadAnalysisBridgeError('no renderer window available to run the analysis');
    }

    const requestId = randomUUID();
    const timeoutMs = deps.timeoutMs ?? UPLOAD_ANALYSIS_TIMEOUT_MS;

    return new Promise<LiveAnalysisData | null>((resolve, reject) => {
        // Every settle path goes through here or handleUploadAnalysisResult, and
        // both drop the window listener: uploads share one long-lived launcher
        // window, so a listener left behind per request would accumulate for the
        // life of the app (and trip Node's max-listeners warning at 11).
        const onWindowDestroyed = () => settleRejected('renderer window was destroyed before answering');
        const cleanup = () => {
            try {
                win.webContents.removeListener?.('destroyed', onWindowDestroyed);
            } catch {
                // A destroyed webContents can throw here; the listener dies with it.
            }
        };

        const settleRejected = (message: string) => {
            const entry = pending.get(requestId);
            if (!entry) return;
            pending.delete(requestId);
            clearTimeout(entry.timer);
            entry.cleanup();
            reject(new UploadAnalysisBridgeError(message));
        };

        const timer = setTimeout(
            () => settleRejected(`renderer did not answer within ${timeoutMs}ms`),
            timeoutMs,
        );
        // Node keeps the process alive for a pending timer; this one must never
        // be the reason the app can't quit.
        timer.unref?.();

        pending.set(requestId, { resolve, reject, timer, cleanup });

        // A window that closes mid-run would otherwise leave this request
        // waiting out the full ceiling for an answer that can never come.
        win.webContents.once?.('destroyed', onWindowDestroyed);

        try {
            win.webContents.send('run-upload-analysis', { requestId, turns, meetingTypes });
        } catch (e: any) {
            settleRejected(`failed to reach the renderer: ${e?.message ?? e}`);
        }
    });
}

/** Test seam: how many requests are still awaiting an answer. */
export function pendingUploadAnalysisCount(): number {
    return pending.size;
}
