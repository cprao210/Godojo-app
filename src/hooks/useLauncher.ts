// State + data-fetching layer for Launcher: owns the meetings list/delete
// mutation, calendar + upcoming-events polling, meeting-active/undetectable
// sync with the Electron main process, the transcript upload flow, the
// row context-menu + expand/collapse UI state, and the global-chat /
// keyboard-shortcut wiring. Kept separate from the component so the
// component only owns rendering — same split as
// useManagerDashboard / useCalendarConnections / useGlobalChat.

import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from 'react-query';
import { useShortcuts, useResolvedTheme } from '@/hooks';
import { loadUserProfile } from '@/features/settings';
import { chatApi, meetingsApi } from '@/api';
import { PROCESSING_TITLE, isMeetingProcessing, meetingKindOf, meetingSearchText, shouldMergeLocalMeeting } from '@/api/meetingMapping';
import { useMeetingFilters, meetingDateRangeStartMs } from '@/lib/meetingFilterStore';
import { OPTIMISTIC_LIVE_ID, byNewestFirst, isOptimisticId } from '@/api/meetingMapping';
import { mergeMeetingCopies, reconcileFetchedMeetings } from '@/api/meetingMapping';
import { ApiError } from '@/lib/apiClient';
import { applyCompanyToCaches, flushPendingLinks, forgetPendingLink, linkMeetingCompany, rememberPendingLink } from '@/lib/companyAssociation';
import type { PickedCompany } from '@/types';
import { LauncherProps, Meeting, UpcomingMeeting } from '@/types';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Initial page size and the increment used each time "Load more" is
// clicked. Matches the backend's documented example (`?limit=10`).
const INITIAL_MEETINGS_LIMIT = 20;
const LOAD_MORE_MEETINGS_STEP = 10;
// Rows per slim page when building the full client-side meeting index.
const MEETINGS_INDEX_PAGE_SIZE = 200;

// ─── Pure formatting helpers ─────────────────────────────────────────────────
// Exported so LauncherWidgets can format the same way without re-deriving
// the logic.

