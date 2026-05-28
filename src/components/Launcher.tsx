import React, { useState, useEffect } from 'react';
import { Zap, Calendar, ArrowRight, ArrowLeft, MoreHorizontal, ChevronRight, Settings, RefreshCw, Ghost, Trash2, Download, DownloadCloud, CheckCircle, AlertCircle, Briefcase, Upload, X, ChevronUp, Sparkles } from 'lucide-react';
import { generateMeetingPDF } from '../utils/pdfGenerator';
import ConnectCalendarButton from './ui/ConnectCalendarButton';
import MeetingDetails from './MeetingDetails';
import SalesBriefPanel from './SalesBriefPanel';
import TopSearchPill from './TopSearchPill';
import GlobalChatOverlay from './GlobalChatOverlay';
import { motion, AnimatePresence } from 'framer-motion';
import { analytics } from '../lib/analytics/analytics.service'; // Added analytics import
import { useShortcuts } from '../hooks/useShortcuts';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { isMac } from '../utils/platformUtils';
import WindowControls from './WindowControls';
import UserProfileButton from './ui/UserProfileButton';
import { IoSparklesSharp } from 'react-icons/io5';
import NextMeetingCard from './NextMeetingCard';
import MeetingTimeline from './MeetingTimeline';

interface Meeting {
    id: string;
    title: string;
    date: string;
    duration: string;
    summary: string;
    isProcessed?: boolean;
    detailedSummary?: {
        actionItems: string[];
        keyPoints: string[];
    };
    transcript?: Array<{
        speaker: string;
        text: string;
        timestamp: number;
    }>;
    usage?: Array<{
        type: 'assist' | 'followup' | 'chat' | 'followup_questions';
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
    active?: boolean; // UI state
    time?: string; // Optional for compatibility
}

interface LauncherProps {
    onStartMeeting: (calendarEvent?: any) => void;
    onOpenSettings: (tab?: string) => void;
    onPageChange?: (isMain: boolean) => void;
    ollamaPullStatus?: 'idle' | 'downloading' | 'complete' | 'failed';
    ollamaPullPercent?: number;
    ollamaPullMessage?: string;
    authUser?: { displayName?: string | null; email?: string | null; photoURL?: string | null } | null;
    onSignOut?: () => void;
}

// Helper to format date groups
const getGroupLabel = (dateStr: string) => {
    if (dateStr === "Today") return "Today"; // Backward compatibility

    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const checkDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (checkDate.getTime() === today.getTime()) return "Today";
    if (checkDate.getTime() === yesterday.getTime()) return "Yesterday";

    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

// Helper to format time (e.g. 3:14pm)
const formatTime = (dateStr: string) => {
    if (dateStr === "Today") return "Just now"; // Legacy
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
};

const Launcher: React.FC<LauncherProps> = ({ onStartMeeting, onOpenSettings, onPageChange, ollamaPullStatus = 'idle', ollamaPullPercent = 0, ollamaPullMessage = '', authUser, onSignOut }) => {
    const [meetings, setMeetings] = useState<Meeting[]>([]);
    const [isDetectable, setIsDetectable] = useState(false);
    const [isMeetingActive, setIsMeetingActive] = useState(false);
    const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
    const [upcomingEvents, setUpcomingEvents] = useState<any[]>([]);
    const [isPrepared, setIsPrepared] = useState(false);
    const [preparedEvent, setPreparedEvent] = useState<any>(null);
    const [isCalendarConnected, setIsCalendarConnected] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [showNotification, setShowNotification] = useState(false);
    const [salesBriefEvent, setSalesBriefEvent] = useState<any>(null);
    // Global search state (for AI chat overlay)
    const [isGlobalChatOpen, setIsGlobalChatOpen] = useState(false);
    const [submittedGlobalQuery, setSubmittedGlobalQuery] = useState('');

    const fetchMeetings = () => {
        if (window.electronAPI && window.electronAPI.getRecentMeetings) {
            window.electronAPI.getRecentMeetings().then(setMeetings).catch(err => console.error("Failed to fetch meetings:", err));
        }
    };

    const fetchEvents = () => {
        if (window.electronAPI && window.electronAPI.getUpcomingEvents) {
            window.electronAPI.getUpcomingEvents().then(setUpcomingEvents).catch(err => console.error("Failed to fetch events:", err));
        }
    }

    const handleRefresh = async () => {
        setIsRefreshing(true);
        analytics.trackCommandExecuted('refresh_calendar');
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
                console.warn("electronAPI.calendarRefresh not found");
            }
        } catch (e) {
            console.error("Refresh failed in handleRefresh:", e);
        } finally {
            // Ensure distinct feedback provided (min 500ms spin)
            setTimeout(() => setIsRefreshing(false), 500);
        }
    };

    // Keybinds
    const { isShortcutPressed } = useShortcuts();
    const isLight = useResolvedTheme() === 'light';

    useEffect(() => {
        let mounted = true;
        console.log("Launcher mounted");
        // Seed demo data if needed (safe to call always — runs ONCE on mount)
        if (window.electronAPI && window.electronAPI.seedDemo) {
            window.electronAPI.seedDemo().catch(err => console.error("Failed to seed demo:", err));
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
            });
        }

        // Listen for background updates (e.g. after meeting processing finishes)
        const removeMeetingsListener = window.electronAPI.onMeetingsUpdated(() => {
            console.log("Received meetings-updated event");
            fetchMeetings();
        });

        // Simple polling for events every minute
        const interval = setInterval(fetchEvents, 60000);

