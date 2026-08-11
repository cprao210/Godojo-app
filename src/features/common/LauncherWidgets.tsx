// Presentational building blocks for Launcher.tsx.
// Launcher.tsx only owns layout/composition — every piece that renders a
// distinct visual unit (header bar, ghost-mode pill, a meeting row, the
// upload modal, ...) lives here so it can be reused and tested on its own.
// Same split as ManagerDashboardWidgets.tsx / AeDetailWidgets.tsx.

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Zap, Calendar, ArrowRight, ArrowLeft, MoreHorizontal, ChevronRight,
    Settings, RefreshCw, Ghost, Trash2, Download, DownloadCloud, CheckCircle,
    AlertCircle, Briefcase, Upload, X, ChevronUp, LayoutDashboard,
} from 'lucide-react';
import { TopSearchPill, WindowControls } from '@/features/common';
import { ConnectCalendarButton } from '@/features/calendar';
import { UserProfileButton } from '@/features/tenant';
import { generateMeetingPDF } from '@/../utils/pdfGenerator';
import { isMac } from '@/../utils/platformUtils';
import { Meeting } from '@/types';
import { IMAGES } from '@/lib/assets';
import { getGroupLabel, formatTime, formatDurationPill, UPLOAD_MEETING_TYPE_OPTIONS } from '@/hooks/useLauncher';

// ─────────────────────────────────────────────────────────────────────────
// Header bar — back/forward nav, logo, search pill, dashboard/settings/
// profile actions and (non-mac) window controls.
// ─────────────────────────────────────────────────────────────────────────

interface LauncherHeaderProps {
    isLight: boolean;
    selectedMeeting: Meeting | null;
    forwardMeeting: Meeting | null;
    onBack: () => void;
    onForward: () => void;
    meetings: Meeting[];
    onOpenMeeting: (meeting: Meeting) => void;
    onOpenManagerDashboard?: () => void;
    onOpenSettings: (tab?: string) => void;
    authUser?: { displayName?: string | null; email?: string | null; photoURL?: string | null } | null;
    onSignOut?: () => void;
}

export const LauncherHeader: React.FC<LauncherHeaderProps> = ({
    isLight, selectedMeeting, forwardMeeting, onBack, onForward,
    meetings, onOpenMeeting, onOpenManagerDashboard, onOpenSettings,
    authUser, onSignOut,
}) => {
    return (
        <header className={[
            'relative w-full shrink-0 flex items-center gap-3 drag-region select-none border-b z-[200] backdrop-blur-xl',
            isMac ? 'h-[56px]' : 'h-[42px]',   // ← Windows keeps original 40px height
            isLight
                ? 'bg-bg-sidebar/70 border-border-subtle'
                : 'bg-bg-primary/70 border-border-subtle',
        ].join(' ')}>
            {/* Left: Spacing for Traffic Lights + Navigation Arrows */}
            <div className="flex items-center gap-1 no-drag">
                {isMac && <div className="w-[70px]" />} {/* Traffic Light Spacer (macOS only) */}

                {/* Back Button */}
                <button
                    onClick={selectedMeeting ? onBack : undefined}
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
                    onClick={onForward}
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
            {/* <div className="flex items-center gap-2 no-drag ml-1">
                <div className="relative flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-blue-700 shadow-[0_2px_8px_rgba(59,130,246,0.35)]">
                    <Sparkles className="h-2.5 w-2.5 fill-white text-white" />
                </div>
                <span className={["text-sm font-semibold tracking-tight", isLight ? "text-text-primary" : "text-white"].join(" ")}>
                    GoDojo AI
                </span>
            </div> */}
            <img src={IMAGES.godojoLogoV3} alt="GoDojo AI" className="h-5 object-contain" />

            {/* Center: Search pill */}
            <div className="mx-2 flex-1 no-drag">
                {/* Center: Spotlight-style Search Pill */}
                <TopSearchPill
                    meetings={meetings}
                    onOpenMeeting={(meetingId) => {
                        const meeting = meetings.find(m => m.id === meetingId);
                        if (meeting) {
                            onOpenMeeting(meeting);
                        }
                    }}
                />
            </div>

            {/* Right: Dashboard + Settings + Profile */}
            <div className={`flex items-center gap-2 no-drag shrink-0 ${isMac ? 'mr-1' : ''}`}>

                {/* Manager Dashboard */}
                {onOpenManagerDashboard && (
                    <button
                        onClick={onOpenManagerDashboard}
                        className={[
                            'inline-flex items-center justify-center rounded-full transition-all no-drag',
                            isMac ? 'h-9 w-9' : 'h-7 w-7',
                            isLight
                                ? 'border border-border-muted bg-bg-elevated/80 text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
                                : 'border border-border-subtle bg-bg-item-surface text-text-secondary hover:bg-white/[0.08] hover:text-white',
                        ].join(' ')}
                        aria-label="Manager Dashboard"
                        title='Manager Dashboard'
                    >
                        <LayoutDashboard size={15} />
                    </button>
                )}

                {/* Settings */}
                <button
                    onClick={() => {
                        onOpenSettings();
                    }}
                    className={[
                        'inline-flex items-center justify-center rounded-full transition-all no-drag',
                        isMac ? 'h-9 w-9' : 'h-7 w-7',   // ← shrink on Windows
                        isLight
                            ? 'border border-border-muted bg-bg-elevated/80 text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
                            : 'border border-border-subtle bg-bg-item-surface text-text-secondary hover:bg-white/[0.08] hover:text-white',
                    ].join(' ')}
                    aria-label="Settings"
                    title='Settings'
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
    );
};

