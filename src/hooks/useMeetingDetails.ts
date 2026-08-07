/**
 * useMeetingDetails.ts
 *
 * Owns everything MeetingDetails needs that isn't pure rendering:
 *  - reconciling the post-call "processing" skeleton with the backend
 *  - HTTP detail fetch (React Query) + local-SQLite transcript fallback
 *  - the dedicated-table scorecard fetch (IPC, not HTTP)
 *  - title/summary edit mutations (optimistic, HTTP-canonical + IPC write-through)
 *  - the Ask-Dojo (usage tab) history fetch
 *  - copy-to-clipboard formatting per tab
 *  - regenerate-summary
 *  - talk-time computation
 *  - speaker display-name resolution (diarization-aware)
 *
 * MeetingDetails.tsx (and its tab components) just render what this returns.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { meetingsApi } from '@/api';
import { guardSession } from '@/lib/firebase';
import type { Meeting, MeetingTranscriptLine, MeetingScorecardResult } from '@/types';

export const formatTime = (ms: number) => {
    const date = new Date(ms);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();
};

export const cleanMarkdown = (content: string) => {
    if (!content) return '';
    // Ensure code blocks are on new lines to fix rendering issues
    return content.replace(/([^\n])```/g, '$1\n\n```');
};

// ─── Check if a detailedSummary exists but has no meaningful data ──────────────
export function isSummaryEmpty(ds: NonNullable<Meeting['detailedSummary']>): boolean {
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

function computeTalkTime(transcript: { speaker: string; text: string; timestamp: number }[] | undefined) {
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
        userWords,
        clientWords,
    };
}

export type MeetingDetailsTab = 'summary' | 'transcript' | 'usage' | 'analysis';

export function useMeetingDetails(initialMeeting: Meeting) {
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
    const { data: meetingData = initialMeeting, isLoading: isLoadingMeetingDetail } = useQuery<Meeting>(
        meetingKey,
        () => meetingsApi.get(initialMeeting.id),
        { initialData: initialMeeting, enabled: !isProcessing },
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
    const [activeTab, setActiveTab] = useState<MeetingDetailsTab>('summary');

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
    const [chatMessages, setChatMessages] = useState<import('@/types').MeetingChatMessage[]>([]);
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
                    { label: '✅ WHAT I DID RIGHT', items: ds.salesCoachReview.whatIDidRight },
                    { label: '⚠️ WHAT I COULD HAVE DONE BETTER', items: ds.salesCoachReview.whatICouldHaveDoneBetter },
                    { label: '❌ WHAT I MISSED COMPLETELY', items: ds.salesCoachReview.whatIMissedCompletely },
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
                        roiParts.push(`    Quantitative:\n${roi.quantitative.map(q => `      • ${q}`).join('\n')}`);
                    }
                    if (roi.qualitative?.length) {
                        roiParts.push(`    Qualitative:\n${roi.qualitative.map(q => `      • ${q}`).join('\n')}`);
                    }
                    if (roiParts.length) {
                        parts.push(`  VALUE & ROI:\n${roiParts.join('\n')}`);
                    }
                }

                return parts.join('\n\n');
            };

            textToCopy = `
${meeting.title.toUpperCase()}
${new Date(meeting.date).toLocaleDateString()}

OVERVIEW
${ds.overview || 'No overview available.'}

KEY POINTS
${formatList(ds.keyPoints)}

ACTION ITEMS
${formatList(ds.actionItems)}

BANT
${formatBANT()}

MEDDICC
${formatMEDDICC()}

DEAL STATUS
  Stage: ${ds.dealStatus?.stage || 'Unknown'}
  ${ds.dealStatus?.summary || ''}

SALES COACH REVIEW
${formatSalesCoachReview() || '  None'}

NEXT CALL PLAYBOOK
${formatNextCallPlaybook() || '  None'}
            `
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

    const talkTime = useMemo(() => computeTalkTime(meeting.transcript), [meeting.transcript]);

    return {
        meeting,
        isProcessing,
        isLoadingMeetingDetail,
        scorecard,
        activeTab, setActiveTab,
        aiInteractionsData, isLoadingAiInteractions,
        query, setQuery,
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
        handleSubmitQuestion,
        handleInputKeyDown,
        handleCopy,
        handleTitleSave,
        handleActionItemSave,
        handleKeyPointSave,
        handleRegenerateSummary,
        handleFollowUpEmail,
        summaryMutation,
        queryClient,
        meetingKey,
    };
}