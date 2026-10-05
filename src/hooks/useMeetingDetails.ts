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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { meetingsApi, chatApi } from '@/api';
import { isMeetingProcessing } from '@/api/meetingMapping';
import { guardSession } from '@/lib/firebase';
import type { CompanyRef, Meeting, MeetingTranscriptLine, MeetingScorecardResult } from '@/types';
import { fieldEvidenceList, fieldSummary, fieldText } from '@/lib/bantMeddic';
import { deriveProcessingStage, hasGeneratedSummary, PROCESSING_STALL_TIMEOUT_MS } from '@/lib/meetingLifecycle';
import { filledCoachQuestions, coachQuestionText, coachPromises, parseCoachNoteItem, /* parseCoachHighlight, */ callInvolves, type ParsedCoachNote } from '@/lib/coachSummary';
import { classifyLLMError } from '@/lib/utils';
import { splitRepFollowUps } from '@/lib/objections';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import { createSpeakerLabeler, formatTime, formatTranscriptForCopy, formatTranscriptTimestamp, transcriptTimesAreRelative as computeTranscriptTimesAreRelative } from '@/lib/transcriptLabels';

// Label/time formatting lives in lib/transcriptLabels so the PDF export renders transcripts
// identically to the Transcript tab. Re-exported here for existing importers (@/hooks).
export { formatTime, formatTranscriptTimestamp };

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
        !ds.salesCoachReview?.whatIDidRight?.some(s => typeof s === 'string' ? s?.trim() : !!(s && (s.moment || s.why))) &&
        !ds.salesCoachReview?.whatICouldHaveDoneBetter?.some(s => s?.trim()) &&
        !ds.salesCoachReview?.whatIMissedCompletely?.some(s => s?.trim()) &&
        !ds.nextCallPlaybook?.callGoal?.trim() &&
        !ds.nextCallPlaybook?.openingRecap?.trim() &&
        !filledCoachQuestions(ds.nextCallPlaybook?.questionsToAsk) &&
        !(ds.nextCallPlaybook?.valueAndROI?.quantitative?.length || ds.nextCallPlaybook?.valueAndROI?.qualitative?.length) &&
        !ds.openLoops?.length &&
        !ds.promises?.length &&
        !ds.demoReview?.reactions?.length &&
        !ds.demoReview?.successCriteria?.length &&
        !(ds.negotiation?.terms?.length || ds.negotiation?.trades?.length || ds.negotiation?.limit?.trim() || ds.negotiation?.pathToSignature?.length)
    );
}

/**
 * Collapses exact back-to-back duplicate transcript lines — same speaker,
 * same text, timestamps within 500ms of each other — regardless of which
 * source (local SQLite or the backend/Supabase mirror) produced them.
 *
 * Mirrors the same adjacency + threshold rule SessionTracker.addTranscript
 * already uses on the capture side, so a transcript is deduped consistently
 * no matter where the duplication actually originates: a capture-time
 * double-emit that slipped past that check, or the Supabase mirror pipeline
 * re-enqueuing the same rows (e.g. from saveMeeting()'s placeholder-save +
 * final-save sequence) without the local-side "clear before reinsert"
 * transaction that keeps SQLite itself duplicate-free.
 *
 * Only ever removes an EXACT adjacent repeat — a phrase legitimately spoken
 * again later in the conversation, with other lines in between, is untouched.
 */
function dedupeTranscript<T extends { speaker: string; text: string; timestamp: number }>(
    transcript: T[] | undefined,
): T[] {
    if (!transcript || transcript.length === 0) return transcript ?? [];
    const result: T[] = [];
    for (const seg of transcript) {
        const prev = result[result.length - 1];
        if (
            prev &&
            prev.speaker === seg.speaker &&
            prev.text === seg.text &&
            Math.abs(prev.timestamp - seg.timestamp) < 500
        ) {
            continue; // exact adjacent duplicate — drop it
        }
        result.push(seg);
    }
    return result;
}

export interface TalkTimeSpeaker {
    /** Internal role — drives colour + which name-resolution path is used. */
    speaker: 'user' | 'client';
    displayName?: string;
    speakerIndex?: number;
    words: number;
    percent: number;
}

const INTERNAL_SPEAKERS = new Set(['system', 'ai', 'assistant', 'model']);

/**
 * Per-SPEAKER talk time, not per-channel. Segments are grouped by their
 * resolved identity — the original label when present (uploaded transcripts
 * carry real names: "Alex", "Daniel", "Lara") or role+dial index otherwise —
 * so multi-party calls and 3+ speaker uploads each get their own row
 * ("Alex — 213 words · 54%"), and the sales/client split stays driven by the
 * parser's first-speaker=mic-user rule rather than guesswork.
 */
export function computeTalkTime(
    transcript: { speaker: string; text: string; displayName?: string; speakerIndex?: number }[] | undefined
): { speakers: TalkTimeSpeaker[]; totalWords: number } {
    if (!transcript || transcript.length === 0) return { speakers: [], totalWords: 0 };
    const groups = new Map<string, TalkTimeSpeaker>();
    for (const seg of transcript) {
        const raw = (seg.speaker || '').toLowerCase();
        if (INTERNAL_SPEAKERS.has(raw)) continue; // system/AI turns are not participants
        if (!seg.text?.trim()) continue;
        const role: 'user' | 'client' = raw === 'user' ? 'user' : 'client';
        const key = `${role}::${seg.displayName ?? '∅'}::${seg.speakerIndex ?? '∅'}`;
        const words = seg.text.trim().split(/\s+/).filter(Boolean).length;
        const existing = groups.get(key);
        if (existing) {
            existing.words += words;
        } else {
            groups.set(key, { speaker: role, displayName: seg.displayName, speakerIndex: seg.speakerIndex, words, percent: 0 });
        }
    }
    const speakers = [...groups.values()];
    const totalWords = speakers.reduce((sum, s) => sum + s.words, 0);
    if (totalWords > 0) {
        for (const s of speakers) s.percent = Math.round((s.words / totalWords) * 100);
    }
    return { speakers, totalWords };
}

