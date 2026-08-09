/**
 * meetingProviderUtils.ts
 *
 * Detects which video-call provider a meeting link belongs to. Previously
 * duplicated verbatim in both MeetingTimeline.tsx and NextMeetingCard.tsx —
 * centralized here so the two stay in sync.
 */

export type MeetingProvider = 'meet' | 'zoom' | 'teams';

/** Narrow variant (no 'other') — used by MeetingTimeline's compact pill. */
export function detectProvider(link?: string): MeetingProvider | null {
    if (!link) return null;
    if (link.includes('meet.google.com')) return 'meet';
    if (link.includes('zoom.us')) return 'zoom';
    if (link.includes('teams.microsoft.com')) return 'teams';
    return null;
}

/** Wide variant (falls back to 'other') — used by NextMeetingCard's provider chip. */
export function detectProviderOrOther(link?: string): MeetingProvider | 'other' | null {
    if (!link) return null;
    return detectProvider(link) ?? 'other';
}