// ─────────────────────────────────────────────────────────────────────────
// Ghost mode toggle — hover tooltip explains what "detectable" means.
// ─────────────────────────────────────────────────────────────────────────

interface GhostModeToggleProps {
    isDetectable: boolean;
    onToggle: () => void;
    isLight: boolean;
}

export const GhostModeToggle: React.FC<GhostModeToggleProps> = ({ isDetectable, onToggle, isLight }) => (
    <div className="relative group/ghost">
        <button
            onClick={onToggle}
            className={[
                'relative flex items-center gap-2 rounded-xl px-3 py-2 border transition-all duration-200 select-none cursor-pointer',
                !isDetectable
                    ? isLight
                        ? 'bg-blue-50 border-blue-200 text-blue-700 shadow-[0_0_12px_-2px_rgba(59,130,246,0.2)]'
                        : 'bg-blue-500/10 border-blue-500/30 text-blue-300 shadow-[0_0_16px_-4px_rgba(59,130,246,0.35)]'
                    : isLight
                        ? 'bg-bg-elevated border-border-muted text-text-secondary hover:border-border-muted hover:text-text-primary shadow-sm'
                        : 'bg-bg-item-surface border-border-subtle text-text-tertiary hover:bg-white/[0.07] hover:border-border-muted hover:text-text-secondary',
            ].join(' ')}
            aria-label={!isDetectable ? 'Ghost mode on — app is hidden from screen share' : 'Ghost mode off — app is visible'}
        >
            {!isDetectable ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                    <path d="M12 2C7.58172 2 4 5.58172 4 10V22L7 19L9.5 21.5L12 19L14.5 21.5L17 19L20 22V10C20 5.58172 16.4183 2 12 2Z" fill="currentColor" />
                    <circle cx="9" cy="10" r="1.5" fill={isLight ? 'white' : '#1e3a5f'} />
                    <circle cx="15" cy="10" r="1.5" fill={isLight ? 'white' : '#1e1b4b'} />
                </svg>
            ) : (
                <Ghost size={14} strokeWidth={2} className="shrink-0" />
            )}
            <span className="text-[12px] font-medium leading-none whitespace-nowrap">
                {!isDetectable ? 'Ghost On' : 'Ghost Off'}
            </span>
            <div className={[
                'w-7 h-3.5 rounded-full relative transition-colors duration-200 shrink-0',
                !isDetectable ? 'bg-accent-primary' : isLight ? 'bg-bg-toggle-switch' : 'bg-white/15',
            ].join(' ')}>
                <div className={[
                    'absolute top-[1.5px] w-[10px] h-[10px] rounded-full bg-white shadow-sm transition-all duration-200',
                    !isDetectable ? 'left-[16px]' : 'left-[2px]',
                ].join(' ')} />
            </div>
        </button>
        {/* Ghost tooltip */}
        <div className={[
            'pointer-events-none absolute top-[50px] left-1/2 -translate-x-1/2 mb-2 z-[500]',
            'opacity-0 group-hover/ghost:opacity-100 transition-opacity duration-150 delay-300',
        ].join(' ')}>
            <div className={[
                'rounded-lg px-3 py-2 text-[11px] leading-snug whitespace-nowrap shadow-lg',
                isLight ? 'bg-bg-primary' : 'bg-bg-card border border-border-subtle text-text-secondary',
            ].join(' ')}>
                <p className="font-semibold mb-0.5">{!isDetectable ? 'Ghost mode is ON' : 'Ghost mode is OFF'}</p>
                <p className="text-text-tertiary">{!isDetectable ? 'Hidden from screen share & recording' : 'Visible to screen share & recording'}</p>
            </div>
            <div className={['absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent', isLight ? 'border-t-bg-primary' : 'border-t-bg-card'].join(' ')} />
        </div>
    </div>
);

