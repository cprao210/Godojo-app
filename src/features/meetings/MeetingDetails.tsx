import React, { useEffect, useRef, useState } from 'react';
import { useResolvedTheme, useMeetingDetails, formatTime, formatTranscriptTimestamp, cleanMarkdown, isSummaryEmpty } from '@/hooks';
import { hasGeneratedSummary } from '@/lib/meetingLifecycle';
import { coachQuestionText } from '@/lib/coachSummary';
import { formatDurationHuman } from '@/lib/transcriptLabels';
import { Mail, ChevronDown, ChevronUp, BarChart3, ArrowUp, Copy, Check, TrendingUp, TriangleAlert, MessageSquare, Building2, Plus, Download } from 'lucide-react';
import { AskDojoInput } from './AskDojoInput';
import { MessagesSquareIcon, NotepadText, RefreshCcw, RefreshCw, NotebookPen, ClipboardList } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { MeetingChatOverlay, FollowUpEmailModal, MeetingScorecardPanel } from '@/features/meetings';
// Direct-file import (not the barrel): MeetingDetails itself is exported from
// that barrel, so going through it here would be a self-import cycle.
import GamePlan from './GamePlan';
import CoachNotes from './CoachNotes';
import HowDemoLanded from './HowDemoLanded';
import WhereTermsStand from './WhereTermsStand';
import CoachSectionNav from './CoachSectionNav';
import PostMeetingProcessingLoader from './PostMeetingProcessingLoader';
import MeetingSummarySkeleton from './MeetingSummarySkeleton';
import CallAnalysisSkeleton from './CallAnalysisSkeleton';
import LLMUsageChip from './LLMUsageChip';
import { CompanySelectModal } from '@/features/meetings/CompanyAssociation';
import { applyCompanyToCaches } from '@/lib/companyAssociation';
import { generateMeetingPDF } from '@/../utils/pdfGenerator';
import { chatMarkdownComponents, SourcesDisplay } from '@/features/chat';
import { CitationProvider, rehypeCitations, CiteChip, indexSourceMap } from '@/features/chat/citations';
import { EditableTextBlock } from '@/features/common';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import { IMAGES } from '@/lib/assets';
import CallAnalysisPanel from './CallAnalysisPanel';
import { MeetingDetailsProps, Meeting, DetailAnalysisAccordionProps } from '@/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AiInteractionSource } from "@/types";

// Skeleton pulse component
const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
    <div className={`animate-pulse rounded-lg ${className}`} style={{ background: 'rgba(128,128,128,0.12)' }} />
);

// ─── Detail Analysis accordion ────────────────────────────────────────────────
// Self-contained — safe to lift to a dashboard widget in future.
// Just pass `scorecard` + `isLight` and it renders standalone.

