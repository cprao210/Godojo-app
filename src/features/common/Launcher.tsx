/**
 * Launcher.tsx
 *
 * The main "home" screen of the app — greets the user, surfaces the next
 * upcoming meeting + a one-click Start button, shows calendar connection
 * status, and lists recent meetings (with export/delete + transcript
 * upload). Also hosts the floating global-chat entry point and the
 * per-meeting detail view once a meeting is opened.
 *
 * All state, effects, and data-fetching live in useLauncher (mirrors the
 * ManagerDashboard / AeDetailView split): this component only owns layout
 * and composes the reusable pieces in LauncherWidgets.tsx.
 */

import React from 'react';
import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { IoSparklesSharp } from 'react-icons/io5';
import { MeetingDetails, MeetingTimeline, NextMeetingDetails, NextMeetingEmptyState, SalesBriefPanel } from '@/features/meetings';
import { GlobalChatOverlay, FloatingChatButton } from '@/features/chat';
import { useLauncher } from '@/hooks';
import { LauncherHeader, GhostModeToggle, RefreshButton, StartMeetingButton, OllamaPullBadge } from './LauncherWidgets';
import { CalendarConnectCard, RecentMeetingsHeader, MeetingsList, RefreshToast, TranscriptUploadModal } from './LauncherWidgets';
import { LauncherProps, Meeting } from '@/types';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';

