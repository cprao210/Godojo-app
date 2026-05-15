import React, { act, useEffect, useMemo, useState } from 'react';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { ArrowLeft, Search, Mail, Link, ChevronDown, BarChart3, Play, ArrowUp, Copy, Check, MoreHorizontal, Settings, ArrowRight, TrendingUp, TriangleAlert, MessageSquare, MessagesSquareIcon, ChartColumnIncreasing, CircleCheck, NotepadText, TableOfContents, RefreshCcw, Loader2, RefreshCw, Shield } from 'lucide-react';
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
import { LiveAnalysisData } from '../types/liveAnalysis';
import { FaCircleHalfStroke } from "react-icons/fa6";

const formatTime = (ms: number) => {
    const date = new Date(ms);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();
};

const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;
};

const cleanMarkdown = (content: string) => {
    if (!content) return '';
    // Ensure code blocks are on new lines to fix rendering issues
    return content.replace(/([^\n])```/g, '$1\n\n```');
};

// email: a.email,
// name: a.displayName || a.email!.split('@')[0] || undefined,
// organizer: a.organizer || false,
// self: a.self || false,

interface Meeting {
    id: string;
    title: string;
    date: string;
    duration: string;
    summary: string;
    isProcessed?: boolean;
    detailedSummary?: {
        // Old fields (keep for backward compat with existing meetings)
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
        actionItemsTitle?: string;
        keyPointsTitle?: string;

        leadName?: string;
        company?: string;

        liveAnalysis?: LiveAnalysisData;

        // New sales fields
        dealStatus?: {
            stage?: string;
            summary?: string;
        };
        bant?: {
            budget?: { status: string; detail: string };
            authority?: { status: string; detail: string };
            need?: { status: string; detail: string };
            timeline?: { status: string; detail: string };
        };
        meddicc?: {
            metrics?: { status: string; detail: string };
            economicBuyer?: { status: string; detail: string };
            decisionCriteria?: { status: string; detail: string };
            decisionProcess?: { status: string; detail: string };
            identifyPain?: { status: string; detail: string };
            champion?: { status: string; detail: string };
            competition?: { status: string; detail: string };
            gaps?: string[];
        };
        followUpEmail?: {
            subject?: string;
            sections?: {
                whatYouWillAchieveAfterTransformation?: string[];
                whatWeDiscussed?: string[];
                whatIsTheNeed?: string[];
                currentProcess?: string;
                scopeOfImprovement?: string[];
                howOurSolutionHelps?: string[];
                expectedBusinessImpact?: string[];
                nextSteps?: string[];
            };
            fullEmail?: string;
        };
        salesCoachReview?: {
            whatIDidRight?: string[];
            whatICouldHaveDoneBetter?: string[];
            whatIMissedCompletely?: string[];
        };
        nextCallPlaybook?: {
            openingRecap?: string;
            questionsToAsk?: string[];
            valueAndROI?: {
                quantitative?: string[];
                qualitative?: string[];
            };
        };
    };
    participants?: { email: string | null, name: string | null, oraganizer: boolean, self: boolean }[];
    transcript?: Array<{
        speaker: string;
        displayName?: string;
        text: string;
        timestamp: number;
        final?: boolean;
        confidence?: number;
    }>;
    usage?: Array<{
        type: 'assist' | 'followup' | 'chat' | 'followup_questions';
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
}

interface MeetingDetailsProps {
    meeting: Meeting;
    onBack: () => void;
    onOpenSettings: () => void;
}

// Skeleton pulse component
const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
    <div className={`animate-pulse bg-white/8 rounded-lg ${className}`} />
);

const MeetingDetails: React.FC<MeetingDetailsProps> = ({ meeting: initialMeeting }) => {

    const isLight = useResolvedTheme() === 'light';
    // We need local state for the meeting object to reflect optimistic updates
    const [meeting, setMeeting] = useState<Meeting>(initialMeeting);
    const [activeTab, setActiveTab] = useState<'summary' | 'transcript' | 'usage' | 'analysis'>('summary');
    const [query, setQuery] = useState('');
    const [isCopied, setIsCopied] = useState(false);
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [regenError, setRegenError] = useState<string | null>(null);
    const [isFollowUpEmailOpen, setIsFollowUpEmailOpen] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [submittedQuery, setSubmittedQuery] = useState('');
    const [isProcessing, setIsProcessing] = useState<boolean>(
        initialMeeting.title === 'Processing...' || initialMeeting.isProcessed === false
    );
    const [isTalktimeOpen, setIsTalktimeOpen] = useState(false);
    const [isTranscriptOpen, setIsTranscriptOpen] = useState(true);

    const speakerNames = (meeting.detailedSummary as any)?.speakerNames as
        { user: string; interviewer: string } | undefined;

    const getSpeakerDisplayName = (speaker: string, displayName?: string): string => {
        // Prefer the live displayName from the transcript entry when available

        if (displayName) return displayName;
        if (speaker === 'user') return speakerNames?.user === "Me" ? "You" : (speakerNames?.user || 'You');
        if (speaker === 'interviewer') return speakerNames?.interviewer === "Them" ? "Other Party" : (speakerNames?.interviewer || 'Other Party');
        if (speaker === 'assistant') return 'Assistant';
        return speaker;
    };

    useEffect(() => {
        if (!isProcessing) return;
        if (!window.electronAPI?.onMeetingsUpdated) return;

        const unsubscribe = window.electronAPI.onMeetingsUpdated(() => {
            if (window.electronAPI?.getMeetingDetails) {
                window.electronAPI.getMeetingDetails(meeting.id)
                    .then((updated: any) => {
                        if (updated && updated.isProcessed) {
                            setMeeting(updated);
                            setIsProcessing(false); // ← stop skeleton
                        }
                    })
                    .catch((e) => {
                        console.log("[ERROR: Get Meeting Details]: ", e);
                    });
            }
        });

        return () => unsubscribe();
    }, [isProcessing, meeting.id]);

    const handleSubmitQuestion = () => {
        if (query.trim()) {
            setSubmittedQuery(query);
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

            const formatBANT = () => {
                if (!ds.bant) return '  None';
                return (['budget', 'authority', 'need', 'timeline'] as const)
                    .map(key => {
                        const item = ds.bant?.[key];
                        if (!item) return null;
                        const statusIcon = item.status === 'Clear' ? '✅' : item.status === 'Partial' ? '⚠️' : '❌';
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
                        const statusIcon = item.status === 'Clear' ? '✅' : item.status === 'Partial' ? '⚠️' : '❌';
                        return `  ${statusIcon} ${label.toUpperCase()} (${item.status}): ${item.detail}`;
                    })
                    .filter(Boolean)
                    .join('\n');

                const gaps = ds.meddicc?.gaps?.length
                    ? `\n\n  ⚠ GAPS:\n${ds.meddicc.gaps.map(g => `  • ${g}`).join('\n')}`
                    : '';

                return rows + gaps;
            };

            const formatFollowUpEmail = () => {
                if (!ds.followUpEmail) return '  None';
                const sections = ds.followUpEmail.sections;
                if (!sections) return '  None';

                const sectionLabels: Record<string, string> = {
                    whatWeDiscussed: 'What We Discussed',
                    currentProcess: 'Current Process',
                    scopeOfImprovement: 'Scope of Improvement',
                    howOurSolutionHelps: 'How Our Solution Helps',
                    expectedBusinessImpact: 'Expected Business Impact',
                    nextSteps: 'Next Steps',
                };

                return (Object.keys(sectionLabels) as Array<keyof typeof sections>)
                    .map(key => {
                        const val = sections[key];
                        if (!val || (Array.isArray(val) && val.length === 0)) return null;
                        const label = sectionLabels[key as string];
                        const content = Array.isArray(val)
                            ? val.map(s => `    • ${s}`).join('\n')
                            : `    ${val}`;
                        return `  ${label}:\n${content}`;
                    })
                    .filter(Boolean)
                    .join('\n\n');
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

                ds.followUpEmail ? [
                    `${'━'.repeat(50)}`,
                    `FOLLOW-UP EMAIL DRAFT`,
                    `${'━'.repeat(50)}`,
                    ds.followUpEmail.subject ? `  Subject: ${ds.followUpEmail.subject}\n` : '',
                    formatFollowUpEmail(),
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
                .map(t => `[${formatTime(t.timestamp)}] ${getSpeakerDisplayName(t.speaker, t.displayName)}: ${t.text}`)
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
    const handleTitleSave = async (newTitle: string) => {
        setMeeting(prev => ({ ...prev, title: newTitle }));
        if (window.electronAPI?.updateMeetingTitle) {
            await window.electronAPI.updateMeetingTitle(meeting.id, newTitle);
        }
    };

    const handleOverviewSave = async (newOverview: string) => {
        setMeeting(prev => ({
            ...prev,
            detailedSummary: {
                ...prev.detailedSummary!,
                overview: newOverview
            }
        }));
        if (window.electronAPI?.updateMeetingSummary) {
            await window.electronAPI.updateMeetingSummary(meeting.id, { overview: newOverview });
        }
    };

    const handleActionItemSave = async (index: number, newVal: string) => {
        const newItems = [...(meeting.detailedSummary?.actionItems || [])];
        if (!newVal.trim()) {
            // Optional: Remove empty items? For now just keep empty or update
        }
        newItems[index] = newVal;

        setMeeting(prev => ({
            ...prev,
            detailedSummary: {
                ...prev.detailedSummary!,
                actionItems: newItems
            }
        }));

        if (window.electronAPI?.updateMeetingSummary) {
            await window.electronAPI.updateMeetingSummary(meeting.id, { actionItems: newItems });
        }
    };

    const handleKeyPointSave = async (index: number, newVal: string) => {
        const newItems = [...(meeting.detailedSummary?.keyPoints || [])];
        newItems[index] = newVal;

        setMeeting(prev => ({
            ...prev,
            detailedSummary: {
                ...prev.detailedSummary!,
                keyPoints: newItems
            }
        }));

        if (window.electronAPI?.updateMeetingSummary) {
            await window.electronAPI.updateMeetingSummary(meeting.id, { keyPoints: newItems });
        }
    };

    const handleRegenerateSummary = async () => {

        setIsRegenerating(true);
        setRegenError(null);

        try {

            const result = await window.electronAPI.regenerateMeetingSummary(meeting.id);

            if (result?.success && result.meeting) {
                // Replace the entire meeting state with fresh data from DB
                setMeeting(result.meeting);
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
        if (!transcript || transcript.length === 0) return { user: 0, interviewer: 0, userWords: 0, interviewerWords: 0 };
        let userWords = 0, interviewerWords = 0;
        for (const seg of transcript) {
            if (!seg.text?.trim()) continue; // Ignore empty/system messages
            const wordCount = seg.text.trim().split(/\s+/).filter(Boolean).length; // Count words
            if (seg.speaker === 'user') { userWords += wordCount; }
            else if (seg.speaker === 'interviewer') { interviewerWords += wordCount };
        }
        const totalWords = userWords + interviewerWords;
        if (totalWords === 0) return { user: 0, interviewer: 0, userWords, interviewerWords };
        return {
            user: Math.round((userWords / totalWords) * 100),
            interviewer: Math.round((interviewerWords / totalWords) * 100),
            // Optional raw counts
            userWords,
            interviewerWords,
        };
    };

    const talkTime = useMemo(() => computeTalkTime(meeting.transcript), [meeting.transcript]);

    return (
        <div className="h-full w-full flex flex-col bg-bg-secondary text-text-secondary font-sans overflow-hidden">

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
                        <div className="w-full pr-4">
                            {/* Date formatting could be improved to use meeting.date if it's an ISO string */}
                            <div className="text-sm text-text-tertiary font-medium mb-1">
                                {new Date(meeting.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                            </div>

                            {/* Editable Title */}
                            <div className="mb-5">
                                <div className="flex items-center justify-between mb-4">
                                    <h1 className="text-2xl font-semibold text-white">
                                        <EditableTextBlock
                                            initialValue={meeting.title}
                                            onSave={handleTitleSave}
                                            tagName="h1"
                                            className="text-3xl font-bold text-text-primary tracking-tight -ml-2 px-2 py-1 rounded-md transition-colors"
                                            multiline={false}
                                        />
                                    </h1>
                                    <button
                                        onClick={handleFollowUpEmail}
                                        disabled={isRegenerating || isProcessing}
                                        className={`flex items-center gap-1.5 text-xs font-medium text-text-secondary ${isRegenerating || isProcessing ? 'opacity-50 cursor-not-allowed' : 'hover:text-text-primary hover:bg-text-secondary/10'}  transition-colors border border-white/[0.2] rounded-lg px-2 py-0.5`}
                                    >
                                        <Mail size={12} />
                                        Follow-up email
                                    </button>
                                </div>

                            </div>
                        </div>

                        <FollowUpEmailModal
                            isOpen={isFollowUpEmailOpen}
                            onClose={() => setIsFollowUpEmailOpen(false)}
                            meeting={meeting}
                        />
                        {/* Moved Actions: Follow-up & Share (REMOVED per user request) */}
                        {/* <div className="flex items-center gap-2 mt-1"> ... </div> */}
                    </div>

                    {/* Tabs */}
                    {/* Designing Tabs to match reference 1:1 (Dark Pill Container) */}
                    <div className="flex items-center justify-between mb-8">
                        <div className={`p-1 rounded-xl inline-flex items-center gap-0.5 ${isLight ? 'bg-[#E5E5EA] border border-black/[0.04]' : 'bg-[#121214] border border-white/[0.08]'}`}>
                            {['summary', 'transcript', 'usage', 'analysis'].map((tab) => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab as any)}
                                    className={`
                                        relative px-3 py-1 text-[13px] font-medium rounded-lg transition-all duration-200 z-10
                                        ${activeTab === tab ? (isLight ? 'text-black' : 'text-[#E9E9E9]') : `${isLight ? 'text-text-secondary' : 'text-text-tertiary'} hover:text-text-primary`}
                                    `}
                                >
                                    {activeTab === tab && (
                                        <motion.div
                                            layoutId="activeTabBackground"
                                            className={`absolute inset-0 rounded-lg -z-10 shadow-sm ${isLight ? 'bg-white' : 'bg-[#3A3A3C]'}`}
                                            initial={false}
                                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                                        />
                                    )}
                                    {tab === 'analysis' ? 'Call Analysis' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                                </button>
                            ))}
                        </div>

                        <div className="flex items-center gap-6">

                            <button
                                onClick={handleRegenerateSummary}
                                disabled={isRegenerating || isProcessing}
                                title={isProcessing ? 'Wait for analysis to complete first' : 'Regenerate summary'}
                                className={`flex items-center gap-2 text-xs font-medium text-text-secondary ${isRegenerating || isProcessing ? 'text-text-tertiary' : 'hover:text-text-primary'} transition-colors`}
                            >
                                <RefreshCcw size={14} className={isRegenerating || isProcessing ? 'animate-spin' : 'hover:text-text-primary'} />
                                {isRegenerating ? 'Regenerating...' : 'Regenerate'}
                            </button>

                            {regenError && (
                                <span className="text-[11px] text-red-400">{regenError}</span>
                            )}

                            {/* Copy Button - Inline with Tabs (Always visible) */}
                            <button
                                onClick={handleCopy}
                                className="flex items-center gap-2 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
                            >
                                {isCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                                {isCopied ? 'Copied' : activeTab === 'summary' ? 'Copy full summary' : activeTab === 'transcript' ? 'Copy full transcript' : 'Copy usage'}
                            </button>

                        </div>
                    </div>

                    {/* Tab Content */}
                    <div className="space-y-8">
                        {/* Using standard divs for content, framer motion for layout */}
                        {activeTab === 'summary' && (
                            <>
                                {(isRegenerating || isProcessing) ?
                                    <motion.div
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ duration: 0.3 }}
                                    >
                                        {/* Regenerating banner */}
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

                                        <Skeleton className='h-[200px] bg-gray-900 w-full mb-3' />
                                        <div className='flex gap-3'>
                                            <Skeleton className='h-[400px] bg-gray-900 w-full mb-3' />
                                            <Skeleton className='h-[400px] bg-gray-900 w-full mb-3' />
                                        </div>
                                        <Skeleton className='h-[200px] bg-gray-900 w-full mb-3' />
                                    </motion.div>
                                    :
                                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

                                        {meeting.detailedSummary?.keyPoints?.length !== 0 && <section className="mb-10">
                                            <h2 className="text-lg font-semibold flex gap-3 text-white mb-4"><NotepadText className='text-blue-500' /> Call Summary</h2>

                                            <div className="space-y-3">
                                                {meeting.detailedSummary?.keyPoints?.map((point, i) => (
                                                    <div key={i} className="flex gap-3">
                                                        <div className="mt-2 w-1.5 h-1.5 bg-blue-400 rounded-full" />
                                                        <p className="text-sm text-white/70">{point}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </section>}

                                        {meeting.detailedSummary?.salesCoachReview !== undefined ?
                                            <>
                                                <section className="mb-10">
                                                    <h2 className="text-lg font-semibold text-white mb-4">
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
                                                            'MEDDICC': {
                                                                headerBg: 'bg-violet-500/10', headerBorder: 'border-violet-500/25', headerText: 'text-violet-300',
                                                                dot: 'bg-violet-400', cardBg: 'bg-violet-500/5', cardBorder: 'border-violet-500/15',
                                                                badgeBg: 'bg-violet-500/15', badgeText: 'text-violet-300', badgeBorder: 'border-violet-500/30',
                                                            },
                                                            'BANT': {
                                                                headerBg: 'bg-blue-500/10', headerBorder: 'border-blue-500/25', headerText: 'text-blue-300',
                                                                dot: 'bg-blue-400', cardBg: 'bg-blue-500/5', cardBorder: 'border-blue-500/15',
                                                                badgeBg: 'bg-blue-500/15', badgeText: 'text-blue-300', badgeBorder: 'border-blue-500/30',
                                                            },
                                                            'DISCOVERY': {
                                                                headerBg: 'bg-amber-500/10', headerBorder: 'border-amber-500/25', headerText: 'text-amber-300',
                                                                dot: 'bg-amber-400', cardBg: 'bg-amber-500/5', cardBorder: 'border-amber-500/15',
                                                                badgeBg: 'bg-amber-500/15', badgeText: 'text-amber-300', badgeBorder: 'border-amber-500/30',
                                                            },
                                                            'OTHER': {
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
                                                                    <div className="flex-1 h-px bg-white/[0.06]" />
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
                                                                                    <span className="text-[10px] text-white/20 font-medium ml-1">
                                                                                        {items.length} {items.length === 1 ? 'point' : 'points'}
                                                                                    </span>
                                                                                </div>

                                                                                {/* Items inside this framework */}
                                                                                <div className="divide-y divide-white/[0.04]">
                                                                                    {items.map((item, i) => (
                                                                                        <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
                                                                                            {item.component && <span className={`text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 mt-0.5 w-[100px] text-center ${cfg.badgeBg} ${cfg.badgeText} ${cfg.badgeBorder}`}>
                                                                                                {item.component}
                                                                                            </span>}
                                                                                            <div className="w-px self-stretch bg-white/10 shrink-0" />
                                                                                            <p className="text-sm text-white/70 leading-relaxed">{item.content}</p>
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
                                                            ?.filter(item => {
                                                                const lower = item.toLowerCase().trim();
                                                                return item.trim() &&
                                                                    !lower.startsWith('n/a') &&
                                                                    !lower.startsWith('not ') &&
                                                                    !lower.startsWith('none') &&
                                                                    !lower.startsWith('no ') &&
                                                                    !lower.startsWith('unknown') &&
                                                                    !lower.startsWith('not discussed') &&
                                                                    !lower.startsWith('not mentioned') &&
                                                                    lower !== '-' &&
                                                                    lower !== '—';
                                                            });

                                                        if (!validBetterItems || validBetterItems.length === 0) return null;

                                                        return (
                                                            <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                                                                <div className='flex gap-3 mb-3'>
                                                                    <div><TrendingUp size={18} /></div>
                                                                    <div className="text-sm font-bold text-white/50 tracking-wider mb-3">BETTER EXECUTION</div>
                                                                </div>
                                                                {validBetterItems.map((item, i) => (
                                                                    <p key={i} className="text-sm italic text-white/70 mb-4">
                                                                        <span className='text-gray-50/30'>•</span> {item}
                                                                    </p>
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
                                                            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20">
                                                                <div className='flex gap-3 mb-3'>
                                                                    <div><TriangleAlert className='text-red-400' size={18} /></div>
                                                                    <div className="text-sm font-bold text-red-400 tracking-wider mb-3">MISSED COMPLETELY</div>
                                                                </div>
                                                                {validMissedItems.map(({ label, content }, i) => (
                                                                    <div key={i} className="flex items-start gap-3 mb-4">
                                                                        <span className="text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 mt-0.5 w-[130px] text-center text-red-400 bg-red-500/10 border-red-500/20">
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
                                                        <h2 className="text-lg font-semibold text-white">
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
                                                                        <p className="text-sm text-white/70 leading-relaxed">
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
                                                                    <p key={i} className="text-sm text-white/80 leading-relaxed">
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
                                                                        onSave={(val) => {
                                                                            setMeeting(prev => ({
                                                                                ...prev,
                                                                                detailedSummary: { ...prev.detailedSummary!, actionItemsTitle: val }
                                                                            }));
                                                                            window.electronAPI?.updateMeetingSummary(meeting.id, { actionItemsTitle: val });
                                                                        }}
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
                                                                                        setMeeting(prev => ({
                                                                                            ...prev,
                                                                                            detailedSummary: { ...prev.detailedSummary!, actionItems: newItems }
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
                                                                <div className="flex items-center justify-between mb-4">

                                                                    <EditableTextBlock
                                                                        initialValue={meeting.detailedSummary?.keyPointsTitle || 'Key Points'}
                                                                        onSave={(val) => {
                                                                            setMeeting(prev => ({
                                                                                ...prev,
                                                                                detailedSummary: { ...prev.detailedSummary!, keyPointsTitle: val }
                                                                            }));
                                                                            window.electronAPI?.updateMeetingSummary(meeting.id, { keyPointsTitle: val });
                                                                        }}
                                                                        tagName="h2"
                                                                        className="text-lg font-semibold text-text-primary -ml-2 px-2 py-1 rounded-sm transition-colors"
                                                                        multiline={false}
                                                                    />
                                                                </div>
                                                                <ul className="space-y-3">
                                                                    {meeting.detailedSummary.keyPoints.map((item, i) => (
                                                                        <li key={i} className="flex items-start gap-3 group">
                                                                            <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-purple-500 transition-colors shrink-0" />
                                                                            <div className="flex-1">
                                                                                <EditableTextBlock
                                                                                    initialValue={item}
                                                                                    onSave={(val) => handleKeyPointSave(i, val)}
                                                                                    tagName="p"
                                                                                    className="text-sm text-text-secondary leading-relaxed -ml-2 px-2 rounded-sm transition-colors"
                                                                                    placeholder="Type a key point..."
                                                                                    onEnter={() => {
                                                                                        const newItems = [...(meeting.detailedSummary?.keyPoints || [])];
                                                                                        newItems.splice(i + 1, 0, "");
                                                                                        setMeeting(prev => ({
                                                                                            ...prev,
                                                                                            detailedSummary: { ...prev.detailedSummary!, keyPoints: newItems }
                                                                                        }));
                                                                                    }}
                                                                                />
                                                                            </div>
                                                                        </li>
                                                                    ))}
                                                                </ul>
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

                                {meeting.transcript && meeting.transcript.length > 0 && (
                                    <div className="mb-6 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                                        {/* Accordion Header */}
                                        <button
                                            onClick={() => setIsTalktimeOpen(prev => !prev)}
                                            className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-white/[0.03]"
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/10">
                                                    <BarChart3 className="h-4 w-4 text-white/70" />
                                                </div>

                                                <div className="text-left">
                                                    <h3 className="text-sm font-semibold text-white/90">
                                                        Speaking Balance
                                                    </h3>

                                                    <p className="text-xs text-white/40">
                                                        Conversation analytics
                                                    </p>
                                                </div>
                                            </div>

                                            <ChevronDown
                                                className={`h-4 w-4 text-white/50 transition-transform duration-300 ${isTalktimeOpen ? 'rotate-180' : ''
                                                    }`}
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
                                                    <div className="border-t border-white/10 px-4 py-4">

                                                        {/* User */}
                                                        <div className="mb-4">
                                                            <div className="mb-2 flex items-center justify-between">
                                                                <div className='flex gap-3 items-center'>

                                                                    <div className="flex items-center gap-2">
                                                                        <span className="text-sm text-white/80">
                                                                            You
                                                                        </span>
                                                                    </div>

                                                                    <div className="text-xs text-white/40">
                                                                        • {talkTime.userWords.toLocaleString()} words spoken
                                                                    </div>

                                                                </div>

                                                                <span className="text-sm font-medium text-white">
                                                                    {talkTime.user}%
                                                                </span>
                                                            </div>

                                                            <div className="h-1 overflow-hidden rounded-full bg-white/10">
                                                                <div
                                                                    className="h-full rounded-full bg-blue-600 transition-all duration-500"
                                                                    style={{ width: `${talkTime.user}%` }}
                                                                />
                                                            </div>
                                                        </div>

                                                        {/* Remote Participant */}
                                                        <div>
                                                            <div className="mb-2 flex items-center justify-between">
                                                                <div className='flex gap-3 items-center'>

                                                                    <div className="flex items-center gap-2">

                                                                        <span className="text-sm text-white/80">
                                                                            Other Party
                                                                        </span>
                                                                    </div>

                                                                    <div className="text-xs text-white/40">
                                                                        • {talkTime.interviewerWords.toLocaleString()} words spoken
                                                                    </div>

                                                                </div>
                                                                <span className="text-sm font-medium text-white">
                                                                    {talkTime.interviewer}%
                                                                </span>
                                                            </div>

                                                            <div className="h-1 overflow-hidden rounded-full bg-white/10">
                                                                <div
                                                                    className="h-full rounded-full bg-white/40 transition-all duration-500"
                                                                    style={{ width: `${talkTime.interviewer}%` }}
                                                                />
                                                            </div>
                                                        </div>

                                                        {/* Optional Footer */}
                                                        <div className="mt-4 border-t border-white/5 pt-3">
                                                            <p className="text-xs leading-relaxed text-white/40">
                                                                Speaking balance helps understand participation and engagement during the meeting.
                                                            </p>
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </div>
                                )}
                                <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                                    {/* Transcript Header */}
                                    <button
                                        onClick={() => setIsTranscriptOpen(prev => !prev)}
                                        className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-white/[0.03]"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/10">
                                                <MessageSquare className="h-4 w-4 text-white/70" />
                                            </div>

                                            <div className="text-left">
                                                <h3 className="text-sm font-semibold text-white/90">
                                                    Transcript
                                                </h3>

                                                <p className="text-xs text-white/40">
                                                    Full meeting conversation
                                                </p>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-3">
                                            <span className="text-xs text-white/40">
                                                {meeting.transcript?.length || 0} messages
                                            </span>

                                            <ChevronDown
                                                className={`h-4 w-4 text-white/50 transition-transform duration-300 ${isTranscriptOpen ? 'rotate-180' : ''
                                                    }`}
                                            />
                                        </div>
                                    </button>

                                    <AnimatePresence initial={false}>
                                        {isTranscriptOpen && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{
                                                    height: 'auto',
                                                    opacity: 1,
                                                }}
                                                exit={{
                                                    height: 0,
                                                    opacity: 0,
                                                }}
                                                transition={{
                                                    duration: 0.25,
                                                }}
                                                className="overflow-hidden"
                                            >
                                                <div className="border-t border-white/10 px-4 py-5">
                                                    <div className="space-y-6">
                                                        {(() => {
                                                            const filteredTranscript =
                                                                meeting.transcript?.filter(entry => {
                                                                    return ![
                                                                        'system',
                                                                        'ai',
                                                                        'assistant',
                                                                        'model',
                                                                    ].includes(
                                                                        entry.speaker?.toLowerCase()
                                                                    );
                                                                }) || [];

                                                            if (filteredTranscript.length === 0) {
                                                                return (
                                                                    <p className="text-text-tertiary">
                                                                        No transcript available.
                                                                    </p>
                                                                );
                                                            }

                                                            return filteredTranscript.map(
                                                                (entry, i) => (
                                                                    <div
                                                                        key={i}
                                                                        className="group rounded-2xl border border-white/[0.04] bg-white/[0.02] p-4 transition-all hover:bg-white/[0.03]"
                                                                    >
                                                                        <div className="mb-2 flex items-center gap-2">
                                                                            <span
                                                                                className={`text-xs font-semibold text-white ${entry.speaker === 'user'
                                                                                    ? 'bg-blue-600'
                                                                                    : 'bg-white/40'
                                                                                    } px-2 py-1 rounded-full truncate max-w-[120px]`}
                                                                            >
                                                                                {getSpeakerDisplayName(
                                                                                    entry.speaker,
                                                                                    entry.displayName
                                                                                )}
                                                                            </span>

                                                                            <span className="font-mono text-xs text-white/30">
                                                                                {entry.timestamp
                                                                                    ? formatTime(
                                                                                        entry.timestamp
                                                                                    )
                                                                                    : '0:00'}
                                                                            </span>
                                                                        </div>

                                                                        <p className="text-[15px] leading-relaxed text-text-secondary select-text">
                                                                            {entry.text}
                                                                        </p>
                                                                    </div>
                                                                )
                                                            );
                                                        })()}
                                                    </div>
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            </motion.section>
                        )}

                        {activeTab === 'usage' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-8 pb-10">
                                {meeting.usage?.map((interaction, i) => (
                                    <div key={i} className="space-y-4">
                                        {/* User Question */}
                                        {interaction.question && (
                                            <div className="flex justify-end">
                                                <div className="bg-accent-primary text-white px-5 py-2.5 rounded-2xl rounded-tr-sm max-w-[80%] text-[15px] leading-relaxed shadow-sm">
                                                    {interaction.question}
                                                </div>
                                            </div>
                                        )}

                                        {/* AI Answer */}
                                        {interaction.answer && (
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
                                                            {cleanMarkdown(interaction.answer || '')}
                                                        </ReactMarkdown>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {!meeting.usage?.length && <p className="text-text-tertiary">No usage history.</p>}
                            </motion.section>
                        )}

                        {activeTab === 'analysis' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                {meeting.detailedSummary?.liveAnalysis ? (
                                    <LiveAnalysisContent
                                        hideBar="Missing Details"
                                        analysisData={meeting.detailedSummary.liveAnalysis}
                                        aiInsight={meeting.detailedSummary.liveAnalysis.signals?.[0]?.ask_now || undefined}
                                    />
                                ) : (
                                    <div className="flex flex-col items-center justify-center h-48 gap-3">
                                        <Shield size={24} className="text-white/10" />
                                        <p className="text-[12px] text-white/25 text-center px-8">
                                            No live analysis data available for this meeting.
                                        </p>
                                    </div>
                                )}
                            </motion.section>
                        )}
                    </div>
                </motion.div>
            </main>

            {/* Floating Footer (Ask Bar) */}
            <div className={`absolute bottom-0 left-0 right-0 p-6 flex justify-center pointer-events-none ${isChatOpen ? 'z-50' : 'z-20'}`}>
                <div className="w-full max-w-[440px] relative group pointer-events-auto">
                    {/* Dark Glass Effect Input (Matching Reference) */}
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleInputKeyDown}
                        placeholder="Ask about this meeting..."
                        className="w-full pl-5 pr-12 py-3 bg-transparent backdrop-blur-[24px] backdrop-saturate-[140%] shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-white/20 rounded-full text-sm text-text-primary placeholder-text-tertiary/70 focus:outline-none transition-shadow duration-200"
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
                    setSubmittedQuery('');
                }}
                meetingContext={{
                    id: meeting.id,  // Required for RAG queries
                    title: meeting.title,
                    summary: meeting.detailedSummary?.overview,
                    keyPoints: meeting.detailedSummary?.keyPoints,
                    actionItems: meeting.detailedSummary?.actionItems,
                    transcript: meeting.transcript
                }}
                initialQuery={submittedQuery}
                onNewQuery={(newQuery) => {
                    setSubmittedQuery(newQuery);
                }}
            />
        </div>
    )

    // return (
    //     <div className="h-full w-full flex flex-col bg-bg-secondary text-text-secondary font-sans overflow-hidden">
    //         {/* Main Content */}
    //         <main className="flex-1 overflow-y-auto custom-scrollbar">
    //             <motion.div
    //                 initial={{ opacity: 0, y: 10 }}
    //                 animate={{ opacity: 1, y: 0 }}
    //                 transition={{ delay: 0.1, duration: 0.3 }}
    //                 className="max-w-4xl mx-auto px-8 py-8 pb-32" // Added pb-32 for floating footer clearance
    //             >
    //                 {/* Meta Info & Actions Row */}
    //                 <div className="flex items-start justify-between mb-6">
    //                     <div className="w-full pr-4">
    //                         {/* Date formatting could be improved to use meeting.date if it's an ISO string */}
    //                         <div className="text-xs text-text-tertiary font-medium mb-1">
    //                             {new Date(meeting.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
    //                         </div>

    //                         {/* Editable Title */}
    //                         <EditableTextBlock
    //                             initialValue={meeting.title}
    //                             onSave={handleTitleSave}
    //                             tagName="h1"
    //                             className="text-3xl font-bold text-text-primary tracking-tight -ml-2 px-2 py-1 rounded-md transition-colors"
    //                             multiline={false}
    //                         />
    //                     </div>

    //                     {/* Moved Actions: Follow-up & Share (REMOVED per user request) */}
    //                     {/* <div className="flex items-center gap-2 mt-1"> ... </div> */}
    //                 </div>

    //                 {/* Tabs */}
    //                 {/* Designing Tabs to match reference 1:1 (Dark Pill Container) */}
    //                 <div className="flex items-center justify-between mb-8">
    //                     <div className={`p-1 rounded-xl inline-flex items-center gap-0.5 ${isLight ? 'bg-[#E5E5EA] border border-black/[0.04]' : 'bg-[#121214] border border-white/[0.08]'}`}>
    //                         {['summary', 'transcript', 'usage'].map((tab) => (
    //                             <button
    //                                 key={tab}
    //                                 onClick={() => setActiveTab(tab as any)}
    //                                 className={`
    //                                     relative px-3 py-1 text-[13px] font-medium rounded-lg transition-all duration-200 z-10
    //                                     ${activeTab === tab ? (isLight ? 'text-black' : 'text-[#E9E9E9]') : `${isLight ? 'text-text-secondary' : 'text-text-tertiary'} hover:text-text-primary`}
    //                                 `}
    //                             >
    //                                 {activeTab === tab && (
    //                                     <motion.div
    //                                         layoutId="activeTabBackground"
    //                                         className={`absolute inset-0 rounded-lg -z-10 shadow-sm ${isLight ? 'bg-white' : 'bg-[#3A3A3C]'}`}
    //                                         initial={false}
    //                                         transition={{ type: "spring", stiffness: 400, damping: 30 }}
    //                                     />
    //                                 )}
    //                                 {tab.charAt(0).toUpperCase() + tab.slice(1)}
    //                             </button>
    //                         ))}
    //                     </div>

    //                     {/* Copy Button - Inline with Tabs (Always visible) */}
    //                     <button
    //                         onClick={handleCopy}
    //                         className="flex items-center gap-2 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
    //                     >
    //                         {isCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
    //                         {isCopied ? 'Copied' : activeTab === 'summary' ? 'Copy full summary' : activeTab === 'transcript' ? 'Copy full transcript' : 'Copy usage'}
    //                     </button>
    //                 </div>

    //                 {/* Tab Content */}
    //                 <div className="space-y-8">
    //                     {/* Using standard divs for content, framer motion for layout */}
    //                     {activeTab === 'summary' && (
    //                         <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    //                             {/* Overview - Rendered as Markdown */}
    //                             <div className="mb-6 pb-6 border-b border-border-subtle prose prose-sm max-w-none">
    //                                 <ReactMarkdown
    //                                     remarkPlugins={[remarkGfm]}
    //                                     components={{
    //                                         h1: ({ node, ...props }) => <h1 className="text-xl font-bold text-text-primary mt-4 mb-2" {...props} />,
    //                                         h2: ({ node, ...props }) => <h2 className="text-lg font-semibold text-text-primary mt-4 mb-2" {...props} />,
    //                                         h3: ({ node, ...props }) => <h3 className="text-base font-semibold text-text-primary mt-3 mb-1" {...props} />,
    //                                         p: ({ node, ...props }) => <p className="text-sm text-text-secondary leading-relaxed mb-2" {...props} />,
    //                                         ul: ({ node, ...props }) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
    //                                         ol: ({ node, ...props }) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
    //                                         li: ({ node, ...props }) => <li className="text-sm text-text-secondary" {...props} />,
    //                                         strong: ({ node, ...props }) => <strong className="font-semibold text-text-primary" {...props} />,
    //                                         a: ({ node, ...props }) => <a className="text-blue-500 hover:underline" {...props} />,
    //                                     }}
    //                                 >
    //                                     {meeting.detailedSummary?.overview || ''}
    //                                 </ReactMarkdown>
    //                             </div>


    //                             {/* Action Items - Only show if there are items */}
    //                             {meeting.detailedSummary?.actionItems && meeting.detailedSummary.actionItems.length > 0 && (
    //                                 <section className="mb-8">
    //                                     <div className="flex items-center justify-between mb-4">
    //                                         <EditableTextBlock
    //                                             initialValue={meeting.detailedSummary?.actionItemsTitle || 'Action Items'}
    //                                             onSave={(val) => {
    //                                                 setMeeting(prev => ({
    //                                                     ...prev,
    //                                                     detailedSummary: { ...prev.detailedSummary!, actionItemsTitle: val }
    //                                                 }));
    //                                                 window.electronAPI?.updateMeetingSummary(meeting.id, { actionItemsTitle: val });
    //                                             }}
    //                                             tagName="h2"
    //                                             className="text-lg font-semibold text-text-primary -ml-2 px-2 py-1 rounded-sm transition-colors"
    //                                             multiline={false}
    //                                         />
    //                                     </div>
    //                                     <ul className="space-y-3">
    //                                         {meeting.detailedSummary.actionItems.map((item, i) => (
    //                                             <li key={i} className="flex items-start gap-3 group">
    //                                                 <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-blue-500 transition-colors shrink-0" />
    //                                                 <div className="flex-1">
    //                                                     <EditableTextBlock
    //                                                         initialValue={item}
    //                                                         onSave={(val) => handleActionItemSave(i, val)}
    //                                                         tagName="p"
    //                                                         className="text-sm text-text-secondary leading-relaxed -ml-2 px-2 rounded-sm transition-colors"
    //                                                         placeholder="Type an action item..."
    //                                                         onEnter={() => {
    //                                                             const newItems = [...(meeting.detailedSummary?.actionItems || [])];
    //                                                             newItems.splice(i + 1, 0, "");
    //                                                             setMeeting(prev => ({
    //                                                                 ...prev,
    //                                                                 detailedSummary: { ...prev.detailedSummary!, actionItems: newItems }
    //                                                             }));
    //                                                         }}
    //                                                     />
    //                                                 </div>
    //                                             </li>
    //                                         ))}
    //                                     </ul>
    //                                 </section>
    //                             )}

    //                             {/* Key Points - Only show if there are items */}
    //                             {meeting.detailedSummary?.keyPoints && meeting.detailedSummary.keyPoints.length > 0 && (
    //                                 <section>
    //                                     <div className="flex items-center justify-between mb-4">
    //                                         <EditableTextBlock
    //                                             initialValue={meeting.detailedSummary?.keyPointsTitle || 'Key Points'}
    //                                             onSave={(val) => {
    //                                                 setMeeting(prev => ({
    //                                                     ...prev,
    //                                                     detailedSummary: { ...prev.detailedSummary!, keyPointsTitle: val }
    //                                                 }));
    //                                                 window.electronAPI?.updateMeetingSummary(meeting.id, { keyPointsTitle: val });
    //                                             }}
    //                                             tagName="h2"
    //                                             className="text-lg font-semibold text-text-primary -ml-2 px-2 py-1 rounded-sm transition-colors"
    //                                             multiline={false}
    //                                         />
    //                                     </div>
    //                                     <ul className="space-y-3">
    //                                         {meeting.detailedSummary.keyPoints.map((item, i) => (
    //                                             <li key={i} className="flex items-start gap-3 group">
    //                                                 <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-purple-500 transition-colors shrink-0" />
    //                                                 <div className="flex-1">
    //                                                     <EditableTextBlock
    //                                                         initialValue={item}
    //                                                         onSave={(val) => handleKeyPointSave(i, val)}
    //                                                         tagName="p"
    //                                                         className="text-sm text-text-secondary leading-relaxed -ml-2 px-2 rounded-sm transition-colors"
    //                                                         placeholder="Type a key point..."
    //                                                         onEnter={() => {
    //                                                             const newItems = [...(meeting.detailedSummary?.keyPoints || [])];
    //                                                             newItems.splice(i + 1, 0, "");
    //                                                             setMeeting(prev => ({
    //                                                                 ...prev,
    //                                                                 detailedSummary: { ...prev.detailedSummary!, keyPoints: newItems }
    //                                                             }));
    //                                                         }}
    //                                                     />
    //                                                 </div>
    //                                             </li>
    //                                         ))}
    //                                     </ul>
    //                                 </section>
    //                             )}

    //                             {/* ── Deal Status ───────────────────────────────────── */}
    //                             {meeting.detailedSummary?.dealStatus && (
    //                                 <div className="mt-4 p-3 rounded-lg bg-white/5 border border-white/10">
    //                                     <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-1">Deal Stage</div>
    //                                     <span className="text-sm font-bold text-violet-400">{meeting.detailedSummary.dealStatus.stage}</span>
    //                                     <p className="text-sm text-white/70 mt-1">{meeting.detailedSummary.dealStatus.summary}</p>
    //                                 </div>
    //                             )}

    //                             {/* ── BANT ──────────────────────────────────────────── */}
    //                             {meeting.detailedSummary?.bant && (
    //                                 <div className="mt-4">
    //                                     <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">BANT Qualification</div>
    //                                     <div className="grid grid-cols-2 gap-2">
    //                                         {(['budget', 'authority', 'need', 'timeline'] as const).map(key => {
    //                                             const item = meeting.detailedSummary?.bant?.[key];
    //                                             if (!item) return null;
    //                                             const color = item.status === 'Clear' ? 'text-green-400' : item.status === 'Partial' ? 'text-yellow-400' : 'text-red-400';
    //                                             return (
    //                                                 <div key={key} className="p-2 rounded-lg bg-white/5 border border-white/10">
    //                                                     <div className="flex items-center justify-between mb-1">
    //                                                         <span className="text-xs font-semibold text-white/70 capitalize">{key}</span>
    //                                                         <span className={`text-xs font-bold ${color}`}>{item.status}</span>
    //                                                     </div>
    //                                                     <p className="text-xs text-white/50">{item.detail}</p>
    //                                                 </div>
    //                                             );
    //                                         })}
    //                                     </div>
    //                                 </div>
    //                             )}

    //                             {/* ── MEDDICC ───────────────────────────────────────── */}
    //                             {meeting.detailedSummary?.meddicc && (
    //                                 <div className="mt-4">
    //                                     <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">MEDDICC Qualification</div>
    //                                     <div className="flex flex-col gap-2">
    //                                         {(['metrics', 'economicBuyer', 'decisionCriteria', 'decisionProcess', 'identifyPain', 'champion', 'competition'] as const).map(key => {
    //                                             const item = meeting.detailedSummary?.meddicc?.[key];
    //                                             if (!item) return null;
    //                                             const color = item.status === 'Clear' ? 'text-green-400' : item.status === 'Partial' ? 'text-yellow-400' : 'text-red-400';
    //                                             const label = key.replace(/([A-Z])/g, ' $1').trim();
    //                                             return (
    //                                                 <div key={key} className="p-2 rounded-lg bg-white/5 border border-white/10 flex items-start gap-3">
    //                                                     <span className={`text-xs font-bold mt-0.5 w-14 shrink-0 ${color}`}>{item.status}</span>
    //                                                     <div>
    //                                                         <span className="text-xs font-semibold text-white/70 capitalize">{label}</span>
    //                                                         <p className="text-xs text-white/50 mt-0.5">{item.detail}</p>
    //                                                     </div>
    //                                                 </div>
    //                                             );
    //                                         })}
    //                                     </div>
    //                                     {meeting.detailedSummary.meddicc.gaps && meeting.detailedSummary.meddicc.gaps.length > 0 && (
    //                                         <div className="mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20">
    //                                             <div className="text-xs font-semibold text-red-400 mb-1">⚠ Gaps to address</div>
    //                                             {meeting.detailedSummary.meddicc.gaps.map((gap, i) => (
    //                                                 <div key={i} className="text-xs text-red-300">• {gap}</div>
    //                                             ))}
    //                                         </div>
    //                                     )}
    //                                 </div>
    //                             )}

    //                             {/* ── Follow-up Email ───────────────────────────────── */}
    //                             {meeting.detailedSummary?.followUpEmail?.sections && (
    //                                 <div className="mt-4">
    //                                     <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Follow-up Email Draft</div>
    //                                     {meeting.detailedSummary.followUpEmail.subject && (
    //                                         <div className="text-xs text-white/70 mb-2">
    //                                             <span className="font-semibold text-white/50">Subject: </span>
    //                                             {meeting.detailedSummary.followUpEmail.subject}
    //                                         </div>
    //                                     )}
    //                                     <div className="flex flex-col gap-2 p-3 rounded-lg bg-white/5 border border-white/10 text-xs text-white/70">
    //                                         {(['whatWeDiscussed', 'currentProcess', 'scopeOfImprovement', 'howOurSolutionHelps', 'expectedBusinessImpact', 'nextSteps'] as const).map(key => {
    //                                             const section = meeting.detailedSummary?.followUpEmail?.sections?.[key];
    //                                             if (!section || (Array.isArray(section) && section.length === 0)) return null;
    //                                             const label = key.replace(/([A-Z])/g, ' $1').trim();
    //                                             return (
    //                                                 <div key={key}>
    //                                                     <div className="font-semibold text-white/50 mb-1 capitalize">{label}</div>
    //                                                     {Array.isArray(section)
    //                                                         ? section.map((s, i) => <div key={i}>• {s}</div>)
    //                                                         : <div>{section}</div>
    //                                                     }
    //                                                 </div>
    //                                             );
    //                                         })}
    //                                     </div>
    //                                 </div>
    //                             )}

    //                             {/* ── Sales Coach Review ────────────────────────────── */}
    //                             {meeting.detailedSummary?.salesCoachReview && (
    //                                 <div className="mt-4">
    //                                     <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Sales Coach Review</div>
    //                                     {([
    //                                         { key: 'whatIDidRight', label: '✅ What I did right', color: 'text-green-400' },
    //                                         { key: 'whatICouldHaveDoneBetter', label: '🔶 What I could have done better', color: 'text-yellow-400' },
    //                                         { key: 'whatIMissedCompletely', label: '❌ What I missed completely', color: 'text-red-400' },
    //                                     ] as const).map(({ key, label, color }) => {
    //                                         const items = meeting.detailedSummary?.salesCoachReview?.[key];
    //                                         if (!items || items.length === 0) return null;
    //                                         return (
    //                                             <div key={key} className="mb-3">
    //                                                 <div className={`text-xs font-semibold mb-1 ${color}`}>{label}</div>
    //                                                 {items.map((item, i) => (
    //                                                     <div key={i} className="text-xs text-white/60 mb-0.5">• {item}</div>
    //                                                 ))}
    //                                             </div>
    //                                         );
    //                                     })}
    //                                 </div>
    //                             )}

    //                             {/* ── Next Call Playbook ────────────────────────────── */}
    //                             {meeting.detailedSummary?.nextCallPlaybook && (
    //                                 <div className="mt-4 p-3 rounded-lg bg-violet-500/10 border border-violet-500/20">
    //                                     <div className="text-xs font-semibold text-violet-400 uppercase tracking-wider mb-2">Next Call Playbook</div>
    //                                     {meeting.detailedSummary.nextCallPlaybook.openingRecap && (
    //                                         <div className="mb-3">
    //                                             <div className="text-xs font-semibold text-white/50 mb-1">Opening Recap</div>
    //                                             <p className="text-xs text-white/70">{meeting.detailedSummary.nextCallPlaybook.openingRecap}</p>
    //                                         </div>
    //                                     )}
    //                                     {meeting.detailedSummary.nextCallPlaybook.questionsToAsk && (
    //                                         <div className="mb-3">
    //                                             <div className="text-xs font-semibold text-white/50 mb-1">Questions to Ask</div>
    //                                             {meeting.detailedSummary.nextCallPlaybook.questionsToAsk.map((q, i) => (
    //                                                 <div key={i} className="text-xs text-white/70 mb-0.5">• {q}</div>
    //                                             ))}
    //                                         </div>
    //                                     )}
    //                                     {meeting.detailedSummary.nextCallPlaybook.valueAndROI && (
    //                                         <div>
    //                                             <div className="text-xs font-semibold text-white/50 mb-1">Value & ROI to Reinforce</div>
    //                                             {meeting.detailedSummary.nextCallPlaybook.valueAndROI.quantitative?.map((v, i) => (
    //                                                 <div key={i} className="text-xs text-white/70 mb-0.5">📊 {v}</div>
    //                                             ))}
    //                                             {meeting.detailedSummary.nextCallPlaybook.valueAndROI.qualitative?.map((v, i) => (
    //                                                 <div key={i} className="text-xs text-white/70 mb-0.5">💡 {v}</div>
    //                                             ))}
    //                                         </div>
    //                                     )}
    //                                 </div>
    //                             )}
    //                         </motion.div>
    //                     )}

    //                     {activeTab === 'transcript' && (
    //                         <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    //                             <div className="space-y-6">
    //                                 {(() => {
    //                                     console.log('Raw Transcript:', meeting.transcript);
    //                                     const filteredTranscript = meeting.transcript?.filter(entry => {
    //                                         const isHidden = ['system', 'ai', 'assistant', 'model'].includes(entry.speaker?.toLowerCase());
    //                                         if (isHidden) console.log('Filtered out:', entry);
    //                                         return !isHidden;
    //                                     }) || [];
    //                                     console.log('Filtered Transcript:', filteredTranscript);

    //                                     if (filteredTranscript.length === 0) {
    //                                         return <p className="text-text-tertiary">No transcript available.</p>;
    //                                     }

    //                                     return filteredTranscript.map((entry, i) => (
    //                                         <div key={i} className="group">
    //                                             <div className="flex items-center gap-2 mb-1">
    //                                                 <span className="text-xs font-semibold text-text-secondary">
    //                                                     {entry.speaker === 'user' ? 'Me' : 'Them'}
    //                                                 </span>
    //                                                 <span className="text-xs text-text-tertiary font-mono">{entry.timestamp ? formatTime(entry.timestamp) : '0:00'}</span>
    //                                             </div>
    //                                             <p className="text-text-secondary text-[15px] leading-relaxed transition-colors select-text cursor-text">{entry.text}</p>
    //                                         </div>
    //                                     ));
    //                                 })()}
    //                             </div>
    //                         </motion.section>
    //                     )}

    //                     {activeTab === 'usage' && (
    //                         <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-8 pb-10">
    //                             {meeting.usage?.map((interaction, i) => (
    //                                 <div key={i} className="space-y-4">
    //                                     {/* User Question */}
    //                                     {interaction.question && (
    //                                         <div className="flex justify-end">
    //                                             <div className="bg-accent-primary text-white px-5 py-2.5 rounded-2xl rounded-tr-sm max-w-[80%] text-[15px] leading-relaxed shadow-sm">
    //                                                 {interaction.question}
    //                                             </div>
    //                                         </div>
    //                                     )}

    //                                     {/* AI Answer */}
    //                                     {interaction.answer && (
    //                                         <div className="flex items-start gap-4">
    //                                             <div className="mt-1 w-6 h-6 rounded-full bg-bg-input flex items-center justify-center border border-border-subtle shrink-0">
    //                                                 <img src={NativelyLogo} alt="AI" className="w-4 h-4 opacity-50 object-contain force-black-icon" />
    //                                             </div>
    //                                             <div>
    //                                                 <div className="text-[11px] text-text-tertiary mb-1.5 font-medium">{formatTime(interaction.timestamp)}</div>
    //                                                 <div className="text-text-secondary text-[15px] leading-relaxed max-w-none">
    //                                                     <ReactMarkdown
    //                                                         remarkPlugins={[remarkGfm]}
    //                                                         components={{
    //                                                             h1: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
    //                                                             h2: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
    //                                                             h3: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
    //                                                             p: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
    //                                                             ul: ({ node, ...props }) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
    //                                                             ol: ({ node, ...props }) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
    //                                                             li: ({ node, ...props }) => <li className="text-[15px] text-text-secondary font-normal" {...props} />,
    //                                                             strong: ({ node, ...props }) => <span className="font-normal text-text-secondary" {...props} />,
    //                                                             a: ({ node, ...props }: any) => <a className="text-blue-500 hover:underline" {...props} />,
    //                                                             pre: ({ children }: any) => <div className="not-prose mb-4">{children}</div>,
    //                                                             code: ({ node, inline, className, children, ...props }: any) => {
    //                                                                 const match = /language-(\w+)/.exec(className || '');
    //                                                                 const isInline = inline ?? false;
    //                                                                 const lang = match ? match[1] : '';

    //                                                                 return !isInline ? (
    //                                                                     <div className="my-3 rounded-xl overflow-hidden border border-white/[0.08] shadow-lg bg-zinc-800/60 backdrop-blur-md">
    //                                                                         <div className="bg-white/[0.04] px-3 py-1.5 border-b border-white/[0.08]">
    //                                                                             <span className="text-[10px] uppercase tracking-widest font-semibold text-white/40 font-mono">
    //                                                                                 {lang || 'CODE'}
    //                                                                             </span>
    //                                                                         </div>
    //                                                                         <div className="bg-transparent">
    //                                                                             <SyntaxHighlighter
    //                                                                                 language={lang || 'text'}
    //                                                                                 style={vscDarkPlus}
    //                                                                                 customStyle={{
    //                                                                                     margin: 0,
    //                                                                                     borderRadius: 0,
    //                                                                                     fontSize: '13px',
    //                                                                                     lineHeight: '1.6',
    //                                                                                     background: 'transparent',
    //                                                                                     padding: '16px',
    //                                                                                     fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    //                                                                                 }}
    //                                                                                 wrapLongLines={true}
    //                                                                                 showLineNumbers={true}
    //                                                                                 lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: 'rgba(255,255,255,0.2)', textAlign: 'right', fontSize: '11px' }}
    //                                                                                 {...props}
    //                                                                             >
    //                                                                                 {String(children).replace(/\n$/, '')}
    //                                                                             </SyntaxHighlighter>
    //                                                                         </div>
    //                                                                     </div>
    //                                                                 ) : (
    //                                                                     <code className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[13px] font-mono text-text-primary border border-border-subtle whitespace-pre-wrap" {...props}>
    //                                                                         {children}
    //                                                                     </code>
    //                                                                 );
    //                                                             }
    //                                                         }}
    //                                                     >
    //                                                         {cleanMarkdown(interaction.answer || '')}
    //                                                     </ReactMarkdown>
    //                                                 </div>
    //                                             </div>
    //                                         </div>
    //                                     )}
    //                                 </div>
    //                             ))}
    //                             {!meeting.usage?.length && <p className="text-text-tertiary">No usage history.</p>}
    //                         </motion.section>
    //                     )}
    //                 </div>
    //             </motion.div>
    //         </main>

    //         {/* Floating Footer (Ask Bar) */}
    //         <div className={`absolute bottom-0 left-0 right-0 p-6 flex justify-center pointer-events-none ${isChatOpen ? 'z-50' : 'z-20'}`}>
    //             <div className="w-full max-w-[440px] relative group pointer-events-auto">
    //                 {/* Dark Glass Effect Input (Matching Reference) */}
    //                 <input
    //                     type="text"
    //                     value={query}
    //                     onChange={(e) => setQuery(e.target.value)}
    //                     onKeyDown={handleInputKeyDown}
    //                     placeholder="Ask about this meeting..."
    //                     className="w-full pl-5 pr-12 py-3 bg-transparent backdrop-blur-[24px] backdrop-saturate-[140%] shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-white/20 rounded-full text-sm text-text-primary placeholder-text-tertiary/70 focus:outline-none transition-shadow duration-200"
    //                 />
    //                 <button
    //                     onClick={handleSubmitQuestion}
    //                     className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all duration-200 border border-white/5 ${query.trim() ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-primary hover:bg-bg-item-hover'
    //                         }`}
    //                 >
    //                     <ArrowUp size={16} className="transform rotate-45" />
    //                 </button>
    //             </div>
    //         </div>

    //         {/* Chat Overlay */}
    //         <MeetingChatOverlay
    //             isOpen={isChatOpen}
    //             onClose={() => {
    //                 setIsChatOpen(false);
    //                 setQuery('');
    //                 setSubmittedQuery('');
    //             }}
    //             meetingContext={{
    //                 id: meeting.id,  // Required for RAG queries
    //                 title: meeting.title,
    //                 summary: meeting.detailedSummary?.overview,
    //                 keyPoints: meeting.detailedSummary?.keyPoints,
    //                 actionItems: meeting.detailedSummary?.actionItems,
    //                 transcript: meeting.transcript
    //             }}
    //             initialQuery={submittedQuery}
    //             onNewQuery={(newQuery) => {
    //                 setSubmittedQuery(newQuery);
    //             }}
    //         />
    //     </div>
    // );
};

export default MeetingDetails;
