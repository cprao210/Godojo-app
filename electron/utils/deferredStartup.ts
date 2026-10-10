// deferredStartup.ts
//
// A tiny queue for startup work that is useful but not needed before the user
// can use the app: catalog refreshes, the cloud backfill, the sync audit.
//
// WHY: on low-end machines (2-core i3, 8 GB) everything used to start in the
// same second as the first window — often at Windows sign-in, when the OS is
// busiest — so the launcher was slow to appear and slow to respond. Tasks
// queued here wait until `releaseDeferredStartupTasks()` (called once the
// first window exists) plus a settle delay, then run ONE AT A TIME so they
// never compete with each other either.
//
// Semantics:
//   - Order is preserved (FIFO). Each task runs to completion (or failure)
//     before the next starts; a failing task never blocks the queue.
//   - Tasks enqueued after the queue has drained still run, after a short gap,
//     so late triggers (e.g. a sign-in minutes after launch) behave the same.
//   - Tasks resolve their dependencies when they RUN, not when queued — e.g.
//     read DatabaseManager.getDb() inside the task, never capture it earlier.

type DeferredTask = { name: string; run: () => Promise<unknown> | unknown };

/** Settle delay after release before the first task starts. */
export const DEFERRED_STARTUP_DELAY_MS = 30_000;
/** Pause between consecutive tasks. */
export const DEFERRED_TASK_GAP_MS = 2_000;

const queue: DeferredTask[] = [];
let released = false;
let releaseTimerDone = false;
let running = false;

function pump(): void {
    if (!releaseTimerDone || running) return;
    const task = queue.shift();
    if (!task) return;
    running = true;
    const startedAt = Date.now();
    Promise.resolve()
        .then(() => task.run())
        .then(
            () => console.log(`[DeferredStartup] ${task.name} done in ${Date.now() - startedAt} ms`),
            (err) => console.warn(`[DeferredStartup] ${task.name} failed (non-fatal):`, err),
        )
        .finally(() => {
            running = false;
            if (queue.length > 0) {
                setTimeout(pump, DEFERRED_TASK_GAP_MS).unref?.();
            }
        });
}

/** Queue a non-critical startup task. Safe to call before or after release. */
export function scheduleDeferredStartupTask(name: string, run: DeferredTask['run']): void {
    queue.push({ name, run });
    if (releaseTimerDone && !running && queue.length === 1) {
        setTimeout(pump, DEFERRED_TASK_GAP_MS).unref?.();
    }
}

/** Start the countdown. Call once, after the first window is created; idempotent. */
export function releaseDeferredStartupTasks(delayMs: number = DEFERRED_STARTUP_DELAY_MS): void {
    if (released) return;
    released = true;
    console.log(`[DeferredStartup] ${queue.length} task(s) queued; starting in ${Math.round(delayMs / 1000)} s`);
    setTimeout(() => {
        releaseTimerDone = true;
        pump();
    }, delayMs).unref?.();
}

/** Test-only: reset module state. */
export function __resetDeferredStartupForTests(): void {
    queue.length = 0;
    released = false;
    releaseTimerDone = false;
    running = false;
}
