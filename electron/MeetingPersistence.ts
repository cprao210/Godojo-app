// MeetingPersistence.ts
// Handles meeting lifecycle: stop, save, and recovery.
// Extracted from IntelligenceManager to decouple DB operations from LLM orchestration.

import { SessionTracker, TranscriptSegment } from './SessionTracker';
import { LLMHelper } from './LLMHelper';
import { DatabaseManager, Meeting, formatDuration } from './db/DatabaseManager';
import { SupabaseMirrorService } from './db/SupabaseMirrorService';
import { GROQ_TITLE_PROMPT, GROQ_SUMMARY_JSON_PROMPT, verifySummaryAgainstTranscript, buildCorrectionAddendum } from './llm';
import { buildSummaryPrompt, buildCoachCallTypeSection, BANT_MEDDICC_OUTPUT_SCHEMA } from './llm/summaryPrompt';
import { emitLLMUsage, type LLMUsageCall } from './utils/llmUsageBus';
import { LiveAnalysisData, MeetingScorecardResult } from '../src/types';
import { AppState } from './main';
import { buildScorecardPrompt } from './llm/ScoreCardLLM';
import { reconcileScorecardWithLiveAnalysis } from './scorecardReconciliation';
import { reconcileBantMeddicWithLiveAnalysis } from './summaryReconciliation';
import { sanitizeCoachSummary, clearForeignCoachBlocks } from './utils/coachSummaryData';
import { resolveCoachCallType } from './utils/coachCallType';
import { hasMultipleClientSpeakers, resolveSpeakerDisplayName, buildSpeakerRoster, formatSpeakerRosterBlock, transcriptTurnLabel, SpeakerNameMapLike } from './utils/speakerLabels';
import { parseUploadTranscript } from './utils/uploadTranscriptParser';
import { AuthManager } from './services/AuthManager';
import { deriveCompanyCandidates } from '../utils/companyDomainShared';
import { buildUploadAnalysisPrompt, clipForLocalAnalysis, normalizeUploadAnalysis } from './utils/uploadAnalysis';
import { requestUploadAnalysis, isLocalUploadAnalysisForced } from './utils/uploadAnalysisBridge';
import { requestFinalAnalysisV2, isFinalAnalysisV2Enabled } from './utils/finalAnalysisBridge';
import {
    generateCallAnalysis,
    hasUsableCallAnalysis,
    meetingTypesForRegenerate,
    MeetingTypeHint,
    REGENERATE_ANALYSIS_TIMEOUT_MS,
} from './utils/callAnalysis';
import { fieldEvidenceList, fieldSummary, fieldText } from '../src/lib/bantMeddic';
import { requestBackendChunking } from './utils/backendRagChunking';
import {
    beginMeetingProcessing,
    startProcessingStep,
    setProcessingStepDetail,
    completeProcessingSteps,
    endMeetingProcessing,
} from './utils/meetingProcessingProgress';

const crypto = require('crypto');

// Bounded wait for an in-flight final live-analysis run before background
// summary generation kicks off (see the deferred phase in stopMeeting below).
// Must match FINAL_ANALYSIS_MAX_WAIT_MS in src/lib/meetingLifecycle.ts — that
// file is the renderer's copy of the same deadline (it used to be the only
// place this was enforced, blocking the End Call button; main enforces it here
// now so the UI never has to wait on it).
const FINAL_ANALYSIS_MAX_WAIT_MS = 10_000;

/** The LLM half of scorecard generation, before grounding and persistence.
 *  Carries the criteria snapshot along so finalizeScorecard() can store the
 *  exact criteria the score was produced against. */
type ScorecardDraft = {
    scorecardResult: MeetingScorecardResult | null;
    customScoringCriteria: import('../src/types').ScoringCriteriaSettings | null;
};

// ── Summary grounding verification ──────────────────────────────────────────
// After generating the structured summary JSON, we cross-check it against the
// transcript with a second LLM call and get back a 0-100 grounding confidence
// score plus specific unsupported/fabricated fields. If confidence is below
// SUMMARY_CONFIDENCE_THRESHOLD, we regenerate with those specific issues fed
// back into the prompt, up to SUMMARY_MAX_ATTEMPTS total tries. This is
// bounded rather than "retry until perfect" — an unbounded loop risks
// runaway latency/cost if the transcript is genuinely ambiguous and no
// attempt will ever clear the bar. We keep the highest-confidence attempt
// seen across all tries as the final result, so a capped-out run still
// returns the best available summary instead of discarding everything.
const SUMMARY_CONFIDENCE_THRESHOLD = 75;
const SUMMARY_MAX_ATTEMPTS = 3;

// BANT/MEDDIC + Sales Self-Analysis reconciliation lives in
// ./summaryReconciliation (pure, unit-tested); see reconcileBantMeddicWithLiveAnalysis
// usage below for why it must run against the FINAL live analysis on every path.

/** The signed-in user's name and email — what an uploaded transcript's rep label is matched against. */
function uploadRepNameHints(): Array<string | null> {
    const { displayName, email } = AuthManager.getInstance().snapshot();
    return [displayName, email];
}

export class MeetingPersistence {
    private session: SessionTracker;
    private llmHelper: LLMHelper;

    constructor(session: SessionTracker, llmHelper: LLMHelper) {
        this.session = session;
        this.llmHelper = llmHelper;
    }