        return () => {
            mounted = false;
            if (removeMeetingsListener) removeMeetingsListener();
            if (removeUndetectableListener) removeUndetectableListener();
            if (removeMeetingStateListener) removeMeetingStateListener();
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
    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;

    const nextMeeting = upcomingEvents.find(e => {
        const diff = new Date(e.startTime).getTime() - Date.now();

        return diff > -5 * MINUTE && diff < 24 * HOUR; // -5 min to 24 hours
    });

    const getMeetingStartText = (startTime: string) => {
        const diffMs = new Date(startTime).getTime() - Date.now();

        if (diffMs <= 0) {
            return "Starting now";
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
    }

    const extractNameFromEmail = (email: string): string => {
        if (!email) return 'Unknown';
        const prefix = email.split('@')[0];
        const parts = prefix.split(/[._\-+]/);
        return parts
            .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
            .join(' ');
    };

    const handlePrepare = (event: any) => {
        // Enrich event with better attendee information
        const enrichedEvent = {
            ...event,
            attendees: (event.attendees || []).map((a: any) => ({
                ...a,
                // Ensure display name is properly set
                displayName: a.displayName || a.name || extractNameFromEmail(a.email),
                self: a.self || a.email === (window as any).currentUserEmail, // Need to track current user
            }))
        };
        setPreparedEvent(enrichedEvent);
        setIsPrepared(true);
    };

    const handleStartPreparedMeeting = async () => {
        if (!preparedEvent) return;
        analytics.trackCommandExecuted('start_prepared_meeting');
        try {
            const inputDeviceId = localStorage.getItem('preferredInputDeviceId');
            const outputDeviceId = localStorage.getItem('preferredOutputDeviceId');

            // Ensure attendees have proper names
            const attendeesWithNames = (preparedEvent.attendees || []).map((a: any) => ({
                ...a,
                name: a.displayName || a.name || extractNameFromEmail(a.email),
            }));

            await window.electronAPI.startMeeting({
                title: preparedEvent.title,
                calendarEventId: preparedEvent.id,
                source: 'calendar',
                attendees: attendeesWithNames,
                organizer: preparedEvent.organizer || '',
                audio: { inputDeviceId, outputDeviceId }
            });
            setIsPrepared(false);
        } catch (e) {
            console.error("Failed to start prepared meeting", e);
        }
    };

    if (!window.electronAPI) {
        return <div className="text-white p-10">Error: Electron API not initialized. Check preload script.</div>;
    }

    const toggleDetectable = () => {
        const newState = !isDetectable;
        setIsDetectable(newState);
        window.electronAPI?.setUndetectable(!newState); // Note: setUndetectable takes the *undetectable* state, which is inverse of *detectable*
        analytics.trackModeSelected(newState ? 'launcher' : 'undetectable'); // If visible (detectable), mode is normal/launcher. If not detectable, mode is undetectable.
    };

    // Group meetings
    const groupedMeetings = meetings.reduce((acc, meeting) => {
        const label = getGroupLabel(meeting.date);
        if (!acc[label]) acc[label] = [];
        acc[label].push(meeting);
        return acc;
    }, {} as Record<string, Meeting[]>);

    // Group order (Today, Yesterday, then others sorted new to old is implicit via API return order ideally, 
    // but JS object key order isn't guaranteed. We can use a Map or just known keys.)
    // Simple sort for keys:
    const sortedGroups = Object.keys(groupedMeetings).sort((a, b) => {
        if (a === 'Today') return -1;
        if (b === 'Today') return 1;
        if (a === 'Yesterday') return -1;
        if (b === 'Yesterday') return 1;
        // Approximation for others: parse date
        return new Date(b).getTime() - new Date(a).getTime();
    });

    const [forwardMeeting, setForwardMeeting] = useState<Meeting | null>(null);
    const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
    const [menuEntered, setMenuEntered] = useState(false);

    const [isUploadOpen, setIsUploadOpen] = useState(false);
    const [uploadText, setUploadText] = useState('');
    const [uploadTitle, setUploadTitle] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [focusedMeetingId, setFocusedMeetingId] = useState<string | null>(null);
    const [isMeetingsExpanded, setIsMeetingsExpanded] = useState(false);

    // Focused meeting for the detail card — defaults to soonest (nextMeeting)
    const focusedMeeting = upcomingEvents.find(e => e.id === focusedMeetingId) ?? nextMeeting ?? null;

    const handleUploadTranscript = async () => {
        if (!uploadText.trim()) return;
        setIsUploading(true);
        setUploadError(null);
        try {
            const result = await window.electronAPI.uploadTranscript(
                uploadText.trim(),
                uploadTitle.trim() || undefined
            );
            if (result?.success) {
                setIsUploadOpen(false);
                setUploadText('');
                setUploadTitle('');
                fetchMeetings(); // refresh list
            } else {
                setUploadError(result?.error || 'Upload failed');
            }
        } catch (e) {
            setUploadError('Something went wrong');
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

    const handleOpenMeeting = async (meeting: Meeting) => {
        setForwardMeeting(null); // Clear forward history on new navigation
        console.log("[Launcher] Opening meeting:", meeting.id);
        analytics.trackCommandExecuted('open_meeting_details');

        if (meeting.title === 'Processing...' || meeting.isProcessed === false) {
            setSelectedMeeting(meeting);
            return;
        }

        // Fetch full meeting details including transcript and usage
        if (window.electronAPI && window.electronAPI.getMeetingDetails) {
            try {
                console.log("[Launcher] Fetching full meeting details...");
                const fullMeeting = await window.electronAPI.getMeetingDetails(meeting.id);
                console.log("[Launcher] Got meeting details:", fullMeeting);
                console.log("[Launcher] Transcript count:", fullMeeting?.transcript?.length);
                console.log("[Launcher] Usage count:", fullMeeting?.usage?.length);
                if (fullMeeting) {
                    setSelectedMeeting(fullMeeting);
                    return;
                }
            } catch (err) {
                console.error("[Launcher] Failed to fetch meeting details:", err);
            }
        } else {
            console.warn("[Launcher] getMeetingDetails not available on electronAPI");
        }
        // Fallback to list-view data if fetch fails
        setSelectedMeeting(meeting);
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

    // Helper to format duration to mm:ss or mmm:ss
    const formatDurationPill = (durationStr: string) => {
        if (!durationStr) return "00:00";

        // Check if it's already in colon format (e.g. "5:30", "105:20")
        if (durationStr.includes(':')) {
            const parts = durationStr.split(':');
            const mins = parts[0];
            const secs = parts[1] || "00";

            // Allow 3 digits for mins if >= 100, otherwise pad to 2
            const formattedMins = mins.length >= 3 ? mins : mins.padStart(2, '0');
            return `${formattedMins}:${secs}`;
        }

        // Fallback for "X min" format (legacy)
        const minutes = parseInt(durationStr.replace('min', '').trim()) || 0;
        const mm = minutes.toString().padStart(2, '0');
        return `${mm}:00`;
    };

    return (
        <div className={[
            "h-full w-full flex flex-col text-text-primary font-sans overflow-hidden selection:bg-accent-secondary/30",
            "bg-bg-main",
        ].join(" ")} style={{
            backgroundImage: isLight
                ? "radial-gradient(900px 500px at 50% -100px, #e3e9f7 0%, #eef1f8 60%)"
                : "radial-gradient(900px 500px at 50% -100px, #0c1530 0%, #05070d 60%)",
        }}>
            {/* 1. Header (Static) */}
            <header className={[
                "relative w-full shrink-0 flex items-center gap-3 drag-region select-none border-b z-[200] backdrop-blur-xl",
                isMac ? "h-[56px]" : "h-[42px]",   // ← Windows keeps original 40px height
                isLight
                    ? "bg-bg-sidebar/70 border-border-subtle"
                    : "bg-bg-primary/70 border-border-subtle",
            ].join(" ")}>
                {/* Left: Spacing for Traffic Lights + Navigation Arrows */}
                <div className="flex items-center gap-1 no-drag">
                    {isMac && <div className="w-[70px]" />} {/* Traffic Light Spacer (macOS only) */}

                    {/* Back Button */}
                    <button
                        onClick={selectedMeeting ? handleBack : undefined}
                        disabled={!selectedMeeting}
                        className={`p-1 ml-3 flex items-center justify-center rounded-full transition-all
                            ${selectedMeeting
                                ? `text-text-secondary hover:text-text-primary ${isLight ? 'hover:bg-bg-item-surface' : 'hover:bg-white/10'}`
                                : 'text-text-tertiary opacity-30 cursor-default'}`}
                    >
                        <ArrowLeft size={16} />
                    </button>

                    {/* Forward Button */}
                    <button
                        onClick={handleForward}
                        disabled={!forwardMeeting}
                        className={`p-1 flex items-center justify-center rounded-full transition-all
                            ${forwardMeeting
                                ? `text-text-secondary hover:text-text-primary ${isLight ? 'hover:bg-bg-item-surface' : 'hover:bg-white/10'}`
                                : 'text-text-tertiary opacity-0 cursor-default'}`}
                    >
                        <ArrowRight size={16} />
                    </button>
                </div>

                {/* Logo */}
                <div className="flex items-center gap-2 no-drag ml-1">
                    <div className="relative flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-blue-700 shadow-[0_2px_8px_rgba(59,130,246,0.35)]">
                        <Sparkles className="h-2.5 w-2.5 fill-white text-white" />
                    </div>
                    <span className={["text-sm font-semibold tracking-tight", isLight ? "text-text-primary" : "text-white"].join(" ")}>
                        GoDojo AI
                    </span>
                </div>

                {/* Center: Search pill */}
                <div className="mx-2 flex-1 no-drag">
                    {/* Center: Spotlight-style Search Pill */}
                    <TopSearchPill
                        meetings={meetings}
                        onAIQuery={(query) => {
                            analytics.trackCommandExecuted('ai_query_search');
                            setSubmittedGlobalQuery(query);
                            setIsGlobalChatOpen(true);
                        }}
                        onLiteralSearch={(query) => {
                            // For now, also use AI query for literal search
                            // Could be enhanced to do fuzzy filtering in the UI
                            analytics.trackCommandExecuted('literal_search');
                            setSubmittedGlobalQuery(query);
                            setIsGlobalChatOpen(true);
                        }}
                        onOpenMeeting={(meetingId) => {
                            const meeting = meetings.find(m => m.id === meetingId);
                            if (meeting) {
                                handleOpenMeeting(meeting);
                                analytics.trackCommandExecuted('open_meeting_from_search');
                            }
                        }}
                    />
                </div>

                {/* Right: Settings + Profile */}
                <div className={`flex items-center gap-2 no-drag shrink-0 ${isMac ? 'mr-1' : ''}`}>

                    {/* Settings */}
                    <button
                        onClick={() => {
                            onOpenSettings();
                        }}
                        className={[
                            "inline-flex items-center justify-center rounded-full transition-all no-drag",
                            isMac ? "h-9 w-9" : "h-7 w-7",   // ← shrink on Windows
                            isLight
                                ? "border border-border-muted bg-bg-elevated/80 text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
                                : "border border-border-subtle bg-bg-item-surface text-text-secondary hover:bg-white/[0.08] hover:text-white",
                        ].join(" ")}
                        aria-label="Settings"
                    >
                        <Settings size={15} />
                    </button>

                    {/* Profile pill */}
                    {authUser && onSignOut && (
                        <UserProfileButton
                            displayName={authUser.displayName}
                            email={authUser.email}
                            photoURL={authUser.photoURL}
                            onSignOut={onSignOut}
                        />
                    )}
                    {!isMac && <WindowControls />}
                </div>
            </header>

            <div className="relative flex-1 flex flex-col overflow-hidden">
                {!isDetectable && (
                    <div className={`absolute inset-1 border-2 border-dashed rounded-2xl pointer-events-none z-[100] ${isLight ? 'border-border-muted' : 'border-white/20'}`} />
                )}
                <AnimatePresence mode="wait">
                    {selectedMeeting ? (
                        <motion.div
                            key="details"
                            className="flex-1 overflow-hidden"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                        >
                            <MeetingDetails
                                meeting={selectedMeeting}
                                onBack={handleBack}
                                onOpenSettings={onOpenSettings}
                            />
                        </motion.div>
                    ) : (
                        <motion.div
                            key="launcher"
                            className="flex-1 flex flex-col overflow-hidden"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                        >

                            {/* Main Area - Fixed Top, Scrollable Bottom */}
                            {/* Top Section is now effectively static due to parent flex col */}

                            {/* TOP SECTION */}
                            <motion.section
                                className={[
                                    "shrink-0 border-b border-border-subtle px-8 pt-3 pb-3 origin-top bg-bg-main",
                                ].join(" ")}
                                style={{
                                    backgroundImage: isLight
                                        ? "radial-gradient(900px 500px at 50% -100px, #e3e9f7 0%, #eef1f8 60%)"
                                        : "radial-gradient(900px 500px at 50% -100px, #0c1530 0%, #05070d 60%)",
                                }}
                                animate={{
                                    scale: isMeetingsExpanded ? 0.97 : 1,
                                    opacity: isMeetingsExpanded ? 0.45 : 1,
                                    filter: isMeetingsExpanded ? 'blur(1.5px)' : 'blur(0px)',
                                    y: isMeetingsExpanded ? -6 : 0,
                                }}
                                transition={{ duration: 0.42, ease: [0.32, 0.72, 0, 1] }}
                            >
                                <div className="max-w-4xl mx-auto space-y-3">

                                    {/* Welcome row */}
                                    <div className="flex items-center justify-between gap-4">
                                        <div className="flex items-center gap-3">
                                            <IoSparklesSharp className="text-blue-500 shrink-0" size={22} />
                                            <div>
                                                <h1 className="text-xl font-semibold tracking-tight text-text-primary">
                                                    Welcome back{authUser?.displayName ? `, ${authUser.displayName.split(' ')[0]}` : ''}
                                                </h1>
                                                <p className="text-xs mt-0.5 text-text-secondary">
                                                    Your meetings, transcripts and AI insights — all in one place.
                                                </p>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2.5">

                                            {/* ── Ghost Mode — redesigned ── */}
                                            <div className="relative group/ghost">
                                                <button
                                                    onClick={toggleDetectable}
                                                    className={[
                                                        "relative flex items-center gap-2 rounded-xl px-3 py-2 border transition-all duration-200 select-none cursor-pointer",
                                                        !isDetectable
                                                            ? isLight
                                                                ? "bg-blue-50 border-blue-200 text-blue-700 shadow-[0_0_12px_-2px_rgba(59,130,246,0.2)]"
                                                                : "bg-blue-500/10 border-blue-500/30 text-blue-300 shadow-[0_0_16px_-4px_rgba(59,130,246,0.35)]"
                                                            : isLight
                                                                ? "bg-bg-elevated border-border-muted text-text-secondary hover:border-border-muted hover:text-text-primary shadow-sm"
                                                                : "bg-bg-item-surface border-border-subtle text-text-tertiary hover:bg-white/[0.07] hover:border-border-muted hover:text-text-secondary",
                                                    ].join(" ")}
                                                    aria-label={!isDetectable ? "Ghost mode on — app is hidden from screen share" : "Ghost mode off — app is visible"}
                                                >
                                                    {!isDetectable ? (
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                                                            <path d="M12 2C7.58172 2 4 5.58172 4 10V22L7 19L9.5 21.5L12 19L14.5 21.5L17 19L20 22V10C20 5.58172 16.4183 2 12 2Z" fill="currentColor" />
                                                            <circle cx="9" cy="10" r="1.5" fill={isLight ? "white" : "#1e3a5f"} />
                                                            <circle cx="15" cy="10" r="1.5" fill={isLight ? "white" : "#1e1b4b"} />
                                                        </svg>
                                                    ) : (
                                                        <Ghost size={14} strokeWidth={2} className="shrink-0" />
                                                    )}
                                                    <span className="text-[12px] font-medium leading-none whitespace-nowrap">
                                                        {!isDetectable ? "Ghost On" : "Ghost Off"}
                                                    </span>
                                                    <div className={[
                                                        "w-7 h-3.5 rounded-full relative transition-colors duration-200 shrink-0",
                                                        !isDetectable ? "bg-accent-primary" : isLight ? "bg-bg-toggle-switch" : "bg-white/15",
                                                    ].join(" ")}>
                                                        <div className={[
                                                            "absolute top-[1.5px] w-[10px] h-[10px] rounded-full bg-white shadow-sm transition-all duration-200",
                                                            !isDetectable ? "left-[16px]" : "left-[2px]",
                                                        ].join(" ")} />
                                                    </div>
                                                </button>
                                                {/* Ghost tooltip */}
                                                <div className={[
                                                    "pointer-events-none absolute top-[50px] left-1/2 -translate-x-1/2 mb-2 z-[500]",
                                                    "opacity-0 group-hover/ghost:opacity-100 transition-opacity duration-150 delay-300",
                                                ].join(" ")}>
                                                    <div className={[
                                                        "rounded-lg px-3 py-2 text-[11px] leading-snug whitespace-nowrap shadow-lg",
                                                        isLight ? "bg-bg-primary" : "bg-bg-card border border-border-subtle text-text-secondary",
                                                    ].join(" ")}>
                                                        <p className="font-semibold mb-0.5">{!isDetectable ? "Ghost mode is ON" : "Ghost mode is OFF"}</p>
                                                        <p className="text-text-tertiary">{!isDetectable ? "Hidden from screen share & recording" : "Visible to screen share & recording"}</p>
                                                    </div>
                                                    <div className={["absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent", isLight ? "border-t-bg-primary" : "border-t-bg-card"].join(" ")} />
                                                </div>
                                            </div>

                                            {/* ── Refresh — with tooltip ── */}
                                            <div className="relative group/refresh">
                                                <button
                                                    onClick={handleRefresh}
                                                    disabled={isRefreshing}
                                                    className={[
                                                        "h-9 w-9 flex items-center justify-center rounded-xl border transition-all duration-200",
                                                        isRefreshing ? "cursor-wait" : "",
                                                        isLight
                                                            ? "bg-bg-elevated border-border-muted hover:border-border-muted hover:bg-bg-item-surface shadow-sm"
                                                            : "bg-bg-item-surface border-border-subtle hover:bg-white/[0.07] hover:border-border-muted",
                                                    ].join(" ")}
                                                    aria-label="Refresh calendar and meetings"
                                                >
                                                    <RefreshCw className={isRefreshing ? "animate-spin text-accent-primary" : "text-text-tertiary"} size={14} />
                                                </button>
                                                {/* Refresh tooltip */}
                                                <div className={[
                                                    "pointer-events-none absolute top-[50px] left-1/2 -translate-x-1/2 mb-2 z-[500]",
                                                    "opacity-0 group-hover/refresh:opacity-100 transition-opacity duration-150 delay-300",
                                                ].join(" ")}>
                                                    <div className={[
                                                        "rounded-lg px-3 py-2 text-[11px] leading-snug whitespace-nowrap shadow-lg",
                                                        isLight ? "bg-bg-primary" : "bg-bg-card border border-border-subtle text-text-secondary",
                                                    ].join(" ")}>
                                                        <p className="font-semibold mb-0.5">{isRefreshing ? "Refreshing…" : "Sync calendar & meetings"}</p>
                                                        <p className="text-text-tertiary">Pull latest events from your calendar</p>
                                                    </div>
                                                    <div className={["absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent", isLight ? "border-t-bg-primary" : "border-t-bg-card"].join(" ")} />
                                                </div>
                                            </div>

                                            {/* ── Start GoDojo CTA ── */}
                                            <motion.button
                                                onClick={() => {
                                                    if (isMeetingActive) {
                                                        window.electronAPI?.setWindowMode?.("overlay", true);
                                                        analytics.trackCommandExecuted("resume_meeting_from_launcher");
                                                    } else {
                                                        onStartMeeting(nextMeeting);
                                                        analytics.trackCommandExecuted("start_natively_cta");
                                                    }
                                                }}
                                                whileHover={{ scale: 1.02, filter: "brightness(1.08)" }}
                                                whileTap={{ scale: 0.98 }}
                                                transition={{ duration: 0.15, ease: "easeOut" }}
                                                className="group relative overflow-hidden text-white pl-3.5 pr-4 py-2 rounded-xl font-medium text-[13px] flex items-center gap-2 shrink-0"
                                                style={{
                                                    background: isMeetingActive
                                                        ? "linear-gradient(to bottom, #10b981, #059669)"
                                                        : "linear-gradient(to bottom, #3b82f6, #2563eb)",
                                                    boxShadow: isMeetingActive
                                                        ? "0 6px 18px -4px rgba(16,185,129,0.6), inset 0 1px 0 rgba(255,255,255,0.2)"
                                                        : "0 6px 18px -4px rgba(59,130,246,0.6), inset 0 1px 0 rgba(255,255,255,0.2)",
                                                }}
                                            >
                                                <span className="absolute inset-x-0 top-0 h-[45%] bg-gradient-to-b from-white/20 to-transparent pointer-events-none rounded-t-xl" />
                                                <AnimatePresence mode="wait" initial={false}>
                                                    {isMeetingActive ? (
                                                        <motion.div key="active" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.18 }} className="relative z-10 flex items-center gap-2">
                                                            <span className="relative flex h-[7px] w-[7px] shrink-0">
                                                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
                                                                <span className="relative inline-flex rounded-full h-[7px] w-[7px] bg-white" />
                                                            </span>
                                                            Meeting ongoing
                                                        </motion.div>
                                                    ) : (
                                                        <motion.div key="start" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.18 }} className="relative z-10 flex items-center gap-2">
                                                            {/* <img src={icon} alt="" className="w-[13px] h-[13px] object-contain brightness-0 invert opacity-90 shrink-0" /> */}
                                                            Start GoDojo
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </motion.button>

                                        </div>
                                    </div>

                                    {/* Ollama pull status — preserved exactly */}
                                    <AnimatePresence>
                                        {ollamaPullStatus !== 'idle' && (
                                            <motion.div
                                                initial={{ opacity: 0, scale: 0.9, y: 10 }}
                                                animate={{ opacity: 1, scale: 1, y: 0 }}
                                                exit={{ opacity: 0, scale: 0.9, y: 10 }}
                                                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                                                className={`flex items-center gap-2 px-4 py-2 rounded-full w-fit ${isLight ? 'bg-bg-elevated border border-border-muted shadow-[0_4px_16px_rgba(0,0,0,0.1)]' : 'bg-bg-elevated/80 border border-white/10 shadow-[0_4px_16px_rgba(0,0,0,0.3)]'}`}
                                            >
                                                {ollamaPullStatus === 'downloading' ? (
                                                    <DownloadCloud size={14} className="text-blue-400 animate-pulse shrink-0" />
                                                ) : ollamaPullStatus === 'complete' ? (
                                                    <CheckCircle size={14} className="text-emerald-400 shrink-0" />
                                                ) : (
                                                    <AlertCircle size={14} className="text-red-400 shrink-0" />
                                                )}
                                                <span className="text-[11px] font-medium text-text-secondary whitespace-nowrap">
                                                    {ollamaPullStatus === 'downloading' ? `Setting up AI memory... ${ollamaPullPercent}%` : ollamaPullMessage}
                                                </span>
                                                {ollamaPullStatus === 'downloading' && (
                                                    <div className="w-24 h-[3px] bg-white/10 rounded-full overflow-hidden">
                                                        <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${ollamaPullPercent}%` }} />
                                                    </div>
                                                )}
                                            </motion.div>
                                        )}
                                    </AnimatePresence>

                                    {/* ── Hero cards ── */}
                                    {isPrepared && preparedEvent ? (

                                        /* PREPARED STATE — full-width, preserved exactly */
                                        <div className={`relative rounded-xl overflow-hidden border border-emerald-500/30 ${isLight ? 'bg-bg-elevated' : 'bg-bg-secondary'} flex flex-col items-center justify-center p-6 min-h-[180px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-emerald-900/40 ${isLight ? 'via-bg-elevated to-bg-elevated' : 'via-bg-secondary to-bg-secondary'}`}>
                                            <div className="absolute top-4 right-4"><Zap size={16} className="text-yellow-400" /></div>
                                            <div className="text-center max-w-lg z-10">
                                                <span className="inline-block px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-bold tracking-wider mb-4 border border-emerald-500/20">READY TO JOIN</span>
                                                <h2 className="text-2xl font-bold text-text-primary mb-2">{preparedEvent.title}</h2>
                                                <p className="text-xs text-text-secondary mb-6 flex items-center justify-center gap-2">
                                                    <Calendar size={12} />
                                                    {new Date(preparedEvent.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - {new Date(preparedEvent.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                                                    {preparedEvent.link && " • Link Ready"}
                                                </p>
                                                <div className="flex items-center gap-3 justify-center">
                                                    <button onClick={handleStartPreparedMeeting} className="bg-emerald-500 hover:bg-emerald-400 text-white px-8 py-3 rounded-xl text-sm font-semibold transition-all shadow-lg hover:shadow-emerald-500/25 active:scale-95 flex items-center gap-2">
                                                        Start Meeting <ArrowRight size={16} />
                                                    </button>
                                                    <button onClick={() => setIsPrepared(false)} className="px-4 py-3 rounded-xl text-xs font-medium text-text-tertiary hover:text-white transition-colors">Cancel</button>
                                                </div>
                                            </div>
                                            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[300px] h-[300px] bg-emerald-500/10 blur-[100px] pointer-events-none" />
                                        </div>

                                    ) : (

                                        /* TWO-COLUMN LAYOUT: left = meeting/empty state, right = calendar card */
                                        <div className="flex gap-4 items-stretch min-h-0">

                                            {/* LEFT — Meeting card + timeline strip below */}
                                            <div className="flex-1 min-w-0 flex flex-col gap-2">

                                                {/* Detail card — full width always */}
                                                <div className="flex-1 min-w-0">
                                                    <NextMeetingCard
                                                        meeting={focusedMeeting}
                                                        isLight={isLight}
                                                        getMeetingStartText={getMeetingStartText}
                                                        onStart={onStartMeeting}
                                                        onSalesBrief={setSalesBriefEvent}
                                                        onPrepare={handlePrepare}
                                                    />
                                                </div>

                                                {/* Timeline strip — only when 2+ meetings */}
                                                {upcomingEvents.length > 1 && (
                                                    <MeetingTimeline
                                                        events={upcomingEvents}
                                                        selectedId={focusedMeetingId}
                                                        onSelect={setFocusedMeetingId}
                                                        isLight={isLight}
                                                    />
                                                )}

                                            </div>

                                            {/* RIGHT — Calendar connect card */}
                                            <motion.div
                                                initial={{ opacity: 0, y: 12 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ duration: 0.5, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
                                                className={[
                                                    "w-[300px] shrink-0 relative rounded-xl overflow-hidden border p-5 flex flex-col",
                                                    isLight
                                                        ? "border-border-muted bg-gradient-to-br from-white via-[#f5f3fb] to-[#ece9f7] shadow-[0_4px_24px_-8px_rgba(99,102,241,0.2)]"
                                                        : "border-white/[0.08] bg-gradient-to-br from-[#12082e] via-[#0e0625] to-[#090418] shadow-[0_0_60px_-10px_rgba(99,60,255,0.3)]",
                                                ].join(" ")}
                                            >
                                                {/* Ambient glows */}
                                                <div aria-hidden className={["pointer-events-none absolute -top-20 -left-12 h-48 w-48 rounded-full blur-3xl", isLight ? "bg-blue-300/35" : "bg-indigo-600/20"].join(" ")} />
                                                <div aria-hidden className={["pointer-events-none absolute -bottom-16 -right-10 h-48 w-48 rounded-full blur-3xl", isLight ? "bg-purple-300/35" : "bg-purple-600/20"].join(" ")} />

                                                {/* Header row */}
                                                <div className="relative flex items-center justify-between mb-4">
                                                    <div className="flex items-center gap-2">
                                                        <span className={["inline-flex h-8 w-8 items-center justify-center rounded-lg relative", isLight ? "bg-gradient-to-br from-purple-100 to-fuchsia-50 text-purple-600 ring-1 ring-inset ring-purple-200/60" : "bg-gradient-to-br from-purple-500/25 to-fuchsia-700/10 text-purple-300"].join(" ")}>
                                                            <Calendar className="h-[15px] w-[15px]" strokeWidth={2.2} />
                                                            <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-purple-600 text-[7px] font-bold text-white">+</span>
                                                        </span>
                                                        <span className="text-[13px] font-semibold tracking-tight">Calendar</span>
                                                    </div>
                                                    <span className={["inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold", isLight ? isCalendarConnected ? "bg-green-50 text-green-500 ring-1 ring-inset ring-green-200" : "bg-rose-50 text-rose-500 ring-1 ring-inset ring-rose-200/70" : isCalendarConnected ? "bg-green-500/15 text-green-300" : "bg-rose-500/15 text-rose-300"].join(" ")}>
                                                        {isCalendarConnected ? "Connected" : "Not Connected"}
                                                    </span>
                                                </div>

                                                {/* Title */}
                                                <h3 className="relative text-[15px] font-semibold leading-snug tracking-tight mb-4">
                                                    {isCalendarConnected ? (
                                                        <>Calendar linked<br /><span className="text-[13px] font-normal text-text-secondary">Events are syncing automatically.</span></>
                                                    ) : (
                                                        <>Connect your calendar<br />to unlock AI meeting<br />preparation</>
                                                    )}
                                                </h3>

                                                {/* Features list */}
                                                <div className="relative flex-1 space-y-3">
                                                    {[
                                                        { icon: Zap, label: "Auto-detect meetings", color: "text-yellow-400" },
                                                        { icon: Briefcase, label: "AI sales brief per event", color: "text-blue-400" },
                                                        { icon: Calendar, label: "One-click join", color: "text-purple-400" },
                                                    ].map(({ icon: Icon, label, color }) => (
                                                        <div key={label} className="flex items-center gap-2.5">
                                                            <span className={["inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", isLight ? "bg-bg-elevated shadow-sm border border-border-subtle" : "bg-bg-item-surface"].join(" ")}>
                                                                <Icon className={`h-3.5 w-3.5 ${color}`} strokeWidth={2.2} />
                                                            </span>
                                                            <span className="text-[12px] font-medium text-text-secondary">{label}</span>
                                                        </div>
                                                    ))}
                                                </div>

                                                {/* CTA */}
                                                <ConnectCalendarButton
                                                    className="relative mt-4 w-full"
                                                    onConnect={() => setIsCalendarConnected(true)}
                                                />
                                            </motion.div>

                                        </div>
                                    )}

                                </div>
                            </motion.section>

                            {/* BOTTOM SECTION: Black Background (Scrollable content) */}
                            <motion.main className="overflow-y-auto custom-scrollbar"
                                animate={{
                                    flex: isMeetingsExpanded ? '1 1 100%' : '1 1 0%',
                                    borderRadius: isMeetingsExpanded ? '16px 16px 0 0' : '0px',
                                    marginTop: isMeetingsExpanded ? '-320px' : '0px',
                                    boxShadow: isMeetingsExpanded
                                        ? '0 -8px 40px rgba(0,0,0,0.35), 0 -2px 8px rgba(0,0,0,0.15)'
                                        : '0 0px 0px rgba(0,0,0,0)',
                                    zIndex: isMeetingsExpanded ? 10 : 1,
                                }}
                                style={{
                                    position: 'relative',
                                    backgroundColor: isLight ? 'var(--bg-sidebar)' : 'var(--bg-secondary)',
                                }}
                                transition={{ duration: 0.42, ease: [0.32, 0.72, 0, 1] }}
                            >
                                <section className="px-8 py-5 min-h-full">
                                    <div className="max-w-4xl mx-auto">

                                        {/* Section header */}
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-2.5">
                                                <div className={[
                                                    "flex h-7 w-7 items-center justify-center rounded-lg",
                                                    isLight ? "bg-accent-muted text-accent-primary" : "bg-accent-muted text-blue-400",
                                                ].join(" ")}>
                                                    <Calendar size={14} strokeWidth={2.2} />
                                                </div>
                                                <span className="text-[15px] font-semibold text-text-primary tracking-tight">
                                                    Recent Meetings
                                                </span>
                                            </div>

                                            {/* Right-side header actions */}
                                            <div className="flex items-center gap-2">

                                                {/* Upload Transcript — dev only */}
                                                {process.env.NODE_ENV === 'development' && (
                                                    <button
                                                        onClick={() => setIsUploadOpen(true)}
                                                        className={[
                                                            "flex items-center gap-1.5 text-[11px] font-medium rounded-lg px-2.5 py-1.5 border transition-all duration-150",
                                                            isLight
                                                                ? "text-text-secondary border-border-muted bg-bg-elevated hover:bg-bg-component hover:text-text-primary hover:border-border-muted shadow-sm"
                                                                : "text-text-tertiary border-border-muted bg-bg-item-surface hover:bg-white/[0.06] hover:border-white/[0.14] hover:text-text-secondary",
                                                        ].join(" ")}
                                                    >
                                                        <Upload size={11} />
                                                        Upload Transcript
                                                    </button>
                                                )}

                                                {/* Expand / Collapse */}
                                                <motion.button
                                                    onClick={() => setIsMeetingsExpanded(prev => !prev)}
                                                    className={[
                                                        "flex items-center gap-1.5 text-[11px] font-medium rounded-lg px-2.5 py-1.5 border transition-colors duration-150",
                                                        isMeetingsExpanded
                                                            ? isLight
                                                                ? "text-accent-primary border-accent-primary/30 bg-accent-muted shadow-sm"
                                                                : "text-blue-400 border-blue-500/30 bg-blue-500/10"
                                                            : isLight
                                                                ? "text-text-secondary border-border-muted bg-bg-elevated hover:bg-bg-component hover:text-text-primary shadow-sm"
                                                                : "text-text-tertiary border-border-muted bg-bg-item-surface hover:bg-white/[0.06] hover:border-white/[0.14] hover:text-text-secondary",
                                                    ].join(" ")}
                                                    whileTap={{ scale: 0.95 }}
                                                >
                                                    <motion.span
                                                        animate={{ rotate: isMeetingsExpanded ? 180 : 0 }}
                                                        transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                                                        style={{ display: 'flex' }}
                                                    >
                                                        <ChevronUp size={11} />
                                                    </motion.span>
                                                    {isMeetingsExpanded ? 'Collapse' : 'Expand'}
                                                </motion.button>

                                            </div>

                                        </div>

                                        {/* Rows — no outer card, dividers only between rows */}
                                        {meetings.length === 0 ? (
                                            <div className="py-8 text-center text-sm text-text-tertiary">
                                                No recent meetings yet.
                                            </div>
                                        ) : (
                                            <div className="rounded-xl first:rounded-t-xl last:rounded-b-xl border border-border-muted">
                                                {meetings.map((m, index) => (
                                                    <motion.div
                                                        key={m.id}
                                                        layoutId={`meeting-${m.id}`}
                                                        onClick={() => handleOpenMeeting(m)}
                                                        className={[
                                                            "group relative flex items-center gap-4 px-5 py-4 cursor-pointer transition-colors",
                                                            index !== meetings.length - 1 ? "border-b border-border-subtle" : "",
                                                            "bg-bg-sidebar hover:bg-bg-item-surface",
                                                        ].join(" ")}
                                                    >
                                                        {/* Left: Icon */}
                                                        <div className={[
                                                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10",
                                                            isLight ? "text-accent-primary" : "text-blue-400",
                                                        ].join(" ")}>
                                                            {m.title === 'Processing...'
                                                                ? <RefreshCw size={15} className="animate-spin text-blue-500" />
                                                                : <Calendar size={15} strokeWidth={2} />
                                                            }
                                                        </div>

                                                        {/* Center: Title + subtitle */}
                                                        <div className="flex-1 min-w-0">
                                                            <div className={[
                                                                "text-[13px] font-semibold truncate leading-tight",
                                                                m.title === 'Processing...'
                                                                    ? "text-blue-400 italic animate-pulse"
                                                                    : "text-text-primary",
                                                            ].join(" ")}>
                                                                {m.title}
                                                            </div>
                                                            <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-text-tertiary">
                                                                {(() => {
                                                                    const org = (m as any).organizer || (m as any).attendees?.[0]?.displayName || null;
                                                                    const count = (m as any).attendees?.length;
                                                                    return (
                                                                        <>
                                                                            {org && <span className="truncate max-w-[160px]">{org}</span>}
                                                                            {org && count && <span className="opacity-40">•</span>}
                                                                            {count && <span>{count} Participant{count !== 1 ? 's' : ''}</span>}
                                                                            {!org && !count && <span>{formatTime(m.date)}</span>}
                                                                        </>
                                                                    );
                                                                })()}
                                                            </div>
                                                        </div>

                                                        {/* Right: Date + duration + chevron */}
                                                        <div className="flex items-center gap-4 shrink-0">
                                                            {m.title === 'Processing...' ? (
                                                                <span className="text-[11px] text-blue-400 font-medium">Finalizing...</span>
                                                            ) : (
                                                                <>
                                                                    <span className="text-[12px] font-medium min-w-[120px] text-right text-text-secondary">
                                                                        {getGroupLabel(m.date) === 'Today'
                                                                            ? `Today, ${formatTime(m.date)}`
                                                                            : getGroupLabel(m.date) === 'Yesterday'
                                                                                ? `Yesterday, ${formatTime(m.date)}`
                                                                                : `${getGroupLabel(m.date)}, ${formatTime(m.date)}`
                                                                        }
                                                                    </span>
                                                                    <span className="font-mono text-[12px] font-semibold px-2.5 py-0.5 rounded-md border border-border-muted bg-bg-item-surface text-text-secondary min-w-[46px] text-center tabular-nums">
                                                                        {formatDurationPill(m.duration)}
                                                                    </span>
                                                                </>
                                                            )}
                                                            <ChevronRight size={15} className="transition-all duration-200 shrink-0 text-text-tertiary group-hover:text-text-secondary group-hover:translate-x-0.5" />
                                                        </div>

                                                        {/* Context menu trigger */}
                                                        <div className="absolute right-5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-all duration-200">
                                                            <button
                                                                className="p-1.5 rounded-md transition-colors text-text-tertiary hover:text-text-primary hover:bg-bg-item-surface"
                                                                onClick={(e) => { e.stopPropagation(); setActiveMenuId(activeMenuId === m.id ? null : m.id); }}
                                                            >
                                                                <MoreHorizontal size={15} />
                                                            </button>
                                                        </div>

                                                        {/* Dropdown — unchanged logic */}
                                                        <AnimatePresence>
                                                            {activeMenuId === m.id && (
                                                                <motion.div
                                                                    initial={{ opacity: 0, scale: 0.95, y: 6 }}
                                                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                                                    exit={{ opacity: 0, scale: 0.95, y: 4 }}
                                                                    transition={{ duration: 0.1 }}
                                                                    className={["absolute right-5 top-10 mt-1 w-[100px] backdrop-blur-xl rounded-lg shadow-2xl z-[200] overflow-hidden border", isLight ? "bg-bg-elevated border-border-muted shadow-[0_8px_24px_rgba(0,0,0,0.12)]" : "bg-bg-card/90 border-border-muted"].join(" ")}
                                                                    onClick={(e) => e.stopPropagation()}
                                                                    onMouseEnter={() => setMenuEntered(true)}
                                                                    onMouseLeave={() => { if (menuEntered) setActiveMenuId(null); }}
                                                                >
                                                                    <div className="p-1 flex flex-col gap-0.5">
                                                                        <button
                                                                            className={["w-full flex items-center gap-2 px-3 py-1.5 text-[12px] rounded-lg transition-colors text-left text-text-primary", isLight ? "hover:bg-bg-item-surface" : "hover:bg-white/10"].join(" ")}
                                                                            onClick={async () => {
                                                                                setActiveMenuId(null);
                                                                                analytics.trackPdfExported();
                                                                                if (window.electronAPI?.getMeetingDetails) {
                                                                                    try { generateMeetingPDF(await window.electronAPI.getMeetingDetails(m.id) ?? m); }
                                                                                    catch { generateMeetingPDF(m); }
                                                                                } else { generateMeetingPDF(m); }
                                                                            }}
                                                                        >
                                                                            <Download size={12} /> Export
                                                                        </button>
                                                                        <button
                                                                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10 hover:text-red-300 rounded-lg transition-colors text-left"
                                                                            onClick={async () => {
                                                                                if (window.electronAPI?.deleteMeeting) {
                                                                                    const ok = await window.electronAPI.deleteMeeting(m.id);
                                                                                    if (ok) setMeetings(prev => prev.filter(x => x.id !== m.id));
                                                                                }
                                                                                setActiveMenuId(null);
                                                                            }}
                                                                        >
                                                                            <Trash2 size={12} /> Delete
                                                                        </button>
                                                                    </div>
                                                                </motion.div>
                                                            )}
                                                        </AnimatePresence>
                                                    </motion.div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </section>
                            </motion.main>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Notification Toast - Liquid Glass (macOS 26 Tahoe Concept) */}
            <AnimatePresence>
                {showNotification && (
                    <motion.div
                        initial={{ x: 300, opacity: 0, scale: 0.9 }}
                        animate={{ x: 0, opacity: 1, scale: 1 }}
                        exit={{ x: 300, opacity: 0, scale: 0.95 }}
                        transition={{ type: "spring", stiffness: 350, damping: 30, mass: 1 }}
                        className={`fixed bottom-10 right-10 z-[2000] flex items-center gap-4 pl-4 pr-6 py-3.5 rounded-[18px] backdrop-blur-xl saturate-[180%] ring-1 ring-black/10 ${isLight ? 'bg-bg-elevated/90 border border-border-muted shadow-[0_8px_32px_rgba(0,0,0,0.15),inset_0_1px_0_rgba(255,255,255,0.9)]' : 'bg-bg-card/70 border border-border-subtle shadow-[0_40px_80px_-20px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.06)]'}`}
                    >
                        {/* Liquid Icon Orb */}
                        <div className="relative flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-b from-blue-400/20 to-blue-600/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] border border-white/5">
                            <div className="absolute inset-0 rounded-full bg-blue-500/20 blur-md" />
                            <RefreshCw size={15} className="text-blue-300 animate-[spin_2s_linear_infinite] drop-shadow-[0_0_5px_rgba(59,130,246,0.6)]" />
                        </div>

                        {/* Text Content */}
                        <div className="flex flex-col gap-0.5">
                            <span className="text-[14px] font-semibold text-text-primary leading-none tracking-tight">Refreshed</span>
                            <span className="text-[11px] text-text-tertiary font-medium leading-none tracking-wide">Synced with calendar</span>
                        </div>

                        {/* Specular Highlight Overlay */}
                        <div className="absolute inset-0 rounded-[18px] bg-gradient-to-tr from-white/5 via-transparent to-transparent pointer-events-none" />
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Global Chat Overlay */}
            <GlobalChatOverlay
                isOpen={isGlobalChatOpen}
                onClose={() => {
                    setIsGlobalChatOpen(false);
                    setSubmittedGlobalQuery('');
                }}
                initialQuery={submittedGlobalQuery}
            />
            {/* Sales Brief Panel */}
            <AnimatePresence>
                {salesBriefEvent && (
                    <SalesBriefPanel
                        eventData={salesBriefEvent}
                        onClose={() => setSalesBriefEvent(null)}
                    />
                )}
            </AnimatePresence>

            {/* DEV ONLY — Transcript Upload Modal */}
            <AnimatePresence>
                {isUploadOpen && (
                    <>
                        {/* Backdrop */}
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className={["fixed inset-0 z-[100] backdrop-blur-sm", isLight ? "bg-black/30" : "bg-black/60"].join(" ")}
                            onClick={() => setIsUploadOpen(false)}
                        />

                        {/* Modal */}
                        <motion.div
                            initial={{ opacity: 0, scale: 0.96, y: 8 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.96, y: 8 }}
                            transition={{ duration: 0.22, type: "spring", damping: 26, stiffness: 320 }}
                            className="fixed inset-0 z-[101] flex items-center justify-center p-4 pointer-events-none"
                        >
                            <div className={[
                                "relative w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden pointer-events-auto",
                                isLight
                                    ? "bg-bg-elevated border border-border-muted shadow-[0_20px_60px_rgba(0,0,0,0.15)]"
                                    : "bg-bg-secondary border border-border-muted shadow-[0_20px_60px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.04]",
                            ].join(" ")}>

                                {/* Header */}
                                <div className={["flex items-center justify-between px-6 py-4 border-b", isLight ? "border-border-subtle" : "border-border-muted"].join(" ")}>
                                    <div className="flex items-center gap-3">
                                        <div className={["flex h-7 w-7 items-center justify-center rounded-lg", isLight ? "bg-blue-400/20 text-accent-primary" : "bg-blue-400/20 text-blue-400"].join(" ")}>
                                            <Upload size={13} strokeWidth={2.2} />
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold text-text-primary">Upload Transcript</p>
                                            <p className="text-[11px] text-text-tertiary mt-0.5">Dev only · paste a transcript to generate a full sales analysis</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => setIsUploadOpen(false)}
                                        className={["p-1.5 rounded-full transition-colors", isLight ? "text-text-tertiary hover:text-text-primary hover:bg-bg-item-surface" : "text-text-tertiary hover:text-text-primary hover:bg-white/10"].join(" ")}
                                    >
                                        <X size={14} />
                                    </button>
                                </div>

                                {/* Body */}
                                <div className="px-6 py-5 space-y-4">

                                    {/* Title field */}
                                    <div>
                                        <label className="text-[11px] font-medium text-text-tertiary uppercase tracking-wider mb-1.5 block">
                                            Meeting Title <span className="normal-case tracking-normal font-normal opacity-60">(optional)</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={uploadTitle}
                                            onChange={e => setUploadTitle(e.target.value)}
                                            placeholder="e.g. Q4 Discovery Call — TechFlow"
                                            className={[
                                                "w-full rounded-xl px-4 py-2.5 text-sm text-text-primary focus:outline-none transition-colors",
                                                isLight
                                                    ? "bg-bg-input border border-border-muted placeholder-text-tertiary focus:border-accent-primary/40 focus:ring-2 focus:ring-accent-primary/10"
                                                    : "bg-bg-input border border-border-muted placeholder-text-tertiary focus:border-white/20 focus:ring-0",
                                            ].join(" ")}
                                        />
                                    </div>

                                    {/* Transcript textarea */}
                                    <div>
                                        <label className="text-[11px] font-medium text-text-tertiary uppercase tracking-wider mb-1.5 block">
                                            Transcript
                                        </label>
                                        <textarea
                                            value={uploadText}
                                            onChange={e => setUploadText(e.target.value)}
                                            placeholder={`Paste transcript here. Supported formats:\n\n[00:00:12] REP: Hello, thanks for joining...\nPROSPECT: Happy to be here...\n\nor plain text lines`}
                                            rows={12}
                                            className={[
                                                "w-full rounded-xl px-4 py-3 text-sm text-text-primary focus:outline-none transition-colors resize-none font-mono leading-relaxed",
                                                isLight
                                                    ? "bg-bg-input border border-border-muted placeholder-text-tertiary focus:border-accent-primary/40 focus:ring-2 focus:ring-accent-primary/10"
                                                    : "bg-bg-input border border-border-muted placeholder-text-tertiary/60 focus:border-white/20",
                                            ].join(" ")}
                                        />
                                        <p className="text-[10px] text-text-tertiary mt-1.5">
                                            {uploadText.split('\n').filter(l => l.trim()).length} lines · Supports [timestamp] SPEAKER: text format
                                        </p>
                                    </div>

                                    {uploadError && (
                                        <div className={["flex items-center gap-2 text-[12px] rounded-lg px-3 py-2.5 border", isLight ? "text-red-600 bg-red-50 border-red-200" : "text-red-400 bg-red-500/10 border-red-500/20"].join(" ")}>
                                            <AlertCircle size={13} className="shrink-0" />
                                            {uploadError}
                                        </div>
                                    )}
                                </div>

                                {/* Footer */}
                                <div className={["flex items-center justify-between px-6 py-4 border-t", isLight ? "border-border-subtle bg-bg-primary/40" : "border-border-muted bg-bg-item-surface/50"].join(" ")}>
                                    <p className="text-[11px] text-text-tertiary">
                                        {uploadText.trim() ? `${uploadText.trim().length.toLocaleString()} characters` : 'No transcript pasted yet'}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => { setIsUploadOpen(false); setUploadText(''); setUploadTitle(''); }}
                                            className={["px-4 py-2 text-sm rounded-xl transition-colors font-medium", isLight ? "text-text-secondary hover:text-text-primary hover:bg-bg-component" : "text-text-tertiary hover:text-text-secondary hover:bg-white/[0.06]"].join(" ")}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={handleUploadTranscript}
                                            disabled={isUploading || !uploadText.trim()}
                                            className={[
                                                "flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed",
                                                isLight ? "bg-accent-primary hover:bg-blue-700 shadow-sm" : "bg-accent-primary hover:bg-blue-500",
                                            ].join(" ")}
                                        >
                                            {isUploading ? (
                                                <>
                                                    <RefreshCw size={13} className="animate-spin" />
                                                    Processing...
                                                </>
                                            ) : (
                                                <>
                                                    <Upload size={13} />
                                                    Upload & Analyse
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
        </div >
    );
};

export default Launcher;