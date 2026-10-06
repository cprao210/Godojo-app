/**
 * llmUsageStore.ts
 *
 * Session store for the LLM usage observability payloads (see
 * electron/utils/llmUsageBus.ts): every post-call summary generation,
 * regeneration and follow-up-email generation reports provider, model and
 * input/output token counts over the 'llm-usage' IPC channel (post-call summary,
 * follow-up email, and the pre-call sales brief + company insights). PostHog capture
 * happens in the main process; this store exists purely for the renderer's
 * dev-only usage chip (src/features/meetings/LLMUsageChip).
 *
 * Session-scoped by design: payloads arrive while the app is running, so a
 * generation is visible immediately after it happens. Nothing is persisted —
 * restarting clears the history, which is fine for a dev tool.
 */

import { useEffect, useState } from 'react';
import type { LLMUsagePayload } from '@/electron.d';

const byMeeting = new Map<string, LLMUsagePayload[]>();
const listeners = new Map<string, Set<() => void>>();

let initialized = false;

function notify(meetingId: string): void {
    for (const fn of listeners.get(meetingId) ?? []) fn();
}

function init(): void {
    if (initialized) return;
    initialized = true;
    try {
        window.electronAPI?.onLLMUsage?.((payload: LLMUsagePayload) => {
            if (!payload?.meetingId) return;
            const list = byMeeting.get(payload.meetingId) ?? [];
            list.push(payload);
            byMeeting.set(payload.meetingId, list);
            notify(payload.meetingId);
        });
    } catch (e) {
        console.warn('[llmUsageStore] subscription failed:', e);
    }
}

// Subscribe as soon as the module loads (not on the first chip mount), so a pre-call
// generation that finishes before its panel renders — or while another view is open —
// is still in the session history when the chip appears.
if (typeof window !== 'undefined') init();

/** All usage payloads seen this session for a meeting, oldest first. */
export function getLLMUsageHistory(meetingId: string): LLMUsagePayload[] {
    init();
    return byMeeting.get(meetingId) ?? [];
}

/** React hook: usage payloads for a meeting, re-rendering on new arrivals. */
export function useLLMUsage(meetingId?: string): LLMUsagePayload[] {
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!meetingId) return;
        init();
        const listener = () => setTick((t) => t + 1);
        let set = listeners.get(meetingId);
        if (!set) {
            set = new Set();
            listeners.set(meetingId, set);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
            if (set.size === 0) listeners.delete(meetingId);
        };
    }, [meetingId]);
    return meetingId ? (byMeeting.get(meetingId) ?? []) : [];
}