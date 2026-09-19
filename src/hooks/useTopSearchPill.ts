// State + interaction layer for TopSearchPill: owns the open/focused/results
// state machine, the fuzzy meeting search itself, keyboard navigation
// (⌘K to open, arrows to navigate, Enter to select, Escape to close), and
// click-outside-to-close. Kept separate from the component so the component
// only owns rendering — same split as useGlobalChat / useCalendarConnections.
//
// The pill is ALSO the meetings list's filter control: its query and the
// type/date filters write to the shared meetingFilterStore, which the
// launcher's meetings list reads. The query is persistent — dismissing the
// pill keeps the list filtered; the input's × clears it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Meeting, PillState, SearchResult } from "@/types";
import { meetingKindOf, meetingSearchText } from "@/api/meetingMapping";
import {
    CallCategory,
    MeetingDateFilter,
    MeetingSourceTypeFilter,
    getMeetingFilters,
    meetingDateRangeStartMs,
    setMeetingFilters,
    useMeetingFilters,
} from "@/lib/meetingFilterStore";

// ============================================
// Search Helpers
// ============================================

function searchMeetings(
    meetings: Meeting[],
    query: string,
    filters: { source: MeetingSourceTypeFilter; dateRange: MeetingDateFilter; callTypes: string[] },
): SearchResult[] {
    const text = query.trim().toLowerCase();
    if (!text) return [];

    const rangeStart = meetingDateRangeStartMs(filters.dateRange);
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (const meeting of meetings) {
        if (seen.has(meeting.id)) continue;

        // Filters narrow the dropdown the same way they narrow the list.
        if (filters.source !== 'all' && meetingKindOf(meeting) !== filters.source) continue;
        if (rangeStart != null) {
            const t = new Date(meeting.date).getTime();
            if (Number.isNaN(t) || t < rangeStart) continue;
        }
        if (filters.callTypes.length > 0) {
            const types = meeting.meetingTypes ?? [];
            if (!filters.callTypes.some(c => types.includes(c))) continue;
        }

        // Text match spans title, summary, company name/domain, and attendee
        // names/emails (see meetingSearchText).
        if (!meetingSearchText(meeting).includes(text)) continue;

        seen.add(meeting.id);
        const dateLabel = new Date(meeting.date).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
        });
        results.push({
            id: meeting.id,
            type: "meeting",
            title: meeting.title,
            subtitle: meeting.company?.name ? `${meeting.company.name} · ${dateLabel}` : dateLabel,
            meetingId: meeting.id,
        });

        if (results.length >= 8) break;
    }

    return results;
}

// ============================================
// Hook
// ============================================

interface UseTopSearchPillArgs {
    meetings: Meeting[];
    onOpenMeeting: (meetingId: string) => void;
    onExpansionChange?: (isExpanded: boolean) => void;
}

