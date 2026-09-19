// Shared meeting-filter state — the single source of truth for the header
// search pill (query + type/date filters) AND the meetings list it filters.
// A tiny external store (useSyncExternalStore) because the pill (LauncherHeader)
// and the meetings list (useLauncher) are sibling components that must stay in
// sync without prop-drilling through LauncherProps.
//
// The pill's query is PERSISTENT: closing the pill does not clear it, so the
// list stays filtered after ⌘K is dismissed (the input's × clears it).

import { useSyncExternalStore } from "react";

export type MeetingSourceTypeFilter = 'all' | 'calendar' | 'quick' | 'upload';
export type MeetingDateFilter = 'all' | 'today' | '7d' | '30d';

export type CallCategory = 'discovery' | 'demo' | 'negotiation';

export interface MeetingFilters {
    search: string;
    source: MeetingSourceTypeFilter;
    dateRange: MeetingDateFilter;
    /** Multi-select call categories — a meeting can carry several, and the
    filter matches ANY of the selected ones (empty = all). */
    callTypes: CallCategory[];
}

let state: MeetingFilters = { search: '', source: 'all', dateRange: 'all', callTypes: [] };
const listeners = new Set<() => void>();

export function getMeetingFilters(): MeetingFilters {
    return state;
}

export function setMeetingFilters(patch: Partial<MeetingFilters>): void {
    const next = { ...state, ...patch };
    if (next.search === state.search && next.source === state.source
        && next.dateRange === state.dateRange
        && next.callTypes.length === state.callTypes.length
        && next.callTypes.every(t => state.callTypes.includes(t))) return;
    state = next;
    listeners.forEach(l => l());
}

export function subscribeMeetingFilters(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export function useMeetingFilters(): MeetingFilters {
    return useSyncExternalStore(subscribeMeetingFilters, getMeetingFilters);
}

// Epoch-ms start of the date filter's window; null = no bound (All time).
export function meetingDateRangeStartMs(range: MeetingDateFilter): number | undefined {
    if (range === 'all') return undefined;
    const now = new Date();
    if (range === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return start.getTime();
    }
    const days = range === '7d' ? 7 : 30;
    return now.getTime() - days * 24 * 60 * 60 * 1000;
}