const DetailAnalysisAccordion: React.FC<DetailAnalysisAccordionProps> = ({ scorecard, isLight }) => {
    const [open, setOpen] = useState(false);
    return (
        <section className="mt-6">
            <button
                onClick={() => setOpen(o => !o)}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all duration-150 ${isLight
                    ? 'border-slate-200 bg-white hover:bg-slate-50'
                    : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'
                    } ${open ? (isLight ? 'rounded-b-none border-b-transparent' : 'rounded-b-none border-b-transparent') : ''}`}
            >
                <div className="flex items-center gap-2.5">
                    <div className={`w-5 h-5 rounded flex items-center justify-center ${isLight ? 'bg-slate-100' : 'bg-white/[0.06]'}`}>
                        <TrendingUp size={11} strokeWidth={2} className={isLight ? 'text-slate-500' : 'text-white/40'} />
                    </div>
                    <span className={`text-[13px] font-semibold ${isLight ? 'text-slate-700' : 'text-white/70'}`}>
                        Detailed Analysis
                    </span>
                    {/* Type pills summary — show each detected type (score badge hidden for now) */}
                    <div className="flex gap-1 ml-1">
                        {(Object.values(scorecard.scorecards ?? [])).map(sc => {
                            const COLORS: Record<string, { color: string; bg: string }> = {
                                discovery: { color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' },
                                demo: { color: '#34d399', bg: 'rgba(52,211,153,0.1)' },
                                negotiation: { color: '#fbbf24', bg: 'rgba(251,191,36,0.1)' },
                            };
                            const LABELS: Record<string, string> = {
                                discovery: 'Discovery',
                                demo: 'Demo',
                                negotiation: 'Negotiation',
                            };
                            const c = COLORS[sc.meetingType] ?? { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' };
                            return (
                                <span key={sc.meetingType}
                                    className="text-[9px] font-bold tracking-wide px-1.5 py-0.5 rounded flex items-center gap-1"
                                    style={{ color: c.color, background: c.bg }}
                                >
                                    {LABELS[sc.meetingType] ?? sc.meetingType}
                                    {/* SCORING DISABLED FOR TESTING (not accurate enough yet) — re-enable by uncommenting.
                                    <span className="opacity-70 font-semibold">{sc.overallScore}</span>
                                    */}
                                </span>
                            );
                        })}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {/* SCORING DISABLED FOR TESTING (not accurate enough yet) — re-enable by uncommenting.
                    <span className={`text-[11px] font-semibold tabular-nums ${isLight ? 'text-slate-500' : 'text-white/40'}`}>
                        Overall Score: {scorecard.overallWeightedScore}/100
                    </span>
                    */}
                    <ChevronDown
                        size={14}
                        className={`transition-transform duration-200 ${isLight ? 'text-slate-400' : 'text-white/30'} ${open ? 'rotate-180' : ''}`}
                    />
                </div>
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                        className="overflow-hidden"
                    >
                        <div className={`px-4 pt-3 pb-4 rounded-b-xl border border-t-0 ${isLight ? 'border-slate-200 bg-white' : 'border-white/[0.07] bg-white/[0.02]'
                            }`}>
                            <MeetingScorecardPanel result={scorecard} />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </section>
    );
};

/** Ask Dojo history only has somewhere useful to show doc/asset sources —
 * meeting/live-shaped entries (`{ title, meeting_id }`, often "live" as a
 * placeholder, not a real openable meeting) are dropped. Dedupes on `id`
 * since the same doc commonly appears once per matched chunk. */
function docSourcesFor(sources: AiInteractionSource[] | undefined) {
    if (!sources?.length) return [];
    const seen = new Set<string>();
    const out: { id: string; title: string }[] = [];
    for (const s of sources) {
        if (!("id" in s) || !s.id || seen.has(s.id)) continue;
        seen.add(s.id);
        out.push({ id: s.id, title: s.title });
    }
    return out;
}

const MeetingDetails: React.FC<MeetingDetailsProps> = ({ meeting: initialMeeting, viewContext }) => {

    const isLight = useResolvedTheme() === 'light';
    // Customer-company chip (view/change) — the modal writes through the
    // backend, then the meeting query is invalidated so the chip refreshes.
    const [isCompanyModalOpen, setIsCompanyModalOpen] = useState(false);
    const {
        meeting,
        isProcessing,
        isLoadingTranscript,
        scorecard,
        processingStage,
        processingProgress,
        isSummaryReady,
        isAnalysisReady,
        isLoadingAskDojo,
        canRegenerate,
        activeTab, setActiveTab,
        aiInteractionsData,
        hasMoreAiInteractions, isLoadingMoreAiInteractions, loadMoreAiInteractions,
        meetingInputRef,
        isCopied,
        isRegenerating,
        regenError,
        isFollowUpEmailOpen, setIsFollowUpEmailOpen,
        isChatOpen, setIsChatOpen,
        pendingQuery,
        chatMessages, setChatMessages,
        isTalktimeOpen, setIsTalktimeOpen,
        talkTime,
        getSpeakerDisplayName,
        transcriptTimesAreRelative,
        handleSubmitQuestion,
        handlePracticeWithDojo,
        isChatBusy,
        handleChatBusyChange,
        handleStopChatGeneration,
        handleCopy,
        handleTitleSave,
        handleActionItemSave,
        handleKeyPointSave,
        handleRegenerateSummary,
        handleFollowUpEmail,
        summaryMutation,
        queryClient,
        meetingKey,
    } = useMeetingDetails(initialMeeting);
    // Clears the ask bar (which owns its own text) when the chat closes.
    const [askResetSignal, setAskResetSignal] = useState(0);

    // Fires once per mount, independent of activeTab — matches "no matter
    // of what tab is selected" in the spec. Re-fires if the user backs out
    // and opens a different meeting, since that's a genuinely new view.
    useEffect(() => {
        posthogAnalytics.trackPageView(viewContext === 'ae_review' ? 'ae_meeting_details' : 'meeting_details');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialMeeting?.id]);

    // The Ask Dojo tab renders Q&A oldest-first, so landing at the top of the
    // page shows the oldest exchange. Jump to the bottom of the page scroller
    // whenever the tab is showing loaded history — instant (not smooth) since
    // the history can be long. Skipped when there's no history so the empty
    // state doesn't cause a pointless page jump.
    const askDojoEndRef = useRef<HTMLDivElement>(null);
    const askDojoScrollRef = useRef<HTMLElement>(null);

    // The title row + tab row stay pinned to the top of the scroll pane. Anything else
    // that sticks (the Speaking Balance card) needs to sit BELOW it, so measure its
    // height; `isStuck` adds a divider under the pinned block once content scrolls beneath it.
    const stickyHeaderRef = useRef<HTMLDivElement>(null);
    const [stickyHeaderH, setStickyHeaderH] = useState(0);
    const [isStuck, setIsStuck] = useState(false);
    // "Back to top" button: appears once the pane has scrolled a little way down and
    // disappears again at the top. Same pane (and listener) for every tab.
    const SCROLL_TOP_THRESHOLD_PX = 240;
    const [showScrollTop, setShowScrollTop] = useState(false);
    const handleScrollToTop = () =>
        askDojoScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    useEffect(() => {
        const el = stickyHeaderRef.current;
        if (!el) return;
        const measure = () => setStickyHeaderH(el.offsetHeight);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    useEffect(() => {
        const scroller = askDojoScrollRef.current;
        if (!scroller) return;
        const onScroll = () => {
            setIsStuck(scroller.scrollTop > 0);
            setShowScrollTop(scroller.scrollTop > SCROLL_TOP_THRESHOLD_PX);
        };
        onScroll();
        scroller.addEventListener('scroll', onScroll, { passive: true });
        return () => scroller.removeEventListener('scroll', onScroll);
    }, []);
    useEffect(() => {
        if (activeTab === 'usage' && !isLoadingAskDojo && (aiInteractionsData?.items?.length ?? 0) > 0) {
            askDojoEndRef.current?.scrollIntoView({ behavior: 'auto' });
        }
        // Deliberately NOT keyed on aiInteractionsData: "Load more" refetches
        // swap the array (older Q&A prepended above) and must not yank the
        // user back down to the newest exchange.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, isLoadingAskDojo]);

    // "Load more" prepends older Q&A ABOVE the current viewport, which would
    // shift what the page scroller shows. Record the scroller position before
    // the fetch, then restore it over the same newest content once the page
    // has grown.
    const askDojoAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
    const handleAskDojoLoadMore = () => {
        const el = askDojoScrollRef.current;
        if (el) askDojoAnchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
        loadMoreAiInteractions();
    };
    useEffect(() => {
        const anchor = askDojoAnchorRef.current;
        const el = askDojoScrollRef.current;
        if (!anchor || !el) return;
        el.scrollTop = anchor.scrollTop + Math.max(0, el.scrollHeight - anchor.scrollHeight);
        askDojoAnchorRef.current = null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [aiInteractionsData]);

    // Regenerate is triggered from three separate buttons in this file (tab
    // bar + two empty-state variants) — wrap once here so all three fire the
    // same tracked call instead of instrumenting each onClick separately.
    const handleRegenerateSummaryTracked = () => {
        posthogAnalytics.trackSummaryRegenerate();
        handleRegenerateSummary();
    };

    const TAB_TRACKERS: Record<'summary' | 'transcript' | 'usage' | 'analysis', (() => void) | null> = {
        summary: null,
        transcript: () => posthogAnalytics.trackTranscriptTabView(),
        usage: () => posthogAnalytics.trackAskDojoTabView(),
        analysis: () => posthogAnalytics.trackCallAnalysisTabView(),
    };

    return (
        <div className={`relative h-full w-full flex flex-col font-sans overflow-hidden ${isLight ? 'bg-[#f0f2f8] text-slate-700' : 'bg-[#0a0c14] text-slate-300'}`}>

            {/* Main Content */}
            <main ref={askDojoScrollRef} className="flex-1 overflow-y-auto custom-scrollbar">
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1, duration: 0.3 }}
                    // Full-width header: the meta row and tab bar span the whole
                    // pane (only padded, not centered); the tab content below
                    // is full width as well.
                    className="px-8 pb-8"
                >
                    {/* Header — full-bleed bar with a divider underneath.
                        Row layout: 2 columns, [date / title / company / duration] on the
                        left, [follow-up email / export] pinned to the end on the right. */}
                    <div
                        ref={stickyHeaderRef}
                        // Pinned: title row + tab row. Opaque so content scrolls cleanly beneath it;
                        // z-30 keeps it under the modals/chat overlay (z-50) but above page content.
                        className={`sticky top-0 z-30 -mx-8 px-8 pt-6 pb-4 mb-4 border-b transition-colors ${isLight ? 'bg-[#f0f2f8]' : 'bg-[#0a0c14]'} ${isStuck ? (isLight ? 'border-slate-200' : 'border-border-subtle') : 'border-transparent'}`}
                    >
                        <header className={`-mx-8 px-8 pb-5 mb-5 border-b ${isLight ? 'border-slate-200' : 'border-border-subtle'}`}>
                            <div className="flex items-center justify-between gap-4">
                                {/* Left column */}
                                <div className="flex items-center gap-3 min-w-0">
                                    {/* Date */}
                                    <span className={`shrink-0 text-[13px] font-medium ${isLight ? 'text-slate-500' : 'text-text-tertiary'}`}>
                                        {new Date(meeting.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                    </span>
                                    <span aria-hidden className={`shrink-0 ${isLight ? 'text-slate-300' : 'text-white/20'}`}>/</span>

                                    {/* Title — sized to its text (not flex-1) so the company and
                                duration chips sit right beside it; it truncates first when
                                the row runs out of room. */}
                                    <h1 className="min-w-0">
                                        <EditableTextBlock
                                            initialValue={meeting.title}
                                            onSave={handleTitleSave}
                                            tagName="h1"
                                            className={`text-[18px] font-semibold tracking-tight truncate -ml-2 px-2 py-1 rounded-md transition-colors ${isLight ? 'text-slate-900' : 'text-white'}`}
                                            multiline={false}
                                        />
                                    </h1>

                                    {/* Customer company chip — click to change/remove. The
                                association lives on the backend; AI context for this
                                meeting resolves through it. */}
                                    {meeting.company ? (
                                        <button
                                            onClick={() => setIsCompanyModalOpen(true)}
                                            className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors ${isLight
                                                ? 'bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100'
                                                : 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20'
                                                }`}
                                        >
                                            <Building2 size={11} />
                                            {meeting.company.name}
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => setIsCompanyModalOpen(true)}
                                            className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-medium border border-dashed transition-colors ${isLight
                                                ? 'border-slate-300 text-slate-400 hover:text-slate-600 hover:border-slate-400'
                                                : 'border-border-subtle text-text-tertiary hover:text-text-secondary'
                                                }`}
                                        >
                                            <Plus size={10} />
                                            Add company
                                        </button>
                                    )}
                                    {meeting.duration && meeting.duration !== '—' && (
                                        <span className={`shrink-0 px-2.5 py-1 rounded-full text-[11.5px] font-medium tabular-nums ${isLight ? 'bg-slate-100 text-slate-500' : 'bg-white/[0.05] text-text-tertiary'}`}>
                                            {formatDurationHuman(meeting.duration, meeting.durationMs)}
                                        </span>
                                    )}
                                </div>

                                {/* Right column — pinned to the end */}
                                <div className="shrink-0 flex items-center gap-2">
                                    {/* Follow-up email — bordered pill button */}
                                    <button
                                        onClick={() => {
                                            posthogAnalytics.trackFollowUpMail();
                                            handleFollowUpEmail();
                                        }}
                                        disabled={isRegenerating || isProcessing}
                                        className={`
                                    shrink-0 flex items-center gap-2.5 px-5 py-2.5 rounded-lg text-[15px] font-medium
                                    transition-all duration-200 active:scale-[0.97]
                                    ${isRegenerating || isProcessing ? 'opacity-40 cursor-not-allowed' : ''}
                                    ${isLight
                                                ? 'bg-white border border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50 shadow-sm'
                                                : 'bg-slate-700/30 border border-slate-700/10 text-white/80 hover:bg-slate-700/40 hover:border-slate-500/40'
                                            }
                                `}
                                    >
                                        <Mail size={13} strokeWidth={1.8} />
                                        Follow-up email
                                    </button>

                                    {/* Export as PDF — same action as the meetings-row
                                export, as an icon-only button. */}
                                    <button
                                        onClick={() => generateMeetingPDF(meeting)}
                                        title="Export as PDF"
                                        aria-label="Export as PDF"
                                        className={`
                                    shrink-0 flex items-center justify-center w-[46px] h-[46px] rounded-lg
                                    transition-all duration-200 active:scale-[0.97]
                                    ${isLight
                                                ? 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 shadow-sm'
                                                : 'bg-slate-700/30 border border-slate-700/10 text-white/80 hover:bg-slate-700/40 hover:border-slate-500/40'
                                            }
                                `}
                                    >
                                        <Download size={16} strokeWidth={1.8} />
                                    </button>
                                </div>
                            </div>

                        </header>

                        {/* Tabs + Action buttons row — same 2-column shape as the header:
                        tabs on the left, regenerate / copy pinned to the end. */}
                        <div className="flex items-center justify-between gap-4">

                            {/* Left column: tab pill container */}
                            <div className={`p-1.5 rounded-xl inline-flex items-center gap-1 ${isLight ? 'bg-slate-100 border border-slate-200' : 'bg-slate-700/20 border border-border-subtle'}`}>
                                {(['summary', 'transcript', 'usage', 'analysis'] as const).map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => {
                                            TAB_TRACKERS[tab]?.();
                                            setActiveTab(tab);
                                        }}
                                        className={`
                                        relative px-5 py-2.5 text-[15px] font-medium rounded-lg transition-all duration-200 z-10
                                        ${activeTab === tab
                                                ? isLight ? 'text-slate-900' : 'text-white'
                                                : isLight ? 'text-slate-500 hover:text-slate-700' : 'text-text-tertiary hover:text-text-primary'
                                            }
                                    `}
                                    >
                                        {activeTab === tab && (
                                            <motion.div
                                                layoutId="activeTabBg"
                                                className={`absolute inset-0 rounded-lg -z-10 shadow-sm ${isLight ? 'bg-white shadow-slate-200/80' : 'bg-bg-card'}`}
                                                initial={false}
                                                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                                            />
                                        )}
                                        {tab === 'summary' ? 'Coach' : tab === 'analysis' ? 'Call Analysis' : tab === 'usage' ? 'Ask Dojo' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                                    </button>
                                ))}
                            </div>

                            {/* Right column: action buttons */}
                            <div className="shrink-0 flex items-center gap-2">

                                {/* DEV-ONLY: LLM token usage behind the latest
                                    summary generation/regeneration (hover for
                                    details). Renders nothing in production. */}
                                <LLMUsageChip
                                    meetingId={meeting.id}
                                    kinds={['summary_initial', 'summary_regenerate']}
                                    isLight={isLight}
                                />

                                {/* Regenerate */}
                                <button
                                    onClick={handleRegenerateSummaryTracked}
                                    disabled={!canRegenerate}
                                    title={canRegenerate ? 'Regenerate summary' : 'Wait for analysis to complete first'}
                                    className={`
                                    flex items-center gap-2.5 px-5 py-2.5 rounded-lg text-[15px] font-medium
                                    transition-all duration-200 active:scale-[0.97]
                                    ${!canRegenerate ? 'opacity-40 cursor-not-allowed' : ''}
                                    ${isLight
                                            ? 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 shadow-sm'
                                            : 'bg-slate-700/30 border border-slate-700/10 text-white/70 hover:bg-slate-700/40 hover:border-slate-500/40'
                                        }
                                `}
                                >
                                    <RefreshCcw size={15} strokeWidth={1.8} className={isRegenerating ? 'animate-spin' : ''} />
                                    {isRegenerating ? 'Regenerating...' : 'Regenerate'}
                                </button>

                                {regenError && (
                                    <span className="text-[11px] text-red-400 mx-1">{regenError}</span>
                                )}

                                {/* Copy prep sheet — primary action */}
                                <button
                                    onClick={handleCopy}
                                    className={`
                                    flex items-center gap-2.5 px-5 py-2.5 rounded-lg text-[15px] font-medium text-white
                                    transition-all duration-200 active:scale-[0.97]
                                    ${isLight
                                            ? 'bg-blue-600 hover:bg-blue-700 shadow-sm'
                                            : 'bg-blue-600 hover:bg-blue-500'
                                        }
                                `}
                                >
                                    {isCopied
                                        ? <Check size={15} strokeWidth={2} className="text-emerald-300" />
                                        : <Copy size={15} strokeWidth={1.8} />
                                    }
                                    {isCopied
                                        ? 'Copied!'
                                        : activeTab === 'summary' ? 'Copy prep sheet'
                                            : activeTab === 'transcript' ? 'Copy transcript'
                                                : 'Copy'
                                    }
                                </button>

                            </div>
                        </div>

                    </div>

                    {/* Modals live outside the sticky block so their z-index isn't trapped in it */}
                    <FollowUpEmailModal
                        isOpen={isFollowUpEmailOpen}
                        onClose={() => setIsFollowUpEmailOpen(false)}
                        meeting={meeting}
                        isLight={isLight}
                    />

                    <AnimatePresence>
                        {isCompanyModalOpen && (
                            <CompanySelectModal
                                key="company-modal"
                                meetingId={meeting.id}
                                mode="edit"
                                initialCompany={meeting.company ?? null}
                                // get_meeting populates company_candidates
                                // whenever the event spans 2+ external
                                // attendee domains — the backend
                                // deliberately doesn't pick for the user.
                                // The post-call prompt rendered these; the
                                // edit chip never did, so a multi-domain
                                // meeting made you type a name the backend
                                // had already worked out.
                                candidates={meeting.company_candidates ?? undefined}
                                isLight={isLight}
                                onClose={() => setIsCompanyModalOpen(false)}
                                // One helper for all three surfaces so the
                                // detail cache, the company poll and the
                                // launcher list can't drift apart. The old
                                // version never touched ['meetings'], so
                                // the card and its search haystack
                                // (meetingSearchText reads company.name)
                                // stayed stale.
                                onSaved={(saved) => applyCompanyToCaches(queryClient, meeting.id, saved)}
                                onCleared={() => applyCompanyToCaches(queryClient, meeting.id, null)}
                            />
                        )}
                    </AnimatePresence>

                    {/* Tab Content — full width; pb-32 for floating footer clearance */}
                    <div className="w-full pb-32">
                        <div className="space-y-8">
                            {/* Using standard divs for content, framer motion for layout */}
                            {activeTab === 'summary' && (
                                <>
                                    {processingStage.stage === 'stalled' ? (
                                        /* ── Processing never finished ──
                                           Past PROCESSING_STALL_TIMEOUT_MS the run is
                                           not coming back, so stop animating a wait
                                           that has no end and offer the actual fix. */
                                        <motion.div
                                            initial={{ opacity: 0, y: 6 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            className={`flex flex-col items-center justify-center py-20 gap-5 rounded-2xl border border-dashed ${isLight ? 'border-amber-200 bg-amber-50/40' : 'border-amber-500/20 bg-amber-500/[0.04]'}`}
                                        >
                                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${isLight ? 'bg-amber-100' : 'bg-amber-500/10'}`}>
                                                <TriangleAlert size={24} strokeWidth={1.5} className={isLight ? 'text-amber-500' : 'text-amber-400/70'} />
                                            </div>
                                            <div className="text-center flex flex-col gap-1.5 max-w-[300px]">
                                                <p className={`text-[14px] font-semibold ${isLight ? 'text-slate-700' : 'text-white/60'}`}>
                                                    {processingStage.label}
                                                </p>
                                                <p className={`text-[12px] leading-relaxed ${isLight ? 'text-slate-500' : 'text-white/30'}`}>
                                                    {processingStage.detail}
                                                </p>
                                            </div>
                                            <button
                                                onClick={handleRegenerateSummaryTracked}
                                                disabled={!canRegenerate}
                                                className={`mt-1 flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium transition-all ${isLight ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 shadow-sm' : 'bg-white/[0.05] border border-white/[0.1] text-white/60 hover:bg-white/[0.08]'} disabled:opacity-40 disabled:cursor-not-allowed`}
                                            >
                                                <RefreshCcw size={12} strokeWidth={1.8} className={isRegenerating ? 'animate-spin' : ''} />
                                                {isRegenerating ? 'Regenerating…' : 'Regenerate summary'}
                                            </button>
                                        </motion.div>
                                    ) : !isSummaryReady ?
                                        <motion.div
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={{ duration: 0.3 }}
                                        >
                                            {/* Regenerating keeps its simple banner. */}
                                            {isRegenerating && (
                                                <div className="flex items-center gap-3 mb-6 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                                                    <RefreshCw size={13} className="text-blue-400 shrink-0 animate-spin" />
                                                    <p className="text-xs text-blue-400 font-medium">
                                                        Regenerating summary — this may take 15-30 seconds...
                                                    </p>
                                                </div>
                                            )}

                                            {/* Two distinct placeholders, never mixed:
                                            - still processing  -> the real background steps
                                              reported by main (own IPC channel; no GET-by-id)
                                            - already processed -> layout-matching skeleton
                                              while GET /meetings/:id is in flight */}
                                            {isProcessing && !isRegenerating ? (
                                                <PostMeetingProcessingLoader
                                                    snapshot={processingProgress}
                                                    fallbackStartedAt={new Date(initialMeeting.date).getTime()}
                                                    isLight={isLight}
                                                />
                                            ) : (
                                                <MeetingSummarySkeleton isLight={isLight} />
                                            )}
                                        </motion.div>
                                        :
                                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

                                            {/* ── No summary at all ── */}
                                            {!meeting.detailedSummary && (
                                                <div className={`flex flex-col items-center justify-center py-20 gap-4 rounded-2xl border border-dashed ${isLight ? 'border-slate-200 bg-slate-50/50' : 'border-white/[0.07] bg-white/[0.02]'}`}>
                                                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isLight ? 'bg-slate-100' : 'bg-white/[0.05]'}`}>
                                                        <NotepadText size={22} strokeWidth={1.5} className={isLight ? 'text-slate-400' : 'text-white/25'} />
                                                    </div>
                                                    <div className="text-center">
                                                        <p className={`text-[14px] font-medium mb-1 ${isLight ? 'text-slate-600' : 'text-white/50'}`}>No summary yet</p>
                                                        <p className={`text-[12px] ${isLight ? 'text-slate-400' : 'text-white/25'}`}>Summary will appear here once the meeting is processed</p>
                                                    </div>
                                                    <button
                                                        onClick={handleRegenerateSummaryTracked}
                                                        className={`mt-1 flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium transition-all ${isLight ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 shadow-sm' : 'bg-white/[0.05] border border-white/[0.1] text-white/60 hover:bg-white/[0.08]'}`}
                                                    >
                                                        <RefreshCcw size={12} strokeWidth={1.8} />
                                                        Generate summary
                                                    </button>
                                                </div>
                                            )}

                                            {/* ── Summary object exists but there is nothing to draw ──
                                            `hasGeneratedSummary` rather than `isSummaryEmpty`: a
                                            meeting whose only content is live analysis passes
                                            isSummaryEmpty (its Analysis tab does have content) yet
                                            every section below still renders nothing, which showed
                                            as a silently blank Summary tab. */}
                                            {meeting.detailedSummary && !hasGeneratedSummary(meeting.detailedSummary) && (
                                                <motion.div
                                                    initial={{ opacity: 0, y: 6 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    className={`flex flex-col items-center justify-center py-20 gap-5 rounded-2xl border border-dashed ${isLight ? 'border-slate-200 bg-slate-50/50' : 'border-white/[0.07] bg-white/[0.02]'}`}
                                                >
                                                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${isLight ? 'bg-slate-100' : 'bg-white/[0.05]'}`}>
                                                        <ClipboardList size={24} strokeWidth={1.5} className={isLight ? 'text-slate-300' : 'text-white/20'} />
                                                    </div>
                                                    <div className="text-center flex flex-col gap-1.5 max-w-[280px]">
                                                        <p className={`text-[14px] font-semibold ${isLight ? 'text-slate-600' : 'text-white/50'}`}>
                                                            Summary data is empty
                                                        </p>
                                                        <p className={`text-[12px] leading-relaxed ${isLight ? 'text-slate-400' : 'text-white/25'}`}>
                                                            The summary was generated but no content could be extracted.
                                                            This can happen with very short or silent meetings.
                                                        </p>
                                                    </div>
                                                    <button
                                                        onClick={handleRegenerateSummary}
                                                        disabled={isRegenerating}
                                                        className={`mt-1 flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium transition-all ${isLight ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 shadow-sm' : 'bg-white/[0.05] border border-white/[0.1] text-white/60 hover:bg-white/[0.08]'} disabled:opacity-40 disabled:cursor-not-allowed`}
                                                    >
                                                        <RefreshCcw size={12} strokeWidth={1.8} className={isRegenerating ? 'animate-spin' : ''} />
                                                        {isRegenerating ? 'Regenerating…' : 'Regenerate summary'}
                                                    </button>
                                                </motion.div>
                                            )}

                                            {/* Two columns like the Transcript tab: coach content on the
                                                left, sticky section navigation on the right. */}
                                            {meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && (
                                                <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,300px)]">
                                                    <div className="min-w-0">

                                                        {meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && meeting.detailedSummary?.keyPoints?.length !== 0 && <section id="coach-call-summary" className="mb-10">

                                                            {/* Card — matches the CallSummary component design */}
                                                            <div
                                                                className={`relative w-full overflow-hidden rounded-2xl border backdrop-blur-xl ${isLight
                                                                    ? 'border-slate-200/80 bg-white shadow-[0_20px_60px_-25px_rgba(30,58,138,0.18)]'
                                                                    : 'border-white/[0.06] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]'
                                                                    }`}
                                                                style={isLight ? undefined : {
                                                                    background: 'linear-gradient(180deg, rgba(20,28,48,0.85) 0%, rgba(10,15,28,0.9) 100%)',
                                                                }}
                                                            >
                                                                {/* Concentric rings decoration — right side */}
                                                                <div className="pointer-events-none absolute right-0 top-0 h-full w-[55%]">
                                                                    <svg viewBox="0 0 500 320" className="absolute right-0 top-1/2 h-[140%] w-full -translate-y-1/2" fill="none">
                                                                        <defs>
                                                                            <radialGradient id="csSummaryRingFade" cx="70%" cy="50%" r="60%">
                                                                                <stop offset="0%" stopColor={isLight ? '#3b82f6' : '#60a5fa'} stopOpacity={isLight ? '0.18' : '0.15'} />
                                                                                <stop offset="100%" stopColor={isLight ? '#3b82f6' : '#60a5fa'} stopOpacity="0" />
                                                                            </radialGradient>
                                                                        </defs>
                                                                        {[60, 100, 145, 195, 250].map((r, i) => (
                                                                            <circle
                                                                                key={r}
                                                                                cx="370" cy="160" r={r}
                                                                                stroke={isLight ? '#93c5fd' : '#1e3a8a'}
                                                                                strokeOpacity={isLight ? 0.35 - i * 0.04 : 0.5 - i * 0.07}
                                                                                strokeWidth="1"
                                                                                strokeDasharray={i % 2 === 0 ? '0' : '2 4'}
                                                                            />
                                                                        ))}
                                                                        <circle cx="370" cy="160" r="200" fill="url(#csSummaryRingFade)" />
                                                                        {[[180, 70], [240, 40], [470, 90], [490, 230], [200, 260], [150, 180]].map(([x, y], i) => (
                                                                            <g key={i} stroke={isLight ? '#60a5fa' : '#93c5fd'} strokeWidth="1" strokeLinecap="round" opacity={isLight ? 0.5 : 0.7}>
                                                                                <line x1={x - 3} y1={y} x2={x + 3} y2={y} />
                                                                                <line x1={x} y1={y - 3} x2={x} y2={y + 3} />
                                                                            </g>
                                                                        ))}
                                                                    </svg>
                                                                </div>

                                                                {/* Top border highlight (dark only) */}
                                                                {!isLight && (
                                                                    <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
                                                                )}

                                                                <div className="relative flex items-center gap-6 p-7 sm:p-8">
                                                                    {/* Left: header + bullets */}
                                                                    <div className="relative z-10 flex-1">
                                                                        <div className="flex items-center gap-2.5">
                                                                            <ClipboardList size={20} className={isLight ? 'text-blue-500' : 'text-blue-400'} />
                                                                            <h3 className={`text-[19px] font-bold tracking-tight ${isLight ? 'text-blue-600' : 'text-blue-300'}`}>
                                                                                Call Summary
                                                                            </h3>
                                                                        </div>
                                                                        <ul className="mt-4 space-y-3">
                                                                            {meeting.detailedSummary?.keyPoints?.map((point, i) => (
                                                                                <li key={i} className={`flex items-start gap-3 text-[14.5px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                                                                                    <span
                                                                                        className={`mt-[8px] inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${isLight ? 'bg-blue-500' : 'bg-blue-400'}`}
                                                                                        style={{ boxShadow: isLight ? '0 0 6px rgba(59,130,246,0.5)' : '0 0 8px rgba(96,165,250,0.8)' }}
                                                                                    />
                                                                                    <span>{point}</span>
                                                                                </li>
                                                                            ))}
                                                                        </ul>
                                                                    </div>

                                                                    {/* Right: notepad icon */}
                                                                    <div className="relative z-10 hidden sm:flex h-[140px] w-[140px] flex-shrink-0 items-center justify-center">
                                                                        <div
                                                                            className="absolute inset-0 rounded-full blur-2xl"
                                                                            style={{ background: isLight ? 'radial-gradient(circle, rgba(59,130,246,0.10) 0%, transparent 30%)' : 'radial-gradient(circle, rgba(59,130,246,0.20) 0%, transparent 30%)' }}
                                                                        />
                                                                        <div
                                                                            className={`relative flex h-[88px] w-[78px] items-center justify-center rounded-xl border ${isLight
                                                                                ? 'border-blue-400/60 bg-gradient-to-b from-white to-blue-50'
                                                                                : 'border-blue-400/40 bg-gradient-to-b from-[#0e1a3575] to-[#0a122671]'
                                                                                }`}
                                                                        // style={{ boxShadow: isLight ? '0 8px 30px -8px rgba(59,130,246,0.4), inset 0 1px 0 rgba(255,255,255,0.8)' : '0 0 30px rgba(59,130,246,0.5), inset 0 1px 0 rgba(147,197,253,0.2)' }}
                                                                        >
                                                                            {/* Spiral binding dots */}
                                                                            <div className="absolute -top-1 left-0 right-0 flex justify-around px-3">
                                                                                {[0, 1, 2].map(i => (
                                                                                    <span key={i} className={`h-2 w-1.5 rounded-full ${isLight ? 'bg-blue-400' : 'bg-blue-300'}`} />
                                                                                ))}
                                                                            </div>
                                                                            <NotebookPen
                                                                                size={36}
                                                                                strokeWidth={1.8}
                                                                                className={isLight ? 'text-blue-400' : 'text-blue-300'}
                                                                            // style={{ filter: isLight ? 'drop-shadow(0 0 4px rgba(59,130,246,0.4))' : 'drop-shadow(0 0 8px rgba(96,165,250,0.9))' }}
                                                                            />
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </section>}

                                                        {/* ── Follow up on the demo — demo reactions/loops/criteria (demo or mixed-with-demo calls) ── */}
                                                        {meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && (
                                                            <HowDemoLanded
                                                                summary={meeting.detailedSummary}
                                                                meetingTypes={meeting.meetingTypes}
                                                                scorecardDetectedTypes={scorecard?.detectedTypes}
                                                                isLight={isLight}
                                                            />
                                                        )}

                                                        {/* ── Move the deal to signature — negotiation panel (negotiation or mixed-with-negotiation calls) ── */}
                                                        {meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && (
                                                            <WhereTermsStand
                                                                summary={meeting.detailedSummary}
                                                                meetingTypes={meeting.meetingTypes}
                                                                scorecardDetectedTypes={scorecard?.detectedTypes}
                                                                isLight={isLight}
                                                            />
                                                        )}

                                                        {/* ── Game Plan — call-type-aware next-call coaching ── */}
                                                        {meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && (
                                                            <GamePlan
                                                                summary={meeting.detailedSummary}
                                                                date={meeting.date}
                                                                participants={meeting.participants}
                                                                isLight={isLight}
                                                                onPractice={handlePracticeWithDojo}
                                                            />
                                                        )}

                                                        {/* ── Coach's Notes — what worked / what to try next ── */}
                                                        {meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && (
                                                            <CoachNotes summary={meeting.detailedSummary} isLight={isLight} />
                                                        )}

                                                        {/* ── Detail Analysis accordion ── */}
                                                        {/* {scorecard && meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && (
                                            <div className='mb-7'>

                                                <DetailAnalysisAccordion
                                                    scorecard={scorecard}
                                                    isLight={isLight}
                                                />
                                            </div>
                                        )} */}

                                                        {meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && meeting.detailedSummary?.salesCoachReview === undefined && (
                                                            <>
                                                                <section className="mb-10">

                                                                    <div className="space-y-3">
                                                                        {/* Action Items - Only show if there are items */}
                                                                        {meeting.detailedSummary?.actionItems && meeting.detailedSummary.actionItems.length > 0 && (
                                                                            <section id="coach-action-items" className="mb-8">
                                                                                <div className="flex items-center justify-between mb-4">
                                                                                    <EditableTextBlock
                                                                                        initialValue={meeting.detailedSummary?.actionItemsTitle || 'Action Items'}
                                                                                        onSave={(val) => summaryMutation.mutate({ actionItemsTitle: val })}
                                                                                        tagName="h2"
                                                                                        className="text-lg font-semibold text-text-primary -ml-2 px-2 py-1 rounded-sm transition-colors"
                                                                                        multiline={false}
                                                                                    />
                                                                                </div>
                                                                                <ul className="space-y-3">
                                                                                    {meeting.detailedSummary.actionItems.map((item, i) => (
                                                                                        <li key={i} className="flex items-start gap-3 group">
                                                                                            <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-red-500 transition-colors shrink-0" />
                                                                                            <div className="flex-1">
                                                                                                <EditableTextBlock
                                                                                                    initialValue={item}
                                                                                                    onSave={(val) => handleActionItemSave(i, val)}
                                                                                                    tagName="p"
                                                                                                    className="text-sm text-text-secondary leading-relaxed -ml-2 px-2 rounded-sm transition-colors"
                                                                                                    placeholder="Type an action item..."
                                                                                                    onEnter={() => {
                                                                                                        const newItems = [...(meeting.detailedSummary?.actionItems || [])];
                                                                                                        newItems.splice(i + 1, 0, "");
                                                                                                        queryClient.setQueryData<Meeting>(meetingKey, (m = meeting) => ({
                                                                                                            ...m,
                                                                                                            detailedSummary: { keyPoints: [], ...(m.detailedSummary ?? {}), actionItems: newItems }
                                                                                                        }));
                                                                                                    }}
                                                                                                />
                                                                                            </div>
                                                                                        </li>
                                                                                    ))}
                                                                                </ul>
                                                                            </section>
                                                                        )}

                                                                        {/* Key Points - Only show if there are items */}
                                                                        {meeting.detailedSummary?.keyPoints && meeting.detailedSummary.keyPoints.length > 0 && (
                                                                            <section id="coach-key-points">
                                                                                <div
                                                                                    className={`relative w-full overflow-hidden rounded-2xl border backdrop-blur-xl ${isLight
                                                                                        ? 'border-slate-200/80 bg-white shadow-[0_20px_60px_-25px_rgba(30,58,138,0.18)]'
                                                                                        : 'border-white/[0.06] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]'
                                                                                        }`}
                                                                                    style={isLight ? undefined : {
                                                                                        background: 'linear-gradient(180deg, rgba(20,28,48,0.85) 0%, rgba(10,15,28,0.9) 100%)',
                                                                                    }}
                                                                                >
                                                                                    {/* Concentric rings */}
                                                                                    <div className="pointer-events-none absolute right-0 top-0 h-full w-[55%]">
                                                                                        <svg viewBox="0 0 500 320" className="absolute right-0 top-1/2 h-[140%] w-full -translate-y-1/2" fill="none">
                                                                                            <defs>
                                                                                                <radialGradient id="csKeyRingFade" cx="70%" cy="50%" r="60%">
                                                                                                    <stop offset="0%" stopColor={isLight ? '#3b82f6' : '#60a5fa'} stopOpacity={isLight ? '0.18' : '0.35'} />
                                                                                                    <stop offset="100%" stopColor={isLight ? '#3b82f6' : '#60a5fa'} stopOpacity="0" />
                                                                                                </radialGradient>
                                                                                            </defs>
                                                                                            {[60, 100, 145, 195, 250].map((r, i) => (
                                                                                                <circle key={r} cx="370" cy="160" r={r}
                                                                                                    stroke={isLight ? '#93c5fd' : '#1e3a8a'}
                                                                                                    strokeOpacity={isLight ? 0.35 - i * 0.04 : 0.5 - i * 0.07}
                                                                                                    strokeWidth="1"
                                                                                                    strokeDasharray={i % 2 === 0 ? '0' : '2 4'}
                                                                                                />
                                                                                            ))}
                                                                                            <circle cx="370" cy="160" r="200" fill="url(#csKeyRingFade)" />
                                                                                            {[[180, 70], [240, 40], [470, 90], [490, 230], [200, 260], [150, 180]].map(([x, y], i) => (
                                                                                                <g key={i} stroke={isLight ? '#60a5fa' : '#93c5fd'} strokeWidth="1" strokeLinecap="round" opacity={isLight ? 0.5 : 0.7}>
                                                                                                    <line x1={x - 3} y1={y} x2={x + 3} y2={y} />
                                                                                                    <line x1={x} y1={y - 3} x2={x} y2={y + 3} />
                                                                                                </g>
                                                                                            ))}
                                                                                        </svg>
                                                                                    </div>

                                                                                    {!isLight && (
                                                                                        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
                                                                                    )}

                                                                                    <div className="relative flex items-center gap-6 p-7">
                                                                                        <div className="relative z-10 flex-1">
                                                                                            <div className="flex items-center gap-2.5">
                                                                                                <ClipboardList size={18} className={isLight ? 'text-blue-600' : 'text-blue-400'} />
                                                                                                <EditableTextBlock
                                                                                                    initialValue={meeting.detailedSummary?.keyPointsTitle || 'Key Points'}
                                                                                                    onSave={(val) => summaryMutation.mutate({ keyPointsTitle: val })}
                                                                                                    tagName="h3"
                                                                                                    className={`text-[15px] font-semibold tracking-tight -ml-1 px-1 rounded-sm transition-colors ${isLight ? 'text-blue-700' : 'text-blue-300'}`}
                                                                                                    multiline={false}
                                                                                                />
                                                                                            </div>
                                                                                            <ul className="mt-4 space-y-2.5">
                                                                                                {meeting.detailedSummary.keyPoints.map((item, i) => (
                                                                                                    <li key={i} className={`flex items-start gap-2.5 text-[13.5px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                                                                                                        <span
                                                                                                            className={`mt-[7px] inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${isLight ? 'bg-blue-500' : 'bg-blue-400'}`}
                                                                                                            style={{ boxShadow: isLight ? '0 0 6px rgba(59,130,246,0.5)' : '0 0 8px rgba(96,165,250,0.8)' }}
                                                                                                        />
                                                                                                        <div className="flex-1">
                                                                                                            <EditableTextBlock
                                                                                                                initialValue={item}
                                                                                                                onSave={(val) => handleKeyPointSave(i, val)}
                                                                                                                tagName="p"
                                                                                                                className={`text-[13.5px] leading-relaxed -ml-2 px-2 rounded-sm transition-colors ${isLight ? 'text-slate-700' : 'text-slate-300'}`}
                                                                                                                placeholder="Type a key point..."
                                                                                                                onEnter={() => {
                                                                                                                    const newItems = [...(meeting.detailedSummary?.keyPoints || [])];
                                                                                                                    newItems.splice(i + 1, 0, "");
                                                                                                                    queryClient.setQueryData<Meeting>(meetingKey, (m = meeting) => ({
                                                                                                                        ...m,
                                                                                                                        detailedSummary: { actionItems: [], ...(m.detailedSummary ?? {}), keyPoints: newItems }
                                                                                                                    }));
                                                                                                                }}
                                                                                                            />
                                                                                                        </div>
                                                                                                    </li>
                                                                                                ))}
                                                                                            </ul>
                                                                                        </div>

                                                                                        {/* Right: notepad icon */}
                                                                                        <div className="relative z-10 hidden sm:flex h-[140px] w-[140px] flex-shrink-0 items-center justify-center">
                                                                                            <div
                                                                                                className="absolute inset-0 rounded-full blur-2xl"
                                                                                                style={{ background: isLight ? 'radial-gradient(circle, rgba(59,130,246,0.25) 0%, transparent 70%)' : 'radial-gradient(circle, rgba(59,130,246,0.45) 0%, transparent 70%)' }}
                                                                                            />
                                                                                            <div
                                                                                                className={`relative flex h-[88px] w-[78px] items-center justify-center rounded-xl border ${isLight ? 'border-blue-400/60 bg-gradient-to-b from-white to-blue-50' : 'border-blue-400/40 bg-gradient-to-b from-[#0e1a35] to-[#0a1226]'}`}
                                                                                                style={{ boxShadow: isLight ? '0 8px 30px -8px rgba(59,130,246,0.4), inset 0 1px 0 rgba(255,255,255,0.8)' : '0 0 30px rgba(59,130,246,0.5), inset 0 1px 0 rgba(147,197,253,0.2)' }}
                                                                                            >
                                                                                                <div className="absolute -top-1 left-0 right-0 flex justify-around px-3">
                                                                                                    {[0, 1, 2].map(i => (
                                                                                                        <span key={i} className={`h-2 w-1.5 rounded-full ${isLight ? 'bg-blue-400' : 'bg-blue-300'}`} />
                                                                                                    ))}
                                                                                                </div>
                                                                                                <NotebookPen
                                                                                                    size={36} strokeWidth={1.8}
                                                                                                    className={isLight ? 'text-blue-600' : 'text-blue-300'}
                                                                                                    style={{ filter: isLight ? 'drop-shadow(0 0 4px rgba(59,130,246,0.4))' : 'drop-shadow(0 0 8px rgba(96,165,250,0.9))' }}
                                                                                                />
                                                                                            </div>
                                                                                        </div>
                                                                                    </div>
                                                                                </div>
                                                                            </section>
                                                                        )}
                                                                    </div>
                                                                </section>
                                                            </>

                                                        )}

                                                    </div>
                                                    <CoachSectionNav isLight={isLight} stickyTop={stickyHeaderH} meeting={meeting} />
                                                </div>
                                            )}

                                        </motion.div>
                                    }

                                </>
                            )}

                            {activeTab === 'transcript' && (
                                <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                    {/* Local-first: don't gate this on isLoadingMeetingDetail (the
                                    backend HTTP fetch) or isProcessing (summary generation) —
                                    the transcript is written to local SQLite synchronously the
                                    moment the meeting ends, well before either of those finish.
                                    isLoadingTranscript reflects that local-first source directly,
                                    so this tab shows content the instant it's actually available. */}
                                    {isLoadingTranscript ? (
                                        <div className="space-y-3">
                                            <Skeleton className="h-8 w-40 mb-4" />
                                            {Array.from({ length: 6 }).map((_, i) => (
                                                <Skeleton key={i} className={`h-14 w-full ${i % 2 === 0 ? 'mr-24' : 'ml-24'}`} />
                                            ))}
                                        </div>
                                    ) : (
                                        <>
                                            {/* Two columns: transcript on the left, Speaking Balance pinned on the right. */}
                                            <div className={meeting.transcript && meeting.transcript.length > 0
                                                ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(380px,32%)] gap-6 items-start'
                                                : ''}>
                                                <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                                    <div className="space-y-6">
                                                        {(() => {
                                                            const filteredTranscript = meeting.transcript?.filter(entry => {
                                                                // (No console.log here: this runs on every render of the page.)
                                                                return !['system', 'ai', 'assistant', 'model'].includes(entry.speaker?.toLowerCase());
                                                            }) || [];

                                                            if (filteredTranscript.length === 0) {
                                                                return (
                                                                    <div className={`flex flex-col items-center justify-center py-16 gap-4 rounded-2xl border border-dashed ${isLight ? 'border-slate-200 bg-slate-50/50' : 'border-white/[0.07] bg-white/[0.02]'}`}>
                                                                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isLight ? 'bg-slate-100' : 'bg-white/[0.05]'}`}>
                                                                            <MessageSquare size={22} strokeWidth={1.5} className={isLight ? 'text-slate-400' : 'text-white/25'} />
                                                                        </div>
                                                                        <div className="text-center">
                                                                            <p className={`text-[14px] font-medium mb-1 ${isLight ? 'text-slate-600' : 'text-white/50'}`}>No transcript recorded</p>
                                                                            <p className={`text-[12px] ${isLight ? 'text-slate-400' : 'text-white/25'}`}>Transcription will appear here during a live meeting</p>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            }

                                                            return filteredTranscript.map((entry, i) => (
                                                                <div key={i} className="group">

                                                                    <div className="flex items-center gap-2 mb-1">
                                                                        <span className={`text-xs font-semibold text-white ${entry.speaker === 'user'
                                                                            ? 'bg-blue-600'
                                                                            : isLight ? 'bg-slate-400' : 'bg-blue-500/30'
                                                                            } px-2 py-1 rounded-full truncate max-w-[180px]`}>
                                                                            {getSpeakerDisplayName(
                                                                                entry.speaker,
                                                                                entry.displayName,
                                                                                entry.speakerIndex
                                                                            )}
                                                                        </span>
                                                                        <span className="text-xs text-text-tertiary font-mono">{entry.timestamp ? formatTranscriptTimestamp(entry.timestamp, transcriptTimesAreRelative) : '0:00'}</span>
                                                                    </div>
                                                                    <p className="text-text-secondary text-[15px] leading-relaxed transition-colors select-text cursor-text whitespace-pre-line">{entry.text}</p>


                                                                </div>
                                                            ));

                                                        })()}
                                                    </div>
                                                </motion.section>

                                                {meeting.transcript && meeting.transcript.length > 0 && (
                                                    <aside
                                                        aria-label="Speaking balance"
                                                        // Sticks to the top of the scroll pane while the transcript scrolls
                                                        // past; on narrow panes it sits above the transcript.
                                                        style={{ top: stickyHeaderH + 16, maxHeight: `calc(100vh - ${stickyHeaderH + 32}px)` }}
                                                        className={`max-lg:order-first lg:sticky overflow-y-auto custom-scrollbar rounded-2xl border ${isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-gray-800/10'}`}
                                                    >
                                                        <div className="flex items-center gap-3 px-5 py-4">
                                                            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${isLight ? 'bg-slate-100' : 'bg-gray-800'}`}>
                                                                <BarChart3 className={`h-4 w-4 ${isLight ? 'text-slate-500' : 'text-white/70'}`} />
                                                            </div>
                                                            <div className="min-w-0 text-left">
                                                                <h3 className={`text-sm font-semibold ${isLight ? 'text-slate-700' : 'text-white/90'}`}>
                                                                    Speaking Balance
                                                                </h3>
                                                                <p className={`text-xs ${isLight ? 'text-slate-400' : 'text-white/40'}`}>
                                                                    Conversation analytics
                                                                </p>
                                                            </div>
                                                        </div>

                                                        <div className={`border-t px-5 py-5 ${isLight ? 'border-slate-200' : 'border-white/10'}`}>
                                                            {talkTime.speakers.map((speakerEntry, i) => {
                                                                const name = getSpeakerDisplayName(
                                                                    speakerEntry.speaker,
                                                                    speakerEntry.displayName,
                                                                    speakerEntry.speakerIndex
                                                                );
                                                                return (
                                                                    <div
                                                                        key={`${speakerEntry.speaker}-${speakerEntry.displayName ?? '∅'}-${speakerEntry.speakerIndex ?? '∅'}`}
                                                                        className={i === talkTime.speakers.length - 1 ? '' : 'mb-5'}
                                                                    >
                                                                        {/* Name can be long: it takes the remaining width and truncates
                                                                    (full name on hover); the percentage never gets pushed out. */}
                                                                        <div className="mb-0.5 flex items-baseline justify-between gap-3">
                                                                            <span
                                                                                title={name}
                                                                                className={`min-w-0 flex-1 truncate text-sm ${isLight ? 'text-slate-700' : 'text-white/80'}`}
                                                                            >
                                                                                {name}
                                                                            </span>
                                                                            <span className={`shrink-0 text-sm font-medium tabular-nums ${isLight ? 'text-slate-800' : 'text-white'}`}>
                                                                                {speakerEntry.percent}%
                                                                            </span>
                                                                        </div>
                                                                        <div className={`mb-2 text-xs ${isLight ? 'text-slate-400' : 'text-white/40'}`}>
                                                                            {speakerEntry.words.toLocaleString()} words spoken
                                                                        </div>

                                                                        <div className={`h-1 overflow-hidden rounded-full ${isLight ? 'bg-slate-200' : 'bg-white/10'}`}>
                                                                            <div
                                                                                className={`h-full rounded-full transition-all duration-500 ${speakerEntry.speaker === 'user'
                                                                                    ? 'bg-blue-500'
                                                                                    : isLight ? 'bg-slate-400' : 'bg-blue-500/30'
                                                                                    }`}
                                                                                style={{ width: `${speakerEntry.percent}%` }}
                                                                            />
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}

                                                            {talkTime.speakers.length === 0 && (
                                                                <p className={`text-xs ${isLight ? 'text-slate-400' : 'text-white/40'}`}>
                                                                    No speaker data recorded for this meeting yet.
                                                                </p>
                                                            )}

                                                            <div className={`mt-5 border-t pt-4 ${isLight ? 'border-slate-100' : 'border-white/5'}`}>
                                                                <p className={`text-xs leading-relaxed ${isLight ? 'text-slate-400' : 'text-white/40'}`}>
                                                                    Speaking balance helps understand participation and engagement during the meeting.
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </aside>
                                                )}
                                            </div>
                                        </>)}
                                </motion.section>
                            )}

                            {activeTab === 'usage' && (
                                <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-8 pb-10">
                                    {isLoadingAskDojo ? (
                                        Array.from({ length: 3 }).map((_, i) => (
                                            <div key={i} className="space-y-3">
                                                <Skeleton className="h-10 w-2/3" />
                                                <Skeleton className="h-24 w-full" />
                                            </div>
                                        ))
                                    ) : (
                                        <>
                                            {/* Older Q&A pages in — above the newest exchange the
                                        tab auto-scrolls to, hence ChevronUp. Kept visible
                                        while loading (hasMore || isLoadingMore) so it doesn't
                                        flicker out and back between click and refetch. */}
                                            {(hasMoreAiInteractions || isLoadingMoreAiInteractions) && (aiInteractionsData?.items?.length ?? 0) > 0 && (
                                                <div className="flex justify-center">
                                                    <button
                                                        type="button"
                                                        onClick={handleAskDojoLoadMore}
                                                        disabled={isLoadingMoreAiInteractions}
                                                        className={[
                                                            'flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium shadow-lg',
                                                            'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                                                            isLight
                                                                ? 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 shadow-slate-900/10'
                                                                : 'bg-gray-800 text-white/90 border border-white/10 hover:bg-gray-700 shadow-black/40',
                                                        ].join(' ')}
                                                    >
                                                        {isLoadingMoreAiInteractions
                                                            ? <RefreshCw size={14} className="animate-spin" />
                                                            : <ChevronUp size={14} />}
                                                        {isLoadingMoreAiInteractions ? 'Loading…' : 'Load more'}
                                                    </button>
                                                </div>
                                            )}
                                            {(aiInteractionsData?.items ?? []).map((interaction) => (
                                                <div key={interaction.id} className="space-y-4">
                                                    {/* User Question */}
                                                    {interaction.user_query && (
                                                        <div className="flex justify-end">
                                                            <div className="bg-accent-primary text-white px-5 py-2.5 rounded-2xl rounded-tr-sm max-w-[80%] text-[15px] leading-relaxed shadow-sm">
                                                                {interaction.user_query}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* AI Answer */}
                                                    {interaction.ai_response && (
                                                        <div className="flex items-start gap-4">
                                                            <div className="mt-1 w-6 h-6 rounded-full bg-bg-input flex items-center justify-center border border-border-subtle shrink-0">
                                                                <img src={IMAGES.godojoLogoIcon} alt="AI" className="w-4 h-4 opacity-50 object-contain force-black-icon" />
                                                            </div>
                                                            {/* flex-1 min-w-0: without min-w-0 this flex item can't shrink
                                                            below its content's intrinsic width, so a wide markdown
                                                            table (which scrolls fine on its own — see the table
                                                            wrapper in markdownComponents.tsx) just expands this row
                                                            instead, pushing the whole panel into horizontal overflow. */}
                                                            <div className="flex-1 min-w-0">
                                                                <div className="text-[11px] text-text-tertiary mb-1.5 font-medium">{formatTime(interaction.timestamp)}</div>
                                                                <div className="text-text-secondary text-[15px] leading-relaxed max-w-none">
                                                                    {/* Same inline-citation design as the chat overlays:
                                                                [n] markers become hoverable chips backed by the
                                                                source_map persisted with each interaction. */}
                                                                    <CitationProvider map={indexSourceMap(interaction.source_map ?? [])}>
                                                                        <ReactMarkdown
                                                                            remarkPlugins={[remarkGfm]}
                                                                            rehypePlugins={[rehypeCitations]}
                                                                            components={{
                                                                                ...chatMarkdownComponents,
                                                                                cite: CiteChip as any,
                                                                                // Ask Dojo tab keeps headings/paragraphs down to plain
                                                                                // body copy (no bold/large text) unlike the chat overlays.
                                                                                h1: ({ node, ...props }: any) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                                h2: ({ node, ...props }: any) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                                h3: ({ node, ...props }: any) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                                p: ({ node, ...props }: any) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                                ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                                                                                ol: ({ node, ...props }: any) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                                                                                li: ({ node, ...props }: any) => <li className="text-[15px] text-text-secondary font-normal" {...props} />,
                                                                                strong: ({ node, ...props }: any) => <span className="font-normal text-text-secondary" {...props} />,
                                                                            }}
                                                                        >
                                                                            {cleanMarkdown(interaction.ai_response || '')}
                                                                        </ReactMarkdown>
                                                                    </CitationProvider>
                                                                </div>
                                                                {(() => {
                                                                    const docSources = docSourcesFor(interaction.sources);
                                                                    if (docSources.length === 0) return null;
                                                                    // Same "first chip + +N popover" treatment as Global Chat,
                                                                    // instead of wrapping every source into its own chip.
                                                                    return (
                                                                        <div className="mt-2">
                                                                            <SourcesDisplay sources={{ meetings: [], assets: docSources }} />
                                                                        </div>
                                                                    );
                                                                })()}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </>
                                    )}
                                    {!isLoadingAskDojo && !(aiInteractionsData?.items?.length) && (
                                        <div className={`flex flex-col items-center justify-center py-16 gap-4 rounded-2xl border border-dashed ${isLight ? 'border-slate-200 bg-slate-50/50' : 'border-white/[0.07] bg-white/[0.02]'}`}>
                                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isLight ? 'bg-slate-100' : 'bg-white/[0.05]'}`}>
                                                <MessagesSquareIcon size={22} strokeWidth={1.5} className={isLight ? 'text-slate-400' : 'text-white/25'} />
                                            </div>
                                            <div className="text-center">
                                                <p className={`text-[14px] font-medium mb-1 ${isLight ? 'text-slate-600' : 'text-white/50'}`}>No questions asked yet</p>
                                                <p className={`text-[12px] ${isLight ? 'text-slate-400' : 'text-white/25'}`}>Questions you ask Dojo about this meeting will appear here</p>
                                            </div>
                                            <div className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-[12px] ${isLight ? 'bg-blue-50 border border-blue-100 text-blue-500' : 'bg-blue-500/10 border border-blue-500/20 text-blue-400'}`}>
                                                <ArrowUp size={12} className="rotate-45" />
                                                Use the search bar below to ask anything
                                            </div>
                                        </div>
                                    )}
                                    {/* Sentinel for the auto-scroll-on-open above. */}
                                    <div ref={askDojoEndRef} />
                                </motion.section>
                            )}

                            {activeTab === 'analysis' && (
                                <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                    {/* Gated on the detail read having actually resolved, not on
                                    `isLoadingMeetingDetail` — that flag is false on the first
                                    render (initialData) and while the query is disabled during
                                    processing, which is how this tab used to claim "No live
                                    analysis captured" for a meeting that has some. */}
                                    {!isAnalysisReady ? (
                                        // Same split as the Summary tab: still processing -> the
                                        // real background steps; processed -> layout-matching
                                        // skeleton while GET /meetings/:id is in flight.
                                        isProcessing ? (
                                            <PostMeetingProcessingLoader
                                                snapshot={processingProgress}
                                                fallbackStartedAt={new Date(initialMeeting.date).getTime()}
                                                isLight={isLight}
                                            />
                                        ) : (
                                            <CallAnalysisSkeleton isLight={isLight} />
                                        )
                                    ) : meeting.detailedSummary?.liveAnalysis ? (
                                        <>
                                            {/* <div className={`rounded-2xl mb-4 overflow-hidden ${isLight ? 'transparent' : 'bg-[#0d0d0f]'}`}>
                                            <DealHealthScore analysisData={meeting.detailedSummary.liveAnalysis} calledFromAnalysisTab={true} />
                                        </div> */}
                                            <CallAnalysisPanel
                                                analysisData={meeting.detailedSummary.liveAnalysis}
                                                isLight={isLight}
                                                stickyTop={stickyHeaderH}
                                                meeting={meeting}
                                            />
                                        </>
                                    ) : (
                                        <div className={`flex flex-col items-center justify-center py-16 gap-4 rounded-2xl border border-dashed ${isLight ? 'border-slate-200 bg-slate-50/50' : 'border-white/[0.07] bg-white/[0.02]'}`}>
                                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isLight ? 'bg-slate-100' : 'bg-white/[0.05]'}`}>
                                                <BarChart3 size={22} strokeWidth={1.5} className={isLight ? 'text-slate-400' : 'text-white/25'} />
                                            </div>
                                            <div className="text-center">
                                                <p className={`text-[14px] font-medium mb-1 ${isLight ? 'text-slate-600' : 'text-white/50'}`}>No live analysis captured</p>
                                                <p className={`text-[12px] max-w-[260px] leading-relaxed ${isLight ? 'text-slate-400' : 'text-white/25'}`}>
                                                    Live intelligence is captured during active meetings. Start a new meeting to see BANT, MEDDIC, and signal analysis here.
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </motion.section>
                            )}
                        </div>
                    </div>
                </motion.div>
            </main>

            {/* Back-to-top — bottom right, Transcript and Ask Dojo only (the
                Coach and Call Analysis rails have their own Back to top). z-30: above
                page content and the ask-bar overlay (z-20), below the chat
                overlay and modals (z-50). */}
            <AnimatePresence>
                {showScrollTop && (activeTab === 'transcript' || activeTab === 'usage') && (
                    <motion.button
                        key="scroll-to-top"
                        type="button"
                        onClick={handleScrollToTop}
                        aria-label="Scroll to top"
                        title="Back to top"
                        // Springy pop-in with a little overshoot so the eye catches it.
                        initial={{ opacity: 0, scale: 0.5, y: 16 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.6, y: 12 }}
                        transition={{ type: 'spring', stiffness: 420, damping: 18 }}
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.93 }}
                        // Primary blue in both themes — same as the "Copy prep sheet" button.
                        className={`absolute bottom-28 right-10 z-30 flex h-12 w-12 items-center justify-center rounded-full text-white bg-blue-600 ring-4 transition-colors ${isLight
                            ? 'hover:bg-blue-700 ring-blue-500/20 shadow-[0_8px_24px_-4px_rgba(37,99,235,0.55)]'
                            : 'hover:bg-blue-500 ring-blue-400/20 shadow-[0_8px_28px_-4px_rgba(59,130,246,0.7)]'
                            }`}
                    >
                        {/* Attention ring: pulses a few times each time the button appears, then stops. */}
                        <span
                            aria-hidden
                            className="pointer-events-none absolute inset-0 rounded-full bg-blue-500/50 animate-ping"
                            style={{ animationIterationCount: 3 }}
                        />
                        <ArrowUp size={20} strokeWidth={2.5} className="relative" />
                    </motion.button>
                )}
            </AnimatePresence>

            {/* Floating Footer (Ask Bar) */}
            <div className={`absolute bottom-10 left-0 right-0 p-6 flex flex-col items-center gap-2 pointer-events-none ${isChatOpen ? 'z-50' : 'z-20'}`}>
                {/* History affordance — only shown when there's a past conversation
                    and the overlay is currently closed, so it's clear there's
                    something to go back to without needing to type first. */}
                {!isChatOpen && chatMessages.length > 0 && (
                    <button
                        onClick={() => setIsChatOpen(true)}
                        className={`pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium backdrop-blur-[24px] backdrop-saturate-[140%] transition-colors ${isLight
                            ? 'bg-white border border-slate-200 text-slate-600 hover:bg-gray-100 shadow-[0_8px_30px_rgba(0,0,0,0.08)]'
                            : 'bg-bg-secondary border border-white/20 text-white/70 hover:bg-bg-elevated shadow-[0_8px_30px_rgb(0,0,0,0.12)]'
                            }`}
                    >
                        <MessageSquare size={12} />
                        {chatMessages.length} {chatMessages.length === 1 ? 'message' : 'messages'} · View conversation
                    </button>
                )}
                <AskDojoInput
                    inputRef={meetingInputRef}
                    isLight={isLight}
                    isChatOpen={isChatOpen}
                    isChatBusy={isChatBusy}
                    onSubmit={handleSubmitQuestion}
                    onOpenChat={() => setIsChatOpen(true)}
                    onStop={handleStopChatGeneration}
                    resetSignal={askResetSignal}
                />
            </div>

            {/* Chat Overlay */}
            <MeetingChatOverlay
                isOpen={isChatOpen}
                onBusyChange={handleChatBusyChange}
                onClose={() => {
                    setIsChatOpen(false);
                    setAskResetSignal(n => n + 1);
                }}
                meetingContext={{
                    id: meeting.id,  // Required for RAG queries
                    title: meeting.title,
                    summary: meeting.detailedSummary?.overview,
                    keyPoints: meeting.detailedSummary?.keyPoints,
                    actionItems: meeting.detailedSummary?.actionItems,
                    transcript: meeting.transcript
                }}
                initialQuery={pendingQuery}
                messages={chatMessages}
                onMessagesChange={setChatMessages}
                // Ask-Dojo tab goes stale after a chat turn (P1-7). The backend
                // persists the turn in a background task right around `done`,
                // so refresh now AND once more after the write has landed —
                // an immediate-only refetch can race the insert. When the tab
                // isn't mounted this just marks it stale for its next view.
                onTurnComplete={() => {
                    const key = ['ai-interactions', meeting.id];
                    void queryClient.invalidateQueries(key);
                    window.setTimeout(() => void queryClient.invalidateQueries(key), 1500);
                }}
            />
        </div>
    )

};

export default MeetingDetails;