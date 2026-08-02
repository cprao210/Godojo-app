import React, { useEffect, useMemo, useState } from 'react';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { Mail, ChevronDown, BarChart3, ArrowUp, Copy, Check, TrendingUp, TriangleAlert, MessageSquare, MessagesSquareIcon, ChartColumnIncreasing, CircleCheck, NotepadText, RefreshCcw, RefreshCw, NotebookPen, ClipboardList } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import MeetingChatOverlay from './MeetingChatOverlay';
import EditableTextBlock from './EditableTextBlock';
import NativelyLogo from './icon.png';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import FollowUpEmailModal from './FollowUpEmailModal';
import { LiveAnalysisContent } from './LiveAnalysisContent';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { meetingsApi } from '../lib/meetingsApi';
import type { Meeting, MeetingTranscriptLine } from '../types/meeting';
import { guardSession } from '../lib/firebase';
import { DealHealthScore } from './DealHealthScore';
import { MeetingScorecardPanel } from './MeetingScoreCard';
import type { MeetingScorecardResult } from '../types/score-card';

const formatTime = (ms: number) => {
    const date = new Date(ms);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();
};

const cleanMarkdown = (content: string) => {
    if (!content) return '';
    // Ensure code blocks are on new lines to fix rendering issues
    return content.replace(/([^\n])```/g, '$1\n\n```');
};

// Meeting type is imported from ../types/meeting (shared with Launcher + meetingsApi).

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    isStreaming?: boolean;
}

interface MeetingDetailsProps { meeting: Meeting; }

// Skeleton pulse component
const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
    <div className={`animate-pulse rounded-lg ${className}`} style={{ background: 'rgba(128,128,128,0.12)' }} />
);

// ─── Check if a detailedSummary exists but has no meaningful data ──────────────
function isSummaryEmpty(ds: NonNullable<Meeting['detailedSummary']>): boolean {
    const hasContent = (arr?: string[]) => Array.isArray(arr) && arr.some(s => s?.trim());
    // A meeting with live analysis data is never considered "empty" — the Analysis tab has content
    if ((ds as any).liveAnalysis) return false;
    return (
        !ds.overview?.trim() &&
        !hasContent(ds.keyPoints) &&
        !hasContent(ds.actionItems) &&
        !ds.dealStatus?.stage?.trim() &&
        !ds.dealStatus?.summary?.trim() &&
        !ds.salesCoachReview?.whatIDidRight?.some(s => s?.trim()) &&
        !ds.salesCoachReview?.whatICouldHaveDoneBetter?.some(s => s?.trim()) &&
        !ds.salesCoachReview?.whatIMissedCompletely?.some(s => s?.trim()) &&
        !ds.nextCallPlaybook?.openingRecap?.trim() &&
        !ds.nextCallPlaybook?.questionsToAsk?.some(s => s?.trim())
    );
}

