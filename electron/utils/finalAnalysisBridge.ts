// electron/utils/finalAnalysisBridge.ts
//
// Main → overlay request for the live analysis v2 END-OF-CALL pass
// (POST /intelligence/live-analysis/v2/end).
//
// Why the overlay: it is the only place that holds everything the pass needs — the last tick's
// SIGNED v2 state, the full transcript with original (untranslated) text and turn ids, and the
// renderer-only API client that owns the Firebase token. Main has the transcript too, but only
// the display text, and no state. So MeetingPersistence asks, useFloatingDock answers
// (window.electronAPI.onRunFinalAnalysisV2 → respondFinalAnalysisV2), and the answer becomes
// the meeting's liveAnalysis before the summary is written.
//
// Same request/response bookkeeping as ./uploadAnalysisBridge (pending map, timeout, window
// destroyed = reject), with a much shorter ceiling: this sits in front of the summary.

import { randomUUID } from 'crypto';
import { LiveAnalysisData } from '../../src/types';

export interface FinalAnalysisResultPayload {
    requestId?: string;
    ok?: boolean;
    data?: LiveAnalysisData | null;
    error?: string;
}

/** Backend budget is 45s; the renderer's HTTP timeout is 60s. */
export const FINAL_ANALYSIS_V2_TIMEOUT_MS = 65_000;

export class FinalAnalysisBridgeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FinalAnalysisBridgeError';
    }
}

/** Same build flag the renderer uses to select live analysis v2. */
export function isFinalAnalysisV2Enabled(): boolean {
    return process.env.VITE_LIVE_ANALYSIS_V2 === 'true';
}

interface PendingRequest {
    resolve: (data: LiveAnalysisData | null) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    cleanup: () => void;
}

const pending = new Map<string, PendingRequest>();

export function handleFinalAnalysisV2Result(payload: FinalAnalysisResultPayload): void {
    const requestId = payload?.requestId;
    if (!requestId) return;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.cleanup();
    if (payload.ok) entry.resolve(payload.data ?? null);
    else entry.reject(new FinalAnalysisBridgeError(payload.error || 'final analysis failed'));
}

export interface FinalAnalysisDeps {
    /** The window that answers. Defaults to the overlay (where the live v2 hook runs). */
    getWindow?: () => { isDestroyed?: () => boolean; webContents?: any } | null | undefined;
    timeoutMs?: number;
}

function defaultGetWindow() {
    try {
        const { AppState } = require('../main');
        return AppState.getInstance()?.getWindowHelper?.()?.getOverlayWindow?.() ?? null;
    } catch {
        return null;
    }
}

export function requestFinalAnalysisV2(
    meetingTypes: ('discovery' | 'demo' | 'negotiation')[] = [],
    deps: FinalAnalysisDeps = {},
): Promise<LiveAnalysisData | null> {
    const win: any = (deps.getWindow ?? defaultGetWindow)();
    if (!win || win.isDestroyed?.() || !win.webContents) {
        return Promise.reject(new FinalAnalysisBridgeError('no overlay window to run the final analysis'));
    }
    const requestId = randomUUID();
    const timeoutMs = deps.timeoutMs ?? FINAL_ANALYSIS_V2_TIMEOUT_MS;

    return new Promise<LiveAnalysisData | null>((resolve, reject) => {
        const onWindowDestroyed = () => settleRejected('overlay window was destroyed before answering');
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
            reject(new FinalAnalysisBridgeError(message));
        };
        const timer = setTimeout(() => settleRejected(`overlay did not answer within ${timeoutMs}ms`), timeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, reject, timer, cleanup });
        win.webContents.once?.('destroyed', onWindowDestroyed);
        try {
            win.webContents.send('run-final-analysis-v2', { requestId, meetingTypes });
        } catch (e: any) {
            settleRejected(`failed to reach the overlay: ${e?.message ?? e}`);
        }
    });
}

/** Test seam. */
export function pendingFinalAnalysisCount(): number {
    return pending.size;
}