// ─────────────────────────────────────────────────────────────────────────
// Refresh button — spins while syncing, with hover tooltip.
// ─────────────────────────────────────────────────────────────────────────

interface RefreshButtonProps {
    isRefreshing: boolean;
    onRefresh: () => void;
    isLight: boolean;
}

export const RefreshButton: React.FC<RefreshButtonProps> = ({ isRefreshing, onRefresh, isLight }) => (
    <div className="relative group/refresh">
        <button
            onClick={onRefresh}
            disabled={isRefreshing}
            className={[
                'h-9 w-9 flex items-center justify-center rounded-xl border transition-all duration-200',
                isRefreshing ? 'cursor-wait' : '',
                isLight
                    ? 'bg-bg-elevated border-border-muted hover:border-border-muted hover:bg-bg-item-surface shadow-sm'
                    : 'bg-bg-item-surface border-border-subtle hover:bg-white/[0.07] hover:border-border-muted',
            ].join(' ')}
            aria-label="Refresh calendar and meetings"
        >
            <RefreshCw className={isRefreshing ? 'animate-spin text-accent-primary' : 'text-text-tertiary'} size={14} />
        </button>
        {/* Refresh tooltip */}
        <div className={[
            'pointer-events-none absolute top-[50px] left-1/2 -translate-x-1/2 mb-2 z-[500]',
            'opacity-0 group-hover/refresh:opacity-100 transition-opacity duration-150 delay-300',
        ].join(' ')}>
            <div className={[
                'rounded-lg px-3 py-2 text-[11px] leading-snug whitespace-nowrap shadow-lg',
                isLight ? 'bg-bg-primary' : 'bg-bg-card border border-border-subtle text-text-secondary',
            ].join(' ')}>
                <p className="font-semibold mb-0.5">{isRefreshing ? 'Refreshing…' : 'Sync calendar & meetings'}</p>
                <p className="text-text-tertiary">Pull latest events from your calendar</p>
            </div>
            <div className={['absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent', isLight ? 'border-t-bg-primary' : 'border-t-bg-card'].join(' ')} />
        </div>
    </div>
);

// ─────────────────────────────────────────────────────────────────────────
// Start / resume meeting CTA — swaps label + color while a meeting is live.
// ─────────────────────────────────────────────────────────────────────────

interface StartMeetingButtonProps {
    isMeetingActive: boolean;
    onClick: () => void;
}

