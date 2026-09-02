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
import { ApiError } from '@/lib/apiClient';
import { LauncherProps, Meeting, UpcomingMeeting } from '@/types';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

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

export function useLauncher({ onStartMeeting, ollamaPullStatus = 'idle', onPageChange, authUser }: Pick<LauncherProps, 'onStartMeeting' | 'onPageChange' | 'authUser'> & { ollamaPullStatus?: LauncherProps['ollamaPullStatus'] }) {

    const queryClient = useQueryClient();

    // ─── Meetings list + delete mutation ────────────────────────────────────
    const { data: meetings = [] } = useQuery<Meeting[]>(['meetings'], meetingsApi.list, {
        // Poll only while a meeting is still processing (replaces the manual setInterval).
        staleTime: 10_000,
        refetchInterval: (data) => {
            const stillProcessing = (data ?? []).filter(
                (m) => m.isProcessed === false || m.title === 'Processing...',
            );
            if (stillProcessing.length === 0) return false;

            const worthPolling = stillProcessing.some((m) => {
                const startedAt = new Date(m.date).getTime();
                return Number.isNaN(startedAt) || Date.now() - startedAt < PROCESSING_POLL_TIMEOUT_MS;
            });
            return worthPolling ? PROCESSING_POLL_INTERVAL_MS : false;
        },
    });

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

    // Meeting ids already sent to the backend chunking endpoint (or seen as
    // already-processed on first load — see the effect below). Prevents
    // re-firing chunk() on every subsequent poll tick once a meeting is done.
    const chunkedMeetingIdsRef = React.useRef<Set<string>>(new Set());
    const hasSeededChunkedRef = React.useRef(false);
    // Dedupes trackCalendarEventsFetched() across fetchEvents()'s 60s poll —
    // see fetchEvents below.
    const lastTrackedEventsSignatureRef = React.useRef<string>('');

    // Fire /meetings/:id/chunking exactly once, the moment a meeting's
    // transcript + summary processing actually finishes (isProcessed: true).
    // This is strictly later than endMeeting() resolving — isProcessed only
    // flips once MeetingPersistence.processAndSaveMeeting has fully written
    // the real record, so there's no "row not synced yet" race here.
    useEffect(() => {
        if (meetings.length === 0) return;

        // On first load, treat every already-processed meeting as already
        // handled — this effect is for newly-completed meetings going
        // forward, not for retroactively chunking existing history.
        if (!hasSeededChunkedRef.current) {
            meetings.forEach(m => {
                if (m.isProcessed) chunkedMeetingIdsRef.current.add(m.id);
            });
            hasSeededChunkedRef.current = true;
            return;
        }

        meetings.forEach(m => {
            if (!m.isProcessed) return;
            if (chunkedMeetingIdsRef.current.has(m.id)) return;

            chunkedMeetingIdsRef.current.add(m.id); // mark immediately — avoid double-fire on the next poll tick
            meetingsApi.chunk(m.id).catch(err =>
                console.error(`[Launcher] Failed to chunk meeting ${m.id} for RAG:`, err)
            );
        });
    }, [meetings]);

    const effectiveName = localProfile.displayName || authUser?.displayName || authUser?.email?.split('@')[0] || '';

    // Meetings load over HTTP via React Query (the useQuery above). Existing call sites keep
    // working: this just invalidates the cache so the list refetches from the backend.
    // (The incoming branch's dedup-by-id now lives in meetingsApi.list.)
    const fetchMeetings = () => { void queryClient.invalidateQueries(['meetings']); };

    // Detect whether any meeting in the list is still being processed
    const hasProcessingMeeting = meetings.some(
        m => m.isProcessed === false || m.title === 'Processing...'
    );

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

                // When a meeting ends, optimistically prepend a Processing placeholder
                // to the meetings list immediately — before fetchMeetings() round-trips
                // to the backend. This makes the card appear with zero perceived delay.
                // The real entry (with actual id/title) arrives via onMeetingsUpdated
                // and replaces this placeholder naturally since setMeetings overwrites
                // the whole list.
                if (!isActive) {
                    queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) => {
                        // Don't double-insert if one is already there from a previous
                        // rapid end cycle
                        const alreadyHasPlaceholder = prev.some(
                            m => m.title === 'Processing...' && m.isProcessed === false
                        );
                        if (alreadyHasPlaceholder) return prev;

                        const optimisticPlaceholder: Meeting = {
                            id: `optimistic-${Date.now()}`,
                            title: 'Processing...',
                            date: new Date().toISOString(),
                            duration: '—',
                            summary: 'Generating summary...',
                            isProcessed: false,
                        };
                        return [optimisticPlaceholder, ...prev];
                    });
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
                    const idx = prev.findIndex(m => m.title === 'Processing...' && m.isProcessed === false);
                    if (idx === -1) return prev;
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
            });
        }

        // Listen for background updates (e.g. after meeting processing finishes)
        const removeMeetingsListener = window.electronAPI.onMeetingsUpdated(() => {
            console.log('Received meetings-updated event');
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
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [focusedMeetingId, setFocusedMeetingId] = useState<string | null>(null);
    const [isMeetingsExpanded, setIsMeetingsExpanded] = useState(false);

    // Focused meeting for the detail card — defaults to soonest (nextMeeting)
    const focusedMeeting = upcomingEvents.find(e => e.id === focusedMeetingId) ?? nextMeeting ?? null;

    const handleUploadTranscript = async () => {
        if (!uploadText.trim()) return;
        setIsUploading(true);
        setUploadError(null);

        // Optimistically inject a placeholder immediately so the user sees
        // the card appear right away without needing to hit refresh.
        const optimisticId = `optimistic-upload-${Date.now()}`;
        queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) => {
            const alreadyHasPlaceholder = prev.some(
                m => m.title === 'Processing...' && m.isProcessed === false
            );
            if (alreadyHasPlaceholder) return prev;
            const placeholder: Meeting = {
                id: optimisticId,
                title: uploadTitle.trim() || 'Processing...',
                date: new Date().toISOString(),
                duration: '—',
                summary: 'Analyzing transcript...',
                isProcessed: false,
            };
            return [placeholder, ...prev];
        });

        try {
            // const result = await window.electronAPI.uploadTranscript(
            //     uploadText.trim(),
            //     uploadTitle.trim() || undefined,
            //     uploadMeetingTypes
            // );
            // if (result?.success) {
            //     setIsUploadOpen(false);
            //     setUploadText('');
            //     setUploadTitle('');
            //     setUploadMeetingTypes(['discovery']);
            //     fetchMeetings(); // replaces placeholder with real entry
            // } else {
            //     // Remove the placeholder on failure
            //     queryClient.setQueryData<Meeting[]>(["meetings"], (prev = []) => prev.filter(m => m.id !== optimisticId));
            //     setUploadError(result?.error || 'Upload failed');
            // }
            const result = await meetingsApi.uploadTranscript(
                uploadTitle.trim() || 'Processing...',
                uploadText.trim()
            );
            setIsUploadOpen(false);
            setUploadText('');
            setUploadTitle('');
            setUploadMeetingTypes(['discovery']);
            fetchMeetings();

        } catch (e) {
            queryClient.setQueryData<Meeting[]>(['meetings'], (prev = []) => prev.filter(m => m.id !== optimisticId));
            setUploadError(e instanceof ApiError ? e.message : 'Something went wrong');
        } finally {
            setIsUploading(false);
        }
    };

    useEffect(() => {
        setMenuEntered(false);
    }, [activeMenuId]);

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

        // calendar / events
        upcomingEvents,
        isCalendarConnected,
        setIsCalendarConnected,
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
                onStartMeeting(nextMeeting);
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