import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFERRED_STARTUP_DELAY_MS,
    DEFERRED_TASK_GAP_MS,
    __resetDeferredStartupForTests,
    releaseDeferredStartupTasks,
    scheduleDeferredStartupTask,
} from '../utils/deferredStartup';

// Let queued promise callbacks (task run → then → finally) settle.
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('deferredStartup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        __resetDeferredStartupForTests();
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not run anything before release + settle delay', async () => {
        const task = vi.fn();
        scheduleDeferredStartupTask('a', task);
        await vi.advanceTimersByTimeAsync(DEFERRED_STARTUP_DELAY_MS * 2);
        expect(task).not.toHaveBeenCalled(); // never released

        releaseDeferredStartupTasks();
        await vi.advanceTimersByTimeAsync(DEFERRED_STARTUP_DELAY_MS - 1);
        expect(task).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await flush();
        expect(task).toHaveBeenCalledTimes(1);
    });

    it('runs tasks one at a time, in order', async () => {
        const order: string[] = [];
        let finishFirst!: () => void;
        scheduleDeferredStartupTask('first', () => new Promise<void>((r) => { order.push('first:start'); finishFirst = () => { order.push('first:end'); r(); }; }));
        scheduleDeferredStartupTask('second', () => { order.push('second'); });

        releaseDeferredStartupTasks();
        await vi.advanceTimersByTimeAsync(DEFERRED_STARTUP_DELAY_MS);
        await flush();
        await vi.advanceTimersByTimeAsync(DEFERRED_TASK_GAP_MS * 5);
        expect(order).toEqual(['first:start']); // second waits for first

        finishFirst();
        await flush();
        await vi.advanceTimersByTimeAsync(DEFERRED_TASK_GAP_MS);
        await flush();
        expect(order).toEqual(['first:start', 'first:end', 'second']);
    });

    it('a failing task does not block the queue', async () => {
        const after = vi.fn();
        scheduleDeferredStartupTask('boom', () => { throw new Error('x'); });
        scheduleDeferredStartupTask('after', after);
        releaseDeferredStartupTasks();
        await vi.advanceTimersByTimeAsync(DEFERRED_STARTUP_DELAY_MS);
        await flush();
        await vi.advanceTimersByTimeAsync(DEFERRED_TASK_GAP_MS);
        await flush();
        expect(after).toHaveBeenCalledTimes(1);
    });

    it('tasks scheduled after the queue drained still run', async () => {
        releaseDeferredStartupTasks();
        await vi.advanceTimersByTimeAsync(DEFERRED_STARTUP_DELAY_MS);
        const late = vi.fn();
        scheduleDeferredStartupTask('late', late); // e.g. a sign-in minutes later
        await vi.advanceTimersByTimeAsync(DEFERRED_TASK_GAP_MS);
        await flush();
        expect(late).toHaveBeenCalledTimes(1);
    });

    it('release is idempotent', async () => {
        const task = vi.fn();
        scheduleDeferredStartupTask('a', task);
        releaseDeferredStartupTasks();
        releaseDeferredStartupTasks(0); // ignored — must not run early
        await vi.advanceTimersByTimeAsync(1);
        await flush();
        expect(task).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(DEFERRED_STARTUP_DELAY_MS);
        await flush();
        expect(task).toHaveBeenCalledTimes(1);
    });
});