export const StartMeetingButton: React.FC<StartMeetingButtonProps> = ({ isMeetingActive, onClick }) => (
    <motion.button
        onClick={onClick}
        whileHover={{ scale: 1.02, filter: 'brightness(1.08)' }}
        whileTap={{ scale: 0.98 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className="group relative overflow-hidden text-white pl-3.5 pr-4 py-2 rounded-xl font-medium text-[13px] flex items-center gap-2 shrink-0"
        style={{
            background: isMeetingActive
                ? 'linear-gradient(to bottom, #10b981, #059669)'
                : 'linear-gradient(to bottom, #3b82f6, #2563eb)',
            boxShadow: isMeetingActive
                ? '0 6px 18px -4px rgba(16,185,129,0.6), inset 0 1px 0 rgba(255,255,255,0.2)'
                : '0 6px 18px -4px rgba(59,130,246,0.6), inset 0 1px 0 rgba(255,255,255,0.2)',
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
);

// ─────────────────────────────────────────────────────────────────────────
// Ollama model pull progress badge — preserved exactly from the original.
// ─────────────────────────────────────────────────────────────────────────

interface OllamaPullBadgeProps {
    status: 'idle' | 'downloading' | 'complete' | 'failed';
    percent: number;
    message: string;
    isLight: boolean;
}

export const OllamaPullBadge: React.FC<OllamaPullBadgeProps> = ({ status, percent, message, isLight }) => (
    <AnimatePresence>
        {status !== 'idle' && (
            <motion.div
                initial={{ opacity: 0, scale: 0.9, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 10 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                className={`flex items-center gap-2 px-4 py-2 rounded-full w-fit ${isLight ? 'bg-bg-elevated border border-border-muted shadow-[0_4px_16px_rgba(0,0,0,0.1)]' : 'bg-bg-elevated/80 border border-white/10 shadow-[0_4px_16px_rgba(0,0,0,0.3)]'}`}
            >
                {status === 'downloading' ? (
                    <DownloadCloud size={14} className="text-blue-400 animate-pulse shrink-0" />
                ) : status === 'complete' ? (
                    <CheckCircle size={14} className="text-emerald-400 shrink-0" />
                ) : (
                    <AlertCircle size={14} className="text-red-400 shrink-0" />
                )}
                <span className="text-[11px] font-medium text-text-secondary whitespace-nowrap">
                    {status === 'downloading' ? `Setting up AI memory... ${percent}%` : message}
                </span>
                {status === 'downloading' && (
                    <div className="w-24 h-[3px] bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${percent}%` }} />
                    </div>
                )}
            </motion.div>
        )}
    </AnimatePresence>
);

// ─────────────────────────────────────────────────────────────────────────
// Calendar connect / connected status card.
// ─────────────────────────────────────────────────────────────────────────

interface CalendarConnectCardProps {
    isCalendarConnected: boolean;
    isLight: boolean;
    onConnect: () => void;
    onDisconnect: () => void;
}

export const CalendarConnectCard: React.FC<CalendarConnectCardProps> = ({ isCalendarConnected, isLight, onConnect, onDisconnect }) => (
    <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
        className={[
            'w-[300px] shrink-0 relative rounded-xl overflow-hidden border p-4 flex flex-col',
            isLight
                ? 'border-border-muted bg-gradient-to-br from-white via-[#f5f3fb] to-[#ece9f7] shadow-[0_4px_24px_-8px_rgba(99,102,241,0.2)]'
                : 'border-white/[0.08] bg-gradient-to-br from-[#12082e] via-[#0e0625] to-[#090418] shadow-[0_0_60px_-10px_rgba(99,60,255,0.3)]',
        ].join(' ')}
    >
        {/* Ambient glows */}
        <div aria-hidden className={['pointer-events-none absolute -top-20 -left-12 h-48 w-48 rounded-full blur-3xl', isLight ? 'bg-blue-300/35' : 'bg-indigo-600/20'].join(' ')} />
        <div aria-hidden className={['pointer-events-none absolute -bottom-16 -right-10 h-48 w-48 rounded-full blur-3xl', isLight ? 'bg-purple-300/35' : 'bg-purple-600/20'].join(' ')} />

        {/* Header row */}
        <div className="relative flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
                <span className={['inline-flex h-8 w-8 items-center justify-center rounded-lg relative', isLight ? 'bg-gradient-to-br from-purple-100 to-fuchsia-50 text-purple-600 ring-1 ring-inset ring-purple-200/60' : 'bg-gradient-to-br from-purple-500/25 to-fuchsia-700/10 text-purple-300'].join(' ')}>
                    <Calendar className="h-[15px] w-[15px]" strokeWidth={2.2} />
                    <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-purple-600 text-[7px] font-bold text-white">+</span>
                </span>
                <span className="text-[13px] font-semibold tracking-tight">Calendar</span>
            </div>
            <span className={['inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold', isLight ? isCalendarConnected ? 'bg-green-50 text-green-500 ring-1 ring-inset ring-green-200' : 'bg-rose-50 text-rose-500 ring-1 ring-inset ring-rose-200/70' : isCalendarConnected ? 'bg-green-500/15 text-green-300' : 'bg-rose-500/15 text-rose-300'].join(' ')}>
                {isCalendarConnected ? 'Connected' : 'Not Connected'}
            </span>
        </div>

        {/* Title */}
        <h4 className="relative text-[15px] font-semibold leading-snug tracking-tight mb-4">
            {isCalendarConnected ? (
                <>Calendar linked<br /><span className="text-[13px] font-normal text-text-secondary">Events are syncing automatically.</span></>
            ) : (
                <>Connect your calendar<br />to unlock AI meeting preparation</>
            )}
        </h4>

        {/* Features list */}
        <div className="relative flex-1 space-y-2">
            {[
                { icon: Zap, label: 'Auto-detect meetings', color: 'text-yellow-400' },
                { icon: Briefcase, label: 'Company insights per event', color: 'text-blue-400' },
                { icon: Calendar, label: 'One-click join', color: 'text-purple-400' },
            ].map(({ icon: Icon, label, color }) => (
                <div key={label} className="flex items-center gap-2.5">
                    <span className={['inline-flex shrink-0 items-center justify-center rounded-lg', isLight ? 'bg-bg-elevated shadow-sm border border-border-subtle' : 'bg-bg-item-surface'].join(' ')}>
                        <Icon className={`h-3 w-3 ${color}`} strokeWidth={3} />
                    </span>
                    <span className="text-[12px] font-medium text-text-secondary">{label}</span>
                </div>
            ))}
        </div>

        {/* CTA */}
        <ConnectCalendarButton
            className="relative mt-3 w-full"
            onConnect={onConnect}
            onDisconnect={onDisconnect}
        />
    </motion.div>
);

// ─────────────────────────────────────────────────────────────────────────
// Recent-meetings section header — icon/title + upload/expand actions.
// ─────────────────────────────────────────────────────────────────────────

interface RecentMeetingsHeaderProps {
    isLight: boolean;
    isMeetingsExpanded: boolean;
    onToggleExpand: () => void;
    onOpenUpload: () => void;
}

export const RecentMeetingsHeader: React.FC<RecentMeetingsHeaderProps> = ({ isLight, isMeetingsExpanded, onToggleExpand }) => (
    <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
            <div className={[
                'flex h-7 w-7 items-center justify-center rounded-lg',
                isLight ? 'bg-accent-muted text-accent-primary' : 'bg-accent-muted text-blue-400',
            ].join(' ')}>
                <Calendar size={14} strokeWidth={2.2} />
            </div>
            <span className="text-[15px] font-semibold text-text-primary tracking-tight">
                Recent Meetings
            </span>
        </div>

        {/* Right-side header actions */}
        <div className="flex items-center gap-2">

            {/* Upload Transcript */}
            {/* {(
                <button
                    onClick={onOpenUpload}
                    className={[
                        'flex items-center gap-1.5 text-[11px] font-medium rounded-lg px-2.5 py-1.5 border transition-all duration-150',
                        isLight
                            ? 'text-text-secondary border-border-muted bg-bg-elevated hover:bg-bg-component hover:text-text-primary hover:border-border-muted shadow-sm'
                            : 'text-text-tertiary border-border-muted bg-bg-item-surface hover:bg-white/[0.06] hover:border-white/[0.14] hover:text-text-secondary',
                    ].join(' ')}
                >
                    <Upload size={11} />
                    Upload Transcript
                </button>
            )} */}

            {/* Expand / Collapse */}
            <motion.button
                onClick={onToggleExpand}
                className={[
                    'flex items-center gap-1.5 text-[11px] font-medium rounded-lg px-2.5 py-1.5 border transition-colors duration-150',
                    isMeetingsExpanded
                        ? isLight
                            ? 'text-accent-primary border-accent-primary/30 bg-accent-muted shadow-sm'
                            : 'text-blue-400 border-blue-500/30 bg-blue-500/10'
                        : isLight
                            ? 'text-text-secondary border-border-muted bg-bg-elevated hover:bg-bg-component hover:text-text-primary shadow-sm'
                            : 'text-text-tertiary border-border-muted bg-bg-item-surface hover:bg-white/[0.06] hover:border-white/[0.14] hover:text-text-secondary',
                ].join(' ')}
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
);

// ─────────────────────────────────────────────────────────────────────────
// A single meeting row + its right-click-free hover context menu
// (Export as PDF / Delete). Kept as one row component so the list below
// can stay a plain `.map`.
// ─────────────────────────────────────────────────────────────────────────

interface MeetingRowProps {
    meeting: Meeting;
    isLast: boolean;
    isLight: boolean;
    isMenuOpen: boolean;
    onOpen: (meeting: Meeting) => void;
    onToggleMenu: (id: string | null) => void;
    onMenuMouseEnter: () => void;
    onMenuMouseLeave: () => void;
    onDelete: (id: string) => void;
}

export const MeetingRow: React.FC<MeetingRowProps> = ({
    meeting: m, isLast, isLight, isMenuOpen,
    onOpen, onToggleMenu, onMenuMouseEnter, onMenuMouseLeave, onDelete,
}) => (
    <motion.div
        layoutId={`meeting-${m.id}`}
        onClick={() => onOpen(m)}
        className={[
            'group relative flex items-center gap-4 px-5 py-4 cursor-pointer transition-colors',
            !isLast ? 'border-b border-border-subtle' : '',
            'bg-bg-sidebar hover:bg-bg-item-surface',
        ].join(' ')}
    >
        {/* Left: Icon */}
        <div className={[
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10',
            isLight ? 'text-accent-primary' : 'text-blue-400',
        ].join(' ')}>
            {m.title === 'Processing...'
                ? <RefreshCw size={15} className="animate-spin text-blue-500" />
                : <Calendar size={15} strokeWidth={2} />
            }
        </div>

        {/* Center: Title + subtitle */}
        <div className="flex-1 min-w-0">
            <div className={[
                'text-[13px] font-semibold truncate leading-tight',
                m.title === 'Processing...'
                    ? 'text-blue-400 italic animate-pulse'
                    : 'text-text-primary',
            ].join(' ')}>
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
                onClick={(e) => { e.stopPropagation(); onToggleMenu(isMenuOpen ? null : m.id); }}
            >
                <MoreHorizontal size={15} />
            </button>
        </div>

        {/* Dropdown — unchanged logic */}
        <AnimatePresence>
            {isMenuOpen && (
                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 4 }}
                    transition={{ duration: 0.1 }}
                    className={['absolute right-5 top-10 mt-1 w-[100px] backdrop-blur-xl rounded-lg shadow-2xl z-[200] overflow-hidden border', isLight ? 'bg-bg-elevated border-border-muted shadow-[0_8px_24px_rgba(0,0,0,0.12)]' : 'bg-bg-card/90 border-border-muted'].join(' ')}
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={onMenuMouseEnter}
                    onMouseLeave={onMenuMouseLeave}
                >
                    <div className="p-1 flex flex-col gap-0.5">
                        <button
                            className={['w-full flex items-center gap-2 px-3 py-1.5 text-[12px] rounded-lg transition-colors text-left text-text-primary', isLight ? 'hover:bg-bg-item-surface' : 'hover:bg-white/10'].join(' ')}
                            onClick={async () => {
                                onToggleMenu(null);
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
                            onClick={() => {
                                onDelete(m.id);
                                onToggleMenu(null);
                            }}
                        >
                            <Trash2 size={12} /> Delete
                        </button>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    </motion.div>
);

// ─────────────────────────────────────────────────────────────────────────
// The full meetings list — empty state, or bordered rows with dividers.
// ─────────────────────────────────────────────────────────────────────────

interface MeetingsListProps {
    meetings: Meeting[];
    isLight: boolean;
    activeMenuId: string | null;
    onOpen: (meeting: Meeting) => void;
    onToggleMenu: (id: string | null) => void;
    onMenuMouseEnter: () => void;
    onMenuMouseLeave: () => void;
    onDelete: (id: string) => void;
}

export const MeetingsList: React.FC<MeetingsListProps> = ({
    meetings, isLight, activeMenuId,
    onOpen, onToggleMenu, onMenuMouseEnter, onMenuMouseLeave, onDelete,
}) => {
    if (meetings.length === 0) {
        return (
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className={[
                    'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-10 px-6 text-center',
                    isLight
                        ? 'border-border-muted bg-bg-elevated/60'
                        : 'border-white/[0.08] bg-bg-item-surface/40',
                ].join(' ')}
            >
                <div
                    className={[
                        'flex h-11 w-11 items-center justify-center rounded-full',
                        isLight ? 'bg-accent-muted text-accent-primary' : 'bg-blue-500/10 text-blue-400',
                    ].join(' ')}
                >
                    <Calendar size={18} strokeWidth={2} />
                </div>
                <div>
                    <p className="text-[13px] font-semibold text-text-primary">
                        No recent meetings yet
                    </p>
                    <p className="mt-1 max-w-[240px] text-[12px] leading-relaxed text-text-tertiary">
                        Meetings you record or import will show up here, ready to review.
                    </p>
                </div>
            </motion.div>
        );
    }

    return (
        <div className="rounded-xl first:rounded-t-xl last:rounded-b-xl border border-border-muted">
            {meetings.map((m, index) => (
                <MeetingRow
                    key={m.id}
                    meeting={m}
                    isLast={index === meetings.length - 1}
                    isLight={isLight}
                    isMenuOpen={activeMenuId === m.id}
                    onOpen={onOpen}
                    onToggleMenu={onToggleMenu}
                    onMenuMouseEnter={onMenuMouseEnter}
                    onMenuMouseLeave={onMenuMouseLeave}
                    onDelete={onDelete}
                />
            ))}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────────────────
// "Refreshed" toast — liquid-glass style, bottom-right.
// ─────────────────────────────────────────────────────────────────────────

interface RefreshToastProps {
    show: boolean;
    isLight: boolean;
}

export const RefreshToast: React.FC<RefreshToastProps> = ({ show, isLight }) => (
    <AnimatePresence>
        {show && (
            <motion.div
                initial={{ x: 300, opacity: 0, scale: 0.9 }}
                animate={{ x: 0, opacity: 1, scale: 1 }}
                exit={{ x: 300, opacity: 0, scale: 0.95 }}
                transition={{ type: 'spring', stiffness: 350, damping: 30, mass: 1 }}
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
);

// ─────────────────────────────────────────────────────────────────────────
// Transcript upload modal — title, meeting-type checkboxes, transcript
// textarea, error state and footer actions.
// ─────────────────────────────────────────────────────────────────────────

interface TranscriptUploadModalProps {
    isOpen: boolean;
    isLight: boolean;
    uploadTitle: string;
    setUploadTitle: (v: string) => void;
    uploadText: string;
    setUploadText: (v: string) => void;
    uploadMeetingTypes: ('discovery' | 'demo' | 'negotiation')[];
    setUploadMeetingTypes: React.Dispatch<React.SetStateAction<('discovery' | 'demo' | 'negotiation')[]>>;
    uploadError: string | null;
    isUploading: boolean;
    onClose: () => void;
    onSubmit: () => void;
}

export const TranscriptUploadModal: React.FC<TranscriptUploadModalProps> = ({
    isOpen, isLight, uploadTitle, setUploadTitle, uploadText, setUploadText,
    uploadMeetingTypes, setUploadMeetingTypes, uploadError, isUploading, onClose, onSubmit,
}) => (
    <AnimatePresence>
        {isOpen && (
            <>
                {/* Backdrop */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className={['fixed inset-0 z-[100] backdrop-blur-sm', isLight ? 'bg-black/30' : 'bg-black/60'].join(' ')}
                    onClick={onClose}
                />

                {/* Modal */}
                <motion.div
                    initial={{ opacity: 0, scale: 0.96, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, y: 8 }}
                    transition={{ duration: 0.22, type: 'spring', damping: 26, stiffness: 320 }}
                    className="fixed inset-0 z-[101] flex items-center justify-center p-4 pointer-events-none"
                >
                    <div className={[
                        'relative w-full max-w-[580px] rounded-2xl shadow-2xl overflow-hidden pointer-events-auto',
                        isLight
                            ? 'bg-bg-elevated border border-border-muted shadow-[0_20px_60px_rgba(0,0,0,0.15)]'
                            : 'bg-bg-secondary border border-border-muted shadow-[0_20px_60px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.04]',
                    ].join(' ')}>

                        {/* Header */}
                        <div className={['flex items-center justify-between px-4 py-3 border-b', isLight ? 'border-border-subtle' : 'border-border-muted'].join(' ')}>
                            <div className="flex items-center gap-2">
                                <div className={['flex h-[26px] w-[26px] items-center justify-center rounded-lg', isLight ? 'bg-blue-400/15 text-accent-primary' : 'bg-blue-400/15 text-blue-400'].join(' ')}>
                                    <Upload size={12} strokeWidth={2.2} />
                                </div>
                                <div>
                                    <p className="text-[13px] font-semibold text-text-primary leading-tight">Upload Transcript</p>
                                    <p className="text-[11px] text-text-tertiary leading-tight">Paste a transcript to generate a full sales analysis</p>
                                </div>
                            </div>
                            <button
                                onClick={onClose}
                                className={['p-1 rounded-full transition-colors', isLight ? 'text-text-tertiary hover:text-text-primary hover:bg-bg-item-surface' : 'text-text-tertiary hover:text-text-primary hover:bg-white/10'].join(' ')}
                            >
                                <X size={13} />
                            </button>
                        </div>

                        {/* Body */}
                        <div className="px-4 py-3 space-y-3">

                            {/* Title field */}
                            <div>
                                <label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider mb-1 block">
                                    Meeting Title <span className="normal-case tracking-normal font-normal opacity-60">(optional)</span>
                                </label>
                                <input
                                    type="text"
                                    value={uploadTitle}
                                    onChange={e => setUploadTitle(e.target.value)}
                                    placeholder="e.g. Q4 Discovery Call — TechFlow"
                                    className={[
                                        'w-full rounded-[10px] px-3 py-[7px] text-[13px] text-text-primary focus:outline-none transition-colors',
                                        isLight
                                            ? 'bg-bg-input border border-border-muted placeholder-text-tertiary focus:border-accent-primary/40 focus:ring-2 focus:ring-accent-primary/10'
                                            : 'bg-bg-input border border-border-muted placeholder-text-tertiary focus:border-white/20 focus:ring-0',
                                    ].join(' ')}
                                />
                            </div>

                            {/* Meeting Type */}
                            <div>
                                <label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider mb-1.5 block">
                                    Meeting Type
                                </label>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                    {UPLOAD_MEETING_TYPE_OPTIONS.map(opt => {
                                        const on = uploadMeetingTypes.includes(opt.value);
                                        return (
                                            <button
                                                key={opt.value}
                                                type="button"
                                                onClick={() =>
                                                    setUploadMeetingTypes(prev =>
                                                        prev.includes(opt.value)
                                                            ? prev.filter(t => t !== opt.value)
                                                            : [...prev, opt.value]
                                                    )
                                                }
                                                className="flex items-center gap-1.5 px-2.5 py-[5px] rounded-lg text-[11.5px] font-medium transition-all active:scale-95 select-none"
                                                style={{
                                                    background: on ? opt.activeBg : isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)',
                                                    border: `1px solid ${on ? opt.activeBorder : isLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)'}`,
                                                    color: on ? opt.activeColor : isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.30)',
                                                }}
                                            >
                                                <span
                                                    className="w-[11px] h-[11px] rounded-sm flex items-center justify-center shrink-0"
                                                    style={{
                                                        border: `1.5px solid ${on ? opt.activeColor : isLight ? 'rgba(0,0,0,0.20)' : 'rgba(255,255,255,0.18)'}`,
                                                        background: on ? opt.activeBg : 'transparent',
                                                    }}
                                                >
                                                    {on && (
                                                        <svg width="6" height="5" viewBox="0 0 6 5" fill="none">
                                                            <path d="M0.5 2.5L2 4L5.5 0.5" stroke={opt.activeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                                        </svg>
                                                    )}
                                                </span>
                                                {opt.label}
                                            </button>
                                        );
                                    })}
                                </div>
                                <p className="text-[10px] text-text-tertiary mt-1">
                                    Select one or more — used to generate the meeting scorecard
                                </p>
                            </div>

                            {/* Transcript textarea */}
                            <div>
                                <div className="flex items-baseline justify-between mb-1">
                                    <label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
                                        Transcript
                                    </label>
                                    <span className="text-[10px] text-text-tertiary">
                                        {uploadText.split('\n').filter(l => l.trim()).length} lines · Supports [timestamp] SPEAKER: text format
                                    </span>
                                </div>
                                <textarea
                                    value={uploadText}
                                    onChange={e => setUploadText(e.target.value)}
                                    placeholder={`Paste transcript here. Supported formats:\n\n[00:00:12] SALES PERSON: Hello, thanks for joining...\nCLIENT: Happy to be here...\n\nor plain text lines`}
                                    rows={9}
                                    className={[
                                        'w-full rounded-[10px] px-3 py-2.5 text-[12px] text-text-primary focus:outline-none transition-colors resize-none font-mono leading-relaxed',
                                        isLight
                                            ? 'bg-bg-input border border-border-muted placeholder-text-tertiary focus:border-accent-primary/40 focus:ring-2 focus:ring-accent-primary/10'
                                            : 'bg-bg-input border border-border-muted placeholder-text-tertiary/60 focus:border-white/20',
                                    ].join(' ')}
                                />
                            </div>

                            {uploadError && (
                                <div className={['flex items-center gap-2 text-[12px] rounded-lg px-3 py-2 border', isLight ? 'text-red-600 bg-red-50 border-red-200' : 'text-red-400 bg-red-500/10 border-red-500/20'].join(' ')}>
                                    <AlertCircle size={12} className="shrink-0" />
                                    {uploadError}
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className={['flex items-center justify-between px-4 py-2.5 border-t', isLight ? 'border-border-subtle bg-bg-primary/40' : 'border-border-muted bg-bg-item-surface/50'].join(' ')}>
                            <p className="text-[11px] text-text-tertiary">
                                {uploadText.trim() ? `${uploadText.trim().length.toLocaleString()} characters` : 'No transcript pasted yet'}
                            </p>
                            <div className="flex items-center gap-1.5">
                                <button
                                    onClick={() => { onClose(); setUploadText(''); setUploadTitle(''); }}
                                    className={['px-3.5 py-1.5 text-[12.5px] rounded-[10px] transition-colors font-medium', isLight ? 'text-text-secondary hover:text-text-primary hover:bg-bg-component' : 'text-text-tertiary hover:text-text-secondary hover:bg-white/[0.06]'].join(' ')}
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={onSubmit}
                                    disabled={isUploading || !uploadText.trim()}
                                    className={[
                                        'flex items-center gap-1.5 px-4 py-1.5 rounded-[10px] text-[12.5px] font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed',
                                        isLight ? 'bg-accent-primary hover:bg-blue-700 shadow-sm' : 'bg-accent-primary hover:bg-blue-500',
                                    ].join(' ')}
                                >
                                    {isUploading ? (
                                        <>
                                            <RefreshCw size={12} className="animate-spin" />
                                            Processing...
                                        </>
                                    ) : (
                                        <>
                                            <Upload size={12} />
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
);