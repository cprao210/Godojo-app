/**
 * meetingProcessingProgress.ts
 *
 * In-memory registry of post-meeting background processing, so the renderer can
 * show what main is REALLY doing (analysis → title → summary → save).
 *
 * Deliberately separate from every meeting read path: it has its own IPC
 * channel (`meeting-processing-progress`) and its own getter, and it is never
 * touched by get-meeting-details. Nothing is persisted — if the app restarts
 * mid-processing there is simply no snapshot, and the renderer falls back to
 * its stalled-processing handling.
 */
import {
    createSnapshot,
    ensureStep,
    finishSnapshot,
    updateStep,
    type MeetingProcessingSnapshot,
    type ProcessingStepId,
    type ProcessingStepState,
} from '../../src/lib/postMeetingProgress';

export const MEETING_PROCESSING_PROGRESS_CHANNEL = 'meeting-processing-progress';

const active = new Map<string, MeetingProcessingSnapshot>();

function broadcast(snap: MeetingProcessingSnapshot): void {
    try {
        // Lazy require: keeps this module importable from unit tests (no Electron).
        const { BrowserWindow } = require('electron');
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send(MEETING_PROCESSING_PROGRESS_CHANNEL, snap);
        }
    } catch {
        /* no windows / not running under Electron — progress is best-effort */
    }
}

function commit(snap: MeetingProcessingSnapshot): void {
    active.set(snap.meetingId, snap);
    broadcast(snap);
}

/** Start tracking a meeting. Idempotent: a second call keeps the existing plan. */
export function beginMeetingProcessing(meetingId: string, plan: ProcessingStepId[]): void {
    if (active.has(meetingId)) return;
    commit(createSnapshot(meetingId, plan, Date.now()));
}

export function startProcessingStep(meetingId: string, stepId: ProcessingStepId, detail?: string, fraction?: number): void {
    const cur = active.get(meetingId);
    if (!cur) return;
    const now = Date.now();
    // Work discovered mid-run (the transcript analysis) is inserted before 'save', so the
    // list stays in the order things really happen.
    commit(updateStep(ensureStep(cur, stepId, 'save', now), stepId, { status: 'active', detail, fraction }, now));
}

/** Update an already-running step's live detail / fraction without changing its status. */
export function setProcessingStepDetail(meetingId: string, stepId: ProcessingStepId, detail: string, fraction?: number): void {
    const cur = active.get(meetingId);
    if (!cur) return;
    commit(updateStep(cur, stepId, { detail, fraction }, Date.now()));
}

/** Mark steps finished — success OR a non-fatal failure; either way they are no longer running. */
export function completeProcessingSteps(meetingId: string, ...stepIds: ProcessingStepId[]): void {
    let cur = active.get(meetingId);
    if (!cur) return;
    for (const id of stepIds) cur = updateStep(cur, id, { status: 'done' }, Date.now());
    commit(cur);
}

/** Stop tracking. `saved` = the final row was written (everything reads as done). */
export function endMeetingProcessing(meetingId: string, saved: boolean): void {
    const cur = active.get(meetingId);
    if (!cur) return;
    broadcast(finishSnapshot(cur, saved, Date.now()));
    active.delete(meetingId);
}

export function getMeetingProcessingSnapshot(meetingId: string): MeetingProcessingSnapshot | null {
    return active.get(meetingId) ?? null;
}

export type { MeetingProcessingSnapshot, ProcessingStepState };