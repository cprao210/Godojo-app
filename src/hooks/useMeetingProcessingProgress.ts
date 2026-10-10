import { useEffect, useState } from 'react';
import type { MeetingProcessingSnapshot } from '@/lib/postMeetingProgress';

/**
 * Live view of what main is doing for a meeting that is still processing.
 *
 * Own IPC channel, own getter: it never touches the meeting-details read
 * (GET /meetings/:id or the local details IPC), so the loader it feeds cannot be
 * triggered or influenced by that flow. Cost while idle is zero — `enabled`
 * false means no listener and no read.
 *
 * `null` = main has no snapshot yet (still starting, or the app restarted
 * mid-processing).
 */
export function useMeetingProcessingProgress(meetingId: string, enabled: boolean): MeetingProcessingSnapshot | null {
    const [snapshot, setSnapshot] = useState<MeetingProcessingSnapshot | null>(null);

    useEffect(() => {
        if (!enabled || !meetingId) return;
        let cancelled = false;

        // Subscribe BEFORE the initial read so an event fired in between is never lost;
        // the read only fills in if nothing newer already arrived.
        const off = window.electronAPI?.onMeetingProcessingProgress?.((snap) => {
            if (snap.meetingId === meetingId) setSnapshot(snap);
        });
        window.electronAPI?.getMeetingProcessingProgress?.(meetingId)
            .then((snap) => {
                if (cancelled || !snap) return;
                setSnapshot((prev) => (prev && prev.updatedAt >= snap.updatedAt ? prev : snap));
            })
            .catch(() => { /* progress is best-effort */ });

        return () => {
            cancelled = true;
            off?.();
        };
    }, [meetingId, enabled]);

    // A different meeting must never inherit the previous one's steps.
    return snapshot && snapshot.meetingId === meetingId ? snapshot : null;
}