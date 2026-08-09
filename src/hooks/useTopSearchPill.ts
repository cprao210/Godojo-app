// State + interaction layer for TopSearchPill: owns the open/focused/results
// state machine, the fuzzy meeting search itself, keyboard navigation
// (⌘K to open, arrows to navigate, Enter to select, Escape to close), and
// click-outside-to-close. Kept separate from the component so the component
// only owns rendering — same split as useGlobalChat / useCalendarConnections.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Meeting, PillState, SearchResult } from "@/types";

// ============================================
// Fuzzy Search Helpers
// ============================================
// Pure, side-effect-free — colocated here since nothing outside this hook
// (or its tests) needs them.

function fuzzyMatch(text: string, query: string): boolean {
    const normalizedText = text.toLowerCase();
    const normalizedQuery = query.toLowerCase();

    // Simple contains match for now.
    // (Character-level fuzzy matching was tried and removed for stricter accuracy —
    // only an exact substring match counts.)
    return normalizedText.includes(normalizedQuery);
}

function searchMeetings(meetings: Meeting[], query: string): SearchResult[] {
    if (!query.trim()) return [];

    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (const meeting of meetings) {
        if (seen.has(meeting.id)) continue;

        // Match against title and summary.
        const titleMatch = fuzzyMatch(meeting.title, query);
        const summaryMatch = meeting.summary && fuzzyMatch(meeting.summary, query);

        if (titleMatch || summaryMatch) {
            seen.add(meeting.id);
            results.push({
                id: meeting.id,
                type: "meeting",
                title: meeting.title,
                subtitle: new Date(meeting.date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                }),
                meetingId: meeting.id,
            });
        }

        if (results.length >= 5) break;
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
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(-1);

    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Notify the parent whenever the pill expands/collapses (e.g. so it can
    // dim the rest of the launcher while search is active).
    useEffect(() => {
        onExpansionChange?.(state !== "idle");
    }, [state, onExpansionChange]);

    // Search results for the current query — only computed while the "results" state is active.
    const sessionResults = useMemo(() => {
        if (state !== "results" || !query.trim()) return [];
        return searchMeetings(meetings, query);
    }, [meetings, query, state]);

    const totalItems = sessionResults.length;

    // ── State transitions ────────────────────────────────────────────────
    const open = useCallback(() => {
        setState("focused");
        setTimeout(() => inputRef.current?.focus(), 50);
    }, []);

    const close = useCallback(() => {
        setState("idle");
        // Delay clearing the query so the exit animation has something to fade out.
        setTimeout(() => {
            setQuery("");
            setSelectedIndex(-1);
        }, 150);
        inputRef.current?.blur();
    }, []);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setQuery(value);
        setSelectedIndex(-1);
        setState(value.trim() ? "results" : "focused");
    }, []);

    const handleInputFocus = useCallback(() => {
        setState((prev) => (prev === "idle" ? "focused" : prev));
    }, []);

    const handlePillClick = useCallback(() => {
        if (state === "idle") open();
    }, [state, open]);

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