// ─── Detail Analysis accordion ────────────────────────────────────────────────
// Self-contained — safe to lift to a dashboard widget in future.
// Just pass `scorecard` + `isLight` and it renders standalone.
interface DetailAnalysisAccordionProps {
    scorecard: MeetingScorecardResult;
    isLight: boolean;
}
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
                    {/* Type pills summary — show each detected type with its score */}
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
                                    <span className="opacity-70 font-semibold">{sc.overallScore}</span>
                                </span>
                            );
                        })}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-semibold tabular-nums ${isLight ? 'text-slate-500' : 'text-white/40'}`}>
                        Overall Score: {scorecard.overallWeightedScore}/100
                    </span>
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

const MeetingDetails: React.FC<MeetingDetailsProps> = ({ meeting: initialMeeting }) => {

    const isLight = useResolvedTheme() === 'light';
    const queryClient = useQueryClient();
    const meetingKey = ["meeting", initialMeeting.id];

    // Tracks the post-call processing skeleton. While processing we don't fetch detail
    // over HTTP (the row may not be in the backend yet); the onMeetingsUpdated effect
    // below pulls it once main signals it's ready.
    const [isProcessing, setIsProcessing] = useState<boolean>(
        initialMeeting.title === 'Processing...' || initialMeeting.isProcessed === false
    );

    // Full detail (transcript + usage) loads over HTTP; the list row seeds initialData so
    // the view renders instantly, then reconciles with the backend.
    const { data: meetingData = initialMeeting, isFetching: isLoadingMeetingDetail } = useQuery<Meeting>(
        meetingKey,
        () => meetingsApi.get(initialMeeting.id),
        { initialData: initialMeeting, enabled: !isProcessing && !!initialMeeting.id },
    );

    // The HTTP transcript depends on the Supabase mirror having already synced this
    // meeting's transcript rows — fire-and-forget, and can lag behind (or, for some
    // rows, never catch up to) the local save. Local SQLite is the actual source of
    // truth and always has the transcript the instant a meeting finishes (written
    // synchronously in saveMeeting's transaction), so fall back to it — same
    // "local-first, cloud is just a mirror" precedent already used for scorecard
    // below via meeting:getScorecard.
    const needsLocalTranscript = !isProcessing && !!initialMeeting.id && (meetingData.transcript?.length ?? 0) === 0;
    const { data: localTranscript } = useQuery<MeetingTranscriptLine[] | null>(
        ["meeting-local-transcript", initialMeeting.id],
        async () => {
            const details = await window.electronAPI?.getMeetingDetails?.(initialMeeting.id);
            return details?.transcript ?? null;
        },
        { enabled: needsLocalTranscript },
    );
    // Every existing `meeting.transcript` reference below transparently gets the
    // fallback via this merged value — no need to touch each call site.
    const meeting: Meeting = useMemo(
        () =>
            needsLocalTranscript && localTranscript && localTranscript.length > 0
                ? { ...meetingData, transcript: localTranscript }
                : meetingData,
        [meetingData, needsLocalTranscript, localTranscript]
    );

    // Scorecard is handled locally (IPC), NOT over HTTP: the backend's GET /meetings/{id}
    // only serves summary_json, while the scorecard lives in the dedicated
    // meeting_scorecards table. meeting:getScorecard reads Supabase first (other devices'
    // scorecards) and falls back to local SQLite.
    const scorecardKey = ["meeting-scorecard", initialMeeting.id];
    const { data: localScorecard = null } = useQuery<MeetingScorecardResult | null>(
        scorecardKey,
        async () => {
            const res = await window.electronAPI?.meetingGetScorecard?.(initialMeeting.id);
            return res?.success ? (res.data ?? null) : null;
        },
        { enabled: !isProcessing && !!initialMeeting.id },
    );
    // Prefer the dedicated-table scorecard; the summary_json-embedded blob is only the
    // legacy / DB-write-failure fallback (same precedence as DatabaseManager.getMeetingDetails).
    const scorecard: MeetingScorecardResult | null =
        localScorecard ?? meeting.detailedSummary?.scorecard ?? null;

    // Title / summary edits: HTTP is canonical; the existing IPC write is fired on success
    // as a write-through so local SQLite + RAG stay consistent (and the async mirror can't
    // clobber the edit). Optimistic onMutate preserves the instant-edit feel.
    const titleMutation = useMutation<unknown, unknown, string, { prev?: Meeting }>(
        (title) => meetingsApi.updateTitle(initialMeeting.id, title),
        {
            onMutate: async (title) => {
                await queryClient.cancelQueries(meetingKey);
                const prev = queryClient.getQueryData<Meeting>(meetingKey);
                queryClient.setQueryData<Meeting>(meetingKey, (m = initialMeeting) => ({ ...m, title }));
                return { prev };
            },
            onError: (_e, _t, ctx) => { if (ctx?.prev) queryClient.setQueryData(meetingKey, ctx.prev); },
            onSuccess: (_d, title) => { window.electronAPI?.updateMeetingTitle?.(initialMeeting.id, title); },
            onSettled: () => {
                void queryClient.invalidateQueries(meetingKey);
                void queryClient.invalidateQueries(["meetings"]);
            },
        },
    );
    const summaryMutation = useMutation<unknown, unknown, Record<string, any>, { prev?: Meeting }>(
        (updates) => meetingsApi.updateSummary(initialMeeting.id, updates),
        {
            onMutate: async (updates) => {
                await queryClient.cancelQueries(meetingKey);
                const prev = queryClient.getQueryData<Meeting>(meetingKey);
                queryClient.setQueryData<Meeting>(meetingKey, (m = initialMeeting) => ({
                    ...m,
                    detailedSummary: { actionItems: [], keyPoints: [], ...(m.detailedSummary ?? {}), ...updates },
                }));
                return { prev };
            },
            onError: (_e, _u, ctx) => { if (ctx?.prev) queryClient.setQueryData(meetingKey, ctx.prev); },
            onSuccess: (_d, updates) => { window.electronAPI?.updateMeetingSummary?.(initialMeeting.id, updates as any); },
            onSettled: () => {
                void queryClient.invalidateQueries(meetingKey);
                void queryClient.invalidateQueries(["meetings"]);
            },
        },
    );
    const [activeTab, setActiveTab] = useState<'summary' | 'transcript' | 'usage' | 'analysis'>('summary');

    // Persisted "Ask Dojo" Q&A history — fetched lazily the first time the
    // user opens this tab (enabled gate), not bundled into the initial
    // meeting payload since most sessions on a meeting never open it.
    const { data: aiInteractionsData, isLoading: isLoadingAiInteractions } = useQuery(
        ['ai-interactions', meeting?.id],
        () => meetingsApi.getAiInteractions(meeting!.id),
        {
            enabled: activeTab === 'usage' && !!meeting?.id,
            staleTime: 30_000,
        }
    );
    const [query, setQuery] = useState('');
    const [isCopied, setIsCopied] = useState(false);
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [regenError, setRegenError] = useState<string | null>(null);
    const [isFollowUpEmailOpen, setIsFollowUpEmailOpen] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [pendingQuery, setPendingQuery] = useState<{ text: string; id: number } | null>(null);
    const [chatMessages, setChatMessages] = useState<Message[]>([]);
    const [isTalktimeOpen, setIsTalktimeOpen] = useState(false);

    const speakerNames = (meeting.detailedSummary as any)?.speakerNames as
        { user: string; client: string } | undefined;

    // Diarization: suffix far-end labels only when 2+ distinct speaker indices
    // were recorded for this meeting — 1:1 calls render exactly as before.
    const hasMultipleClientSpeakers = useMemo(() => {
        const seen = new Set<number>();
        for (const seg of meeting.transcript || []) {
            const idx = (seg as any).speakerIndex;
            if (idx !== undefined && idx !== null && seg.speaker !== 'user') {
                seen.add(idx);
                if (seen.size >= 2) return true;
            }
        }
        return false;
    }, [meeting.transcript]);

    const getSpeakerDisplayName = (speaker: string, displayName?: string, speakerIndex?: number): string => {
        // 1. Live transcription supplies displayName directly — always prefer it.
        if (displayName) return displayName;
        // 2. Use resolved calendar names saved in detailedSummary.speakerNames.
        //    These are set by SessionTracker (e.g. "Nikhilbarot", "Salesforce").
        //    Fall back to "You" / "Other Party" only when no calendar data was resolved.
        if (speaker === 'user') return speakerNames?.user || 'You';
        if (speaker === 'client' || speaker === "interviewer") {
            const base = speakerNames?.client || 'Other Party';
            if (hasMultipleClientSpeakers && speakerIndex !== undefined && speakerIndex !== null) {
                return `${base} · Speaker ${speakerIndex + 1}`;
            }
            return base;
        }
        if (speaker === 'assistant') return 'Assistant';
        return speaker;
    };

    useEffect(() => {
        if (!isProcessing) return;

        // IMPORTANT: onMeetingsUpdated fires once, whenever background processing
        // actually finishes — which is very often *before* this component ever
        // mounts (the user is usually still looking at the Launcher card, not
        // this detail view, at that moment). A listener registered only now would
        // silently miss an event that already fired, leaving isProcessing stuck
        // true forever and permanently disabling the transcript/scorecard queries
        // above. So check immediately on mount too, not only on a future event
        const unblockFromLocal = async () => {
            try {
                const details = await window.electronAPI?.getMeetingDetails?.(initialMeeting.id);
                if (details && details.isProcessed !== false && details.title !== 'Processing...') {
                    queryClient.setQueryData<Meeting>(meetingKey, (prev) => ({ ...(prev ?? initialMeeting), ...details }));
                    setIsProcessing(false);
                    void queryClient.invalidateQueries(scorecardKey);
                }
            } catch (e) {
                console.log("[ERROR: Local getMeetingDetails fallback]: ", e);
            }
        };

        // Run the same check immediately — covers "processing already finished
        // before this view opened."
        //
        // NOTE: `updated.isProcessed` only reflects the `meetings` row (summary
        // generated) — it says nothing about whether the transcript/scorecard
        // mirror upserts (separate tables, separate async queue entries) have
        // landed in Supabase yet. Trusting isProcessed alone here was skipping
        // unblockFromLocal() even when updated.transcript was still empty,
        // permanently missing the transcript/scorecard tabs for that view.
        const isHttpResultComplete = (m: Meeting) =>
            !!m.isProcessed && (m.transcript?.length ?? 0) > 0 && !!m.detailedSummary?.scorecard;

        meetingsApi.get(initialMeeting.id)
            .then((updated) => {
                if (updated && isHttpResultComplete(updated)) {
                    queryClient.setQueryData<Meeting>(meetingKey, updated);
                    setIsProcessing(false);
                    void queryClient.invalidateQueries(scorecardKey);
                } else {
                    if (updated?.isProcessed) {
                        // Still stop showing the "processing" skeleton — the
                        // summary IS ready — but let unblockFromLocal fill in
                        // the transcript/scorecard from the reliable local copy.
                        queryClient.setQueryData<Meeting>(meetingKey, updated);
                    }
                    void unblockFromLocal();
                }
            })
            .catch(() => void unblockFromLocal());

        if (!window.electronAPI?.onMeetingsUpdated) return;

        const unsubscribe = window.electronAPI.onMeetingsUpdated(() => {
            meetingsApi.get(initialMeeting.id)
                .then((updated) => {
                    if (updated && isHttpResultComplete(updated)) {
                        queryClient.setQueryData<Meeting>(meetingKey, updated);
                        setIsProcessing(false); // ← stop skeleton
                        // Scorecard is generated during background processing (before the
                        // final save) — fetch it now that processing is done. The query was
                        // disabled while processing, so kick it explicitly.
                        void queryClient.invalidateQueries(scorecardKey);
                    } else {
                        if (updated?.isProcessed) {
                            queryClient.setQueryData<Meeting>(meetingKey, updated);
                        }
                        void unblockFromLocal();
                    }
                })
                .catch(() => void unblockFromLocal());
        });

        return () => unsubscribe();
    }, [isProcessing, initialMeeting.id]);

    const handleSubmitQuestion = () => {
        if (query.trim()) {
            setPendingQuery({ text: query.trim(), id: Date.now() });
            if (!isChatOpen) {
                setIsChatOpen(true);
            }
            setQuery('');
        }
    };

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            handleSubmitQuestion();
        }
    };

    const handleCopy = async () => {
        let textToCopy = '';

        if (activeTab === 'summary' && meeting.detailedSummary) {
            const ds = meeting.detailedSummary;

            const formatList = (arr?: string[]) =>
                arr && arr.length ? arr.map(i => `  • ${i}`).join('\n') : '  None';

            const toStatusIcon = (s: string) =>
                (s === 'Clear' || s === 'confirmed') ? '✅'
                    : (s === 'Partial' || s === 'partial') ? '⚠️' : '❌';

            const formatBANT = () => {
                if (!ds.bant) return '  None';
                return (['budget', 'authority', 'need', 'timeline'] as const)
                    .map(key => {
                        const item = ds.bant?.[key];
                        if (!item) return null;
                        const statusIcon = toStatusIcon(item.status);
                        return `  ${statusIcon} ${key.toUpperCase()} (${item.status}): ${item.detail}`;
                    })
                    .filter(Boolean)
                    .join('\n');
            };

            const formatMEDDICC = () => {
                if (!ds.meddicc) return '  None';
                const keys = ['metrics', 'economicBuyer', 'decisionCriteria', 'decisionProcess', 'identifyPain', 'champion', 'competition'] as const;
                const rows = keys
                    .map(key => {
                        const item = ds.meddicc?.[key];
                        if (!item) return null;
                        const label = key.replace(/([A-Z])/g, ' $1').trim();
                        const statusIcon = toStatusIcon(item.status);
                        return `  ${statusIcon} ${label.toUpperCase()} (${item.status}): ${item.detail}`;
                    })
                    .filter(Boolean)
                    .join('\n');

                const gaps = ds.meddicc?.gaps?.length
                    ? `\n\n  ⚠ GAPS:\n${ds.meddicc.gaps.map(g => `  • ${g}`).join('\n')}`
                    : '';

                return rows + gaps;
            };

            const formatSalesCoachReview = () => {
                if (!ds.salesCoachReview) return '';

                const sections = [
                    {
                        label: '✅ WHAT I DID RIGHT',
                        items: ds.salesCoachReview.whatIDidRight
                    },
                    {
                        label: '⚠️ WHAT I COULD HAVE DONE BETTER',
                        items: ds.salesCoachReview.whatICouldHaveDoneBetter
                    },
                    {
                        label: '❌ WHAT I MISSED COMPLETELY',
                        items: ds.salesCoachReview.whatIMissedCompletely
                    },
                ];

                return sections
                    .map(({ label, items }) => {
                        if (!items || items.length === 0) return null;
                        return `  ${label}\n${items.map(item => `    • ${item}`).join('\n')}`;
                    })
                    .filter(Boolean)
                    .join('\n\n');
            };

            const formatNextCallPlaybook = () => {
                if (!ds.nextCallPlaybook) return '';

                const parts: string[] = [];

                if (ds.nextCallPlaybook.openingRecap) {
                    parts.push(`  OPENING RECAP:\n    ${ds.nextCallPlaybook.openingRecap}`);
                }

                if (ds.nextCallPlaybook.questionsToAsk?.length) {
                    parts.push(`  CRITICAL GAP QUESTIONS:\n${ds.nextCallPlaybook.questionsToAsk.map(q => `    • "${q}"`).join('\n')}`);
                }

                if (ds.nextCallPlaybook.valueAndROI) {
                    const roi = ds.nextCallPlaybook.valueAndROI;
                    const roiParts: string[] = [];

                    if (roi.quantitative?.length) {
                        roiParts.push(`    📊 Quantitative:\n${roi.quantitative.map(v => `      • ${v}`).join('\n')}`);
                    }
                    if (roi.qualitative?.length) {
                        roiParts.push(`    💡 Qualitative:\n${roi.qualitative.map(v => `      • ${v}`).join('\n')}`);
                    }

                    if (roiParts.length) {
                        parts.push(`  VALUE & ROI TO REINFORCE:\n${roiParts.join('\n')}`);
                    }
                }

                return parts.join('\n\n');
            };

            textToCopy = [
                `POST-CALL SALES ANALYSIS REPORT`,
                `${'━'.repeat(50)}`,
                `Meeting : ${meeting.title}`,
                `Date    : ${new Date(meeting.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
                ds.leadName ? `Lead    : ${ds.leadName}` : null,
                ds.company ? `Company : ${ds.company}` : null,
                ``,

                ds.dealStatus ? [
                    `${'━'.repeat(50)}`,
                    `DEAL STATUS`,
                    `${'━'.repeat(50)}`,
                    `  Stage   : ${ds.dealStatus.stage || 'Unknown'}`,
                    `  Summary : ${ds.dealStatus.summary || '—'}`,
                    ``
                ].join('\n') : null,

                ds.keyPoints?.length ? [
                    `${'━'.repeat(50)}`,
                    `CALL SUMMARY`,
                    `${'━'.repeat(50)}`,
                    formatList(ds.keyPoints),
                    ``
                ].join('\n') : null,

                ds.actionItems?.length ? [
                    `${'━'.repeat(50)}`,
                    `ACTION ITEMS`,
                    `${'━'.repeat(50)}`,
                    formatList(ds.actionItems),
                    ``
                ].join('\n') : null,

                ds.bant ? [
                    `${'━'.repeat(50)}`,
                    `BANT QUALIFICATION`,
                    `${'━'.repeat(50)}`,
                    formatBANT(),
                    ``
                ].join('\n') : null,

                ds.meddicc ? [
                    `${'━'.repeat(50)}`,
                    `MEDDICC QUALIFICATION`,
                    `${'━'.repeat(50)}`,
                    formatMEDDICC(),
                    ``
                ].join('\n') : null,

                ds.salesCoachReview ? [
                    `${'━'.repeat(50)}`,
                    `SALES SELF-ANALYSIS`,
                    `${'━'.repeat(50)}`,
                    formatSalesCoachReview(),
                    ``
                ].join('\n') : null,

                ds.nextCallPlaybook ? [
                    `${'━'.repeat(50)}`,
                    `NEXT CALL STRATEGY`,
                    `${'━'.repeat(50)}`,
                    formatNextCallPlaybook(),
                    ``
                ].join('\n') : null,

            ]
                .filter(Boolean)
                .join('\n')
                .trim();

        } else if (activeTab === 'transcript' && meeting.transcript) {
            textToCopy = meeting.transcript
                .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()))
                .map(t => `[${formatTime(t.timestamp)}] ${getSpeakerDisplayName(t.speaker, t.displayName, (t as any).speakerIndex)}: ${t.text}`)
                .join('\n');

        } else if (activeTab === 'usage' && meeting.usage) {
            textToCopy = meeting.usage
                .map(u => `Q: ${u.question || ''}\nA: ${u.answer || ''}`)
                .join('\n\n');
        } else if (activeTab === 'analysis' && meeting.detailedSummary?.liveAnalysis) {
            // Format the live analysis data for copying
            const la = meeting.detailedSummary.liveAnalysis;
            const sections: string[] = [];

            // Helper to format a field
            const formatField = (label: string, field: any) => {
                if (!field || !field.status) return '';
                const statusIcon = field.status === 'confirmed' ? '✅' : field.status === 'partial' ? '⚠️' : '❌';
                return `  ${statusIcon} ${label}: ${field.status.toUpperCase()} - ${field.evidence || 'Not mentioned'}`;
            };

            // MEDDIC Section
            if (la.meddic) {
                const meddicLines = [
                    formatField('Metrics', la.meddic.metrics),
                    formatField('Economic Buyer', la.meddic.economic_buyer),
                    formatField('Decision Criteria', la.meddic.decision_criteria),
                    formatField('Decision Process', la.meddic.decision_process),
                    formatField('Identify Pain', la.meddic.identify_pain),
                    formatField('Champion', la.meddic.champion),
                    formatField('Competition', la.meddic.competition)
                ].filter(Boolean);

                if (meddicLines.length) {
                    sections.push(`MEDDICC QUALIFICATION`);
                    sections.push(`${'─'.repeat(40)}`);
                    sections.push(...meddicLines);
                    sections.push('');
                }
            }

            // BANT Section
            if (la.bant) {
                const bantLines = [
                    formatField('Budget', la.bant.budget),
                    formatField('Authority', la.bant.authority),
                    formatField('Need', la.bant.need),
                    formatField('Timeline', la.bant.timeline)
                ].filter(Boolean);

                if (bantLines.length) {
                    sections.push(`BANT QUALIFICATION`);
                    sections.push(`${'─'.repeat(40)}`);
                    sections.push(...bantLines);
                    sections.push('');
                }
            }

            // Signals Section
            if (la.signals && la.signals.length > 0) {
                sections.push(`BUYING SIGNALS (${la.signals.length})`);
                sections.push(`${'─'.repeat(40)}`);
                la.signals.forEach((signal, idx) => {
                    sections.push(`  ${idx + 1}. "${signal.quote}"`);
                    sections.push(`     Type: ${signal.signal_type.join(', ')}`);
                    sections.push(`     Ask: ${signal.ask_now}`);
                    sections.push('');
                });
            }

            // Objections Section
            if (la.objections && la.objections.length > 0) {
                sections.push(`OBJECTIONS (${la.objections.length})`);
                sections.push(`${'─'.repeat(40)}`);
                la.objections.forEach((obj, idx) => {
                    const typeLabel = obj.type === 'ae_deferral' ? 'Follow-up' : 'Question';
                    sections.push(`  ${idx + 1}. [${typeLabel}] "${obj.quote}"`);
                    sections.push(`     Owner: ${obj.owner}`);
                    sections.push('');
                });
            }

            textToCopy = sections.join('\n').trim();

            if (!textToCopy) {
                textToCopy = 'No analysis data available.';
            }
        }


        if (!textToCopy) return;

        try {
            await navigator.clipboard.writeText(textToCopy);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy content:', err);
        }
    };

    // UPDATE HANDLERS
    const handleTitleSave = (newTitle: string) => { titleMutation.mutate(newTitle); };

    const handleActionItemSave = (index: number, newVal: string) => {
        const newItems = [...(meeting.detailedSummary?.actionItems || [])];
        newItems[index] = newVal;
        summaryMutation.mutate({ actionItems: newItems });
    };

    const handleKeyPointSave = (index: number, newVal: string) => {
        const newItems = [...(meeting.detailedSummary?.keyPoints || [])];
        newItems[index] = newVal;
        summaryMutation.mutate({ keyPoints: newItems });
    };

    const handleRegenerateSummary = async () => {

        setIsRegenerating(true);
        setRegenError(null);

        try {

            const sessionActive = await guardSession();
            if (!sessionActive) return;
            const result = await window.electronAPI.regenerateMeetingSummary(meeting.id);

            if (result?.success && result.meeting) {
                // Regenerate stays on IPC (LLM = Phase 2); push the fresh data into the cache.
                queryClient.setQueryData<Meeting>(meetingKey, result.meeting);
                void queryClient.invalidateQueries(["meetings"]);
                // Regeneration also re-scores against the latest criteria — refetch the
                // locally-served scorecard so the panel shows the fresh result.
                void queryClient.invalidateQueries(scorecardKey);
            } else {
                setRegenError('Failed to regenerate. Please try again.');
            }

        } catch (err) {

            console.log(err);

            setRegenError('Something went wrong.');

        } finally {

            setIsRegenerating(false);

        }

    };

    const handleFollowUpEmail = async () => {
        setIsFollowUpEmailOpen(true);
    };

    const computeTalkTime = (transcript: { speaker: string; text: string; timestamp: number; }[] | undefined) => {
        if (!transcript || transcript.length === 0) return { user: 0, client: 0, userWords: 0, clientWords: 0 };
        let userWords = 0, clientWords = 0;
        for (const seg of transcript) {
            if (!seg.text?.trim()) continue; // Ignore empty/system messages
            const wordCount = seg.text.trim().split(/\s+/).filter(Boolean).length; // Count words
            if (seg.speaker === 'user') { userWords += wordCount; }
            else if (seg.speaker === 'client') { clientWords += wordCount };
        }
        const totalWords = userWords + clientWords;
        if (totalWords === 0) return { user: 0, client: 0, userWords, clientWords };
        return {
            user: Math.round((userWords / totalWords) * 100),
            client: Math.round((clientWords / totalWords) * 100),
            // Optional raw counts
            userWords,
            clientWords,
        };
    };

    const talkTime = useMemo(() => computeTalkTime(meeting.transcript), [meeting.transcript]);

    return (
        <div className={`relative h-full w-full flex flex-col font-sans overflow-hidden ${isLight ? 'bg-[#f0f2f8] text-slate-700' : 'bg-[#0a0c14] text-slate-300'}`}>

            {/* Main Content */}
            <main className="flex-1 overflow-y-auto custom-scrollbar">
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1, duration: 0.3 }}
                    className="max-w-4xl mx-auto px-8 py-8 pb-32" // Added pb-32 for floating footer clearance
                >
                    {/* Meta Info & Actions Row */}
                    <div className="flex items-start justify-between mb-6">
                        <div className="w-full">
                            {/* Date */}
                            <div className={`text-sm font-medium mb-1.5 ${isLight ? 'text-slate-500' : 'text-text-tertiary'}`}>
                                {new Date(meeting.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                            </div>

                            {/* Title row + Follow-up button */}
                            <div className="flex items-center justify-between gap-4 mb-2">
                                <h1 className="flex-1 min-w-0">
                                    <EditableTextBlock
                                        initialValue={meeting.title}
                                        onSave={handleTitleSave}
                                        tagName="h1"
                                        className={`text-[26px] font-bold tracking-tight -ml-2 px-2 py-1 rounded-md transition-colors ${isLight ? 'text-slate-900' : 'text-white'}`}
                                        multiline={false}
                                    />
                                </h1>

                                {/* Follow-up email — bordered pill button */}
                                <button
                                    onClick={handleFollowUpEmail}
                                    disabled={isRegenerating || isProcessing}
                                    className={`
                                        shrink-0 flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-medium
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
                            </div>
                        </div>

                        <FollowUpEmailModal
                            isOpen={isFollowUpEmailOpen}
                            onClose={() => setIsFollowUpEmailOpen(false)}
                            meeting={meeting}
                            isLight={isLight}
                        />
                    </div>

                    {/* Tabs + Action buttons row */}
                    <div className="flex items-center justify-between mb-8">

                        {/* Tab pill container */}
                        <div className={`p-1 rounded-xl inline-flex items-center gap-0.5 ${isLight ? 'bg-slate-100 border border-slate-200' : 'bg-slate-700/20 border border-border-subtle'}`}>
                            {(['summary', 'transcript', 'usage', 'analysis'] as const).map((tab) => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab)}
                                    className={`
                                        relative px-3.5 py-1.5 text-[13px] font-medium rounded-lg transition-all duration-200 z-10
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
                                    {tab === 'analysis' ? 'Call Analysis' : tab === 'usage' ? 'Ask Dojo' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                                </button>
                            ))}
                        </div>

                        {/* Right-side action buttons */}
                        <div className="flex items-center gap-2">

                            {/* Regenerate */}
                            <button
                                onClick={handleRegenerateSummary}
                                disabled={isRegenerating || isProcessing}
                                title={isProcessing ? 'Wait for analysis to complete first' : 'Regenerate summary'}
                                className={`
                                    flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-medium
                                    transition-all duration-200 active:scale-[0.97]
                                    ${isRegenerating || isProcessing ? 'opacity-40 cursor-not-allowed' : ''}
                                    ${isLight
                                        ? 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 shadow-sm'
                                        : 'bg-slate-700/30 border border-slate-700/10 text-white/70 hover:bg-slate-700/40 hover:border-slate-500/40'
                                    }
                                `}
                            >
                                <RefreshCcw size={13} strokeWidth={1.8} className={isRegenerating ? 'animate-spin' : ''} />
                                {isRegenerating ? 'Regenerating...' : 'Regenerate'}
                            </button>

                            {regenError && (
                                <span className="text-[11px] text-red-400 mx-1">{regenError}</span>
                            )}

                            {/* Copy full summary */}
                            <button
                                onClick={handleCopy}
                                className={`
                                    flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-medium
                                    transition-all duration-200 active:scale-[0.97]
                                    ${isLight
                                        ? 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 shadow-sm'
                                        : 'bg-slate-700/30 border border-slate-700/10 text-white/70 hover:bg-slate-700/40 hover:border-slate-500/40'
                                    }
                                `}
                            >
                                {isCopied
                                    ? <Check size={13} strokeWidth={2} className="text-emerald-500" />
                                    : <Copy size={13} strokeWidth={1.8} />
                                }
                                {isCopied
                                    ? 'Copied!'
                                    : activeTab === 'summary' ? 'Copy full summary'
                                        : activeTab === 'transcript' ? 'Copy transcript'
                                            : 'Copy'
                                }
                            </button>

                        </div>
                    </div>

                    {/* Tab Content */}
                    <div className="space-y-8">
                        {/* Using standard divs for content, framer motion for layout */}
                        {activeTab === 'summary' && (
                            <>
                                {(isRegenerating || isProcessing || isLoadingMeetingDetail) ?
                                    <motion.div
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ duration: 0.3 }}
                                    >
                                        {/* Regenerating / processing banner — skip it for the plain
                                            "still fetching over HTTP" case, that one's near-instant. */}
                                        {(isRegenerating || isProcessing) && (
                                            <div className="flex items-center gap-3 mb-6 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                                                <motion.div
                                                    animate={{ rotate: 360 }}
                                                    transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                                                >
                                                    <RefreshCw size={13} className="text-blue-400 shrink-0" />
                                                </motion.div>
                                                <p className="text-xs text-blue-400 font-medium">
                                                    {isProcessing
                                                        ? 'Analysing transcript — this may take 15-30 seconds...'
                                                        : 'Regenerating summary — this may take 15-30 seconds...'
                                                    }
                                                </p>
                                            </div>
                                        )}

                                        <Skeleton className='h-[200px] w-full mb-3' />
                                        <div className='flex gap-3'>
                                            <Skeleton className='h-[400px] w-full mb-3' />
                                            <Skeleton className='h-[400px] w-full mb-3' />
                                        </div>
                                        <Skeleton className='h-[200px] w-full mb-3' />
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
                                                    onClick={handleRegenerateSummary}
                                                    className={`mt-1 flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium transition-all ${isLight ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 shadow-sm' : 'bg-white/[0.05] border border-white/[0.1] text-white/60 hover:bg-white/[0.08]'}`}
                                                >
                                                    <RefreshCcw size={12} strokeWidth={1.8} />
                                                    Generate summary
                                                </button>
                                            </div>
                                        )}

                                        {/* ── Summary object exists but all fields are empty ── */}
                                        {meeting.detailedSummary && isSummaryEmpty(meeting.detailedSummary) && (
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

                                        {meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && meeting.detailedSummary?.keyPoints?.length !== 0 && <section className="mb-10">

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

                                                <div className="relative flex items-center gap-6 p-7">
                                                    {/* Left: header + bullets */}
                                                    <div className="relative z-10 flex-1">
                                                        <div className="flex items-center gap-2.5">
                                                            <ClipboardList size={18} className={isLight ? 'text-blue-500' : 'text-blue-400'} />
                                                            <h3 className={`text-[15px] font-semibold tracking-tight ${isLight ? 'text-blue-600' : 'text-blue-300'}`}>
                                                                Call Summary
                                                            </h3>
                                                        </div>
                                                        <ul className="mt-4 space-y-2.5">
                                                            {meeting.detailedSummary?.keyPoints?.map((point, i) => (
                                                                <li key={i} className={`flex items-start gap-2.5 text-[13.5px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                                                                    <span
                                                                        className={`mt-[7px] inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${isLight ? 'bg-blue-500' : 'bg-blue-400'}`}
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

                                        {/* ── Detail Analysis accordion ── */}
                                        {scorecard && meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && (
                                            <div className='mb-7'>

                                                <DetailAnalysisAccordion
                                                    scorecard={scorecard}
                                                    isLight={isLight}
                                                />
                                            </div>
                                        )}

                                        {meeting.detailedSummary && !isSummaryEmpty(meeting.detailedSummary) && meeting.detailedSummary?.salesCoachReview !== undefined ?
                                            <>
                                                <section className="mb-10">
                                                    <h2 className={`text-lg font-semibold mb-4 ${isLight ? 'text-slate-800' : 'text-white'}`}>
                                                        <div className='flex gap-3'>
                                                            <ChartColumnIncreasing className='text-blue-500' /> Sales Self-Analysis
                                                        </div>
                                                    </h2>

                                                    {(() => {
                                                        const allItems = meeting.detailedSummary?.salesCoachReview?.whatIDidRight?.filter(item => {
                                                            const colonIndex = item.indexOf(':');
                                                            const content = colonIndex > 0 ? item.substring(colonIndex + 1).trim() : item.trim();
                                                            const lower = content.toLowerCase();
                                                            return content &&
                                                                !lower.startsWith('n/a') &&
                                                                !lower.startsWith('not ') &&
                                                                !lower.startsWith('none') &&
                                                                !lower.startsWith('no ') &&
                                                                lower !== '-';
                                                        });

                                                        if (!allItems || allItems.length === 0) return null;

                                                        // ── Group by framework prefix ──────────────────────────────
                                                        const groups: Record<string, { component: string; content: string }[]> = {};
                                                        const ORDER = ['MEDDICC', 'BANT', 'DISCOVERY', 'OTHER'];

                                                        allItems.forEach(item => {
                                                            const colonIndex = item.indexOf(':');
                                                            const hasLabel = colonIndex > 0 && colonIndex < 30;
                                                            const rawLabel = hasLabel ? item.substring(0, colonIndex).trim() : 'OTHER';
                                                            const content = hasLabel ? item.substring(colonIndex + 1).trim() : item;
                                                            const upper = rawLabel.toUpperCase();

                                                            let framework = 'OTHER';
                                                            let component = '';

                                                            if (upper.startsWith('MEDDICC') || upper.startsWith('MEDDIC')) {
                                                                framework = 'MEDDICC';
                                                                component = rawLabel.replace(/^MEDDIC{1,2}\s*/i, '').trim();
                                                            } else if (upper.startsWith('BANT')) {
                                                                framework = 'BANT';
                                                                component = rawLabel.replace(/^BANT\s*/i, '').trim();
                                                            } else if (upper.startsWith('DISCOVERY')) {
                                                                framework = 'DISCOVERY';
                                                                component = rawLabel.replace(/^DISCOVERY\s*/i, '').trim();
                                                            }

                                                            if (!groups[framework]) groups[framework] = [];
                                                            groups[framework].push({ component, content });
                                                        });

                                                        const frameworkConfig: Record<string, {
                                                            headerBg: string; headerBorder: string; headerText: string;
                                                            dot: string; cardBg: string; cardBorder: string;
                                                            badgeBg: string; badgeText: string; badgeBorder: string;
                                                        }> = {
                                                            'MEDDICC': isLight ? {
                                                                headerBg: 'bg-violet-50', headerBorder: 'border-violet-200', headerText: 'text-violet-700',
                                                                dot: 'bg-violet-500', cardBg: 'bg-violet-50', cardBorder: 'border-violet-200',
                                                                badgeBg: 'bg-violet-100', badgeText: 'text-violet-700', badgeBorder: 'border-violet-200',
                                                            } : {
                                                                headerBg: 'bg-violet-500/10', headerBorder: 'border-violet-500/25', headerText: 'text-violet-300',
                                                                dot: 'bg-violet-400', cardBg: 'bg-violet-500/5', cardBorder: 'border-violet-500/15',
                                                                badgeBg: 'bg-violet-500/15', badgeText: 'text-violet-300', badgeBorder: 'border-violet-500/30',
                                                            },
                                                            'BANT': isLight ? {
                                                                headerBg: 'bg-blue-50', headerBorder: 'border-blue-200', headerText: 'text-blue-700',
                                                                dot: 'bg-blue-500', cardBg: 'bg-blue-50', cardBorder: 'border-blue-200',
                                                                badgeBg: 'bg-blue-100', badgeText: 'text-blue-700', badgeBorder: 'border-blue-200',
                                                            } : {
                                                                headerBg: 'bg-blue-500/10', headerBorder: 'border-blue-500/25', headerText: 'text-blue-300',
                                                                dot: 'bg-blue-400', cardBg: 'bg-blue-500/5', cardBorder: 'border-blue-500/15',
                                                                badgeBg: 'bg-blue-500/15', badgeText: 'text-blue-300', badgeBorder: 'border-blue-500/30',
                                                            },
                                                            'DISCOVERY': isLight ? {
                                                                headerBg: 'bg-amber-50', headerBorder: 'border-amber-200', headerText: 'text-amber-700',
                                                                dot: 'bg-amber-500', cardBg: 'bg-amber-50', cardBorder: 'border-amber-200',
                                                                badgeBg: 'bg-amber-100', badgeText: 'text-amber-700', badgeBorder: 'border-amber-200',
                                                            } : {
                                                                headerBg: 'bg-amber-500/10', headerBorder: 'border-amber-500/25', headerText: 'text-amber-300',
                                                                dot: 'bg-amber-400', cardBg: 'bg-amber-500/5', cardBorder: 'border-amber-500/15',
                                                                badgeBg: 'bg-amber-500/15', badgeText: 'text-amber-300', badgeBorder: 'border-amber-500/30',
                                                            },
                                                            'OTHER': isLight ? {
                                                                headerBg: 'bg-slate-100', headerBorder: 'border-slate-200', headerText: 'text-slate-400',
                                                                dot: 'bg-slate-300', cardBg: 'bg-slate-50', cardBorder: 'border-slate-200',
                                                                badgeBg: 'bg-slate-100', badgeText: 'text-slate-400', badgeBorder: 'border-slate-300',
                                                            } : {
                                                                headerBg: 'bg-white/5', headerBorder: 'border-white/10', headerText: 'text-white/50',
                                                                dot: 'bg-white/30', cardBg: 'bg-white/[0.03]', cardBorder: 'border-white/[0.08]',
                                                                badgeBg: 'bg-white/10', badgeText: 'text-white/50', badgeBorder: 'border-white/15',
                                                            },
                                                        };

                                                        // Render in fixed order: MEDDICC → BANT → DISCOVERY → OTHER
                                                        const sortedFrameworks = ORDER.filter(f => groups[f]);

                                                        return (
                                                            <div className="mb-2">
                                                                {/* Section header */}
                                                                <div className="flex items-center gap-2 mb-4">
                                                                    <CircleCheck size={14} className="text-emerald-400" />
                                                                    <p className="text-xs font-bold uppercase tracking-[0.12em] text-emerald-400">What I Did Right</p>
                                                                    <div className={`flex-1 h-px ${isLight ? 'bg-black/[0.08]' : 'bg-white/[0.06]'}`} />
                                                                </div>

                                                                {/* One card per framework */}
                                                                <div className="space-y-3">
                                                                    {sortedFrameworks.map(framework => {
                                                                        const items = groups[framework];
                                                                        const cfg = frameworkConfig[framework];
                                                                        return (
                                                                            <div key={framework} className={`rounded-xl border ${cfg.headerBorder} overflow-hidden`}>

                                                                                {/* Framework header row */}
                                                                                <div className={`flex items-center gap-2.5 px-4 py-2.5 ${cfg.headerBg} border-b ${cfg.headerBorder}`}>
                                                                                    <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                                                                                    <span className={`text-[10px] font-bold uppercase tracking-[0.14em] ${cfg.headerText}`}>
                                                                                        {framework}
                                                                                    </span>
                                                                                    <span className={`text-[10px] font-medium ml-1 ${isLight ? 'text-slate-400' : 'text-white/20'}`}>
                                                                                        {items.length} {items.length === 1 ? 'point' : 'points'}
                                                                                    </span>
                                                                                </div>

                                                                                {/* Items inside this framework */}
                                                                                <div className="divide-y divide-white/[0.04]">
                                                                                    {items.map((item, i) => (
                                                                                        <div key={i} className={`flex items-start gap-3 p-3 rounded-lg border ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-gray-800/10 border-white/10'}`}>
                                                                                            {item.component && <span className={`text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 mt-0.5 w-[100px] text-center ${cfg.badgeBg} ${cfg.badgeText} ${cfg.badgeBorder}`}>
                                                                                                {item.component}
                                                                                            </span>}
                                                                                            <div className={`w-px self-stretch shrink-0 ${isLight ? 'bg-slate-200' : 'bg-white/10'}`} />
                                                                                            <p className={`text-sm leading-relaxed ${isLight ? 'text-slate-600' : 'text-white/70'}`}>{item.content}</p>
                                                                                        </div>

                                                                                        // <div key={i} className={`flex items-start gap-3 px-4 py-3 ${cfg.cardBg}`}>
                                                                                        //     {/* Component badge — only show if there's a component name */}
                                                                                        //     {item.component && (
                                                                                        //         <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md border shrink-0 mt-0.5 whitespace-nowrap ${cfg.badgeBg} ${cfg.badgeText} ${cfg.badgeBorder}`}>
                                                                                        //             {item.component}
                                                                                        //         </span>
                                                                                        //     )}
                                                                                        //     <p className="text-sm text-white/65 leading-relaxed">{item.content}</p>
                                                                                        // </div>
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        );
                                                    })()}
                                                </section>

                                                <div className="grid grid-cols-2 gap-4 mb-10">

                                                    {/* Better Execution */}
                                                    {(() => {
                                                        const validBetterItems = meeting.detailedSummary?.salesCoachReview?.whatICouldHaveDoneBetter
                                                            ?.map(item => {
                                                                const colonIndex = item.indexOf(':');
                                                                const hasLabel = colonIndex > 0 && colonIndex < 30;
                                                                const label = hasLabel ? item.substring(0, colonIndex).trim() : null;
                                                                const content = hasLabel ? item.substring(colonIndex + 1).trim() : item.trim();
                                                                return { label, content };
                                                            })
                                                            .filter(({ content }) => {
                                                                if (!content || content.trim() === '' || content.trim() === '-' || content.trim() === '—') return false;
                                                                const lower = content.toLowerCase().trim();
                                                                return (
                                                                    !lower.startsWith('n/a') &&
                                                                    !lower.startsWith('not ') &&
                                                                    !lower.startsWith('none') &&
                                                                    !lower.startsWith('no ') &&
                                                                    !lower.startsWith('unknown') &&
                                                                    !lower.startsWith('not discussed') &&
                                                                    !lower.startsWith('not mentioned') &&
                                                                    lower !== '-' &&
                                                                    lower !== '—'
                                                                );
                                                            });

                                                        if (!validBetterItems || validBetterItems.length === 0) return null;

                                                        return (
                                                            <div className={`p-4 rounded-xl border ${isLight ? 'bg-white border-slate-200' : 'bg-gray-800/30 border-white/10'}`}>
                                                                <div className='flex gap-3 mb-3'>
                                                                    <div><TrendingUp size={18} className={isLight ? 'text-amber-400' : 'text-amber-400'} /></div>
                                                                    <div className={`text-sm font-bold tracking-wider mb-3 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>BETTER EXECUTION</div>
                                                                </div>
                                                                {validBetterItems.map(({ label, content }, i) => (
                                                                    label ? (
                                                                        <div key={i} className="flex items-start gap-3 mb-4">
                                                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 mt-0.5 w-[130px] text-center ${isLight ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-amber-400 bg-amber-500/10 border-amber-500/20'}`}>
                                                                                {label}
                                                                            </span>
                                                                            <div className={`w-px self-stretch shrink-0 ${isLight ? 'bg-amber-200' : 'bg-amber-500/20'}`} />
                                                                            <p className={`text-sm leading-relaxed ${isLight ? 'text-slate-600' : 'text-white/70'}`}>{content}</p>
                                                                        </div>
                                                                    ) : (
                                                                        <p key={i} className={`text-sm italic mb-4 ${isLight ? 'text-slate-600' : 'text-white/70'}`}>
                                                                            <span className={isLight ? 'text-slate-300' : 'text-gray-50/30'}>•</span> {content}
                                                                        </p>
                                                                    )
                                                                ))}
                                                            </div>
                                                        );
                                                    })()}

                                                    {/* Missed Completely */}
                                                    {(() => {
                                                        const validMissedItems = meeting.detailedSummary?.salesCoachReview?.whatIMissedCompletely
                                                            ?.map(item => {
                                                                const colonIndex = item.indexOf(':');
                                                                const hasLabel = colonIndex > 0 && colonIndex < 30;
                                                                const label = hasLabel ? item.substring(0, colonIndex).trim() : null;
                                                                const content = hasLabel ? item.substring(colonIndex + 1).trim() : item;
                                                                return { label, content };
                                                            })
                                                            .filter(({ content }) => {
                                                                if (!content || content.trim() === '' || content.trim() === '-' || content.trim() === '—') return false;
                                                                const lower = content.toLowerCase().trim();
                                                                return (
                                                                    !lower.startsWith('n/a') &&
                                                                    !lower.startsWith('not ') &&
                                                                    !lower.startsWith('none') &&
                                                                    !lower.startsWith('no ') &&
                                                                    !lower.startsWith('unknown') &&
                                                                    !lower.startsWith('not discussed') &&
                                                                    !lower.startsWith('not mentioned') &&
                                                                    lower !== '-' &&
                                                                    lower !== '—'
                                                                );
                                                            });

                                                        if (!validMissedItems || validMissedItems.length === 0) return null;

                                                        return (
                                                            <div className={`p-4 rounded-xl border ${isLight ? 'bg-red-50 border-red-200' : 'bg-red-500/10 border-red-500/20'}`}>
                                                                <div className='flex gap-3 mb-3'>
                                                                    <div><TriangleAlert className='text-red-400' size={18} /></div>
                                                                    <div className="text-sm font-bold text-red-400 tracking-wider mb-3">MISSED COMPLETELY</div>
                                                                </div>
                                                                {validMissedItems.map(({ label, content }, i) => (
                                                                    <div key={i} className="flex items-start gap-3 mb-4">
                                                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 mt-0.5 w-[130px] text-center ${isLight ? 'text-red-600 bg-red-50 border-red-200' : 'text-red-400 bg-red-500/10 border-red-500/20'}`}>
                                                                            {label || '—'}
                                                                        </span>
                                                                        <div className="w-px self-stretch bg-red-500/20 shrink-0" />
                                                                        <p className="text-sm text-red-300 leading-relaxed">{content}</p>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        );
                                                    })()}

                                                </div>

                                                <section className="mt-8">
                                                    {/* Title */}
                                                    <div className="flex items-center gap-2 mb-10">
                                                        <span className="text-blue-400">✦</span>
                                                        <h2 className={`text-lg font-semibold ${isLight ? 'text-slate-800' : 'text-white'}`}>
                                                            Next Call Strategy
                                                        </h2>
                                                    </div>

                                                    {/* 2 Column Layout */}
                                                    <div className="grid grid-cols-1 gap-8">

                                                        {/* LEFT: QUICK RECAP */}
                                                        <div className="relative pl-5">

                                                            {/* Vertical Blue Line */}
                                                            <div className="absolute left-0 top-1 w-[2px] h-[100%] bg-blue-500 rounded-full" />

                                                            <p className="text-xs font-semibold tracking-wider text-blue-400 mb-4">
                                                                QUICK RECAP OF LAST CALL
                                                            </p>

                                                            <div className="space-y-4">
                                                                {meeting.detailedSummary?.nextCallPlaybook?.valueAndROI?.quantitative?.map((item, i) => (
                                                                    <div key={i} className="flex gap-3">
                                                                        <div className="mt-2 w-1.5 h-1.5 bg-blue-400 rounded-full shrink-0" />
                                                                        <p className={`text-sm ${isLight ? 'text-slate-800' : 'text-white/70'} leading-relaxed`}>
                                                                            {item}
                                                                        </p>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>

                                                        {/* RIGHT: CRITICAL QUESTIONS */}
                                                        <div className="relative pl-5">

                                                            {/* Vertical Red Line */}
                                                            <div className="absolute left-0 top-1 w-[2px] h-[100%] bg-red-400 rounded-full" />

                                                            <p className="text-xs font-semibold tracking-wider text-red-400 mb-4">
                                                                CRITICAL GAP QUESTIONS
                                                            </p>

                                                            <div className="space-y-5">
                                                                {meeting.detailedSummary?.nextCallPlaybook?.questionsToAsk?.map((q, i) => (
                                                                    <p key={i} className={`text-sm ${isLight ? 'text-slate-800' : 'text-white/70'} leading-relaxed`}>
                                                                        “{q}”
                                                                    </p>
                                                                ))}
                                                            </div>
                                                        </div>

                                                    </div>
                                                </section>

                                            </> :

                                            <>
                                                <section className="mb-10">

                                                    <div className="space-y-3">
                                                        {/* Action Items - Only show if there are items */}
                                                        {meeting.detailedSummary?.actionItems && meeting.detailedSummary.actionItems.length > 0 && (
                                                            <section className="mb-8">
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
                                                            <section>
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

                                        }

                                    </motion.div>
                                }

                            </>
                        )}

                        {activeTab === 'transcript' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                {isLoadingMeetingDetail ? (
                                    <div className="space-y-3">
                                        <Skeleton className="h-8 w-40 mb-4" />
                                        {Array.from({ length: 6 }).map((_, i) => (
                                            <Skeleton key={i} className={`h-14 w-full ${i % 2 === 0 ? 'mr-24' : 'ml-24'}`} />
                                        ))}
                                    </div>
                                ) : (
                                    <>
                                        {meeting.transcript && meeting.transcript.length > 0 && (
                                            <div className={`mb-6 overflow-hidden rounded-2xl border ${isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-gray-800/10'}`}>
                                                {/* Accordion Header */}
                                                <button
                                                    onClick={() => setIsTalktimeOpen(prev => !prev)}
                                                    className={`flex w-full items-center justify-between px-4 py-3 transition-colors ${isLight ? 'hover:bg-slate-50' : 'hover:bg-gray-800/30'}`}
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <div className={`flex h-8 w-8 items-center justify-center rounded-xl ${isLight ? 'bg-slate-100' : 'bg-gray-800'}`}>
                                                            <BarChart3 className={`h-4 w-4 ${isLight ? 'text-slate-500' : 'text-white/70'}`} />
                                                        </div>

                                                        <div className="text-left">
                                                            <h3 className={`text-sm font-semibold ${isLight ? 'text-slate-700' : 'text-white/90'}`}>
                                                                Speaking Balance
                                                            </h3>

                                                            <p className={`text-xs ${isLight ? 'text-slate-400' : 'text-white/40'}`}>
                                                                Conversation analytics
                                                            </p>
                                                        </div>
                                                    </div>

                                                    <ChevronDown
                                                        className={`h-4 w-4 transition-transform duration-300 ${isTalktimeOpen ? 'rotate-180' : ''} ${isLight ? 'text-slate-400' : 'text-white/50'}`}
                                                    />
                                                </button>

                                                {/* Accordion Content */}
                                                <AnimatePresence initial={false}>
                                                    {isTalktimeOpen && (
                                                        <motion.div
                                                            initial={{ height: 0, opacity: 0 }}
                                                            animate={{ height: 'auto', opacity: 1 }}
                                                            exit={{ height: 0, opacity: 0 }}
                                                            transition={{ duration: 0.25 }}
                                                            className="overflow-hidden"
                                                        >
                                                            <div className={`border-t px-4 py-4 ${isLight ? 'border-slate-200' : 'border-white/10'}`}>

                                                                {/* User */}
                                                                <div className="mb-4">
                                                                    <div className="mb-2 flex items-center justify-between">
                                                                        <div className='flex gap-3 items-center'>

                                                                            <div className="flex items-center gap-2">
                                                                                <span className={`text-sm ${isLight ? 'text-slate-700' : 'text-white/80'}`}>
                                                                                    {getSpeakerDisplayName('user')}
                                                                                </span>
                                                                            </div>

                                                                            <div className={`text-xs ${isLight ? 'text-slate-400' : 'text-white/40'}`}>
                                                                                • {talkTime.userWords.toLocaleString()} words spoken
                                                                            </div>

                                                                        </div>

                                                                        <span className={`text-sm font-medium ${isLight ? 'text-slate-800' : 'text-white'}`}>
                                                                            {talkTime.user}%
                                                                        </span>
                                                                    </div>

                                                                    <div className={`h-1 overflow-hidden rounded-full ${isLight ? 'bg-slate-200' : 'bg-white/10'}`}>
                                                                        <div
                                                                            className="h-full rounded-full bg-blue-500 transition-all duration-500"
                                                                            style={{ width: `${talkTime.user}%` }}
                                                                        />
                                                                    </div>
                                                                </div>

                                                                {/* Remote Participant */}
                                                                <div>
                                                                    <div className="mb-2 flex items-center justify-between">
                                                                        <div className='flex gap-3 items-center'>

                                                                            <div className="flex items-center gap-2">

                                                                                <span className={`text-sm ${isLight ? 'text-slate-700' : 'text-white/80'}`}>
                                                                                    {getSpeakerDisplayName('client')}
                                                                                </span>
                                                                            </div>

                                                                            <div className={`text-xs ${isLight ? 'text-slate-400' : 'text-white/40'}`}>
                                                                                • {talkTime.clientWords.toLocaleString()} words spoken
                                                                            </div>

                                                                        </div>
                                                                        <span className={`text-sm font-medium ${isLight ? 'text-slate-800' : 'text-white'}`}>
                                                                            {talkTime.client}%
                                                                        </span>
                                                                    </div>

                                                                    <div className={`h-1 overflow-hidden rounded-full ${isLight ? 'bg-slate-200' : 'bg-white/10'}`}>
                                                                        <div
                                                                            className={`h-full rounded-full transition-all duration-500 ${isLight ? 'bg-slate-400' : 'bg-blue-500/30'}`}
                                                                            style={{ width: `${talkTime.client}%` }}
                                                                        />
                                                                    </div>
                                                                </div>

                                                                {/* Optional Footer */}
                                                                <div className={`mt-4 border-t pt-3 ${isLight ? 'border-slate-100' : 'border-white/5'}`}>
                                                                    <p className={`text-xs leading-relaxed ${isLight ? 'text-slate-400' : 'text-white/40'}`}>
                                                                        Speaking balance helps understand participation and engagement during the meeting.
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        )}

                                        <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                            <div className="space-y-6">
                                                {(() => {
                                                    const filteredTranscript = meeting.transcript?.filter(entry => {
                                                        const isHidden = ['system', 'ai', 'assistant', 'model'].includes(entry.speaker?.toLowerCase());
                                                        if (isHidden) console.log('Filtered out:', entry);
                                                        return !isHidden;
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
                                                                    } px-2 py-1 rounded-full truncate max-w-[120px]`}>
                                                                    {getSpeakerDisplayName(
                                                                        entry.speaker,
                                                                        entry.displayName,
                                                                        (entry as any).speakerIndex
                                                                    )}
                                                                </span>
                                                                <span className="text-xs text-text-tertiary font-mono">{entry.timestamp ? formatTime(entry.timestamp) : '0:00'}</span>
                                                            </div>
                                                            <p className="text-text-secondary text-[15px] leading-relaxed transition-colors select-text cursor-text">{entry.text}</p>


                                                        </div>
                                                    ));

                                                })()}
                                            </div>
                                        </motion.section>
                                    </>)}
                            </motion.section>
                        )}

                        {activeTab === 'usage' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-8 pb-10">
                                {isLoadingMeetingDetail || isLoadingAiInteractions ? (
                                    Array.from({ length: 3 }).map((_, i) => (
                                        <div key={i} className="space-y-3">
                                            <Skeleton className="h-10 w-2/3" />
                                            <Skeleton className="h-24 w-full" />
                                        </div>
                                    ))
                                ) : (
                                    (aiInteractionsData?.items ?? []).map((interaction) => (
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
                                                        <img src={NativelyLogo} alt="AI" className="w-4 h-4 opacity-50 object-contain force-black-icon" />
                                                    </div>
                                                    <div>
                                                        <div className="text-[11px] text-text-tertiary mb-1.5 font-medium">{formatTime(interaction.timestamp)}</div>
                                                        <div className="text-text-secondary text-[15px] leading-relaxed max-w-none">
                                                            <ReactMarkdown
                                                                remarkPlugins={[remarkGfm]}
                                                                components={{
                                                                    h1: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                    h2: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                    h3: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                    p: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                    ul: ({ node, ...props }) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                                                                    ol: ({ node, ...props }) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                                                                    li: ({ node, ...props }) => <li className="text-[15px] text-text-secondary font-normal" {...props} />,
                                                                    strong: ({ node, ...props }) => <span className="font-normal text-text-secondary" {...props} />,
                                                                    a: ({ node, ...props }: any) => <a className="text-blue-500 hover:underline" {...props} />,
                                                                    pre: ({ children }: any) => <div className="not-prose mb-4">{children}</div>,
                                                                    code: ({ node, inline, className, children, ...props }: any) => {
                                                                        const match = /language-(\w+)/.exec(className || '');
                                                                        const isInline = inline ?? false;
                                                                        const lang = match ? match[1] : '';

                                                                        return !isInline ? (
                                                                            <div className="my-3 rounded-xl overflow-hidden border border-white/[0.08] shadow-lg bg-zinc-800/60 backdrop-blur-md">
                                                                                <div className="bg-white/[0.04] px-3 py-1.5 border-b border-white/[0.08]">
                                                                                    <span className="text-[10px] uppercase tracking-widest font-semibold text-white/40 font-mono">
                                                                                        {lang || 'CODE'}
                                                                                    </span>
                                                                                </div>
                                                                                <div className="bg-transparent">
                                                                                    <SyntaxHighlighter
                                                                                        language={lang || 'text'}
                                                                                        style={vscDarkPlus}
                                                                                        customStyle={{
                                                                                            margin: 0,
                                                                                            borderRadius: 0,
                                                                                            fontSize: '13px',
                                                                                            lineHeight: '1.6',
                                                                                            background: 'transparent',
                                                                                            padding: '16px',
                                                                                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                                                                        }}
                                                                                        wrapLongLines={true}
                                                                                        showLineNumbers={true}
                                                                                        lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: 'rgba(255,255,255,0.2)', textAlign: 'right', fontSize: '11px' }}
                                                                                        {...props}
                                                                                    >
                                                                                        {String(children).replace(/\n$/, '')}
                                                                                    </SyntaxHighlighter>
                                                                                </div>
                                                                            </div>
                                                                        ) : (
                                                                            <code className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[13px] font-mono text-text-primary border border-border-subtle whitespace-pre-wrap" {...props}>
                                                                                {children}
                                                                            </code>
                                                                        );
                                                                    }
                                                                }}
                                                            >
                                                                {cleanMarkdown(interaction.ai_response || '')}
                                                            </ReactMarkdown>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )))}
                                {!isLoadingMeetingDetail && !isLoadingAiInteractions && !(aiInteractionsData?.items?.length) && (
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
                            </motion.section>
                        )}

                        {activeTab === 'analysis' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                {isLoadingMeetingDetail ? (
                                    <div className="space-y-3">
                                        <Skeleton className="h-32 w-full" />
                                        <div className="flex gap-3">
                                            <Skeleton className="h-40 w-full" />
                                            <Skeleton className="h-40 w-full" />
                                        </div>
                                    </div>
                                ) : meeting.detailedSummary?.liveAnalysis ? (
                                    <>
                                        {/* <div className={`rounded-2xl mb-4 overflow-hidden ${isLight ? 'transparent' : 'bg-[#0d0d0f]'}`}>
                                            <DealHealthScore analysisData={meeting.detailedSummary.liveAnalysis} calledFromAnalysisTab={true} />
                                        </div> */}
                                        <LiveAnalysisContent
                                            hideBar="Missing Details"
                                            analysisData={meeting.detailedSummary.liveAnalysis}
                                            aiInsight={meeting.detailedSummary.liveAnalysis.signals?.[0]?.ask_now || undefined}
                                            calledFromAnalysisTab
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
                </motion.div>
            </main>

            {/* Floating Footer (Ask Bar) */}
            <div className={`absolute bottom-0 left-0 right-0 p-6 flex flex-col items-center gap-2 pointer-events-none ${isChatOpen ? 'z-50' : 'z-20'}`}>
                {/* History affordance — only shown when there's a past conversation
                    and the overlay is currently closed, so it's clear there's
                    something to go back to without needing to type first. */}
                {!isChatOpen && chatMessages.length > 0 && (
                    <button
                        onClick={() => setIsChatOpen(true)}
                        className={`pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium backdrop-blur-[24px] backdrop-saturate-[140%] transition-colors ${isLight
                            ? 'bg-white/80 border border-slate-200 text-slate-600 hover:bg-white shadow-[0_8px_30px_rgba(0,0,0,0.08)]'
                            : 'bg-white/[0.06] border border-white/20 text-white/70 hover:bg-white/[0.1] shadow-[0_8px_30px_rgb(0,0,0,0.12)]'
                            }`}
                    >
                        <MessageSquare size={12} />
                        {chatMessages.length} {chatMessages.length === 1 ? 'message' : 'messages'} · View conversation
                    </button>
                )}
                <div className="w-full max-w-[440px] relative group pointer-events-auto">
                    {/* Dark Glass Effect Input (Matching Reference) */}
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleInputKeyDown}
                        // Clicking/focusing the input opens the panel immediately —
                        // if there's existing history it's visible right away,
                        // without first having to type and submit a new question.
                        onFocus={() => {
                            if (!isChatOpen) setIsChatOpen(true);
                        }}
                        placeholder="Ask about this meeting..."
                        className={`w-full pl-5 pr-12 py-3 backdrop-blur-[24px] backdrop-saturate-[140%] focus:outline-none transition-shadow duration-200 rounded-full text-sm text-text-primary placeholder-text-tertiary/70 ${isLight ? 'bg-white/80 border border-slate-200 shadow-[0_8px_30px_rgba(0,0,0,0.08)]' : 'bg-transparent border border-white/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)]'}`}
                    />
                    <button
                        onClick={handleSubmitQuestion}
                        className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all duration-200 border border-white/5 ${query.trim() ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-primary hover:bg-bg-item-hover'
                            }`}
                    >
                        <ArrowUp size={16} className="transform rotate-45" />
                    </button>
                </div>
            </div>

            {/* Chat Overlay */}
            <MeetingChatOverlay
                isOpen={isChatOpen}
                onClose={() => {
                    setIsChatOpen(false);
                    setQuery('');
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
            />
        </div>
    )

};

export default MeetingDetails;