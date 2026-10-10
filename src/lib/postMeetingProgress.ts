/**
 * postMeetingProgress.ts
 *
 * Shared (main + renderer) model for the post-meeting background-process
 * loader. Pure — no React, no Electron, no DOM — so main can import it and it
 * is trivially testable.
 *
 * Everything here describes REAL work. Main (MeetingPersistence) reports each
 * step as it actually starts and finishes; nothing is derived from a timer, and
 * the percentage is just "how much of the planned work has actually finished".
 *
 * The steps mirror what the pipeline really does today (scorecard generation is
 * disabled, so there is deliberately no scoring step):
 *
 * Listed in the order they actually run:
 *
 *   transcript    – placeholder row + full transcript saved          (always done)
 *   liveAnalysis  – live calls only: finishing the analysis captured during the call
 *   title         – title generation (skipped when a calendar title exists)
 *   summary       – generate → verify against transcript (→ regenerate) loop
 *   analysis      – analysis built FROM THE TRANSCRIPT, after the summary. Only when no
 *                   live analysis exists (uploads, recovery, a failed live run), so it
 *                   is added to a live meeting's list at the moment it actually starts
 *   save          – final write + sync, flips is_processed
 *
 * Steps that will not run for a given meeting (e.g. no title step for a
 * calendar meeting, no summary for a very short transcript) are simply left out
 * of the plan, so the loader never lists work that isn't happening.
 */

export type ProcessingStepId = 'transcript' | 'liveAnalysis' | 'title' | 'summary' | 'analysis' | 'save';
export type ProcessingStepStatus = 'pending' | 'active' | 'done';

export interface ProcessingStepState {
    id: ProcessingStepId;
    status: ProcessingStepStatus;
    /** What this step is doing right now (e.g. "Verifying against the transcript · attempt 2 of 3"). */
    detail?: string;
    /** 0–1 progress inside an active step, when main knows it (summary attempts). */
    fraction?: number;
}

export interface MeetingProcessingSnapshot {
    meetingId: string;
    /** Epoch ms when background processing began. */
    startedAt: number;
    updatedAt: number;
    steps: ProcessingStepState[];
    /** Main has stopped processing this meeting (saved, or gave up). */
    finished: boolean;
}

export const STEP_META: Record<ProcessingStepId, { label: string; idleDetail: string; weight: number }> = {
    transcript: { label: 'Transcript saved', idleDetail: 'Your full conversation is stored.', weight: 5 },
    liveAnalysis: { label: 'Finalizing live analysis', idleDetail: 'Wrapping up the analysis captured during the call.', weight: 10 },
    analysis: { label: 'Analysing the call', idleDetail: 'No live analysis was captured, so BANT, MEDDIC and deal signals are being extracted from the transcript.', weight: 20 },
    title: { label: 'Generating title', idleDetail: 'Naming the meeting from the conversation.', weight: 5 },
    summary: { label: 'Writing the summary', idleDetail: 'Drafting key points, action items and coaching notes.', weight: 60 },
    save: { label: 'Saving results', idleDetail: 'Writing the finished summary to your meeting.', weight: 10 },
};

/** Largest share of a step an in-progress fraction may claim — only finishing completes it. */
const MAX_ACTIVE_FRACTION = 0.95;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function createSnapshot(meetingId: string, plan: ProcessingStepId[], now: number): MeetingProcessingSnapshot {
    // De-dupe while keeping order; the transcript step is always first and already done.
    const ids = Array.from(new Set<ProcessingStepId>(['transcript', ...plan]));
    return {
        meetingId,
        startedAt: now,
        updatedAt: now,
        finished: false,
        steps: ids.map((id) => ({ id, status: id === 'transcript' ? 'done' : 'pending' })),
    };
}

/** Immutable step update. Unknown step ids (not in this meeting's plan) are ignored. */
export function updateStep(
    snap: MeetingProcessingSnapshot,
    stepId: ProcessingStepId,
    patch: Partial<Pick<ProcessingStepState, 'status' | 'detail' | 'fraction'>>,
    now: number,
): MeetingProcessingSnapshot {
    if (!snap.steps.some((s) => s.id === stepId)) return snap;
    return {
        ...snap,
        updatedAt: now,
        steps: snap.steps.map((s) => {
            if (s.id !== stepId) return s;
            const next = { ...s, ...patch };
            // A finished step carries no live detail/fraction.
            if (next.status === 'done') {
                delete next.detail;
                delete next.fraction;
            }
            return next;
        }),
    };
}

/**
 * Make sure a step exists, inserting it just before `beforeId` (or at the end if
 * that step isn't there). Used for work that only becomes known mid-run — e.g.
 * the transcript analysis, which runs after the summary and only when no live
 * analysis exists. Keeps the list in true execution order.
 */
export function ensureStep(
    snap: MeetingProcessingSnapshot,
    stepId: ProcessingStepId,
    beforeId: ProcessingStepId,
    now: number,
): MeetingProcessingSnapshot {
    if (snap.steps.some((s) => s.id === stepId)) return snap;
    const steps = [...snap.steps];
    const at = steps.findIndex((s) => s.id === beforeId);
    steps.splice(at === -1 ? steps.length : at, 0, { id: stepId, status: 'pending' });
    return { ...snap, updatedAt: now, steps };
}

export function finishSnapshot(snap: MeetingProcessingSnapshot, saved: boolean, now: number): MeetingProcessingSnapshot {
    return {
        ...snap,
        updatedAt: now,
        finished: true,
        steps: snap.steps.map((s) =>
            saved ? { id: s.id, status: 'done' as const } : s,
        ),
    };
}

/** Weighted share of planned work that has actually finished, 0–100. */
export function computeProgressPercent(steps: ProcessingStepState[]): number {
    if (steps.length === 0) return 0;
    let total = 0;
    let done = 0;
    for (const s of steps) {
        const w = STEP_META[s.id].weight;
        total += w;
        if (s.status === 'done') done += w;
        else if (s.status === 'active') done += w * Math.min(MAX_ACTIVE_FRACTION, clamp01(s.fraction ?? 0));
    }
    return total === 0 ? 0 : Math.round((done / total) * 100);
}