const Launcher: React.FC<LauncherProps> = ({ onStartMeeting, onOpenSettings, onCloseSettings, onOpenManagerDashboard, onCloseManagerDashboard, isManagerDashboardOpen = false, isSettingsOpen = false, onPageChange, ollamaPullStatus = 'idle', ollamaPullPercent = 0, ollamaPullMessage = '', authUser, onSignOut }) => {

    const launcherStates = useLauncher({ onStartMeeting, onPageChange, ollamaPullStatus, authUser });
    const { isLight, meetings, deleteMutation, upcomingEvents, isCalendarConnected, setIsCalendarConnected } = launcherStates;
    const { isMeetingsLoading, isMeetingsRefreshing } = launcherStates;
    const { focusedMeeting, focusedMeetingId, setFocusedMeetingId, getMeetingStartText } = launcherStates;
    const { isDetectable, toggleDetectable, isRefreshing, handleRefresh, isMeetingActive, onStartMeetingClick } = launcherStates;
    const { showNotification, effectiveName, selectedMeeting, forwardMeeting, handleOpenMeeting, handleBack, handleForward } = launcherStates;
    const { activeMenuId, setActiveMenuId, setMenuEntered, menuEntered, isMeetingsExpanded, setIsMeetingsExpanded } = launcherStates;
    const { isUploadOpen, setIsUploadOpen, uploadText, setUploadText, uploadTitle, setUploadTitle } = launcherStates;
    const { isUploading, uploadMeetingTypes, setUploadMeetingTypes, uploadError, handleUploadTranscript } = launcherStates;
    const { salesBriefEvent, setSalesBriefEvent, isGlobalChatOpen, setIsGlobalChatOpen, submittedGlobalQuery, setSubmittedGlobalQuery } = launcherStates;

    // Search (TopSearchPill, in LauncherHeader) is reachable from every screen —
    // its header sits at z-[200], above SettingsOverlay/ManagerDashboard (z-50).
    // handleOpenMeeting alone only updates Launcher's own content, which stays
    // hidden behind whichever overlay is open, so the result never becomes
    // visible. Close those overlays first so the picked meeting is shown.
    const handleOpenMeetingFromSearch = (meeting: Meeting) => {
        if (isSettingsOpen) onCloseSettings?.();
        if (isManagerDashboardOpen) onCloseManagerDashboard?.();
        handleOpenMeeting(meeting);
    };

    useEffect(() => {
        posthogAnalytics.trackPageView('launcher');
    }, []);

    if (!window.electronAPI) {
        return <div className="text-white p-10">Error: Electron API not initialized. Check preload script.</div>;
    }

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
            <LauncherHeader
                isLight={isLight}
                selectedMeeting={selectedMeeting}
                forwardMeeting={forwardMeeting}
                onBack={handleBack}
                onForward={handleForward}
                meetings={meetings}
                onOpenMeeting={handleOpenMeetingFromSearch}
                onOpenManagerDashboard={onOpenManagerDashboard}
                onCloseManagerDashboard={onCloseManagerDashboard}
                isManagerDashboardOpen={isManagerDashboardOpen}
                isSettingsOpen={isSettingsOpen}
                onOpenSettings={onOpenSettings}
                onCloseSettings={onCloseSettings}
                authUser={authUser}
                onSignOut={onSignOut}
            />

            <div className="relative flex-1 flex flex-col overflow-hidden">
                {/* Ghost Mode (undetectable) is signalled app-wide by <GhostGlowOverlay />,
                    mounted at the app root — a soft edge glow that sits above every screen
                    instead of a dashed frame that used to cut across Settings/Dashboard. */}
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
                            {/* Keyed by meeting id: MeetingDetails (and useMeetingDetails)
                                holds per-meeting local state — active tab, chat history,
                                the processing flag, regenerate errors. Without the key,
                                switching from one meeting straight to another reuses that
                                state and the previous meeting's UI is visibly still there
                                while the new one loads. */}
                            <MeetingDetails key={selectedMeeting.id} meeting={selectedMeeting} />
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
                                                    Welcome back{effectiveName ? `, ${effectiveName.split(' ')[0]}` : ''}
                                                </h1>
                                                <p className="text-xs mt-0.5 text-text-secondary">
                                                    Your meetings, transcripts and AI insights — all in one place.
                                                </p>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2.5">

                                            {/* ── Ghost Mode — redesigned ── */}
                                            <GhostModeToggle isDetectable={isDetectable} onToggle={toggleDetectable} isLight={isLight} />

                                            {/* ── Refresh — with tooltip ── */}
                                            <RefreshButton isRefreshing={isRefreshing} onRefresh={handleRefresh} isLight={isLight} />

                                            {/* ── Start GoDojo CTA ── */}
                                            <StartMeetingButton isMeetingActive={isMeetingActive} onClick={onStartMeetingClick} />

                                        </div>
                                    </div>

                                    {/* Ollama pull status — preserved exactly */}
                                    <OllamaPullBadge status={ollamaPullStatus} percent={ollamaPullPercent} message={ollamaPullMessage} isLight={isLight} />

                                    {/* ── Hero card ── */}

                                    {/* TWO-COLUMN LAYOUT: left = meeting/empty state, right = calendar card */}
                                    <div className="flex gap-4 items-stretch min-h-0">

                                        {/* LEFT — Meeting card + timeline strip below */}
                                        <div className="flex-1 min-w-0 flex flex-col gap-2">

                                            {/* Detail card — full width always */}
                                            <div className="flex-1 min-w-0">
                                                {focusedMeeting ? (
                                                    <NextMeetingDetails
                                                        meeting={focusedMeeting}
                                                        isLight={isLight}
                                                        getMeetingStartText={getMeetingStartText}
                                                        onStart={onStartMeeting}
                                                        onSalesBrief={setSalesBriefEvent}
                                                    />
                                                ) : (
                                                    <NextMeetingEmptyState
                                                        isLight={isLight}
                                                        onStart={onStartMeeting}
                                                    />
                                                )}
                                            </div>

                                            {/* Timeline strip — only when 2+ meetings */}
                                            {upcomingEvents.length > 1 && (
                                                <MeetingTimeline
                                                    events={upcomingEvents}
                                                    selectedId={focusedMeetingId}
                                                    onSelect={setFocusedMeetingId}
                                                />
                                            )}

                                        </div>

                                        {/* RIGHT — Calendar connect card */}
                                        <CalendarConnectCard
                                            isCalendarConnected={isCalendarConnected}
                                            isLight={isLight}
                                            onConnect={() => setIsCalendarConnected(true)}
                                            onDisconnect={() => setIsCalendarConnected(false)}
                                        />

                                    </div>

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
                                        <RecentMeetingsHeader
                                            isLight={isLight}
                                            isMeetingsExpanded={isMeetingsExpanded}
                                            onToggleExpand={() => setIsMeetingsExpanded(prev => !prev)}
                                            onOpenUpload={() => setIsUploadOpen(true)}
                                            isRefreshing={isMeetingsRefreshing}
                                        />

                                        {/* Rows — no outer card, dividers only between rows */}
                                        <MeetingsList
                                            meetings={meetings}
                                            isLight={isLight}
                                            isLoading={isMeetingsLoading}
                                            activeMenuId={activeMenuId}
                                            onOpen={handleOpenMeeting}
                                            onToggleMenu={setActiveMenuId}
                                            onMenuMouseEnter={() => setMenuEntered(true)}
                                            onMenuMouseLeave={() => { if (menuEntered) setActiveMenuId(null); }}
                                            onDelete={(id) => deleteMutation.mutate(id)}
                                        />
                                    </div>
                                </section>
                            </motion.main>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Notification Toast - Liquid Glass (macOS 26 Tahoe Concept) */}
            <RefreshToast show={showNotification} isLight={isLight} />

            {/* Floating Global Chat launcher — bottom-right, real "chat bot" style entry point.
                Hidden once a meeting is open (collides with per-meeting chat) or while
                Settings is open (covers the settings action buttons in that corner). */}
            {!selectedMeeting && !isSettingsOpen && (
                <FloatingChatButton
                    isOpen={isGlobalChatOpen}
                    onClick={() => {
                        if (isGlobalChatOpen) {
                            setIsGlobalChatOpen(false);
                            setSubmittedGlobalQuery('');
                        } else {
                            posthogAnalytics.trackGlobalChatOpened();
                            setIsGlobalChatOpen(true);
                        }
                    }}
                />
            )}

            {/* Global Chat Overlay */}
            <GlobalChatOverlay
                isOpen={isGlobalChatOpen && !isSettingsOpen}
                onClose={() => {
                    setIsGlobalChatOpen(false);
                    setSubmittedGlobalQuery('');
                }}
                initialQuery={submittedGlobalQuery}
                onOpenMeeting={(meetingId) => {
                    const meeting = meetings.find(m => m.id === meetingId);
                    if (meeting) {
                        handleOpenMeeting(meeting);
                    }
                }}
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

            {/* Transcript Upload Modal */}
            <TranscriptUploadModal
                isOpen={isUploadOpen}
                isLight={isLight}
                uploadTitle={uploadTitle}
                setUploadTitle={setUploadTitle}
                uploadText={uploadText}
                setUploadText={setUploadText}
                uploadMeetingTypes={uploadMeetingTypes}
                setUploadMeetingTypes={setUploadMeetingTypes}
                uploadError={uploadError}
                isUploading={isUploading}
                onClose={() => setIsUploadOpen(false)}
                onSubmit={handleUploadTranscript}
            />

        </div>
    );
};

export default Launcher;