export function useTopSearchPill({ meetings, onOpenMeeting, onExpansionChange }: UseTopSearchPillArgs) {
    const [state, setState] = useState<PillState>("idle");
    // The query doubles as the persistent meetings-list filter (see the store).
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [isFilterOpen, setIsFilterOpen] = useState(false);

    const filters = useMeetingFilters();
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Notify the parent whenever the pill expands/collapses (e.g. so it can
    // dim the rest of the launcher while search is active).
    useEffect(() => {
        onExpansionChange?.(state !== "idle");
    }, [state, onExpansionChange]);

    // Every keystroke updates the shared filter store — the meetings list
    // behind the pill re-filters live (pure client-side, zero API calls).
    const handleQueryChange = useCallback((value: string) => {
        setQuery(value);
        setMeetingFilters({ search: value.trim() });
    }, []);

    // Search results for the current query — only computed while the "results" state is active.
    const sessionResults = useMemo(() => {
        if (state !== "results" || !query.trim()) return [];
        return searchMeetings(meetings, query, { source: filters.source, dateRange: filters.dateRange, callTypes: filters.callTypes });
    }, [meetings, query, state, filters.source, filters.dateRange, filters.callTypes]);

    const totalItems = sessionResults.length;

    // ── State transitions ────────────────────────────────────────────────
    const open = useCallback(() => {
        setState("focused");
        setTimeout(() => inputRef.current?.focus(), 50);
    }, []);

    const close = useCallback(() => {
        setState("idle");
        // The query is intentionally NOT cleared on close — it is the
        // persistent list filter (the user filtered their meetings via the
        // header search and expects the list to stay filtered). Only the
        // keyboard-selection index resets; the input's × clears the query
        // and the filter together.
        setSelectedIndex(-1);
        setIsFilterOpen(false);
        inputRef.current?.blur();
    }, []);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        handleQueryChange(value);
        setSelectedIndex(-1);
        setState(value.trim() ? "results" : "focused");
    }, [handleQueryChange]);

    const clearQuery = useCallback(() => {
        handleQueryChange("");
        setSelectedIndex(-1);
        inputRef.current?.focus();
    }, [handleQueryChange]);

    const handleInputFocus = useCallback(() => {
        setState((prev) => (prev === "idle" ? "focused" : prev));
    }, []);

    const handlePillClick = useCallback(() => {
        if (state === "idle") open();
    }, [state, open]);

    const toggleFilterOpen = useCallback(() => {
        setIsFilterOpen(prev => !prev);
    }, []);

    const setFilters = useCallback((patch: { source?: MeetingSourceTypeFilter; dateRange?: MeetingDateFilter; callTypes?: CallCategory[] }) => {
        setMeetingFilters(patch);
    }, []);

    const toggleCallType = useCallback((category: CallCategory) => {
        const current = getMeetingFilters().callTypes;
        const next = current.includes(category)
            ? current.filter(c => c !== category)
            : [...current, category];
        setMeetingFilters({ callTypes: next });
    }, []);

    const activeFilterCount = (filters.source !== 'all' ? 1 : 0) + (filters.dateRange !== 'all' ? 1 : 0)
        + (filters.callTypes.length > 0 ? 1 : 0);

    const handleSelect = useCallback(
        (index: number) => {
            const result = sessionResults[index];
            if (result) {
                onOpenMeeting(result.meetingId);
                close();
            }
        },
        [sessionResults, onOpenMeeting, close],
    );

    // ── Keyboard handling: ⌘K to open, Escape to close, arrows + Enter to navigate ──
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // ⌘K / Ctrl+K toggles open/closed.
            if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                e.preventDefault();
                if (state === "idle") open();
                else close();
                return;
            }

            if (state === "idle") return;

            if (e.key === "Escape") {
                e.preventDefault();
                close();
                return;
            }

            if (state === "results") {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSelectedIndex((prev) => Math.min(prev + 1, totalItems - 1));
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSelectedIndex((prev) => Math.max(prev - 1, -1));
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    handleSelect(selectedIndex);
                }
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [state, open, close, selectedIndex, totalItems, handleSelect]);

    // ── Click outside the pill closes it ─────────────────────────────────
    useEffect(() => {
        if (state === "idle") return;

        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                close();
            }
        };

        // Delay to avoid closing immediately from the click that opened it.
        const timer = setTimeout(() => {
            document.addEventListener("mousedown", handleClickOutside);
        }, 100);

        return () => {
            clearTimeout(timer);
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [state, close]);

    const isExpanded = state !== "idle";
    const showResults = state === "results" && !!query.trim();

    return {
        // state
        state,
        query,
        selectedIndex,
        sessionResults,
        isExpanded,
        showResults,
        // filters (shared store — drives the meetings list too)
        filters,
        setFilters,
        toggleCallType,
        activeFilterCount,
        isFilterOpen,
        toggleFilterOpen,
        clearQuery,
        // refs
        inputRef,
        containerRef,
        // handlers
        close,
        handleInputChange,
        handleInputFocus,
        handlePillClick,
        handleSelect,
        setSelectedIndex,
    };
}