/** Groups a meeting's date into "Today" / "Yesterday" / a short weekday label. */
export const getGroupLabel = (dateStr: string) => {
    if (dateStr === 'Today') return 'Today'; // Backward compatibility

    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const checkDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (checkDate.getTime() === today.getTime()) return 'Today';
    if (checkDate.getTime() === yesterday.getTime()) return 'Yesterday';

    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

/** Formats a meeting's date as a clock time, e.g. "3:14pm". */
export const formatTime = (dateStr: string) => {
    if (dateStr === 'Today') return 'Just now'; // Legacy
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
};

/** Zero-pads a duration string ("hh:mm:ss" / "mm:ss" / legacy "X min") for the row pill. */
export const formatDurationPill = (durationStr: string): string => {
    if (!durationStr) return '00:00';

    // Already in hh:mm:ss or mm:ss from DatabaseManager.formatDuration — pass through
    // with zero-padding applied to each segment
    if (durationStr.includes(':')) {
        const parts = durationStr.split(':');
        if (parts.length === 3) {
            // hh:mm:ss
            const [h, m, s] = parts;
            return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;
        }
        // mm:ss
        const [m, s] = parts;
        return `${m.padStart(2, '0')}:${s.padStart(2, '0')}`;
    }

    // Legacy fallback: "X min" → convert to mm:ss
    const minutes = parseInt(durationStr.replace(/[^0-9]/g, ''), 10) || 0;
    return `${minutes.toString().padStart(2, '0')}:00`;
};

/** Meeting-type checkbox options for the upload-transcript modal. */
export const UPLOAD_MEETING_TYPE_OPTIONS = [
    { value: 'discovery' as const, label: 'Discovery', activeColor: '#a78bfa', activeBg: 'rgba(139,92,246,0.12)', activeBorder: 'rgba(139,92,246,0.35)' },
    { value: 'demo' as const, label: 'Demo', activeColor: '#34d399', activeBg: 'rgba(52,211,153,0.10)', activeBorder: 'rgba(52,211,153,0.30)' },
    { value: 'negotiation' as const, label: 'Negotiation', activeColor: '#fbbf24', activeBg: 'rgba(251,191,36,0.10)', activeBorder: 'rgba(251,191,36,0.30)' },
];

// How often to poll /meetings while a meeting is still "Processing...".
const PROCESSING_POLL_INTERVAL_MS = 3000;
// Stop fast-polling for a meeting that's been stuck "Processing..." longer
// than this — it's almost certainly a sync failure rather than something
// about to finish, so keeping the 3s poller alive forever isn't useful.
const PROCESSING_POLL_TIMEOUT_MS = 5 * 60 * 1000;

// Id of the renderer-only card shown between "user hit End" and "main has a row
// for this call" now lives in meetingMapping.ts alongside the reconciliation
// rules that consume it (OPTIMISTIC_LIVE_ID / isOptimisticId).

/** Client-side search + type/date filtering over the full meetings index.
The search haystack lives in meetingMapping (shared with the header pill). */
export function applyMeetingFilters(
    meetings: Meeting[],
    opts: {
        search: string;
        source: 'all' | 'calendar' | 'quick' | 'upload';
        dateRange: 'all' | 'today' | '7d' | '30d';
        callTypes: string[];
    },
): Meeting[] {
    const s = opts.search.toLowerCase();
    const rangeStart = meetingDateRangeStartMs(opts.dateRange);
    return meetings.filter(m => {
        if (opts.source !== 'all' && meetingKindOf(m) !== opts.source) return false;
        if (rangeStart != null) {
            const t = new Date(m.date).getTime();
            if (Number.isNaN(t) || t < rangeStart) return false;
        }
        // Multi-select call categories: match ANY of the selected ones — a
        // demo+negotiation meeting matches either selection.
        if (opts.callTypes.length > 0) {
            const types = m.meetingTypes ?? [];
            if (!opts.callTypes.some(c => types.includes(c))) return false;
        }
        if (s && !meetingSearchText(m).includes(s)) return false;
        return true;
    });
}

/**
 * Folds locally-known meetings into whatever the list currently shows.
 *
 * SQLite has the finished-call row within milliseconds of the user hitting End
 * (MeetingPersistence.stopMeeting writes it synchronously), so reading it over
 * IPC surfaces the processing card immediately instead of waiting on the
 * GET /meetings round-trip. Additive by design: it never drops a row the
 * backend supplied, and never downgrades a processed row back to a placeholder.
 *
 * Returns `current` by reference when nothing changed, so React Query can skip
 * the re-render.
 */
export function mergeLocalMeetings(current: Meeting[], local: Meeting[]): Meeting[] {
    if (local.length === 0) return current;

    const byId = new Map(current.map(m => [m.id, m]));
    let changed = false;

    for (const row of local) {
        const existing = byId.get(row.id);
        if (!existing) {
            if (!shouldMergeLocalMeeting(row)) continue;
            byId.set(row.id, row);
            changed = true;
        } else {
            // Processing → processed: take the local copy's title/duration/summary
            // but keep any backend-only fields already on the row. Same one-way
            // rule the HTTP list and every refetch use.
            const merged = mergeMeetingCopies(existing, row);
            if (merged !== existing) {
                byId.set(row.id, merged);
                changed = true;
            }
        }
    }

    // Retire the optimistic card once a real row for the same call is listed,
    // otherwise the just-ended meeting shows up twice.
    const hasRealProcessingRow = [...byId.values()].some(
        m => !isOptimisticId(m.id) && isMeetingProcessing(m),
    );
    if (hasRealProcessingRow && byId.delete(OPTIMISTIC_LIVE_ID)) changed = true;

    if (!changed) return current;

    return [...byId.values()].sort(byNewestFirst);
}

export function useLauncher({ onStartMeeting, ollamaPullStatus = 'idle', onPageChange, authUser }: Pick<LauncherProps, 'onStartMeeting' | 'onPageChange' | 'authUser'> & { ollamaPullStatus?: LauncherProps['ollamaPullStatus'] }) {

    const queryClient = useQueryClient();

    // ─── Meetings list + delete mutation ────────────────────────────────────
    // The fetch is reconciled against what's already on screen rather than
    // replacing it outright: a refetch must not revert a processed row to
    // "Processing" because the Supabase mirror is a few seconds behind local
    // SQLite, and must not wipe the optimistic card for a call main hasn't
    // committed yet. See reconcileFetchedMeetings for both rules.
    //
    // The query builds the FULL meeting index in slim card-shape (a few paged
    // requests over ?slim=true rows — no heavy summary_json) and then ALL
    // search/filter/count happen in memory: playing with the header filters
    // costs zero API calls, and the filters work across every meeting, not
    // just a fetched page. The query key stays the single ['meetings']
    // deliberately: this hook has ~10 other spots that read/write the
    // meetings cache via queryClient.*QueryData(['meetings'], ...) for
    // optimistic updates (row delete, live-meeting patches, etc.).
    const { data: meetings = [], isLoading, isFetching } = useQuery<Meeting[]>(['meetings'], async () => {
        const all: Meeting[] = [];
        const seen = new Set<string>();
        const maxRows = 5000; // safety valve — a corpus this big needs server-side search instead
        let offset = 0;
        let page: Meeting[] = [];
        do {
            page = await meetingsApi.list({ limit: MEETINGS_INDEX_PAGE_SIZE, offset, slim: true });
            for (const m of page) {
                if (!seen.has(m.id)) {
                    seen.add(m.id);
                    all.push(m);
                }
            }
            offset += page.length;
        } while (page.length === MEETINGS_INDEX_PAGE_SIZE && offset < maxRows);
        return reconcileFetchedMeetings(queryClient.getQueryData<Meeting[]>(['meetings']) ?? [], all);
    }, {
        // Poll only while a meeting is still processing (replaces the manual setInterval).
        staleTime: 10_000,
        refetchInterval: (data) => {
            const stillProcessing = (data ?? []).filter(isMeetingProcessing);
            if (stillProcessing.length === 0) return false;

            const worthPolling = stillProcessing.some((m) => {
                const startedAt = new Date(m.date).getTime();
                return Number.isNaN(startedAt) || Date.now() - startedAt < PROCESSING_POLL_TIMEOUT_MS;
            });
            return worthPolling ? PROCESSING_POLL_INTERVAL_MS : false;
        },
    });

    // ─── Meeting search + filters (pure client-side) ─────────────────────────
    // The search query and type/date filters are OWNED by the header search
    // pill via the shared meetingFilterStore (the pill is the single filter
    // control). Filtering is a pure in-memory pass — zero API calls.
    const { search: filterSearch, source: filterSource, dateRange: filterDateRange, callTypes: filterCallTypes } = useMeetingFilters();

    const filteredMeetings = React.useMemo(
        () => applyMeetingFilters(meetings, {
            search: filterSearch,
            source: filterSource,
            dateRange: filterDateRange,
            callTypes: filterCallTypes,
        }),
        [meetings, filterSearch, filterSource, filterDateRange, filterCallTypes],
    );

    // Display cap over the FILTERED list — "Show more" reveals more locally
    // (no API), so even a multi-thousand-meeting corpus can't flood the DOM.
    const [meetingDisplayCap, setMeetingDisplayCap] = useState(INITIAL_MEETINGS_LIMIT);
    const visibleMeetings = React.useMemo(
        () => filteredMeetings.slice(0, meetingDisplayCap),
        [filteredMeetings, meetingDisplayCap],
    );
    const hasMoreMeetings = filteredMeetings.length > meetingDisplayCap;
    const isLoadingMoreMeetings = false; // local slice — instant, no skeleton needed
    const loadMoreMeetings = React.useCallback(() => {
        setMeetingDisplayCap(cap => cap + LOAD_MORE_MEETINGS_STEP);
    }, []);

    // Detect whether any meeting in the list is still being processed
    const hasProcessingMeeting = meetings.some(isMeetingProcessing);

    // Skeleton vs. inline refresh indicator. `isLoading` is React Query's
    // "nothing cached yet" state, so the skeleton only ever replaces a blank
    // list — coming back to Home with a warm cache renders the real rows
    // immediately and shows the subtle header spinner instead of flashing
    // placeholder bars over content that's already correct.
    const isMeetingsLoading = isLoading && meetings.length === 0;
    // Suppressed while something is processing: that's when the 3s poll above is
    // running, and a chip blinking on every tick reads as jitter. The processing
    // row is already telling the user work is in flight.
    const isMeetingsRefreshing = isFetching && meetings.length > 0 && !hasProcessingMeeting;

    // Local-first seed: pull the SQLite rows straight over IPC and fold them in.
    // This is what makes the processing card appear the instant a call ends —
    // main has already committed the placeholder row by the time this IPC is
    // serviced, so the card no longer waits on GET /meetings (or on the Supabase
    // mirror having caught up).
    // Single-flight + one trailing re-run. At call end this fires up to three
    // times within ~1 s (meetings-updated, live-call-ended, the launcher
    // becoming visible), and each call is a synchronous SQLite read in main
    // that also JSON-parses up to 50 summaries. A call arriving while one is
    // in flight is folded into ONE re-run after it, so the newest data still
    // lands but a burst costs at most two reads.
    const seedInFlight = React.useRef<Promise<void> | null>(null);
    const seedAgain = React.useRef(false);
    const seedMeetingsFromLocal = React.useCallback((): Promise<void> => {
        if (seedInFlight.current) {
            seedAgain.current = true;
            return seedInFlight.current;
        }
        const run = async () => {
            do {
                seedAgain.current = false;
                try {
                    // Local SQLite only — getRecentMeetings would prefer the Supabase
                    // mirror, which is precisely the copy that hasn't caught up yet.
                    const localRows = await window.electronAPI?.getRecentMeetingsLocal?.();
                    if (localRows && localRows.length > 0) {
                        queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) =>
                            mergeLocalMeetings(prev, localRows as Meeting[]),
                        );
                    }
                } catch {
                    // No electron API (web build) or the read failed — the HTTP list still applies.
                }
            } while (seedAgain.current);
        };
        const p = run().finally(() => { seedInFlight.current = null; });
        seedInFlight.current = p;
        return p;
    }, [queryClient]);

    // Requirement: coming back to Home must show current meetings, not whatever
    // was cached when the user left. WindowHelper only hides/shows the launcher
    // window (it's never destroyed, so there's no mount to refetch on) and the
    // query client runs with refetchOnWindowFocus disabled — so nothing was
    // triggering a refresh here. Chromium flips document visibility when a
    // BrowserWindow is hidden/shown, which is exactly the "returned to Home"
    // signal. `{ stale: true }` keeps it honest: no request unless the data is
    // actually older than staleTime, so toggling windows can't spam the backend.
    useEffect(() => {
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            void seedMeetingsFromLocal();
            void queryClient.refetchQueries(['meetings'], { stale: true });
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, [queryClient, seedMeetingsFromLocal]);

    // ─── Global retry: link orphaned live-chat interactions ────────────────
    // useMeetingDetails.ts links a meeting's pending "Ask Dojo" interaction
    // ids the moment its details page happens to be open AND the backend has
    // synced that meeting. That's a fine fast path, but it only runs for
    // whichever meeting you happen to have open — a meeting whose details
    // page never gets reopened after the backend catches up stays orphaned
    // in PendingLiveChatStore forever, with no other path to link it. This
    // sweeps every meeting with pending interactions, not just the open one,
    // so a meeting's Ask Dojo history isn't dependent on you happening to
    // revisit that specific meeting at the right moment.
    useEffect(() => {
        let cancelled = false;

        const retryPendingLinks = async () => {
            const pendingIds = await window.electronAPI?.getAllPendingLiveChatMeetingIds?.();
            if (!pendingIds || pendingIds.length === 0 || cancelled) return;

            for (const meetingId of pendingIds) {
                if (cancelled) return;
                try {
                    // meetingsApi.get() succeeding is itself proof the backend
                    // has this meeting row — same precondition useMeetingDetails.ts
                    // relies on, just checked here instead of via a mounted page.
                    await meetingsApi.get(meetingId);
                    const interactionIds = await window.electronAPI?.getPendingLiveChatInteractions?.(meetingId);

                    if (!interactionIds || interactionIds.length === 0) {
                        await window.electronAPI?.clearPendingLiveChatInteractions?.(meetingId);
                        continue;
                    }
                    await chatApi.linkMeetingInteractions(meetingId, interactionIds);
                    await window.electronAPI?.clearPendingLiveChatInteractions?.(meetingId);
                } catch (err) {
                    // Backend likely hasn't synced this meeting yet (404) or is
                    // briefly unreachable — leave it pending, next poll retries.
                    if (err instanceof ApiError && err.status === 404) {
                        // The meeting no longer exists (deleted, or never
                        // will sync) — not "hasn't synced yet". Clear it so
                        // this loop stops hammering /meetings/{id} for a
                        // dead id every 15s forever.
                        console.warn('[useLauncher] retry: meeting no longer exists, giving up on pending interactions for', meetingId);
                        await window.electronAPI?.clearPendingLiveChatInteractions?.(meetingId);
                        continue;
                    }
                    // Backend is briefly unreachable, or hasn't synced this
                    // meeting yet for a reason other than deletion — leave it
                    // pending, next poll retries.
                }
            }
        };

        retryPendingLinks();
        const interval = setInterval(retryPendingLinks, 15000);
        return () => { cancelled = true; clearInterval(interval); };
    }, []);

    const deleteMutation = useMutation<void, unknown, string, { prev?: Meeting[] }>(
        (id) => {
            // 'live-meeting-current' is a local-only transient row (RAGManager
            // inserts it to satisfy a FK constraint while a call is in progress —
            // see DatabaseManager.getRecentMeetings) and never has a backend
            // counterpart. It's normally filtered out of the list entirely, but
            // as a defensive fallback (e.g. a stale cached row), skip the HTTP
            // call and just clean it up locally instead of hitting a DELETE
            // route that doesn't exist on the backend.
            if (id === 'live-meeting-current') {
                return Promise.resolve();
            }
            return meetingsApi.remove(id);
        },
        {
            onMutate: async (id) => {
                await queryClient.cancelQueries(['meetings']);
                const prev = queryClient.getQueryData<Meeting[]>(['meetings']);
                queryClient.setQueryData<Meeting[]>(['meetings'], (old = []) => old.filter(x => x.id !== id));
                return { prev };
            },
            onError: (_err, _id, ctx) => {
                if (ctx?.prev) queryClient.setQueryData(['meetings'], ctx.prev);
            },
            // Write-through: also delete locally so the async SQLite→Supabase mirror can't
            // resurrect the row, and offline/RAG reads stay consistent.
            onSuccess: (_data, id) => { window.electronAPI?.deleteMeeting?.(id); },
            onSettled: () => { void queryClient.invalidateQueries(['meetings']); },
        }
    );

    // ─── Core UI state ───────────────────────────────────────────────────────
    const [isDetectable, setIsDetectable] = useState(false);
    const [isMeetingActive, setIsMeetingActive] = useState(false);
    const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
    const [upcomingEvents, setUpcomingEvents] = useState<any[]>([]);
    const [isCalendarConnected, setIsCalendarConnected] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [showNotification, setShowNotification] = useState(false);
    const [salesBriefEvent, setSalesBriefEvent] = useState<UpcomingMeeting | null>(null);

    // Global search state (for AI chat overlay)
    const [isGlobalChatOpen, setIsGlobalChatOpen] = useState(false);
    const [submittedGlobalQuery, setSubmittedGlobalQuery] = useState('');

    const [localProfile, setLocalProfile] = useState(() => loadUserProfile());
    useEffect(() => {
        const handler = (e: StorageEvent) => {
            if (e.key?.startsWith('gd_user_profile')) setLocalProfile(loadUserProfile());
        };
        window.addEventListener('storage', handler);
        return () => window.removeEventListener('storage', handler);
    }, []);

    // Re-read when the signed-in account changes. The cache key is per-uid, but
    // useState's initializer only runs on mount — and "Add another account"
    // (sign out → SignIn → new user) never remounts the Launcher, so without
    // this it keeps greeting the PREVIOUS account by name. Keyed on email
    // because LauncherProps['authUser'] is a narrowed shape without uid;
    // loadUserProfile() resolves the actual per-uid key itself.
    useEffect(() => {
        setLocalProfile(loadUserProfile());
    }, [authUser?.email]);

    // Backend RAG chunking is now triggered from the Electron processing
    // pipeline itself (electron/MeetingPersistence.ts → requestBackendChunking),
    // with immediate retries + a durable SQLite queue. It used to be this
    // renderer "watch isProcessed flip" effect, which only chunked meetings
    // that completed while the Launcher was open, seeded all other history as
    // handled without chunking, and permanently swallowed the first failure —
    // leaving a large fraction of meetings invisible to chat/RAG.

    // Dedupes trackCalendarEventsFetched() across fetchEvents()'s 60s poll —
    // see fetchEvents below.
    const lastTrackedEventsSignatureRef = React.useRef<string>('');

    const effectiveName = localProfile.displayName || authUser?.displayName || authUser?.email?.split('@')[0] || '';

    // Meetings load over HTTP via React Query (the useQuery above). Existing call sites keep
    // working: this just invalidates the cache so the list refetches from the backend.
    // (The incoming branch's dedup-by-id now lives in meetingsApi.list.)
    const fetchMeetings = () => { void queryClient.invalidateQueries(['meetings']); };

    const fetchEvents = () => {
        if (window.electronAPI && window.electronAPI.getUpcomingEvents) {
            window.electronAPI.getUpcomingEvents()
                .then((events) => {
                    setUpcomingEvents(events);
                    // Only fire when the set of events actually changed — fetchEvents
                    // polls every 60s (see the interval below), and re-sending the
                    // same unchanged events on every tick would just spam PostHog.
                    const signature = (events ?? []).map((e: any) => e?.id).join(',');
                    if (signature !== lastTrackedEventsSignatureRef.current) {
                        lastTrackedEventsSignatureRef.current = signature;
                        if (events && events.length > 0) {
                            posthogAnalytics.trackCalendarEventsFetched(events);
                        }
                    }
                })
                .catch(err => console.error('Failed to fetch events:', err));
        }
    };

    // Wraps setIsCalendarConnected so the "next meeting" card updates in the
    // same tick as the connected badge, instead of waiting on the 60s poll
    // or the manual Refresh button. Previously CalendarConnectCard's
    // onConnect/onDisconnect only flipped isCalendarConnected — upcomingEvents
    // is separate state that nothing else refreshed, so "Connected" showed
    // immediately but the next-meeting card kept showing stale/empty data
    // until the user hit Refresh.
    const handleCalendarConnected = () => {
        setIsCalendarConnected(true);
        fetchEvents();
    };
    const handleCalendarDisconnected = () => {
        setIsCalendarConnected(false);
        // Clear immediately rather than waiting on the next fetchEvents —
        // the disconnected provider's events are no longer valid and a stale
        // array would keep the "next meeting" card showing a ghost meeting.
        setUpcomingEvents([]);
    };

    const handleRefresh = async () => {
        posthogAnalytics.trackLauncherRefresh();
        setIsRefreshing(true);
        try {
            if (window.electronAPI && window.electronAPI.calendarRefresh) {
                setShowNotification(true);
                await window.electronAPI.calendarRefresh();
                fetchEvents();
                fetchMeetings();
                setTimeout(() => {
                    setShowNotification(false);
                }, 3000);
            } else {
                console.warn('electronAPI.calendarRefresh not found');
            }
        } catch (e) {
            console.error('Refresh failed in handleRefresh:', e);
        } finally {
            // Ensure distinct feedback provided (min 500ms spin)
            setTimeout(() => setIsRefreshing(false), 500);
        }
    };

    // Active polling — fires every 3 s while any meeting is still processing.
    // Stops automatically once all meetings have been fully processed.
    // This is a safety net for the race where onMeetingsUpdated fires before
    // the listener is registered, or is missed entirely.
    // The "still processing" poll is handled by the useQuery refetchInterval above.

    useEffect(() => {
        if (!window.electronAPI) return;
        Promise.all([
            window.electronAPI.getCalendarStatus(),
            window.electronAPI.getZoomCalendarStatus(),
        ]).then(([google, zoom]) => {
            setIsCalendarConnected(google.connected || zoom.connected);
        });
    }, []);

    // Keybinds
    const { isShortcutPressed } = useShortcuts();
    const isLight = useResolvedTheme() === 'light';

    useEffect(() => {
        let mounted = true;
        console.log('Launcher mounted');
        // Seed demo data if needed (safe to call always — runs ONCE on mount)
        if (window.electronAPI && window.electronAPI.seedDemo) {
            window.electronAPI.seedDemo().catch(err => console.error('Failed to seed demo:', err));
        }

        // Sync initial undetectable state
        if (window.electronAPI?.getUndetectable) {
            window.electronAPI.getUndetectable().then((undetectable) => {
                if (mounted) setIsDetectable(!undetectable);
            });
        }

        // Listen for undetectable changes
        let removeUndetectableListener: (() => void) | undefined;
        if (window.electronAPI?.onUndetectableChanged) {
            removeUndetectableListener = window.electronAPI.onUndetectableChanged((undetectable) => {
                setIsDetectable(!undetectable);
            });
        }

        fetchMeetings();
        fetchEvents();

        // Sync initial meeting active state — guarded so unmounted component isn't written to
        if (window.electronAPI?.getMeetingActive) {
            window.electronAPI.getMeetingActive()
                .then((active) => { if (mounted) setIsMeetingActive(active); })
                .catch(() => { });
        }

        // Listen for meeting state changes (e.g. meeting started/ended from overlay)
        let removeMeetingStateListener: (() => void) | undefined;
        if (window.electronAPI?.onMeetingStateChanged) {
            removeMeetingStateListener = window.electronAPI.onMeetingStateChanged(({ isActive }) => {
                setIsMeetingActive(isActive);

                // When a meeting ends, optimistically prepend a Processing card
                // immediately — this event is broadcast before main even starts
                // finalizing, so it's the earliest possible moment the list can
                // react. mergeLocalMeetings retires this card as soon as the real
                // SQLite row shows up (see seedMeetingsFromLocal below), and
                // onLiveCallEnded patches its id in the meantime.
                if (!isActive) {
                    queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) => {
                        // Idempotent on the fixed id: a rapid end→end cycle can't
                        // stack two cards, but — unlike the old title-based guard —
                        // an unrelated meeting that's stuck processing no longer
                        // suppresses the card for the call that just ended.
                        if (prev.some(m => m.id === OPTIMISTIC_LIVE_ID)) return prev;

                        const optimisticPlaceholder: Meeting = {
                            id: OPTIMISTIC_LIVE_ID,
                            title: PROCESSING_TITLE,
                            date: new Date().toISOString(),
                            duration: '—',
                            summary: '',
                            isProcessed: false,
                        };
                        return [optimisticPlaceholder, ...prev];
                    });
                    // Also read the local DB right away: if main already committed
                    // the row for this call (or for an earlier one the backend
                    // hasn't mirrored yet), the card shows the real title/duration
                    // instead of the generic placeholder. The `meetings-updated`
                    // broadcast that follows finalization seeds again.
                    void seedMeetingsFromLocal();
                }
            });
        }

        // Patch the placeholder with its real, locally-resolvable id as soon as
        // main.ts knows it — well before onMeetingsUpdated (background summary
        // processing finishing) would otherwise be the first time we learn it.
        let removeLiveCallEndedListener: (() => void) | undefined;
        if (window.electronAPI?.onLiveCallEnded) {
            removeLiveCallEndedListener = window.electronAPI.onLiveCallEnded(({ meetingId }) => {
                if (!meetingId) return;
                let placeholderId: string | null = null;
                queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) => {
                    // Prefer the fixed optimistic id; fall back to any optimistic
                    // processing row (e.g. one inserted by an older code path).
                    let idx = prev.findIndex(m => m.id === OPTIMISTIC_LIVE_ID);
                    if (idx === -1) idx = prev.findIndex(m => isOptimisticId(m.id) && isMeetingProcessing(m));
                    if (idx === -1) return prev;
                    // The real row may already be listed (the local seed can win
                    // this race) — then just drop the optimistic duplicate.
                    if (prev.some(m => m.id === meetingId)) {
                        placeholderId = prev[idx].id;
                        return prev.filter((_, i) => i !== idx);
                    }
                    placeholderId = prev[idx].id;
                    const next = [...prev];
                    next[idx] = { ...next[idx], id: meetingId };
                    return next;
                });
                // selectedMeeting is a one-time snapshot, not cache-subscribed —
                // patch it too or an already-open details view stays wedged.
                if (placeholderId) {
                    setSelectedMeeting(prev => (prev && prev.id === placeholderId ? { ...prev, id: meetingId } : prev));
                }
                void seedMeetingsFromLocal();
            });
        }

        // Listen for background updates (e.g. after meeting processing finishes)
        const removeMeetingsListener = window.electronAPI.onMeetingsUpdated(() => {
            console.log('Received meetings-updated event');
            // Local first (synchronous SQLite truth, no network), then the
            // authoritative backend refetch — so the row updates immediately
            // instead of one HTTP round-trip later.
            void seedMeetingsFromLocal();
            fetchMeetings();
        });

        // Simple polling for events every minute
        const interval = setInterval(fetchEvents, 60000);

        return () => {
            mounted = false;
            if (removeMeetingsListener) removeMeetingsListener();
            if (removeUndetectableListener) removeUndetectableListener();
            if (removeMeetingStateListener) removeMeetingStateListener();
            if (removeLiveCallEndedListener) removeLiveCallEndedListener();
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Mount-only: stable setup that must run exactly once

    // Separate effect for keyboard listener — re-registers when isShortcutPressed changes
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isShortcutPressed(e, 'toggleVisibility')) {
                e.preventDefault();
                window.electronAPI.toggleWindow();
            } else if (isShortcutPressed(e, 'moveWindowUp')) {
                e.preventDefault();
                window.electronAPI.moveWindowUp?.();
            } else if (isShortcutPressed(e, 'moveWindowDown')) {
                e.preventDefault();
                window.electronAPI.moveWindowDown?.();
            } else if (isShortcutPressed(e, 'moveWindowLeft')) {
                e.preventDefault();
                window.electronAPI.moveWindowLeft?.();
            } else if (isShortcutPressed(e, 'moveWindowRight')) {
                e.preventDefault();
                window.electronAPI.moveWindowRight?.();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isShortcutPressed]);

    // Filter next meeting (within 24 hours)
    const nextMeeting = upcomingEvents.find(e => {
        const diff = new Date(e.startTime).getTime() - Date.now();

        return diff > -5 * MINUTE && diff < 24 * HOUR; // -5 min to 24 hours
    });

    const getMeetingStartText = (startTime: string) => {
        const diffMs = new Date(startTime).getTime() - Date.now();

        if (diffMs <= 0) {
            return 'Starting now';
        }

        const totalMinutes = Math.ceil(diffMs / (1000 * 60));

        if (totalMinutes < 60) {
            return `Starts in ${totalMinutes} min`;
        }

        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (minutes === 0) {
            return `Starts in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
        }

        return `Starts in ${hours}h ${minutes}m`;
    };

    const toggleDetectable = () => {
        const newState = !isDetectable;
        setIsDetectable(newState);
        // isDetectable=true means visible/on-screen (ghost mode OFF);
        // isDetectable=false means hidden from capture (ghost mode ON) —
        // matches the inverted setUndetectable(!newState) call right below.
        if (newState) {
            posthogAnalytics.trackGhostModeOff();
        } else {
            posthogAnalytics.trackGhostModeOn();
        }
        window.electronAPI?.setUndetectable(!newState); // Note: setUndetectable takes the *undetectable* state, which is inverse of *detectable*
    };

    // ─── Meeting row navigation (back/forward + open) ───────────────────────
    const [forwardMeeting, setForwardMeeting] = useState<Meeting | null>(null);
    const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
    const [menuEntered, setMenuEntered] = useState(false);

    // ─── Transcript upload modal ─────────────────────────────────────────────
    const [isUploadOpen, setIsUploadOpen] = useState(false);
    const [uploadText, setUploadText] = useState('');
    const [uploadTitle, setUploadTitle] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const [uploadMeetingTypes, setUploadMeetingTypes] = useState<('discovery' | 'demo' | 'negotiation')[]>(['discovery']);
    // Optional customer-company answered IN the modal, so an uploaded
    // transcript never needs the post-call company prompt (quick meetings
    // only get that). Best-effort association after the meeting row exists.
    const [uploadCompany, setUploadCompany] = useState<PickedCompany | null>(null);
    // Raw text still sitting in the picker's input. Submit is OUTSIDE the
    // picker, so without this a typed-but-uncommitted name is silently lost.
    const [uploadCompanyDraft, setUploadCompanyDraft] = useState('');
    // "Which speaker is you?" — the pasted transcript's speakers, and the one
    // that becomes the rep. Main pre-selects a speaker named like the
    // signed-in user, else the first one; the user can override it. The
    // analysis grades only the prospect side, so a swapped rep scores 0.
    const [uploadSpeakers, setUploadSpeakers] = useState<string[]>([]);
    const [uploadRepSpeaker, setUploadRepSpeaker] = useState<string | null>(null);
    const [uploadRepSource, setUploadRepSource] = useState<'picked' | 'name' | 'first' | null>(null);
    // The label the user clicked, kept across edits while that speaker still exists.
    const uploadRepPickedRef = React.useRef<string | null>(null);

    useEffect(() => {
        if (!isUploadOpen) return;
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const res = await window.electronAPI?.getUploadTranscriptSpeakers?.(uploadText);
                if (cancelled || !res) return;
                setUploadSpeakers(res.speakers);
                const picked = uploadRepPickedRef.current;
                if (picked && res.speakers.includes(picked)) return;
                uploadRepPickedRef.current = null;
                setUploadRepSpeaker(res.suggestedRep);
                setUploadRepSource(res.suggestedBy);
            } catch (e) {
                console.warn('[useLauncher] could not list transcript speakers:', e);
            }
        }, 300);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [uploadText, isUploadOpen]);

    const pickUploadRepSpeaker = (label: string) => {
        uploadRepPickedRef.current = label;
        setUploadRepSpeaker(label);
        setUploadRepSource('picked');
    };

    const resetUploadSpeakers = () => {
        uploadRepPickedRef.current = null;
        setUploadSpeakers([]);
        setUploadRepSpeaker(null);
        setUploadRepSource(null);
    };
    // Set when the deferred association ultimately fails, so the UI can say so
    // and offer a retry instead of failing invisibly in the console.
    const [companyLinkFailure, setCompanyLinkFailure] = useState<{ meetingId: string; company: PickedCompany } | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [focusedMeetingId, setFocusedMeetingId] = useState<string | null>(null);
    const [isMeetingsExpanded, setIsMeetingsExpanded] = useState(false);

    // Focused meeting for the detail card — defaults to soonest (nextMeeting)
    const focusedMeeting = upcomingEvents.find(e => e.id === focusedMeetingId) ?? nextMeeting ?? null;

    const handleUploadTranscript = async () => {
        if (!uploadText.trim()) return;
        setIsUploading(true);
        setUploadError(null);

        // Snapshot the company BEFORE any await: the state is reset on success
        // below, and a name the user typed without picking a dropdown row only
        // exists as a draft. `uploadCompany` wins when both are present.
        const draftName = uploadCompanyDraft.trim();
        const pickedCompany: PickedCompany | null = uploadCompany ?? (draftName ? { companyId: null, name: draftName } : null);

        // Optimistically inject a placeholder immediately so the user sees
        // the card appear right away without needing to hit refresh.
        const optimisticId = `optimistic-upload-${Date.now()}`;
        queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) => {
            const placeholder: Meeting = {
                id: optimisticId,
                // Keep the user's own title when they gave one — the row renders as
                // processing off `isProcessed`, not off the title string.
                title: uploadTitle.trim() || PROCESSING_TITLE,
                date: new Date().toISOString(),
                duration: '—',
                summary: '',
                isProcessed: false,
            };
            return [placeholder, ...prev];
        });

        try {
            // Uploaded transcripts ride the SAME lifecycle as a live meeting:
            // MeetingPersistence.uploadTranscript parses the text, saves the
            // placeholder row locally (with the full transcript), and runs the
            // shared processAndSaveMeeting pipeline — summary generation,
            // call analysis (the no-live-analysis branch exists precisely for
            // this path), scorecard grounding, isProcessed flip, events, toast
            // and the Supabase mirror. The old HTTP path delegated all of that
            // to a backend that cannot run the LLM pipeline yet.
            const tenantId = await window.electronAPI?.getCurrentTenantId?.() ?? null;
            const result = await window.electronAPI.uploadTranscript(
                uploadText.trim(),
                uploadTitle.trim() || undefined,
                uploadMeetingTypes,
                tenantId,
                uploadRepSpeaker
            );
            if (result?.success) {
                // Link the optimistic card to the real meeting row so the
                // local seed replaces this exact card instead of showing two
                // rows for the same upload (same move the live-call-ended
                // handler makes for the post-call placeholder).
                if (result.meetingId) {
                    const realId = result.meetingId;
                    queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) => {
                        const idx = prev.findIndex(m => m.id === optimisticId);
                        if (idx === -1) return prev;
                        if (prev.some((m, i) => i !== idx && m.id === realId)) {
                            return prev.filter((_, i) => i !== idx);
                        }
                        const next = [...prev];
                        next[idx] = { ...next[idx], id: realId };
                        return next;
                    });
                }
                setIsUploadOpen(false);
                setUploadText('');
                setUploadTitle('');
                setUploadMeetingTypes(['discovery']);
                // Associate the picked company.
                //
                // This CANNOT be a plain immediate PUT: uploadTranscript returns
                // as soon as the LOCAL SQLite placeholder is written, while
                // PUT /meetings/:id/company re-selects the meeting server-side
                // and 404s until SupabaseMirrorService's outbox lands the row.
                // The old .catch(console.warn) made that 404 invisible — the
                // company simply never appeared. linkMeetingCompany waits for
                // 'meeting-backend-ready' (the signal App.tsx's post-call
                // prompt already waits on), retries, and reconciles the caches;
                // the queue entry survives a quit mid-wait.
                if (result.meetingId && pickedCompany) {
                    const linkedMeetingId = result.meetingId;
                    rememberPendingLink(linkedMeetingId, pickedCompany);
                    linkMeetingCompany(linkedMeetingId, pickedCompany)
                        .then(saved => {
                            forgetPendingLink(linkedMeetingId);
                            applyCompanyToCaches(queryClient, linkedMeetingId, saved);
                        })
                        .catch(err => {
                            console.error('[useLauncher] company association failed:', err);
                            // Left queued on purpose — a transient failure
                            // retries on next launch even if the user ignores
                            // the notice.
                            setCompanyLinkFailure({ meetingId: linkedMeetingId, company: pickedCompany });
                        });
                }
                setUploadCompany(null);
                setUploadCompanyDraft('');
                resetUploadSpeakers();
                fetchMeetings(); // reconciles with the real SQLite/backend rows
            } else {
                // Remove the placeholder on failure
                queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) => prev.filter(m => m.id !== optimisticId));
                setUploadError(result?.error || 'Upload failed');
            }
        } catch (e) {
            queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) => prev.filter(m => m.id !== optimisticId));
            setUploadError(e instanceof ApiError ? e.message : 'Something went wrong');
        } finally {
            setIsUploading(false);
        }
    };

    /** Manual retry for a deferred association that exhausted its attempts. */
    const retryCompanyLink = () => {
        const pending = companyLinkFailure;
        if (!pending) return;
        setCompanyLinkFailure(null);
        // The row is long since synced by now — go straight to the PUT.
        linkMeetingCompany(pending.meetingId, pending.company, { skipWait: true })
            .then(saved => {
                forgetPendingLink(pending.meetingId);
                applyCompanyToCaches(queryClient, pending.meetingId, saved);
            })
            .catch(() => setCompanyLinkFailure(pending));
    };

    const dismissCompanyLinkFailure = () => {
        if (companyLinkFailure) forgetPendingLink(companyLinkFailure.meetingId);
        setCompanyLinkFailure(null);
    };

    useEffect(() => {
        setMenuEntered(false);
    }, [activeMenuId]);

    // Retry associations that never completed (app quit during the mirror
    // window, renderer reload). Once per mount; the queue self-prunes.
    useEffect(() => {
        void flushPendingLinks(queryClient);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Auto-select the soonest meeting when events first load or change
    useEffect(() => {
        if (nextMeeting?.id && !focusedMeetingId) {
            setFocusedMeetingId(nextMeeting.id);
        }
    }, [nextMeeting?.id]);

    // Global click listener to close menu
    useEffect(() => {
        const handleClickOutside = () => setActiveMenuId(null);
        window.addEventListener('click', handleClickOutside);
        return () => window.removeEventListener('click', handleClickOutside);
    }, []);

    // Notify parent if we are on the main launcher list view
    useEffect(() => {
        if (onPageChange) {
            onPageChange(!selectedMeeting && !isGlobalChatOpen);
        }
    }, [selectedMeeting, isGlobalChatOpen, onPageChange]);

    // Keyboard shortcut: Cmd+Space (mac) / Ctrl+Space (win/linux) opens the
    // floating AI chat — same as clicking the FAB. Scoped to this Launcher
    // screen only: it's a no-op once a meeting is open (the chat overlay has
    // its own focus/typing context and shouldn't have this listener re-fire
    // underneath it), and it ignores the keystroke while the person is
    // typing in any input/textarea/contentEditable field.
    useEffect(() => {
        const handleShortcut = (e: KeyboardEvent) => {
            if (e.code !== 'Space' || !(e.metaKey || e.ctrlKey)) return;
            if (selectedMeeting) return; // only on the Launcher view, not inside a meeting

            // The isTyping guard only matters when the shortcut would OPEN the
            // chat (avoid hijacking Cmd/Ctrl+Space while typing elsewhere on the
            // page). Once the chat is already open, its own input is focused —
            // that focus would otherwise make every "close" press look like
            // "typing" and get ignored, so the shortcut could open the chat but
            // never close it. Closing should always work regardless of focus.
            if (!isGlobalChatOpen) {
                const target = e.target as HTMLElement | null;
                const isTyping = !!target && (
                    target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable
                );
                if (isTyping) return;
            }

            e.preventDefault();
            setIsGlobalChatOpen(prev => {
                const next = !prev;
                if (next) {
                    posthogAnalytics.trackGlobalChatOpened();
                } else {
                    setSubmittedGlobalQuery('');
                }
                return next;
            });
        };

        window.addEventListener('keydown', handleShortcut);
        return () => window.removeEventListener('keydown', handleShortcut);
    }, [selectedMeeting, isGlobalChatOpen]);

    const handleOpenMeeting = (meeting: Meeting) => {
        setForwardMeeting(null); // Clear forward history on new navigation
        // Full detail (transcript + usage) loads in MeetingDetails via React Query
        // (meetingsApi.get → GET /meetings/{id}); the list row seeds it as initialData.
        setSelectedMeeting(meeting);
        posthogAnalytics.trackMeetingDetailsView();
    };

    const handleBack = () => {
        setForwardMeeting(selectedMeeting);
        setSelectedMeeting(null);
    };

    const handleForward = () => {
        if (forwardMeeting) {
            setSelectedMeeting(forwardMeeting);
            setForwardMeeting(null);
        }
    };

    return {
        // theme / shortcuts
        isLight,

        // meetings + mutation
        meetings,
        deleteMutation,
        hasProcessingMeeting,
        fetchMeetings,
        // true only before the first list ever resolves → skeleton;
        // true on background refetches over existing rows → header indicator.
        isMeetingsLoading,
        isMeetingsRefreshing,
        hasMoreMeetings,
        isLoadingMoreMeetings,
        loadMoreMeetings,

        // calendar / events
        upcomingEvents,
        isCalendarConnected,
        setIsCalendarConnected,
        handleCalendarConnected,
        handleCalendarDisconnected,
        nextMeeting,
        focusedMeeting,
        focusedMeetingId,
        setFocusedMeetingId,
        getMeetingStartText,

        // ghost mode / refresh / meeting-active
        isDetectable,
        toggleDetectable,
        isRefreshing,
        handleRefresh,
        isMeetingActive,
        onStartMeetingClick: () => {
            if (isMeetingActive) {
                window.electronAPI?.setWindowMode?.('overlay', true);
            } else {
                // "Start GoDojo" is the quick-call CTA — deliberately called
                // with no calendarEvent, unlike NextMeetingDetails' "Join
                // Meeting" button (which passes `meeting`). Passing
                // `nextMeeting` here meant every quick call was silently
                // tagged with whatever event happened to be next on the
                // calendar — wrong attendees/organizer/title, and transcript
                // speaker labels derived from that event's attendee list.
                onStartMeeting();
            }
        },
        showNotification,

        // ollama pull status (passed through as-is from props)
        ollamaPullStatus,

        // profile
        effectiveName,

        // navigation between meeting detail / list
        selectedMeeting,
        forwardMeeting,
        handleOpenMeeting,
        handleBack,
        handleForward,

        // row context menu
        activeMenuId,
        setActiveMenuId,
        menuEntered,
        setMenuEntered,

        // expand/collapse of the meetings section
        isMeetingsExpanded,
        setIsMeetingsExpanded,

        // transcript upload modal
        isUploadOpen,
        setIsUploadOpen,
        uploadText,
        setUploadText,
        uploadTitle,
        setUploadTitle,
        isUploading,
        uploadMeetingTypes,
        setUploadMeetingTypes,
        uploadCompany,
        setUploadCompany,
        uploadCompanyDraft,
        setUploadCompanyDraft,
        uploadSpeakers,
        uploadRepSpeaker,
        uploadRepSource,
        pickUploadRepSpeaker,
        resetUploadSpeakers,
        companyLinkFailure,
        retryCompanyLink,
        dismissCompanyLinkFailure,
        // ─── Meeting search + filters (owned by the header pill's store) ─────
        meetingsTotal: filteredMeetings.length,
        visibleMeetings,
        uploadError,
        handleUploadTranscript,

        // sales brief panel
        salesBriefEvent,
        setSalesBriefEvent,

        // global AI chat
        isGlobalChatOpen,
        setIsGlobalChatOpen,
        submittedGlobalQuery,
        setSubmittedGlobalQuery,
    };
}