export type MeetingDetailsTab = 'summary' | 'transcript' | 'usage' | 'analysis';

// Initial page size and the "Load more" step for the Ask Dojo history —
// matches the backend's default page (?limit=50).
const AI_INTERACTIONS_PAGE_SIZE = 50;

export function useMeetingDetails(initialMeeting: Meeting) {
    const queryClient = useQueryClient();
    const meetingKey = ["meeting", initialMeeting.id];

    // 'live-meeting-current' is a local-only RAG session key (see RAGManager /
    // VectorStore) used while a call is still in progress and the meeting row
    // doesn't exist in the backend yet — there is no GET /meetings/{id} (or
    // .../ai-interactions) route for it. Guard both HTTP queries below so we
    // never fire a request for it.
    const isLiveMeetingPlaceholder = initialMeeting.id === 'live-meeting-current';

    // Same problem as `isLiveMeetingPlaceholder` above, for the other kind of
    // client-only id: useLauncher.ts prepends a `Meeting` with id
    // `optimistic-live-call` (post-call processing skeleton) or
    // `optimistic-upload-${Date.now()}` (transcript upload) the instant the
    // placeholder is created, well before the backend has a row for it.
    const isOptimisticMeetingId = (id?: string) => !!id && id.startsWith('optimistic-');

    // Tracks the post-call processing skeleton. While processing we don't fetch detail
    // over HTTP (the row may not be in the backend yet); the onMeetingsUpdated effect
    // below pulls it once main signals it's ready.
    const [isProcessing, setIsProcessing] = useState<boolean>(
        isMeetingProcessing(initialMeeting)
    );

    // Full detail (transcript + usage) loads over HTTP; the list row seeds initialData so
    // the view renders instantly, then reconciles with the backend.
    const canFetchDetail = !isLiveMeetingPlaceholder && !isOptimisticMeetingId(initialMeeting.id);
    const { data: meetingData = initialMeeting, isLoading: isLoadingMeetingDetail, dataUpdatedAt } = useQuery<Meeting>(
        meetingKey,
        () => meetingsApi.get(initialMeeting.id),
        {
            initialData: initialMeeting,
            // CRITICAL: without this, react-query v3 stamps `dataUpdatedAt`
            // with Date.now() the moment initialData is registered — so
            // `dataUpdatedAt > 0` (checked below) becomes true on the very
            // first render, before ANY fetch has run. Downstream that made
            // `isDetailResolved` true while the placeholder still had no
            // summary, which flashed "No summary yet" (with a Generate
            // button) for the few seconds the real GET /meetings/{id} took
            // to land — most visible for slim list rows and the AE
            // drill-down's placeholder meetings, which never carry
            // summary_json. With `initialDataUpdatedAt: 0`, dataUpdatedAt
            // stays 0 until a REAL fetch completes (or the unblock
            // setQueryData below runs), which is what both consumers below
            // always meant. Staleness is unaffected: staleTime is already 0,
            // so the mount refetch behaves exactly as before.
            initialDataUpdatedAt: 0,
            enabled: !isProcessing && canFetchDetail,
        },
    );

    // Has the detail read actually produced a result for this meeting?
    //
    // `isLoadingMeetingDetail` cannot answer that: `initialData` makes it false
    // on the very first render, and a *disabled* query (during isProcessing) is
    // `idle`, which is also not "loading". `dataUpdatedAt` is the only honest
    // signal — react-query stamps it on a completed fetch AND on the
    // `setQueryData` the unblock effect below performs, which are precisely the
    // two ways real detail data arrives. (initialData itself does NOT count:
    // `initialDataUpdatedAt: 0` above keeps the mount-time placeholder from
    // stamping it.) Ids with no backend row can never resolve that way, so they
    // count as resolved and render the list row.
    const isDetailResolved = !canFetchDetail || dataUpdatedAt > 0;

    // Company resolution, deliberately SEPARATE from the detail query above.
    //
    // Two reasons the chip could otherwise never show an association:
    //  1. the detail query is `enabled: !isProcessing`, so for the whole
    //     processing window the view renders the stale list-row prop, and
    //  2. every local/IPC read (DatabaseManager, SupabaseReadService) omits
    //     `company` — neither selects company_id — so unblockFromLocal can't
    //     supply it either.
    // The backend (attach_companies) is the only source, and for an uploaded
    // transcript the association is written asynchronously AFTER the row
    // syncs, so this polls until it resolves rather than reading once.
    const { data: resolvedCompany } = useQuery<CompanyRef | null>(
        ["meeting-company", initialMeeting.id],
        async () => (await meetingsApi.get(initialMeeting.id)).company ?? null,
        {
            enabled: canFetchDetail && !meetingData.company,
            retry: 2,
            refetchInterval: (data) => (data ? false : 15_000),
            refetchOnWindowFocus: true,
        },
    );

    // /chat/live interaction_ids collected during the live call can't be
    // linked to a meeting until the backend actually has that meeting row —
    // useFloatingDock.ts only persists them locally at call-end (see
    // PendingLiveChatStore.ts). `meetingData` is seeded via `initialData`
    // above and stays truthy even before a real network fetch resolves, so
    // gate on `dataUpdatedAt > 0` — with `initialDataUpdatedAt: 0` (see the
    // query options above) that only happens after an actual completed query,
    // which IS the confirmation the backend has synced this meeting. (Before
    // that flag, initialData stamped dataUpdatedAt at mount and this effect
    // fired prematurely — 404 against a not-yet-mirrored row, retried later
    // by the 15s sweep, but noisy and racy.)
    useEffect(() => {
        if (isProcessing || dataUpdatedAt === 0 || meetingData.id !== initialMeeting.id) return;

        (async () => {
            const pendingIds = await window.electronAPI?.getPendingLiveChatInteractions?.(initialMeeting.id);
            if (!pendingIds || pendingIds.length === 0) return;

            try {
                await chatApi.linkMeetingInteractions(initialMeeting.id, pendingIds);
                await window.electronAPI?.clearPendingLiveChatInteractions?.(initialMeeting.id);
            } catch (err) {
                // Leave them in the pending store on failure — this effect will
                // just retry next time the meeting is opened.
                console.error('[useMeetingDetails] failed to link pending live chat interactions', err);
            }
        })();
    }, [isProcessing, dataUpdatedAt, meetingData.id, initialMeeting.id]);

    // A meeting opened while its backend row was still mirroring has a detail
    // cache seeded from the list row (no company). When the mirror lands —
    // and, for uploads, when the deferred association is written just after —
    // re-read rather than waiting for the next mount.
    useEffect(() => {
        if (!canFetchDetail) return;
        const off = window.electronAPI?.onMeetingBackendReady?.(({ meetingId }) => {
            if (meetingId !== initialMeeting.id) return;
            void queryClient.invalidateQueries(meetingKey);
            void queryClient.invalidateQueries(["meeting-company", initialMeeting.id]);
        });
        return () => { off?.(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canFetchDetail, initialMeeting.id]);

    // The HTTP transcript depends on the Supabase mirror having already synced this
    // meeting's transcript rows — fire-and-forget, and can lag behind (or, for some
    // rows, never catch up to) the local save. Local SQLite is the actual source of
    // truth and always has the transcript the instant a meeting finishes (written
    // synchronously in saveMeeting's transaction), so fall back to it — same
    // "local-first, cloud is just a mirror" precedent already used for scorecard
    // below via meeting:getScorecard.
    //
    // Deliberately NOT gated on `!isProcessing`: the transcript is written to local
    // SQLite synchronously the moment the meeting ends, well before summary
    // generation (isProcessing) finishes. Requiring `!isProcessing` here made the
    // Transcript tab wait on an unrelated background job for no reason — the user
    // should see it immediately, even while "Processing..." is still showing for
    // the summary tab.
    const needsLocalTranscript = !!initialMeeting.id && (meetingData.transcript?.length ?? 0) === 0;
    const { data: localTranscript, isLoading: isLoadingLocalTranscript } = useQuery<MeetingTranscriptLine[] | null>(
        ["meeting-local-transcript", initialMeeting.id],
        async () => {
            // Read the local SQLite copy first: the placeholder row saved the instant
            // the call ended already carries the full transcript, while the Supabase
            // mirror (which window.electronAPI.getMeetingDetails prefers) only gets
            // the meetings row and its transcript batch when the async outbox drains
            // — a cloud read in that window returns null or a transcript-less
            // meeting, which is exactly the state a processing meeting is opened in.
            const localDetails = await window.electronAPI?.getMeetingDetailsLocal?.(initialMeeting.id);
            if (localDetails?.transcript?.length) return localDetails.transcript as MeetingTranscriptLine[];
            // No local row (e.g. meeting created on another device) — cloud copy.
            const details = await window.electronAPI?.getMeetingDetails?.(initialMeeting.id);
            return details?.transcript ?? null;
        },
        {
            enabled: needsLocalTranscript,
            // Summary processing can still be writing to this meeting's row in the
            // background; poll briefly so the transcript tab catches up to any
            // late-arriving segments without requiring isProcessing to resolve first.
            refetchInterval: (data) => (needsLocalTranscript && (!data || data.length === 0) ? 2000 : false),
        },
    );
    // Every existing `meeting.transcript` reference below transparently gets the
    // fallback via this merged value — no need to touch each call site.
    //
    // Local is the source of truth once we have it, full stop — NOT just while
    // `needsLocalTranscript` (i.e. while the backend transcript is still empty).
    // `needsLocalTranscript` only gates whether the local-transcript query is
    // *enabled* (see above); it flips to `false` the moment the backend's
    // summary_json comes back with its own (Supabase-mirrored, sometimes
    // differently-chunked) transcript array. Selecting on it here meant that
    // as soon as that happened we'd swap from the local transcript to the
    // backend one, which the user would see as the transcript changing shape /
    // duplicating rather than a clean overwrite. Once `localTranscript` is
    // populated, keep showing it — don't fall back to `meetingData.transcript`.
    //
    // dedupeTranscript() is a second, independent safety net: whichever source
    // ends up being used (local OR the Supabase-mirrored backend copy, if the
    // mirror pipeline enqueues the same segments more than once — see its own
    // comment), collapse exact back-to-back duplicate lines before they ever
    // reach the UI. This does NOT change which source is picked — that logic
    // above is untouched — it only cleans the result of whichever one wins.
    const meeting: Meeting = useMemo(
        () => {
            const base =
                localTranscript && localTranscript.length > 0
                    ? { ...meetingData, transcript: dedupeTranscript(localTranscript) }
                    : { ...meetingData, transcript: dedupeTranscript(meetingData.transcript) };
            // Only ever FILLS a gap — a company already on meetingData (the
            // canonical detail read, or the optimistic paint after an edit)
            // always wins over the poll's copy.
            return base.company ? base : { ...base, company: resolvedCompany ?? null };
        },
        [meetingData, localTranscript, resolvedCompany]
    );

    // Drives the Transcript tab's own skeleton — deliberately NOT the same
    // flag as isLoadingMeetingDetail (that's the backend HTTP fetch, and is
    // often already `false` while we're still waiting on the local IPC
    // fetch, e.g. because the main query is disabled during isProcessing).
    // The transcript is local-first, so loading should reflect "is the
    // *initial* local-transcript fetch still in flight" — isLoading is only
    // true for that first attempt, not for the background refetchInterval
    // polling above, so a genuinely transcript-less meeting still settles
    // into a real empty state instead of spinning forever.
    const isLoadingTranscript =
        (meeting.transcript?.length ?? 0) === 0 &&
        ((needsLocalTranscript && isLoadingLocalTranscript) || isLoadingMeetingDetail);

    // Scorecard is handled locally (IPC), NOT over HTTP: the backend's GET /meetings/{id}
    // only serves summary_json, while the scorecard lives in the dedicated
    // meeting_scorecards table. meeting:getScorecard reads Supabase first (other devices'
    // scorecards) and falls back to local SQLite.
    const scorecardKey = ["meeting-scorecard", initialMeeting.id];
    const scorecardEnabled = !!initialMeeting.id && !isOptimisticMeetingId(initialMeeting.id);
    const {
        data: localScorecard = null,
        dataUpdatedAt: scorecardUpdatedAt,
        isFetching: isFetchingScorecard,
    } = useQuery<MeetingScorecardResult | null>(
        scorecardKey,
        async () => {
            const res = await window.electronAPI?.meetingGetScorecard?.(initialMeeting.id);
            return res?.success ? (res.data ?? null) : null;
        },
        {
            // Deliberately NOT gated on `!isProcessing` any more. processAndSaveMeeting
            // persists the scorecard row as soon as scoring finishes, while the summary
            // is still in its generate → verify loop — so this row appearing while
            // `is_processed` is still 0 is the one real, observable signal of which half
            // of the background work is left. Polling for it is what lets the UI say
            // "Validating summary" honestly instead of animating a fake stage.
            enabled: scorecardEnabled,
            refetchInterval: isProcessing ? 2500 : false,
        },
    );
    // Prefer the dedicated-table scorecard; the summary_json-embedded blob is only the
    // legacy / DB-write-failure fallback (same precedence as DatabaseManager.getMeetingDetails).
    const scorecard: MeetingScorecardResult | null =
        localScorecard ?? meeting.detailedSummary?.scorecard ?? null;

    // Has the scorecard read settled? `!isFetchingScorecard` matters as much as
    // `scorecardUpdatedAt > 0`: the unblock effect and regenerate both invalidate
    // this key, and a stale `null` from a poll taken mid-processing would
    // otherwise count as "resolved" and paint the summary before the real score
    // arrived a moment later.
    const isScorecardResolved = !scorecardEnabled || (scorecardUpdatedAt > 0 && !isFetchingScorecard);

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
    const askDojoEnabled =
        activeTab === 'usage' &&
        !!meeting?.id &&
        !isLiveMeetingPlaceholder &&
        !isOptimisticMeetingId(meeting?.id) &&
        !isProcessing;
    // "Load more" for the Ask Dojo history follows the meetings-list pattern
    // (useLauncher): the backend has no offset/cursor param, only ?limit=N
    // returning the N most recent interactions, so paging further just means
    // asking for a bigger N. The limit lives in a ref, not state, so the
    // refetch in loadMoreAiInteractions reads the bumped value synchronously
    // instead of racing the next render's queryFn closure.
    const aiInteractionsLimitRef = useRef(AI_INTERACTIONS_PAGE_SIZE);
    // The limit is per-meeting — reset it when the meeting changes so a
    // different meeting's tab starts from a fresh first page.
    useEffect(() => {
        aiInteractionsLimitRef.current = AI_INTERACTIONS_PAGE_SIZE;
    }, [meeting?.id]);
    const {
        data: aiInteractionsData,
        isLoading: isLoadingAiInteractions,
        isFetching: isFetchingAiInteractions,
        dataUpdatedAt: aiInteractionsUpdatedAt,
        error: aiInteractionsError,
    } = useQuery(
        ['ai-interactions', meeting?.id],
        () => meetingsApi.getAiInteractions(meeting!.id, aiInteractionsLimitRef.current),
        {
            enabled: askDojoEnabled,
            staleTime: 30_000,
        }
    );
    // A full page (exactly `limit` rows) is the only signal available that
    // there might be more beyond it — the response carries no total count or
    // cursor. Once a page comes back short, there's nothing further to load.
    const hasMoreAiInteractions = (aiInteractionsData?.items?.length ?? 0) >= aiInteractionsLimitRef.current;
    const isLoadingMoreAiInteractions = isFetchingAiInteractions && aiInteractionsLimitRef.current > AI_INTERACTIONS_PAGE_SIZE;
    const loadMoreAiInteractions = () => {
        aiInteractionsLimitRef.current += AI_INTERACTIONS_PAGE_SIZE;
        void queryClient.refetchQueries(['ai-interactions', meeting?.id]);
    };

    // The tab's own loading flag. `isLoadingAiInteractions` alone is not enough:
    // on the very first render after the tab is clicked the query hasn't been
    // enabled yet, so its status is still `idle` — isLoading false, data
    // undefined — which the tab rendered as "No questions asked yet" before any
    // read had happened. An empty state must only ever follow a real answer.
    const isLoadingAskDojo = askDojoEnabled
        ? isLoadingAiInteractions || (aiInteractionsUpdatedAt === 0 && !aiInteractionsError)
        : isProcessing;
    const [query, setQuery] = useState('');
    const meetingInputRef = useRef<HTMLTextAreaElement>(null);
    const [isCopied, setIsCopied] = useState(false);
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [regenError, setRegenError] = useState<string | null>(null);
    const [isFollowUpEmailOpen, setIsFollowUpEmailOpen] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [pendingQuery, setPendingQuery] = useState<{ text: string; id: number } | null>(null);
    const [chatMessages, setChatMessages] = useState<import('@/types').MeetingChatMessage[]>([]);
    const [isTalktimeOpen, setIsTalktimeOpen] = useState(false);
    // Mirrors MeetingChatOverlay's own streaming state (reported via its
    // onBusyChange prop) so the ask-bar input rendered here can swap its
    // send button for a stop button and cancel the in-flight generation.
    const [isChatBusy, setIsChatBusy] = useState(false);
    const stopChatGenerationRef = useRef<(() => void) | null>(null);
    const handleChatBusyChange = useCallback((busy: boolean, stop: (() => void) | null) => {
        setIsChatBusy(busy);
        stopChatGenerationRef.current = stop;
    }, []);
    const handleStopChatGeneration = useCallback(() => {
        stopChatGenerationRef.current?.();
    }, []);

    // ─── What is this meeting actually doing, and what may be painted yet? ────
    //
    // Every flag below answers that from persisted state only. The rule the tabs
    // enforce with them: a section renders when ALL of the data it shows has
    // landed, never as each piece trickles in. That is what stopped the score
    // appearing seconds before the summary it belongs to.

    // Background processing that hasn't finished in PROCESSING_STALL_TIMEOUT_MS
    // has failed (main crashed, the provider never answered, the app was killed
    // mid-run). Measured from the row's own created_at, which MeetingPersistence
    // stamps when the call ENDS — i.e. when processing began. So reopening a
    // meeting abandoned hours ago reads as stalled immediately instead of
    // promising a summary for another five minutes.
    const [isProcessingStalled, setIsProcessingStalled] = useState(false);
    useEffect(() => {
        if (!isProcessing) {
            setIsProcessingStalled(false);
            return;
        }
        const startedAt = new Date(initialMeeting.date).getTime();
        const elapsed = Number.isNaN(startedAt) ? 0 : Date.now() - startedAt;
        if (elapsed >= PROCESSING_STALL_TIMEOUT_MS) {
            setIsProcessingStalled(true);
            return;
        }
        setIsProcessingStalled(false);
        const timer = setTimeout(
            () => setIsProcessingStalled(true),
            PROCESSING_STALL_TIMEOUT_MS - elapsed,
        );
        return () => clearTimeout(timer);
    }, [isProcessing, initialMeeting.id, initialMeeting.date]);

    const processingStage = useMemo(
        () =>
            deriveProcessingStage({
                isProcessing,
                hasScorecard: !!scorecard,
                isDetailResolved: isDetailResolved && isScorecardResolved,
                isStalled: isProcessingStalled,
            }),
        [isProcessing, scorecard, isDetailResolved, isScorecardResolved, isProcessingStalled],
    );

    // The single gate for the Summary tab AND the score accordion inside it, so
    // the two can no longer land at different times.
    //
    // The scorecard read is always waited on — it's a fast local-first read, and
    // it is the thing that used to appear seconds ahead of the summary it
    // belongs to. The *detail* read can be short-circuited when the list row
    // already carries real summary prose: there is nothing left to wait for, and
    // holding a skeleton over data we already have would be its own kind of lie.
    const isSummaryReady =
        !isProcessing &&
        !isRegenerating &&
        isScorecardResolved &&
        (isDetailResolved || hasGeneratedSummary(meeting.detailedSummary));

    // Call Analysis renders `detailedSummary.liveAnalysis`, which arrives with
    // the detail read — so before that read settles the tab must show a skeleton,
    // not "No live analysis captured".
    const isAnalysisReady =
        !!(meeting.detailedSummary as any)?.liveAnalysis || (!isProcessing && isDetailResolved);

    // Regenerate is normally disabled while processing owns the row. A stalled
    // run owns nothing — it's the one case where regenerating is the fix.
    const canRegenerate = !isRegenerating && (!isProcessing || isProcessingStalled);

    const speakerNames = (meeting.detailedSummary as any)?.speakerNames as
        { user: string; client: string; clientDiarized?: string } | undefined;

    // Auto-resize textarea
    useEffect(() => {
        const el = meetingInputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 96)}px`; // max ~4 lines
    }, [query]);

    // Same labelling the PDF export uses (lib/transcriptLabels) — one implementation, so the two
    // can't drift. Speaking Balance calls it with no per-segment displayName; the labeler falls back
    // to the live-resolved names found in the transcript.
    const getSpeakerDisplayName = useMemo(
        () => createSpeakerLabeler(meeting.transcript as any, speakerNames),
        [meeting.transcript, speakerNames]
    );

    // See formatTranscriptTimestamp — epoch ms is ~1.7e12, so a transcript
    // whose positive timestamps are all under a few decades is relative.
    const transcriptTimesAreRelative = useMemo(
        () => computeTranscriptTimesAreRelative(meeting.transcript),
        [meeting.transcript]
    );

    useEffect(() => {
        if (!isProcessing) return;

        // Optimistic/live-placeholder ids have no backend row — HTTP can
        // never resolve them, so skip it and rely on local IPC only.
        const canUseHttp = !isOptimisticMeetingId(initialMeeting.id) && !isLiveMeetingPlaceholder;

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
                if (details && !isMeetingProcessing(details)) {
                    queryClient.setQueryData<Meeting>(meetingKey, (prev) => {
                        const base = prev ?? initialMeeting;
                        return {
                            ...base,
                            ...details,
                            // The local/mirror read has NO company column — letting
                            // it through would blank an association we already hold.
                            company: (details as Meeting).company ?? base.company ?? null,
                            company_skipped: (details as Meeting).company_skipped ?? base.company_skipped,
                        };
                    });
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

        // GET /meetings/:id is canonical for `company`, EXCEPT while an async
        // association (upload flow) is still in flight — then it legitimately
        // returns null and would erase a chip we just painted. Keep whichever
        // copy actually has one.
        const withKnownCompany = (updated: Meeting): Meeting => {
            const prev = queryClient.getQueryData<Meeting>(meetingKey);
            return updated.company ? updated : { ...updated, company: prev?.company ?? null };
        };

        const checkViaHttpThenLocal = () =>
            meetingsApi.get(initialMeeting.id)
                .then((updated) => {
                    if (updated && isHttpResultComplete(updated)) {
                        queryClient.setQueryData<Meeting>(meetingKey, withKnownCompany(updated));
                        setIsProcessing(false);
                        void queryClient.invalidateQueries(scorecardKey);
                    } else {
                        if (updated?.isProcessed) {
                            // Still stop showing the "processing" skeleton — the
                            // summary IS ready — but let unblockFromLocal fill in
                            // the transcript/scorecard from the reliable local copy.
                            queryClient.setQueryData<Meeting>(meetingKey, withKnownCompany(updated));
                        }
                        void unblockFromLocal();
                    }
                })
                .catch(() => void unblockFromLocal());

        if (canUseHttp) {
            void checkViaHttpThenLocal();
        } else {
            void unblockFromLocal();
        }

        if (!window.electronAPI?.onMeetingsUpdated) return;

        const unsubscribe = window.electronAPI.onMeetingsUpdated(() => {
            if (canUseHttp) {
                void checkViaHttpThenLocal();
            } else {
                void unblockFromLocal();
            }
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

    /** Opens the Ask Dojo chat with a caller-supplied prompt — used by the
     *  Game Plan's "Practice with Dojo" buttons. Same path as the ask bar. */
    const handlePracticeWithDojo = (prompt: string) => {
        const text = prompt.trim();
        if (!text) return;
        setPendingQuery({ text, id: Date.now() });
        if (!isChatOpen) {
            setIsChatOpen(true);
        }
    };

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        // Shift+Enter inserts a newline — let the textarea handle it
        // natively instead of submitting.
        if (e.key === 'Enter' && e.shiftKey) {
            return;
        }
        if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            handleSubmitQuestion();
        }
    };

    const handleCopy = async () => {
        let textToCopy = '';

        if (activeTab === 'summary' && meeting.detailedSummary) {
            // Mirrors the Coach tab layout: Call Summary, the type panels
            // (demo/negotiation, when those types are involved), the fixed
            // Game Plan, Coach's notes, and legacy Action Items.
            const ds = meeting.detailedSummary;
            const parts: string[] = [];

            parts.push([
                meeting.title.toUpperCase(),
                new Date(meeting.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
            ].join('\n'));

            // ── Call Summary ──
            if (ds.keyPoints?.length) {
                parts.push(['CALL SUMMARY', ...ds.keyPoints.map(p => `  • ${p}`)].join('\n'));
            }

            const involvesDemo = callInvolves('demo', ds, meeting.meetingTypes, scorecard?.detectedTypes);
            const involvesNegotiation = callInvolves('negotiation', ds, meeting.meetingTypes, scorecard?.detectedTypes);

            // ── Follow up on the demo ──
            if (involvesDemo) {
                const demoParts: string[] = [];
                const reactions = (ds.demoReview?.reactions ?? []).filter(r => r?.feature?.trim() && r?.quote?.trim());
                if (reactions.length) {
                    demoParts.push('  HOW IT LANDED');
                    demoParts.push(...reactions.map(r => {
                        const attribution = [r.speaker?.trim(), r.timestamp?.trim()].filter(Boolean).join(' · ');
                        const verdict = r.verdict === 'landed' ? ' [LANDED]' : r.verdict === 'follow_up' ? ' [FOLLOW UP]' : '';
                        return `    • ${r.feature}: "${r.quote.trim()}"${attribution ? ` — ${attribution}` : ''}${verdict}`;
                    }));
                }
                const demoLoops = (ds.openLoops ?? []).filter(l => l?.concern?.trim());
                if (demoLoops.length) {
                    demoParts.push('  ANSWER WHAT YOU OWE THEM');
                    for (const l of demoLoops) {
                        demoParts.push(`    They asked: "${l.concern.trim()}"`);
                        if (l.suggestedAnswer?.trim()) demoParts.push(`    Try saying: "${l.suggestedAnswer.trim()}"`);
                    }
                }
                const criteria = (ds.demoReview?.successCriteria ?? []).filter(c => c?.metric?.trim() && c?.target?.trim());
                if (criteria.length) {
                    demoParts.push('  AGREE HOW THE PILOT IS JUDGED');
                    demoParts.push(...criteria.map(c =>
                        `    • ${c.target} — ${c.metric}${c.owner?.trim() ? ` (${c.owner.trim()}'s metric)` : ''}`));
                }
                if (demoParts.length) parts.push(['FOLLOW UP ON THE DEMO', ...demoParts].join('\n'));
            }

            // ── Move the deal to signature ──
            if (involvesNegotiation) {
                const negParts: string[] = [];
                const terms = (ds.negotiation?.terms ?? []).filter(t => t?.term?.trim() && (t.theyAsked?.trim() || t.youOffered?.trim()));
                if (terms.length) {
                    negParts.push('  WHERE THE TERMS STAND');
                    for (const t of terms) {
                        const statusLabel =
                            t.status === 'agreed' ? ' [AGREED]'
                                : t.status === 'open' ? ' [OPEN]'
                                    : t.status === 'leaning' ? ' [LEANING YES]'
                                        : t.status === 'must_have' ? ' [MUST HAVE]'
                                            : '';
                        negParts.push(`    • ${t.term}${statusLabel}`);
                        if (t.theyAsked?.trim()) negParts.push(`        They asked: ${t.theyAsked.trim()}`);
                        if (t.youOffered?.trim()) negParts.push(`        You offered: ${t.youOffered.trim()}`);
                    }
                }
                const trades = (ds.negotiation?.trades ?? []).filter(t => t?.give?.trim() && t?.get?.trim());
                const limit = ds.negotiation?.limit?.trim();
                if (trades.length || limit) {
                    negParts.push('  TRADES TO OFFER');
                    negParts.push(...trades.map(t => `    • If you give: ${t.give}\n      Ask for: ${t.get}`));
                    if (limit) negParts.push(`    Your limit: ${limit}`);
                }
                const path = (ds.negotiation?.pathToSignature ?? []).filter(s => s?.step?.trim());
                if (path.length) {
                    negParts.push('  PATH TO SIGNATURE');
                    negParts.push(...path.map(s =>
                        `    • ${[s.date?.trim(), s.step.trim(), s.owner?.trim()].filter(Boolean).join(' — ')}`));
                }
                if (negParts.length) parts.push(['MOVE THE DEAL TO SIGNATURE', ...negParts].join('\n'));
            }

            // ── Your game plan for the next call (fixed structure) ──
            const playbook = ds.nextCallPlaybook;
            const goal = playbook?.callGoal?.trim();
            const recap = playbook?.openingRecap?.trim();
            const questions = (playbook?.questionsToAsk ?? [])
                .map(q => ({
                    text: coachQuestionText(q).trim(),
                    gap: (typeof q === 'string' ? '' : q?.gap?.trim() ?? '') || null,
                }))
                .filter(q => q.text);
            const loops = (ds.openLoops ?? []).filter(l => l?.concern?.trim());
            const quant = (playbook?.valueAndROI?.quantitative ?? []).map(s => s?.trim() ?? '').filter(Boolean);
            const qual = (playbook?.valueAndROI?.qualitative ?? []).map(s => s?.trim() ?? '').filter(Boolean);
            const promises = coachPromises(ds);

            if (goal || recap || questions.length || loops.length || quant.length || qual.length || promises.length) {
                const planParts: string[] = [];
                if (goal) {
                    const closes = Array.from(new Set(questions.map(q => q.gap).filter(Boolean))) as string[];
                    planParts.push(`  YOUR GOAL FOR THE CALL\n    ${goal}${closes.length ? `\n    Closes: ${closes.join(', ')}` : ''}`);
                }
                planParts.push(`  1. OPEN WITH — a 30-second recap in their words\n${recap ? `    "${recap}"` : '    (no recap captured)'}`);
                planParts.push(`  2. ASK THESE — each one closes a gap in the deal${questions.length
                    ? '\n' + questions.map(q => `    • ${q.gap ? `[${q.gap}] ` : ''}${q.text}`).join('\n')
                    : '\n    (none captured)'}`);
                planParts.push(`  3. CLOSE THE OPEN LOOPS — concerns they raised that aren't settled yet${loops.length
                    ? '\n' + loops.map(l =>
                        `    They asked: "${l.concern.trim()}"${l.suggestedAnswer?.trim() ? `\n    Try saying: "${l.suggestedAnswer.trim()}"` : ''}`).join('\n')
                    : '\n    (none — all settled)'}`);
                const valueLines = [
                    ...(quant.length ? ['    In numbers:', ...quant.map(v => `      • ${v}`)] : []),
                    ...(qual.length ? ['    In their words:', ...qual.map(v => `      • ${v}`)] : []),
                ];
                planParts.push(`  4. REINFORCE THE VALUE — numbers they already agreed with${valueLines.length ? '\n' + valueLines.join('\n') : '\n    (none captured)'}`);
                planParts.push(`  5. PROMISES YOU MADE${promises.length
                    ? '\n' + promises.map(p =>
                        `    • ${p.text}${p.owner?.trim() ? ` (${p.owner.trim()})` : ''}${p.dueDate?.trim() ? ` — due ${p.dueDate.trim()}` : ''}`).join('\n')
                    : '\n    (none made)'}`);
                parts.push(['YOUR GAME PLAN FOR THE NEXT CALL', ...planParts].join('\n'));
            }

            // ── Coach's notes ──
            const formatCoachNote = (n: ParsedCoachNote): string => {
                const stamp = n.time ? `[${n.time}] ` : '';
                const lines = [`    • ${stamp}${n.label ? `[${n.label}] ` : ''}${n.content || n.quote || ''}`];
                if (n.content && n.quote) lines.push(`        Try saying: "${n.quote}"`);
                return lines.join('\n');
            };
            // REPLAY (disabled): "Replay these moments" is hidden from the copied text for now.
            // const keepDoing = (ds.salesCoachReview?.whatIDidRight ?? [])
            //     .map(parseCoachHighlight).filter((n): n is ParsedCoachNote => n !== null);
            const tryNextTime = (ds.salesCoachReview?.whatICouldHaveDoneBetter ?? [])
                .map(parseCoachNoteItem).filter((n): n is ParsedCoachNote => n !== null);
            if (tryNextTime.length) {
                const notes: string[] = [];
                // REPLAY (disabled): if (keepDoing.length) notes.push('  REPLAY THESE MOMENTS\n' + keepDoing.map(formatCoachNote).join('\n'));
                notes.push('  TRY NEXT TIME\n' + tryNextTime.map(formatCoachNote).join('\n'));
                parts.push(["COACH'S NOTES", ...notes].join('\n'));
            }

            // ── Legacy meetings keep their editable Action Items section ──
            if (ds.salesCoachReview === undefined && ds.actionItems?.length) {
                parts.push(['ACTION ITEMS', ...ds.actionItems.map(i => `  • ${i}`)].join('\n'));
            }

            textToCopy = parts.join('\n\n').trim();

        } else if (activeTab === 'transcript' && meeting.transcript) {
            // Same "Label (MM:SS): text" shape the Upload Transcript parser reads (format 7),
            // for uploaded AND live-call transcripts — see formatTranscriptForCopy.
            textToCopy = formatTranscriptForCopy(meeting.transcript as any, speakerNames);

        } else if (activeTab === 'usage' && meeting.usage) {
            textToCopy = meeting.usage
                .map(u => `Q: ${u.question || ''}\nA: ${u.answer || ''}`)
                .join('\n\n');
        } else if (activeTab === 'analysis' && meeting.detailedSummary?.liveAnalysis) {
            // Format the live analysis data for copying
            const la = meeting.detailedSummary.liveAnalysis;
            const sections: string[] = [];

            // Helper to format a field: the assessment on the status line, then
            // the supporting statements indented beneath it. An export is
            // exactly where the reference material belongs — someone pasting
            // this into a CRM wants the claim AND what it rests on.
            const formatField = (label: string, field: any) => {
                if (!field || !field.status) return '';
                const statusIcon = field.status === 'confirmed' ? '✅' : field.status === 'partial' ? '⚠️' : '❌';
                const head = `  ${statusIcon} ${label}: ${field.status.toUpperCase()} - ${fieldText(field) || 'Not mentioned'}`;
                // Only when the assessment isn't itself the evidence (old rows).
                const refs = fieldSummary(field) ? fieldEvidenceList(field) : [];
                return refs.length ? [head, ...refs.map(r => `      • ${r}`)].join('\n') : head;
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
            // The prospect's objections, then the rep's own follow-ups — never mixed.
            const { objections: prospectObjections, followUps: repFollowUps } =
                splitRepFollowUps(la.objections || []);
            if (prospectObjections.length > 0) {
                sections.push(`OBJECTIONS (${prospectObjections.length})`);
                sections.push(`${'─'.repeat(40)}`);
                prospectObjections.forEach((obj, idx) => {
                    sections.push(`  ${idx + 1}. "${obj.quote}"`);
                    if (obj.rep_response) sections.push(`     Rep: "${obj.rep_response}"`);
                    sections.push('');
                });
            }
            if (repFollowUps.length > 0) {
                sections.push(`YOUR FOLLOW-UPS (${repFollowUps.length})`);
                sections.push(`${'─'.repeat(40)}`);
                repFollowUps.forEach((obj, idx) => {
                    sections.push(`  ${idx + 1}. "${obj.quote}"`);
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
                // The summary step failed, but regenerating may already have saved a
                // new Call Analysis (a meeting that had none) — show it now.
                const savedAnalysis = result?.meeting?.detailedSummary?.liveAnalysis;
                if (savedAnalysis && !meeting.detailedSummary?.liveAnalysis) {
                    queryClient.setQueryData<Meeting>(meetingKey, (prev) => {
                        const base = prev ?? meeting;
                        return {
                            ...base,
                            detailedSummary: { ...(base.detailedSummary ?? { actionItems: [], keyPoints: [] }), liveAnalysis: savedAnalysis },
                        };
                    });
                }
                // `result.error` now carries the real provider error (e.g. Gemini
                // "429 RESOURCE_EXHAUSTED" / Groq rate-limit text) instead of being
                // swallowed to a bare `false` — classify it into something the user
                // can actually act on, and report both the classified reason and
                // the raw text to PostHog so it's filterable/debuggable there.
                const { reason, message } = classifyLLMError(result?.error);
                setRegenError(message);
                posthogAnalytics.trackSummaryRegenerateFailed(reason, result?.error, meeting.id);
            }
        } catch (err: any) {
            console.log(err);
            const { reason, message } = classifyLLMError(err?.message ?? String(err));
            setRegenError(message);
            posthogAnalytics.trackSummaryRegenerateFailed(reason, err?.message ?? String(err), meeting.id);
            posthogAnalytics.trackException(err instanceof Error ? err : new Error(String(err)), 'useMeetingDetails.handleRegenerateSummary', { meetingId: meeting.id });
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
        isLoadingTranscript,
        scorecard,
        // Lifecycle-derived render gates (see the block above).
        processingStage,
        isProcessingStalled,
        isSummaryReady,
        isAnalysisReady,
        isLoadingAskDojo,
        canRegenerate,
        activeTab, setActiveTab,
        aiInteractionsData, isLoadingAiInteractions,
        hasMoreAiInteractions, isLoadingMoreAiInteractions, loadMoreAiInteractions,
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
        transcriptTimesAreRelative,
        handleSubmitQuestion,
        handlePracticeWithDojo,
        handleInputKeyDown,
        meetingInputRef,
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
    };
}