    /**
     * Stops the meeting immediately, snapshots data, and triggers background processing.
     * Returns immediately so UI can switch.
     */
    /**
     * @param meetingTypes The meeting type(s) the rep selected live (e.g. Demo + Negotiation).
     *   Forwarded as the scorecard's `hintMeetingTypes` so auto-detection respects the
     *   rep's explicit selection instead of guessing from the transcript alone.
     */
    public async stopMeeting(meetingTypes?: ('discovery' | 'demo' | 'negotiation')[], tenantId?: string | null): Promise<{ meetingId: string | null; source: string; candidates: { name: string; domain: string }[] } | null> {
        console.log('[MeetingPersistence] Stopping meeting and queueing save...');

        // 0. Force-save any pending interim transcript
        this.session.flushInterimTranscript();

        // 1. Snapshot valid data BEFORE resetting.
        // duration = end - start - paused, computed from three raw facts —
        // no running clock, no derived state to go stale.
        const startTimeMs = this.session.getSessionStartTime();
        const endTimeMs = Date.now();
        const totalPausedMs = this.session.getTotalPausedMs();
        const durationMs = Math.max(0, (endTimeMs - startTimeMs) - totalPausedMs);
        const appState = AppState.getInstance();
        if (durationMs < 1000) {
            console.log("Meeting too short, ignoring.");
            // Still hand back the live-analysis slot. Nothing will be saved for
            // this call, so anything left in it can only ever be read by the
            // NEXT meeting's summary generation.
            appState?.clearCurrentLiveAnalysis?.();
            // endMeeting used to clear any stale pending-live-analysis target on
            // this path too (its else-branch ran for a null meetingId) — keep
            // that now that the bookkeeping lives in the deferred phase below,
            // which never runs for a meeting that wasn't saved.
            appState?.recordPendingLiveAnalysis?.(null);
            this.session.reset();
            return null;
        }

        // Take the analysis by value and clear the slot unconditionally — the
        // call is over, so from here on the slot belongs to whatever comes
        // next. Clearing only when a result happened to be present left a
        // non-null companyIntel behind on the empty-analysis path.
        //
        // Read in this synchronous phase, NOT after the analysis-settle wait in
        // the deferred phase below: endMeeting has already flipped
        // isMeetingActive to false, so liveAnalysisRouting drops any result
        // landing from here on ('no meeting is active and nothing is pending')
        // — the slot content at this instant is exactly what the old post-wait
        // read saw, just without holding the transcript save hostage to get it.
        const liveAnalysisData = appState?.getCurrentLiveAnalysis?.() || null;
        console.log('[MeetingPersistence] Retrieved liveAnalysisData:', !!liveAnalysisData);
        if (liveAnalysisData) {
            console.log('[MeetingPersistence] Live analysis keys:', Object.keys(liveAnalysisData));
        }
        appState?.clearCurrentLiveAnalysis?.();

        const snapshot = {
            transcript: [...this.session.getFullTranscript()],
            usage: [...this.session.getFullUsage()],
            startTime: startTimeMs,
            endTime: endTimeMs,
            totalPausedMs: totalPausedMs,
            durationMs: durationMs,
            context: this.session.getFullSessionContext(),
        };

        // BUG-04 fix: snapshot metadata BEFORE reset() clears it so the
        // background processAndSaveMeeting worker receives the calendar info.
        const metadataSnapshot = this.session.getMeetingMetadata();
        const speakerNamesSnapshot = this.session.getSpeakerNameMap();

        // 2. Reset state immediately so new meeting can start or UI is clean
        this.session.reset();

        const meetingId = crypto.randomUUID();

        // 3. Initial Save (Placeholder) — MUST come before processAndSaveMeeting.
        // That call isn't awaited, but an async function still runs synchronously
        // up to its first `await` (transcript labelling, prompt building, ...),
        // which blocks main's event loop. Invoking it first therefore delayed the
        // placeholder INSERT, the meetings-updated broadcast, and every IPC queued
        // behind them (live-call-ended, set-window-mode) by however long that
        // prefix took — proportional to transcript length, which is exactly why
        // the Recent Meetings card "sometimes" appeared late. Same order the
        // upload path (uploadTranscript) already uses.
        //
        // Same displayName stamping as the final save in processAndSaveMeeting
        // — without it, this placeholder briefly persists with generic
        // "Other Party" labels until the background save replaces it. The
        // diarization-aware helper is what keeps the post-call labels identical
        // to the ones broadcast during the call ("Raksham · Speaker 1"), instead
        // of flattening every far-end turn onto the plain client name.
        const placeholderMultiClientSpeakers = hasMultipleClientSpeakers(snapshot.transcript);
        const placeholderTranscript = snapshot.transcript.map(segment => ({
            ...segment,
            displayName: segment.displayName
                ?? resolveSpeakerDisplayName(segment.speaker, segment.speakerIndex, speakerNamesSnapshot, placeholderMultiClientSpeakers),
        }))

        const placeholder: Meeting = {
            id: meetingId,
            // A calendar-sourced call already knows its real title — use it so the
            // card reads as "<event title> · preparing summary" instead of the
            // generic placeholder. The renderer keys "is processing" off
            // isProcessed, not off this string (see isMeetingProcessing).
            title: metadataSnapshot?.title || "Processing...",
            date: new Date().toISOString(),
            duration: formatDuration(durationMs),
            durationMs: durationMs,
            summary: "",
            detailedSummary: { actionItems: [], keyPoints: [] },
            // Real transcript, not empty — it's already captured in `snapshot`
            // above and there's no reason to make the Transcript tab wait on
            // background summary/scorecard processing to see it. saveMeeting()
            // now clears-and-reinserts transcript rows on every call, so the
            // later final save in processAndSaveMeeting() safely replaces this
            // rather than duplicating it.
            transcript: placeholderTranscript,
            usage: [],
            tenantId: tenantId || null,
            // Tagged from the FIRST save so the meeting card's
            // Calendar/Quick/Upload badge is correct during the processing
            // window — derived from the actual session metadata, NOT
            // hardcoded (a hardcoded 'calendar' here mislabeled every quick
            // meeting as Calendar while it processed).
            source: metadataSnapshot?.source ?? 'manual',
            isProcessed: false
        };

        try {
            DatabaseManager.getInstance().saveMeeting(placeholder, snapshot.startTime, snapshot.endTime, snapshot.totalPausedMs);
            // Notify Frontend
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));
        } catch (e) {
            console.error("Failed to save placeholder", e);
        }

        // Report the REAL background steps to the renderer (own IPC channel — see
        // utils/meetingProcessingProgress). Only steps that will actually run are
        // planned, mirroring the conditions in processAndSaveMeeting.
        beginMeetingProcessing(meetingId, [
            'liveAnalysis',
            ...(metadataSnapshot?.title ? [] : ['title' as const]),
            ...(snapshot.transcript.length > 2 ? ['summary' as const] : []),
            'save',
        ]);

        // 4. Background processing (title/summary + final save) —
        // deferred behind the analysis-settle wait. This wait used to sit in
        // AppState.endMeeting IN FRONT of this entire method, which held the
        // placeholder save (and with it the transcript's availability in
        // SQLite, the Recent Meetings card data, and the live-call-ended
        // broadcast) hostage behind up to FINAL_ANALYSIS_MAX_WAIT_MS of LLM
        // latency. The wait only guards which live-analysis snapshot the
        // SUMMARY is generated from — the transcript persisted above is
        // complete the moment captures stop, so it must never wait on it.
        // The pending-live-analysis bookkeeping moved here too: it must run
        // after the wait to keep the original routing window (a result landing
        // mid-wait routes 'drop' exactly as it did when the wait sat in
        // endMeeting).
        void (async () => {
            try {
                // Live analysis v2: ONE end-of-call pass over the whole call (POST /v2/end)
                // replaces "wait for the last tick to settle". Its result is patched onto
                // the placeholder right away (Call Analysis tab shows it while the summary
                // is still being written) and is what the summary is grounded on. Any
                // failure falls back to the settle-wait + live snapshot below.
                let analysisForSummary = liveAnalysisData;
                startProcessingStep(meetingId, 'liveAnalysis', 'Running the end-of-call analysis.');
                const finalV2 = isFinalAnalysisV2Enabled()
                    ? await this.runFinalAnalysisV2(meetingId, meetingTypes)
                    : null;
                if (finalV2) {
                    analysisForSummary = finalV2;
                    appState?.recordPendingLiveAnalysis?.(null);
                } else {
                    await appState?.waitForLiveAnalysisToSettle?.(FINAL_ANALYSIS_MAX_WAIT_MS);
                    appState?.recordPendingLiveAnalysis?.(meetingId);
                }
                completeProcessingSteps(meetingId, 'liveAnalysis');
                await this.processAndSaveMeeting(
                    snapshot,
                    meetingId,
                    metadataSnapshot,
                    analysisForSummary,
                    speakerNamesSnapshot,
                    undefined,      // companyIntel — not captured at stop time for live calls
                    meetingTypes,    // ← rep's live selection, was previously dropped (always undefined)
                    tenantId || null
                );
            } catch (err) {
                console.error('[MeetingPersistence] Background processing failed:', err);
                // processAndSaveMeeting's own finally ends tracking; this covers a
                // throw BEFORE it ran (final analysis) so no snapshot is leaked.
                endMeetingProcessing(meetingId, false);
            }
        })();

        // Company-prompt payload for the launcher window: the session source
        // and the attendee-domain candidates (organizer + consumer domains
        // excluded — same classification the backend applies; see
        // utils/companyDomainShared). The backend keeps the authoritative
        // Python list; this TS twin exists because end-of-call decisions run
        // in main, offline from the backend, and must not race the AI pipeline.
        // The signed-in user's email excludes the rep's whole domain (incl.
        // subdomains / unflagged colleagues) — the self/organizer flags alone
        // can't do that.
        const stoppedSource = metadataSnapshot?.source ?? 'manual';
        const stoppedCandidates = stoppedSource === 'upload'
            ? []
            : deriveCompanyCandidates(metadataSnapshot?.attendees || [], {
                userEmail: AuthManager.getInstance().snapshot().email,
            });

        return { meetingId, source: stoppedSource, candidates: stoppedCandidates };
    }

    /**
     * Live analysis v2 end-of-call pass, run by the overlay (see ./utils/finalAnalysisBridge).
     * On success the result is written onto the placeholder meeting at once — the meeting
     * page's Call Analysis tab renders `detailedSummary.liveAnalysis` even while the summary is
     * still processing — and returned so the summary is grounded on it. Null means "fall back".
     */
    private async runFinalAnalysisV2(
        meetingId: string,
        meetingTypes?: ('discovery' | 'demo' | 'negotiation')[],
    ): Promise<LiveAnalysisData | null> {
        const startedAt = Date.now();
        try {
            const data = await requestFinalAnalysisV2(meetingTypes ?? []);
            if (!data) return null;
            try {
                const db = DatabaseManager.getInstance();
                const meeting = db.getMeetingDetails(meetingId);
                if (meeting) {
                    const existing = meeting.detailedSummary || { actionItems: [], keyPoints: [] };
                    db.updateMeeting(meetingId, { detailedSummary: { ...existing, liveAnalysis: data } });
                    const wins = require('electron').BrowserWindow.getAllWindows();
                    wins.forEach((w: any) => w.webContents.send('meetings-updated'));
                }
            } catch (e) {
                console.warn('[MeetingPersistence] Could not patch the end-of-call analysis onto the placeholder:', e);
            }
            console.log(
                `[MeetingPersistence] v2 end-of-call analysis ready in ${Date.now() - startedAt}ms ` +
                `(${data.objections.length} objections, ${data.signals.length} signals)`,
            );
            return data;
        } catch (e: any) {
            console.warn(
                `[MeetingPersistence] v2 end-of-call analysis unavailable after ${Date.now() - startedAt}ms ` +
                `(${e?.message ?? e}) — falling back to the live snapshot.`,
            );
            return null;
        }
    }

    /**
     * Call Analysis for a meeting that has no live analysis (uploads, recovered meetings,
     * and regenerating a meeting whose first analysis failed). Backend producer first,
     * then the local one-shot analyser — see ./utils/callAnalysis. Never throws.
     *
     * @param transcriptText labelled transcript (roster block + turns) for the local analyser
     * @param backendTimeoutMs ceiling on the backend attempt; defaults to the bridge's own
     */
    private async generateCallAnalysisFor(
        segments: Array<Pick<TranscriptSegment, 'speaker' | 'text'>>,
        meetingTypes: MeetingTypeHint[],
        transcriptText: string,
        backendTimeoutMs?: number,
    ): Promise<LiveAnalysisData | null> {
        const startedAt = Date.now();
        const { analysis, producer } = await generateCallAnalysis(
            segments.map(t => ({ speaker: t.speaker, text: t.text })),
            meetingTypes,
            {
                forceLocal: isLocalUploadAnalysisForced(),
                requestBackend: (turns, types) =>
                    requestUploadAnalysis(turns, types, backendTimeoutMs ? { timeoutMs: backendTimeoutMs } : {}),
                runLocal: async (isNegotiation) => {
                    const analysisPrompt = buildUploadAnalysisPrompt(isNegotiation);
                    const { text: analysisInput, truncated } = clipForLocalAnalysis(transcriptText);
                    if (truncated) {
                        console.warn(
                            `[MeetingPersistence] Local call analysis reads only ${truncated.analyzedChars} of ` +
                            `${truncated.totalChars} transcript chars — the result will be marked truncated`,
                        );
                    }
                    const analysisRaw = await this.llmHelper.generateMeetingSummary(
                        analysisPrompt,
                        analysisInput,
                        analysisPrompt,
                    );
                    if (!analysisRaw) return null;
                    const jsonMatch = analysisRaw.match(/```json\n([\s\S]*?)\n```/) || [null, analysisRaw];
                    const jsonStr = (jsonMatch[1] || analysisRaw).trim();
                    try {
                        const analysis = normalizeUploadAnalysis(JSON.parse(jsonStr), isNegotiation);
                        return truncated ? { ...analysis, truncated } : analysis;
                    } catch (e) {
                        console.warn('[MeetingPersistence] Failed to parse call analysis JSON:', e);
                        return null;
                    }
                },
            },
        );
        console.log(
            `[MeetingPersistence] Call analysis ${analysis ? `from ${producer}` : 'unavailable'} ` +
            `after ${Date.now() - startedAt}ms`,
        );
        return analysis;
    }

    /**
     * Heavy lifting: LLM Title, Summary, and DB Write
     */
    private async processAndSaveMeeting(
        data: { transcript: TranscriptSegment[], usage: any[], startTime: number, endTime?: number, totalPausedMs?: number, durationMs: number, context: string },
        meetingId: string,
        metadata?: { title?: string; calendarEventId?: string; source?: 'manual' | 'calendar' | 'upload'; calendarEvent?: any } | null,
        liveAnalysisData?: LiveAnalysisData | null,
        speakerNames?: { user: string; client: string; clientDiarized?: string },
        companyIntel?: Record<string, any> | null,
        hintMeetingTypes?: ('discovery' | 'demo' | 'negotiation')[],
        tenantId?: string | null
    ): Promise<void> {
        let title = "Untitled Session";
        let summaryData: { actionItems: string[], keyPoints: string[], liveAnalysis?: LiveAnalysisData, speakerNames?: { user: string, client: string, clientDiarized?: string } } = { actionItems: [], keyPoints: [] };

        // Use passed-in metadata snapshot (NOT this.session.getMeetingMetadata() which is already cleared)
        let calendarEventId: string | undefined;
        let source: 'manual' | 'calendar' | 'upload' = 'manual';
        // Raw calendar event, wrapped in an array to match the provider's event-feed
        // shape (see CalendarManager.CalendarEvent) — persisted verbatim, untouched.
        let calendarEventMetadata: any[] | undefined;

        if (metadata) {
            if (metadata.title) title = metadata.title;
            if (metadata.calendarEventId) calendarEventId = metadata.calendarEventId;
            if (metadata.source) source = metadata.source;
            // Guard on the full event object (not calendarEventId) — otherwise a
            // metadata payload that carries the id but not the raw event would
            // wrap [undefined] and persist "[null]" into calendar_event_metadata.
            if (metadata.calendarEvent) calendarEventMetadata = [metadata.calendarEvent];
        }

        // Build full transcript text directly from the transcript array so the
        // LLM sees the complete call. The pre-built data.context is capped at
        // 10,000 chars which silently cuts off the second half of longer calls.
        // Average ~60 chars per turn × 1500 turns = 90,000 chars — well within
        // Gemini/Claude/GPT context windows. Groq has a 100k token guard already.
        //
        // When diarization identified 2+ far-end speakers, label prospect turns
        // "PROSPECT (Speaker n)" so the summary LLM can attribute statements.
        const clientIndices = new Set(
            data.transcript
                .filter(t => t.speaker !== 'user' && (t as any).speakerIndex !== undefined)
                .map(t => (t as any).speakerIndex as number)
        );
        const multiClientSpeakers = clientIndices.size >= 2;
        const humanSegments = data.transcript
            .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()));

        // Speaker identity map: uploads carry the original labels as
        // displayName (and the parser's first-speaker=mic-user role rule), so
        // every LLM round-trip over this transcript (title, summary,
        // verification, call analysis, scorecard) gets the same roster
        // preamble + per-turn labels — participants are named, and the model
        // knows which name is the rep vs the prospect side.
        const speakerRoster = buildSpeakerRoster(humanSegments, speakerNames, multiClientSpeakers);
        const rosterBlock = humanSegments.some(t => !!t.displayName)
            ? formatSpeakerRosterBlock(speakerRoster)
            : '';
        const fullTranscriptText = humanSegments
            .map(t => `${transcriptTurnLabel(t, speakerNames, multiClientSpeakers)}: ${t.text}`)
            .join('\n');

        // NOTE: do NOT log the transcript here. This whole prologue runs
        // synchronously on main's event loop (the caller doesn't await), so
        // serialising every segment to the console blocked IPC — including the
        // launcher's meetings refresh and the window switch — for as long as it
        // took, scaling with call length. It also wrote raw meeting content into
        // the app logs. Log a size instead if you need a breadcrumb.
        console.log(`[MeetingPersistence] Processing ${data.transcript.length} transcript segments for ${meetingId}`);

        // Scorecard generation needs the transcript and the rep's meeting-type
        // hints — never the title or the summary. Running it *after* them meant
        // the final save, the "Summary Ready" toast, and the card leaving its
        // processing state all waited on a second full LLM round-trip that could
        // have been in flight the whole time. Start it here and collect it below;
        // that's the bulk of the gap the user saw between the summary actually
        // being ready and being told about it.
        //
        // Only the LLM half runs here. Grounding it against live analysis and
        // writing it out happen in finalizeScorecard() below, because on the
        // upload/recovery path `liveAnalysisData` doesn't exist yet at this point
        // — it's generated further down. Splitting the two keeps the round-trip
        // overlapped while guaranteeing the scorecard is reconciled against the
        // FINAL live analysis on every path.
        //
        // generateScorecardDraft never rejects (every failure path returns a
        // draft object) — the .catch is belt-and-braces so a future throw before
        // its first await can't surface as an unhandled rejection while we're
        // off awaiting the summary.
        // const scorecardDraft: Promise<ScorecardDraft> =
        //     data.transcript.length > 2
        //         ? this.generateScorecardDraft(rosterBlock + fullTranscriptText, hintMeetingTypes ?? null, liveAnalysisData ?? null)
        //             .catch((err): ScorecardDraft => {
        //                 console.warn('[MeetingPersistence] Scorecard generation threw (non-fatal):', err);
        //                 return { scorecardResult: null, customScoringCriteria: null };
        //             })
        //         : Promise.resolve({ scorecardResult: null, customScoringCriteria: null });

        // Idempotent: the live path already began tracking in stopMeeting (with a
        // 'liveAnalysis' step); uploads / re-processing begin here. Listed in execution
        // order — for them the transcript analysis runs AFTER the summary. A live
        // meeting that ends up needing it gets the step inserted when it starts.
        beginMeetingProcessing(meetingId, [
            ...(!metadata || !metadata.title ? ['title' as const] : []),
            ...(data.transcript.length > 2 ? ['summary' as const] : []),
            ...(!liveAnalysisData && data.transcript.length > 2 ? ['analysis' as const] : []),
            'save',
        ]);

        try {
            // Generate Title (only if not set by calendar)
            if (!metadata || !metadata.title) {
                startProcessingStep(meetingId, 'title', 'Naming the meeting from the conversation.');
                const titlePrompt = `Generate a concise 3-6 word title for this meeting context. Output ONLY the title text. Do not use quotes or conversational filler.`;
                const groqTitlePrompt = GROQ_TITLE_PROMPT;

                // Use first 5000 chars of full transcript for title (enough context, saves tokens)
                const titleContext = (rosterBlock + humanSegments
                    .map(t => `${transcriptTurnLabel(t, speakerNames, multiClientSpeakers)}: ${t.text}`)
                    .join('\n')).substring(0, 5000);

                const generatedTitle = await this.llmHelper.generateMeetingSummary(titlePrompt, titleContext, groqTitlePrompt, 'title');
                if (generatedTitle) title = generatedTitle.replace(/[\"*]/g, '').trim();
                completeProcessingSteps(meetingId, 'title');
            }

            // Generate Structured Summary
            if (data.transcript.length > 2) {

                // The kind of call this was (discovery/demo/negotiation) drives
                // which coaching sections the prompt asks for. Explicit rep
                // selection wins; with none, discovery is the default.
                const coachCallType = resolveCoachCallType(hintMeetingTypes);

                // Build a compact Groq-compatible system prompt that includes live analysis grounding.
                // Groq has a lower token budget, so we pass only the status+assessment lines —
                // fieldText, never the raw evidence list (which would interpolate as "a,b").
                const liveAnalysisGroqBlock = liveAnalysisData ? `
                LIVE ANALYSIS REFERENCE (captured during the call):
                BANT: Budget=${liveAnalysisData.bant.budget.status}|${fieldText(liveAnalysisData.bant.budget)}, Authority=${liveAnalysisData.bant.authority.status}|${fieldText(liveAnalysisData.bant.authority)}, Need=${liveAnalysisData.bant.need.status}|${fieldText(liveAnalysisData.bant.need)}, Timeline=${liveAnalysisData.bant.timeline.status}|${fieldText(liveAnalysisData.bant.timeline)}
                MEDDIC: Metrics=${liveAnalysisData.meddic.metrics.status}|${fieldText(liveAnalysisData.meddic.metrics)}, EconBuyer=${liveAnalysisData.meddic.economic_buyer.status}|${fieldText(liveAnalysisData.meddic.economic_buyer)}, Pain=${liveAnalysisData.meddic.identify_pain.status}|${fieldText(liveAnalysisData.meddic.identify_pain)}, Champion=${liveAnalysisData.meddic.champion.status}|${fieldText(liveAnalysisData.meddic.champion)}
                Use this as your grounding anchor for overview, keyPoints, salesCoachReview and nextCallPlaybook. Do NOT include bant/meddicc in your output — the application fills them from this data.
                ` : '';
                // BANT/MEDDIC output schema goes to Groq ONLY when no live
                // analysis exists (upload/recovery): the LLM-derived values are
                // then the last-resort fallback for when call analysis (backend
                // endpoint → local electron analyser) fails entirely. With live
                // analysis, reconciliation overwrites these fields in code —
                // asking the token-constrained Groq model to echo them is pure
                // waste (and a 413 risk).
                const groqBantMeddiccBlock = liveAnalysisData ? '' : `\n\nDerive BANT/MEDDIC from the transcript (fallback when call analysis is unavailable):\n${BANT_MEDDICC_OUTPUT_SCHEMA}`;
                // Same output contract as the main prompt: base Groq schema +
                // (no-analysis BANT/MEDDIC fallback schema) + live-analysis
                // grounding + the call-type coaching section.
                const groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT
                    + groqBantMeddiccBlock
                    + (liveAnalysisGroqBlock ? `\n\n${liveAnalysisGroqBlock}` : '')
                    + '\n\n' + buildCoachCallTypeSection(coachCallType);

                const baseSummaryPrompt = buildSummaryPrompt(liveAnalysisData, companyIntel, coachCallType);

                // Generate -> verify -> (if low confidence) regenerate with the
                // specific flagged issues fed back in, up to SUMMARY_MAX_ATTEMPTS.
                let correctionAddendum = '';
                let bestParsedSummary: any = null;
                let bestConfidence = -1;

                // Observability: collect provider/model/token usage for every
                // LLM call behind this summary (see utils/llmUsageBus — PostHog
                // + the renderer's dev-only usage chip).
                const usageCalls: LLMUsageCall[] = [];
                const usageSink = (call: LLMUsageCall) => usageCalls.push(call);
                const summaryStartedAt = Date.now();
                let attemptsUsed = 0;

                // Each attempt is two real LLM round-trips (draft, then verify).
                const attemptFraction = (attempt: number, verifying: boolean) =>
                    ((attempt - 1) * 2 + (verifying ? 1 : 0)) / (SUMMARY_MAX_ATTEMPTS * 2);
                const attemptSuffix = (attempt: number) =>
                    attempt > 1 ? ` · attempt ${attempt} of ${SUMMARY_MAX_ATTEMPTS}` : '';

                for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt++) {
                    attemptsUsed = attempt;
                    const draftDetail = attempt > 1
                        ? 'Rewriting to fix issues found while verifying'
                        : 'Drafting key points, action items and coaching notes';
                    if (attempt === 1) {
                        startProcessingStep(meetingId, 'summary', draftDetail, attemptFraction(attempt, false));
                    } else {
                        setProcessingStepDetail(meetingId, 'summary', draftDetail + attemptSuffix(attempt), attemptFraction(attempt, false));
                    }
                    const generatedSummary = await this.llmHelper.generateMeetingSummary(
                        baseSummaryPrompt + correctionAddendum,
                        rosterBlock + fullTranscriptText,
                        groqSummaryPrompt + correctionAddendum,
                        'summary',
                        usageSink
                    );
                    if (!generatedSummary) break;

                    const jsonMatch = generatedSummary.match(/```json\n([\s\S]*?)\n```/) || [null, generatedSummary];
                    const jsonStr = (jsonMatch[1] || generatedSummary).trim();

                    let parsedSummary: any;
                    try {
                        // Parse the LLM's structured summary FIRST — this carries
                        // overview/keyPoints/actionItems/dealStatus/salesCoachReview/
                        // nextCallPlaybook. Losing this step means the summary tab
                        // renders empty even though bant/meddicc still get filled in
                        // below from live analysis.
                        parsedSummary = JSON.parse(jsonStr);
                    } catch (e) {
                        console.error(`[MeetingPersistence] Failed to parse summary JSON (attempt ${attempt}/${SUMMARY_MAX_ATTEMPTS})`, e);
                        continue; // unparseable output — try again rather than verifying garbage
                    }

                    let confidence = 0;
                    try {
                        setProcessingStepDetail(meetingId, 'summary', 'Verifying every claim against the transcript' + attemptSuffix(attempt), attemptFraction(attempt, true));
                        const verification = await verifySummaryAgainstTranscript(this.llmHelper, rosterBlock + fullTranscriptText, jsonStr);
                        confidence = verification.confidence;
                        console.log(`[MeetingPersistence] Summary attempt ${attempt}/${SUMMARY_MAX_ATTEMPTS} grounding confidence: ${confidence} (${verification.issues.length} issue(s))`);

                        if (confidence > bestConfidence) {
                            bestConfidence = confidence;
                            bestParsedSummary = parsedSummary;
                        }

                        if (confidence >= SUMMARY_CONFIDENCE_THRESHOLD) {
                            break; // grounded well enough — stop here
                        }

                        correctionAddendum = buildCorrectionAddendum(verification.issues);
                    } catch (e) {
                        // Verifier itself threw unexpectedly (shouldn't normally happen —
                        // verifySummaryAgainstTranscript fails open internally). Accept
                        // this attempt as-is rather than losing the summary entirely.
                        console.warn('[MeetingPersistence] Summary verification threw, accepting ungraded:', e);
                        if (bestParsedSummary === null) {
                            bestParsedSummary = parsedSummary;
                            bestConfidence = 0;
                        }
                        break;
                    }
                }

                if (bestParsedSummary) {
                    if (bestConfidence >= 0 && bestConfidence < SUMMARY_CONFIDENCE_THRESHOLD) {
                        console.warn(`[MeetingPersistence] Accepting summary below confidence threshold after ${SUMMARY_MAX_ATTEMPTS} attempts (best score: ${bestConfidence})`);
                    }
                    // Drop fabricated/placeholder coaching entries, strip
                    // call-type blocks that don't belong to this call type, and
                    // stamp the resolved type for future consumers/regeneration.
                    // See ./utils/coachSummaryData.
                    const sanitized = sanitizeCoachSummary(bestParsedSummary, coachCallType);
                    sanitized.coachCallType = coachCallType;
                    // Guarantee BANT/MEDDIC in the summary matches live
                    // analysis exactly — see reconcileBantMeddicWithLiveAnalysis
                    // for why the prompt instruction alone isn't enough.
                    summaryData = reconcileBantMeddicWithLiveAnalysis({ ...summaryData, ...sanitized }, liveAnalysisData);
                }

                // Report token usage for the whole generation (even a failed
                // one consumed the calls it made). Emitted after the loop so
                // attempts + best confidence ride along.
                if (usageCalls.length > 0) {
                    emitLLMUsage({
                        meetingId,
                        kind: 'summary_initial',
                        calls: usageCalls,
                        totalInputTokens: usageCalls.reduce((n, c) => n + c.inputTokens, 0),
                        totalOutputTokens: usageCalls.reduce((n, c) => n + c.outputTokens, 0),
                        attempts: attemptsUsed,
                        confidence: bestConfidence >= 0 ? bestConfidence : null,
                        durationMs: Date.now() - summaryStartedAt,
                        callType: coachCallType,
                        at: Date.now(),
                    });
                }
            } else {
                console.log("Transcript too short for summary generation.");
            }
        } catch (e) {
            console.error("Error generating meeting metadata", e);
        }
        // Success or a non-fatal failure — either way these are no longer running.
        completeProcessingSteps(meetingId, 'title', 'summary');

        // Generate call analysis for uploaded transcripts (no live analysis available).
        //
        // PRIMARY: the backend's /intelligence/live-analysis route — reached
        // through the very same renderer-side intelligenceApi the live panel
        // calls, because that client owns the Firebase token and cannot run in
        // main (see ./utils/uploadAnalysisBridge). One implementation serves
        // both paths, and uploads gain the company-asset RAG grounding and
        // critique/revise loop that only exist server-side.
        //
        // FALLBACK: ./utils/uploadAnalysis, the local one-shot prompt that used
        // to be the only path here. It mirrors the backend's behaviour by hand
        // (objection category taxonomy, dealOptimizer gated on the negotiation
        // meeting-type hint, NO QUOTE = NO STATUS, ask-this only for
        // non-confirmed fields, catalogue-valid signal types, stableId stamps),
        // so it stays usable with no network, no auth, or an exhausted backend
        // budget — and is pinned on by GODOJO_UPLOAD_ANALYSIS_LOCAL=1.
        //
        // Its own try/catch: generateCallAnalysisFor is documented not to throw,
        // but a throw here used to escape processAndSaveMeeting entirely — the
        // meeting was never saved and chunking was never requested. A failed
        // analysis must cost the analysis, not the meeting.
        if (!liveAnalysisData && data.transcript.length > 2) {
            startProcessingStep(meetingId, 'analysis'); // detail: STEP_META.analysis.idleDetail
            try {
                // Backend first, local analyser as the fallback — shared with
                // regenerateSummary, see ./utils/callAnalysis.
                liveAnalysisData = await this.generateCallAnalysisFor(
                    humanSegments,
                    hintMeetingTypes ?? [],
                    rosterBlock + fullTranscriptText,
                );

                // Call Analysis exists only now on the upload/recovery path — the
                // reconciliation inside the summary step above ran while
                // liveAnalysisData was still null (its no-op early-return) and was
                // never re-applied. Re-run it here, for whichever producer won, so
                // the summary's BANT/MEDDIC can never disagree with the call
                // analysis. This is the same guarantee finalizeScorecard() gives
                // the scorecard: the analysis is the single source of truth for
                // every surface. (salesCoachReview.whatIDidRight survives this
                // pass — it holds film-review highlights about the rep, not
                // framework coverage.)
                if (liveAnalysisData) {
                    summaryData = reconcileBantMeddicWithLiveAnalysis(summaryData, liveAnalysisData);
                }
            } catch (e) {
                console.error('[MeetingPersistence] Call analysis failed (non-fatal, saving without it):', e);
            }
            completeProcessingSteps(meetingId, 'analysis');
        }

        // Set once the meeting + transcript are in SQLite (and queued for the
        // Supabase mirror). Backend chunking needs only the transcript, so the
        // finally below requests it whenever this is true — whatever failed
        // around it (summary, score, analysis, the UI notifications).
        let savedLocally = false;
        try {
            startProcessingStep(meetingId, 'save', 'Writing the finished summary to your meeting.');

            let detailedSummary = { ...summaryData };
            if (liveAnalysisData) {
                detailedSummary = { ...summaryData, liveAnalysis: liveAnalysisData };
            }

            // ── Collect Meeting Scorecard ──────────────────────────────────────────────────
            // The LLM half was started back before the title/summary calls (see
            // scorecardDraft above) so its latency overlaps theirs instead of
            // stacking on top. Only the grounding + write happen here, now that
            // `liveAnalysisData` is final on every path (the upload/recovery path
            // generates it just above). When the transcript was too short to
            // score, the draft is the null outcome and this is a no-op.
            // const { scorecardResult, persisted: scorecardPersisted } =
            //     this.finalizeScorecard(meetingId, await scorecardDraft, liveAnalysisData);

            // if (scorecardResult && !scorecardPersisted) {
            // DB write failed — fall back to embedding it in summary_json so the UI still gets data
            // detailedSummary = { ...detailedSummary, scorecard: scorecardResult } as any;
            // }

            // Use the speaker names snapshot captured BEFORE session.reset() was called.
            // Do NOT call this.session.getSpeakerNameMap() here — the session is already
            // reset at this point and would return the defaults { user: 'Me', client: 'Them' }.
            const resolvedSpeakerNames = speakerNames ?? this.session.getSpeakerNameMap();

            // Persist whenever at least one name differs from the generic default.
            if (resolvedSpeakerNames.user !== 'Me' || resolvedSpeakerNames.client !== 'Them') {
                detailedSummary = {
                    ...detailedSummary,
                    speakerNames: resolvedSpeakerNames
                };
            }

            // Stamp the resolved (company-domain-aware) speaker labels onto
            // each transcript segment before saving. Without this, every
            // segment only carries the raw role ('user'/'client'), and
            // DatabaseManager.saveMeeting() falls back to a hardcoded
            // generic label for any 'client'/'interviewer' segment — which
            // is why the persisted transcript view showed "Other Party"
            // even when Speaking Balance (which reads resolvedSpeakerNames
            // directly, not per-segment displayName) correctly showed the
            // real company name. When diarization found 2+ far-end voices,
            // the same helper appends "· Speaker N" off clientDiarized so the
            // saved labels match what _dispatchTranscript broadcast live.
            const transcriptWithDisplayNames = data.transcript.map(segment => ({
                ...segment,
                displayName: segment.displayName
                    ?? resolveSpeakerDisplayName(segment.speaker, segment.speakerIndex, resolvedSpeakerNames, multiClientSpeakers),
            }));

            const meetingData: Meeting = {
                id: meetingId,
                title: title,
                // Only used when no row exists yet (recovery re-processing): for the
                // normal flow saveMeeting() keeps the placeholder's created_at, so
                // the card doesn't re-timestamp itself to "processing finished".
                date: new Date().toISOString(),
                // Uploads without source timestamps keep an unknown duration
                // rather than a fabricated one (live calls are always > 1s).
                duration: data.durationMs > 0 ? formatDuration(data.durationMs) : '—',
                durationMs: data.durationMs,
                summary: "See detailed summary",
                detailedSummary: detailedSummary,
                transcript: transcriptWithDisplayNames,
                usage: data.usage,
                calendarEventId: calendarEventId,
                calendarEventMetadata: calendarEventMetadata,
                source: source,
                isProcessed: true,
                tenantId: tenantId || null
            };

            DatabaseManager.getInstance().saveMeeting(meetingData, data.startTime, data.endTime ?? (data.startTime + data.durationMs), data.totalPausedMs ?? 0);
            savedLocally = true;

            // Metadata was already snapshotted before session.reset() — nothing to clear here.

            // Notify Frontend to refresh list FIRST, then toast. The toast builds a
            // real BrowserWindow with inline HTML on the active display, and that
            // construction runs on main's event loop — doing it before these sends
            // delayed the card leaving its processing state by exactly as long as
            // the window took to come up. The user sees both either way; this way
            // the list is already correct when the toast lands on top of it.
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));
            // Separate, analytics-specific signal from 'meetings-updated' above —
            // that event also fires on paths that aren't "a meeting successfully
            // finished processing" (e.g. list refreshes), so it's not a safe
            // proxy for counting completed meetings. This one fires exactly once
            // per successfully saved meeting.
            wins.forEach((w: any) => w.webContents.send('meeting-completed'));

            // Toast the user that their summary is ready — same native,
            // display-aware toast used for pause/resume, so it's visible
            // regardless of which screen (or app) the user is currently on.
            // Fires here specifically because this is the point the summary,
            // scorecard, and title have all actually finished generating AND
            // been persisted — not just "processing kicked off".
            AppState.getInstance()?.notifyMeetingSummaryReady?.(title);

        } catch (error) {
            console.error('[MeetingPersistence] Failed to save meeting:', error);
        } finally {
            // After the 'meetings-updated' broadcast above, so the renderer's
            // "finished" event never beats the row it will read.
            endMeetingProcessing(meetingId, savedLocally);
            if (savedLocally) {
                this.triggerBackendChunking(meetingId, tenantId ?? null);
            } else {
                console.warn(`[MeetingPersistence] Meeting ${meetingId} was not saved locally — backend chunking not requested`);
            }
        }
    }

    /**
     * Kick backend RAG ingest now that the meeting + transcript are committed
     * locally (chat/Ask-Dojo read only from backend meeting_chunks). Called from
     * processAndSaveMeeting's `finally`, so it never depends on the summary,
     * score or call analysis having worked. Fire-and-forget: it never throws
     * and never delays the caller.
     */
    private triggerBackendChunking(meetingId: string, tenantId: string | null): void {
        // Wait for the Supabase mirror to actually land the transcript
        // batch first. saveMeeting() only ENQUEUED it (the mirror is
        // async-by-design so local writes never block on network), so
        // without this the chunking POST would routinely race the mirror
        // and get "No transcript found" on its very first attempt —
        // exactly the case requestBackendChunking's retry/queue logic
        // exists to paper over. Flushing here doesn't remove the need for
        // that retry logic (offline, slow network, backend hiccups are
        // still possible), it just means the common case succeeds on the
        // first try instead of needing 5s–30s of backoff.
        //
        // Timeout is generous (20s, vs flush()'s 8s default) because an
        // upload's transcript batch can be large (comment above notes up
        // to ~1500 turns) and 'transcripts' now shares PRIORITY_TABLES
        // with 'meetings' (see SupabaseMirrorService) so it isn't stuck
        // behind unrelated meetings' ai_interactions/chunks batches. If
        // the flush still times out, requestBackendChunking's own
        // retry/durable-queue logic takes over exactly as before.
        void (async () => {
            try {
                await SupabaseMirrorService.getInstance().flush(20_000);
            } catch (e) {
                console.warn('[MeetingPersistence] mirror flush before chunk trigger failed (non-fatal, chunking retries will cover it):', e);
            }
            await requestBackendChunking(meetingId, tenantId).catch(
                (e) => console.error('[MeetingPersistence] backend chunk trigger failed:', e),
            );
        })();
    }

    /**
     * Generates a meeting scorecard via the LLM and persists it to `meeting_scorecards`
     * (mirroring to Supabase). Single source of truth for: loading scoring criteria,
     * building the prompt, stripping ```json fences, parsing, normalizing
     * `categoryBreakdown`, grounding against live analysis, saving, and mirroring —
     * used by both the initial post-meeting scorecard generation and manual
     * regeneration so the two paths can't drift.
     *
     * Split into generateScorecardDraft() (the LLM round-trip, safe to start early
     * and overlap with the title/summary calls) and finalizeScorecard() (grounding +
     * write, which must wait until the final live analysis exists).
     *
     * Returns `scorecardResult: null` if generation/parsing failed (non-fatal —
     * callers should treat this as "no scorecard produced this run").
     * Returns `persisted: false` if generation succeeded but the DB write failed —
     * callers that need a fallback (e.g. embedding the scorecard in summary_json)
     * can check this flag.
     */
    private async generateAndPersistScorecard(
        meetingId: string,
        transcriptText: string,
        hintTypes: ('discovery' | 'demo' | 'negotiation')[] | null,
        liveAnalysis: LiveAnalysisData | null
    ): Promise<{ scorecardResult: MeetingScorecardResult | null; persisted: boolean }> {
        const draft = await this.generateScorecardDraft(transcriptText, hintTypes ?? null, liveAnalysis);
        return this.finalizeScorecard(meetingId, draft, liveAnalysis);
    }

    /**
     * The LLM half of scorecard generation: load criteria, build the prompt, call
     * the model, parse. No DB access, no reconciliation — so it can be kicked off
     * early and awaited later. Never rejects.
     *
     * `liveAnalysis` is optional here and only used to ground the prompt; the
     * live path has it up front, the upload/recovery path doesn't. Either way
     * finalizeScorecard() applies the deterministic grounding afterwards.
     */
    private async generateScorecardDraft(
        transcriptText: string,
        hintTypes: ('discovery' | 'demo' | 'negotiation')[] | null,
        liveAnalysis: LiveAnalysisData | null = null
    ): Promise<ScorecardDraft> {
        let customScoringCriteria: import('../src/types').ScoringCriteriaSettings | null = null;
        try {
            customScoringCriteria = DatabaseManager.getInstance().getScoringCriteria();
        } catch (criteriaErr) {
            console.warn('[MeetingPersistence] Could not load custom scoring criteria, using defaults:', criteriaErr);
        }

        let scorecardResult: MeetingScorecardResult | null = null;
        try {
            const scorecardPrompt = buildScorecardPrompt(customScoringCriteria, hintTypes ?? null, liveAnalysis);
            const scorecardRaw = await this.llmHelper.generateMeetingSummary(
                scorecardPrompt,
                transcriptText,
                scorecardPrompt,
                'meeting_score'
            );
            if (scorecardRaw) {
                const clean = scorecardRaw.replace(/```json|```/g, '').trim();
                const parsed = JSON.parse(clean);
                scorecardResult = {
                    detectedTypes: parsed.detectedTypes ?? [],
                    overallWeightedScore: parsed.overallWeightedScore ?? 0,
                    scorecards: Object.values(parsed.scorecards ?? {}).map((sc: any) => ({
                        ...sc,
                        // Keep the config key when the model returned the breakdown as an
                        // object (it always does) — reconcileScorecardWithLiveAnalysis
                        // matches on key first, so a renamed custom label still grounds.
                        categoryBreakdown: Array.isArray(sc.categoryBreakdown)
                            ? sc.categoryBreakdown
                            : Object.entries(sc.categoryBreakdown ?? {}).map(([key, cat]: [string, any]) => ({ key, ...cat })),
                    })),
                } as MeetingScorecardResult;
            }
        } catch (e) {
            console.warn('[MeetingPersistence] Scorecard generation failed (non-fatal):', e);
            return { scorecardResult: null, customScoringCriteria };
        }

        return { scorecardResult, customScoringCriteria };
    }

    /**
     * Grounds a scorecard draft against live analysis, merges it with any
     * previously-saved scorecard, and writes it to `meeting_scorecards` (+ the
     * Supabase mirror). Synchronous: the SQLite write is sync and the mirror is
     * fire-and-forget.
     */
    private finalizeScorecard(
        meetingId: string,
        draft: ScorecardDraft,
        liveAnalysis: LiveAnalysisData | null
    ): { scorecardResult: MeetingScorecardResult | null; persisted: boolean } {
        const { customScoringCriteria } = draft;
        let scorecardResult = draft.scorecardResult;

        if (!scorecardResult) {
            return { scorecardResult: null, persisted: false };
        }

        // Call Analysis is the single source of truth for MEDDIC / BANT /
        // objections / signals. The prompt was already grounded with it, but a
        // prompt instruction is not a guarantee (same reasoning as
        // reconcileBantMeddicWithLiveAnalysis above), so re-derive those
        // categories deterministically. Unrecognised categories are untouched.
        try {
            scorecardResult = reconcileScorecardWithLiveAnalysis(scorecardResult, liveAnalysis);
        } catch (reconcileErr) {
            console.warn('[MeetingPersistence] Scorecard reconciliation failed (non-fatal):', reconcileErr);
        }

        // Merge with any previously-saved scorecard so that a regenerate run
        // which only re-detects a subset of types (LLM output isn't fully
        // deterministic run-to-run) doesn't blow away scores for types that
        // aren't returned this time. New results win per-type; older types
        // not present in this run are carried forward as-is.
        const previousScorecard = DatabaseManager.getInstance().getMeetingScorecard(meetingId);
        if (previousScorecard?.scorecards?.length) {
            const newTypes = new Set(scorecardResult.scorecards.map(sc => sc.meetingType));
            const carriedOver = previousScorecard.scorecards.filter(sc => !newTypes.has(sc.meetingType));
            const mergedScorecards = [...scorecardResult.scorecards, ...carriedOver];
            const mergedDetectedTypes = Array.from(new Set([
                ...scorecardResult.detectedTypes,
                ...carriedOver.map(sc => sc.meetingType),
            ]));
            const mergedOverallScore = mergedScorecards.length
                ? mergedScorecards.reduce((sum, sc) => sum + (sc.overallScore ?? 0), 0) / mergedScorecards.length
                : scorecardResult.overallWeightedScore;

            scorecardResult = {
                scorecards: mergedScorecards,
                detectedTypes: mergedDetectedTypes,
                overallWeightedScore: mergedOverallScore,
            };
        }

        // Write scorecard to its dedicated table — NOT into summary_json
        try {
            DatabaseManager.getInstance().saveMeetingScorecard(
                meetingId,
                scorecardResult,
                customScoringCriteria ?? null   // snapshot the criteria used
            );
        } catch (scorecardSaveErr) {
            console.warn('[MeetingPersistence] Failed to persist scorecard (non-fatal):', scorecardSaveErr);
            return { scorecardResult, persisted: false };
        }

        // Mirror to Supabase — no-op if unauthenticated, non-fatal on failure
        try {
            SupabaseMirrorService.getInstance().upsertRow('meeting_scorecards', {
                meeting_id: meetingId,
                overall_score: scorecardResult.overallWeightedScore ?? 0,
                detected_types: scorecardResult.detectedTypes ?? [],
                scorecard_json: scorecardResult,
                criteria_snapshot_json: customScoringCriteria ?? null,
                generated_at: new Date().toISOString(),
            });
        } catch (mirrorErr) {
            console.warn('[MeetingPersistence] Scorecard mirror to Supabase failed (non-fatal):', mirrorErr);
        }

        return { scorecardResult, persisted: true };
    }

    /**
     * Re-scores a meeting using the latest scoring criteria from the DB.
     * Saves the result to `meeting_scorecards` (and mirrors to Supabase) so the
     * next `getMeetingDetails` call returns fresh scorecard data.
     *
     * `liveAnalysis` must be the meeting's stored live analysis
     * (`detailedSummary.liveAnalysis`) — passing null would re-score the
     * frameworks from the transcript alone and reintroduce the drift between the
     * Meeting Score and the Call Analysis tab.
     */

    private async regenerateScorecard(
        meetingId: string,
        transcriptContext: string,
        detectedMeetingTypes: ('discovery' | 'demo' | 'negotiation')[] | null,
        liveAnalysis: LiveAnalysisData | null
    ): Promise<void> {
        const { scorecardResult } = await this.generateAndPersistScorecard(
            meetingId,
            transcriptContext,
            detectedMeetingTypes ?? null,
            liveAnalysis
        );

        if (scorecardResult) {
            console.log(`[MeetingPersistence] Regenerated scorecard for meeting ${meetingId}`);
        }
    }

    /**
     * Regenerate the summary for a meeting
     */

    public async regenerateSummary(meetingId: string): Promise<boolean> {

        try {

            const meeting = DatabaseManager.getInstance().getMeetingDetails(meetingId);
            if (!meeting || !meeting.transcript || meeting.transcript.length < 3) {
                console.warn('[MeetingPersistence] Cannot regenerate: meeting not found or transcript too short');
                return false;
            }

            // Build the same context string as original processing — using the
            // shared speaker-identity layer: persisted rows carry displayNames
            // (original labels for uploads, resolved/diarized names for live
            // calls), so regenerating never falls back to generic
            // "SALES PERSON"/"PROSPECT" wording.
            const regenSpeakerNames = (meeting.detailedSummary as any)?.speakerNames as SpeakerNameMapLike | undefined;
            const regenMultiClients = hasMultipleClientSpeakers(meeting.transcript);
            const regenSegments = meeting.transcript
                .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()));
            const regenRosterBlock = regenSegments.some(t => !!t.displayName)
                ? formatSpeakerRosterBlock(buildSpeakerRoster(regenSegments, regenSpeakerNames, regenMultiClients))
                : '';
            const fullRegenerateContext = regenRosterBlock + regenSegments
                .map(t => `${transcriptTurnLabel(t, regenSpeakerNames, regenMultiClients)}: ${t.text}`)
                .join('\n');

            // Re-use live analysis from detailedSummary if present so the regen is also grounded.
            // A meeting without one (an upload or recovered meeting whose first analysis
            // failed — e.g. an exhausted LLM quota) gets it generated here, before the
            // summary, so the Call Analysis tab fills in and the summary's BANT/MEDDIC is
            // reconciled against it exactly as on the first save. Regenerating used to
            // rebuild only the summary, so such a meeting never got a Call Analysis.
            const storedLiveAnalysis = (meeting.detailedSummary as any)?.liveAnalysis;
            let existingLiveAnalysis: LiveAnalysisData | undefined =
                hasUsableCallAnalysis(storedLiveAnalysis) ? storedLiveAnalysis : undefined;
            let generatedLiveAnalysis: LiveAnalysisData | null = null;
            // An upload's analysis comes from its transcript alone, so regenerating re-runs it too
            // and picks up analysis fixes (e.g. what counts as an objection). A live call keeps
            // the analysis made at the end of the call. If the re-run fails, the stored one stays.
            const refreshUploadAnalysis = meeting.source === 'upload' && !!existingLiveAnalysis;
            if ((!existingLiveAnalysis || refreshUploadAnalysis) && regenSegments.length > 2) {
                const regenTypes = meetingTypesForRegenerate(
                    meeting.meetingTypes,
                    DatabaseManager.getInstance().getMeetingScorecard(meetingId)?.detectedTypes,
                    (meeting.detailedSummary as any)?.scorecard?.detectedTypes,
                );
                console.log(
                    `[MeetingPersistence] Regenerate: ${meetingId} ` +
                    (refreshUploadAnalysis ? 'is an upload — re-running its call analysis' : 'has no call analysis — generating it'),
                );
                generatedLiveAnalysis = await this.generateCallAnalysisFor(
                    regenSegments,
                    regenTypes,
                    fullRegenerateContext,
                    REGENERATE_ANALYSIS_TIMEOUT_MS,
                );
                if (generatedLiveAnalysis) {
                    existingLiveAnalysis = generatedLiveAnalysis;
                    // Written straight away so it survives a summary failure below — the
                    // Call Analysis tab reads it on its own.
                    DatabaseManager.getInstance().updateMeetingSummary(meetingId, { liveAnalysis: generatedLiveAnalysis });
                }
            }
            // Resolve the call type again from existing meeting data so a
            // regeneration produces the same call-type-aware structure as the
            // initial save: explicit rep selection (where stored) > the type
            // stamped on the previous summary > scorecard detection > discovery.
            const coachCallType = resolveCoachCallType(
                meeting.meetingTypes,
                (meeting.detailedSummary as any)?.coachCallType,
                DatabaseManager.getInstance().getMeetingScorecard(meetingId)?.detectedTypes,
                (meeting.detailedSummary as any)?.scorecard?.detectedTypes,
            );
            const groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT + '\n\n' + buildCoachCallTypeSection(coachCallType);

            // Observability: usage for this regeneration (utils/llmUsageBus).
            const regenUsage: LLMUsageCall[] = [];
            const regenStartedAt = Date.now();
            const generatedSummary = await this.llmHelper.generateMeetingSummary(
                buildSummaryPrompt(existingLiveAnalysis, null, coachCallType),
                fullRegenerateContext,
                groqSummaryPrompt,
                'summary',
                (call) => regenUsage.push(call)
            );

            if (regenUsage.length > 0) {
                emitLLMUsage({
                    meetingId,
                    kind: 'summary_regenerate',
                    calls: regenUsage,
                    totalInputTokens: regenUsage.reduce((n, c) => n + c.inputTokens, 0),
                    totalOutputTokens: regenUsage.reduce((n, c) => n + c.outputTokens, 0),
                    attempts: 1,
                    confidence: null,
                    durationMs: Date.now() - regenStartedAt,
                    callType: coachCallType,
                    at: Date.now(),
                });
            }

            if (!generatedSummary) return false;

            const jsonMatch = generatedSummary.match(/```json\n([\s\S]*?)\n```/) || [null, generatedSummary];
            const jsonStr = (jsonMatch[1] || generatedSummary).trim();
            let summaryData = JSON.parse(jsonStr);
            // Drop fabricated/placeholder coaching entries and type-mismatched
            // blocks, and stamp the resolved call type — same as the initial save.
            summaryData = sanitizeCoachSummary(summaryData, coachCallType);
            summaryData.coachCallType = coachCallType;
            // Same guarantee as the initial save path — regenerating must not
            // let BANT/MEDDIC drift from the meeting's stored live analysis.
            summaryData = reconcileBantMeddicWithLiveAnalysis(summaryData, existingLiveAnalysis);
            // Never let the summary JSON carry a stray liveAnalysis key over the real one.
            delete summaryData.liveAnalysis;

            // updateMeetingSummary merge-keeps keys the new summary doesn't
            // carry, so explicitly blank out type-specific blocks the resolved
            // call type no longer owns (undefined is dropped by JSON.stringify,
            // removing the stored key) — e.g. a demo regeneration over an old
            // negotiation summary must not keep a stale "negotiation" block.
            DatabaseManager.getInstance().updateMeetingSummary(meetingId, {
                ...summaryData,
                ...clearForeignCoachBlocks(coachCallType),
            });
            console.log(
                `[MeetingPersistence] Regenerated summary for meeting ${meetingId}` +
                (generatedLiveAnalysis ? ' (with a new call analysis)' : ''),
            );

            // Re-score using the latest criteria so any criteria changes made before
            // clicking "regenerate" are reflected in the scorecard shown in the UI.
            // Note if re-enabling: pass `existingLiveAnalysis` through so the
            // re-score stays grounded in the same Call Analysis the summary above
            // was just reconciled against.
            // const existingTypes = (meeting.detailedSummary as any)?.scorecard?.detectedTypes ?? null;
            // try {
            //     await this.regenerateScorecard(meetingId, fullRegenerateContext, existingTypes, existingLiveAnalysis ?? null);
            // } catch (scorecardErr) {
            //     // Non-fatal: text summary was already saved; log and continue.
            //     console.warn('[MeetingPersistence] Scorecard regeneration failed (non-fatal):', scorecardErr);
            // }

            return true;

        } catch (e) {

            console.error('[MeetingPersistence] Failed to regenerate summary:', e);
            // Previously swallowed to `return false` here, which lost the actual
            // provider error (e.g. Gemini "RESOURCE_EXHAUSTED" / Groq rate-limit
            // text set on `e` by LLMHelper.generateMeetingSummary) — the caller
            // only ever saw a generic failure. Rethrow so it reaches the
            // regenerate-meeting-summary IPC handler's catch, which returns
            // { success: false, error } with the real message intact.
            throw e;

        }
    }

    /**
     * Parse a raw transcript text and process it as a real meeting — same
     * lifecycle as a live call: placeholder save + shared processAndSaveMeeting
     * pipeline (summary, call analysis via the no-live-analysis branch,
     * scorecard, events, toast, Supabase mirror). `tenantId` must be threaded
     * through so the row is owned by the current account like live meetings.
     */
    public async uploadTranscript(
        rawText: string,
        title?: string,
        meetingTypes?: ('discovery' | 'demo' | 'negotiation')[],
        tenantId?: string | null,
        repSpeaker?: string | null
    ): Promise<string | null> {
        try {
            // Parse "[HH:MM:SS] SALES PERSON: text", "[MM:SS] ...", plain
            // "Alex: text", and multi-line messages via the shared parser —
            // original speaker labels survive as displayName, timestamps are
            // never invented, and duration is null when the source had none.
            // The rep is the speaker picked in the upload modal, else the one
            // named like the signed-in user, else the first speaker.
            const { segments, durationMs: parsedDurationMs, repSpeaker: resolvedRep, repSource } =
                parseUploadTranscript(rawText, { repLabel: repSpeaker, repNameHints: uploadRepNameHints() });
            const transcript = segments as TranscriptSegment[];
            console.log(`[MeetingPersistence] Upload: rep speaker ${resolvedRep ? `"${resolvedRep}"` : 'none'} (${repSource ?? 'no labels'})`);

            if (transcript.length < 2) {
                console.warn('[MeetingPersistence] Upload: transcript too short');
                return null;
            }

            const meetingId = crypto.randomUUID();
            const now = Date.now();
            // Real timestamp span when the transcript carried them; otherwise
            // duration stays UNKNOWN (0 / '—') rather than estimated from a
            // line count — a fabricated length would contradict the source.
            const durationMs = parsedDurationMs ?? 0;
            const startTimeMs = now - durationMs;
            const context = transcript.map(t => `${t.displayName ?? (t.speaker === 'user' ? 'Me' : 'Them')}: ${t.text}`).join('\n');

            // Save placeholder immediately so it appears in the list
            const placeholder: Meeting = {
                id: meetingId,
                // The user usually typed a title on the upload form — keep it; the
                // row renders as processing off isProcessed, not off this string.
                title: title || 'Processing...',
                date: new Date().toISOString(),
                duration: durationMs > 0 ? formatDuration(durationMs) : '—',
                durationMs: durationMs,
                summary: '',
                detailedSummary: { actionItems: [], keyPoints: [] },
                // Same reasoning as the live-meeting placeholder — the full
                // transcript is already parsed and sitting in memory at this
                // point, no reason to withhold it until background processing.
                transcript,
                usage: [],
                tenantId: tenantId || null,
                isProcessed: false,
                // Tagged from the FIRST save so the meeting card's
                // Live/Quick/Upload badge never mislabels an upload as Quick
                // during the processing window.
                source: 'upload',
            };

            DatabaseManager.getInstance().saveMeeting(placeholder, startTimeMs, startTimeMs + durationMs, 0);
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));

            // Pass the user's title as metadata so processAndSaveMeeting uses it
            // instead of generating a new one from the transcript
            this.processAndSaveMeeting(
                { transcript, usage: [], startTime: startTimeMs, durationMs, context },
                meetingId,
                { title: title || undefined, source: 'upload' },
                null,           // liveAnalysisData — not available for uploads
                undefined,      // speakerNames
                null,           // companyIntel
                meetingTypes,   // ← scorecard type hints from the upload modal
                tenantId || null
            ).catch(err => console.error('[MeetingPersistence] Upload processing failed:', err));

            return meetingId;
        } catch (e) {
            console.error('[MeetingPersistence] uploadTranscript error:', e);
            return null;
        }
    }

    /**
     * Recover meetings that were started but not fully processed (e.g. app crash)
     */
    public async recoverUnprocessedMeetings(): Promise<void> {
        console.log('[MeetingPersistence] Checking for unprocessed meetings...');
        const db = DatabaseManager.getInstance();
        const unprocessed = db.getUnprocessedMeetings();

        if (unprocessed.length === 0) {
            console.log('[MeetingPersistence] No unprocessed meetings found.');
            return;
        }

        console.log(`[MeetingPersistence] Found ${unprocessed.length} unprocessed meetings. recovering...`);

        for (const m of unprocessed) {
            try {
                const details = db.getMeetingDetails(m.id);
                if (!details) continue;

                console.log(`[MeetingPersistence] Recovering meeting ${m.id}...`);

                const context = details.transcript?.map(t => {
                    const label = t.speaker === 'client' ? 'CLIENT' :
                        t.speaker === 'user' ? 'ME' : 'ASSISTANT';
                    return `[${label}]: ${t.text}`;
                }).join('\n') || "";

                // Reuse the raw timing facts stored at save time. NEVER re-derive
                // from created_at — created_at is the processing timestamp, not the
                // real meeting start, so recomputing duration_ms from it makes the
                // duration drift on every recovery (the bug seen after account switch).
                const startTime = m.startTime ?? new Date(details.date).getTime();
                const durationMs = m.durationMs ?? details.durationMs ?? 0;
                const endTime = m.endTime ?? (startTime + durationMs);
                const totalPausedMs = m.totalPausedMs ?? 0;

                const snapshot = {
                    transcript: details.transcript as TranscriptSegment[],
                    usage: details.usage,
                    startTime,
                    endTime,          // NEW
                    totalPausedMs,    // NEW
                    durationMs,
                    context,
                };

                await this.processAndSaveMeeting(snapshot, m.id);
                console.log(`[MeetingPersistence] Recovered meeting ${m.id}`);
            } catch (e) {
                console.error(`[MeetingPersistence] Failed to recover meeting ${m.id}`, e);
            }
        }

    }


}