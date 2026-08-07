/**
 * useMeetingTimeline.ts
 *
 * Backs the horizontal upcoming-meetings strip: scrolls the active pill
 * into view whenever the selection changes, and formats each pill's
 * relative/absolute time labels.
 */
import { useEffect, useRef } from 'react';

export function getRelativeLabel(startTime: string): string {
    const diffMs = new Date(startTime).getTime() - Date.now();
    if (diffMs <= 0) return 'Now';
    const totalMins = Math.ceil(diffMs / 60000);
    if (totalMins < 60) return `${totalMins}m`;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatTimeShort(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

export function useMeetingTimeline(selectedId: string | null) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef<HTMLButtonElement>(null);

    // Scroll active pill into view
    useEffect(() => {
        activeRef.current?.scrollIntoView({
            inline: 'nearest',
            block: 'nearest',
            behavior: 'smooth',
        });
    }, [selectedId]);

    return { scrollRef, activeRef };
}