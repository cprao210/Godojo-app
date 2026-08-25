// MeetingPersistence.ts
// Handles meeting lifecycle: stop, save, and recovery.
// Extracted from IntelligenceManager to decouple DB operations from LLM orchestration.

import { SessionTracker, TranscriptSegment } from './SessionTracker';
import { LLMHelper } from './LLMHelper';
import { DatabaseManager, Meeting, formatDuration } from './db/DatabaseManager';
import { GROQ_TITLE_PROMPT, GROQ_SUMMARY_JSON_PROMPT, verifySummaryAgainstTranscript, buildCorrectionAddendum } from './llm';
import { LiveAnalysisData, MeetingScorecardResult } from '../src/types';
import { AppState } from './main';
import { buildCompanyContextBlock } from '../electron/utils/salesBriefUtils';
import { buildScorecardPrompt } from './llm/ScoreCardLLM';
import { BANT_ORDER, MEDDICC_ORDER } from '../src/lib/bantMeddic';

const crypto = require('crypto');

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

// ── BANT/MEDDIC reconciliation ──────────────────────────────────────────────
// buildSummaryPrompt() TELLS the LLM live analysis is authoritative and to
// "copy these values directly" — but that's a prompt instruction, not a
// guarantee. The LLM can paraphrase evidence, misapply the status mapping,
// or re-derive a field from the transcript instead of trusting the supplied
// value, especially on a fallback-tier provider. This function makes that
// guarantee real: it overwrites summaryData.bant/meddicc in code, directly
// from liveAnalysisData, so the Summary tab and the Call Analysis tab can
// never disagree on BANT/MEDDIC status or evidence.

// salesCoachReview.whatIDidRight's BANT/MEDDICC-labelled items are reconciled
// the same way (see buildConfirmedWhatIDidRight below): the LLM was previously
// free to cherry-pick up to 6 "wins" from the transcript on its own judgment,
// which routinely disagreed with the Confirmed set shown in Call Analysis.
// Those items are now derived deterministically from the same
// liveAnalysis-backed bant/meddicc objects below, so "Sales Self-Analysis"
// can never show a different confirmed count than the live Call Analysis tab.
// Only fields that legitimately require transcript reasoning (overview,
// dealStatus, whatICouldHaveDoneBetter, whatIMissedCompletely,
// nextCallPlaybook, keyPoints, actionItems) are left for the LLM.

const toComponentName = (camelKey: string): string => camelKey.charAt(0).toUpperCase() + camelKey.slice(1);

function buildConfirmedWhatIDidRight(
    bant: Record<string, { status: string; detail: string }>,
    meddicc: Record<string, { status: string; detail: string }>,
): string[] {
    const meddiccItems = MEDDICC_ORDER
        .filter((key) => meddicc[key]?.status === 'Clear')
        .map((key) => `MEDDICC ${toComponentName(key)}: ${meddicc[key].detail}`);

    const bantItems = BANT_ORDER
        .filter((key) => bant[key]?.status === 'Clear')
        .map((key) => `BANT ${toComponentName(key)}: ${bant[key].detail}`);

    return [...meddiccItems, ...bantItems];
}
const STATUS_MAP: Record<string, string> = {
    confirmed: 'Clear',
    partial: 'Partial',
    missing: 'Missing',
    '': 'Missing',
};

function reconcileBantMeddicWithLiveAnalysis(
    summaryData: any,
    liveAnalysis: LiveAnalysisData | null | undefined,
): any {

    if (!liveAnalysis) return summaryData; // nothing to reconcile against — leave LLM output as-is

    const field = (f: { status: string; evidence: string } | undefined) => ({
        status: STATUS_MAP[f?.status ?? ''] ?? 'Missing',
        detail: f?.evidence || '',
    });

    const reconciledBant = {
        budget: field(liveAnalysis.bant?.budget),
        authority: field(liveAnalysis.bant?.authority),
        need: field(liveAnalysis.bant?.need),
        timeline: field(liveAnalysis.bant?.timeline),
    };

    const reconciledMeddicc = {
        metrics: field(liveAnalysis.meddic?.metrics),
        economicBuyer: field(liveAnalysis.meddic?.economic_buyer),
        decisionCriteria: field(liveAnalysis.meddic?.decision_criteria),
        decisionProcess: field(liveAnalysis.meddic?.decision_process),
        identifyPain: field(liveAnalysis.meddic?.identify_pain),
        champion: field(liveAnalysis.meddic?.champion),
        competition: field(liveAnalysis.meddic?.competition),
        // gaps is genuinely a summarization task (which of the 7 fields
        // are weak) — keep the LLM's own list rather than recomputing it
        // here, but fall back to deriving it from the reconciled statuses
        // above if the LLM omitted it.
        gaps: summaryData?.meddicc?.gaps?.length
            ? summaryData.meddicc.gaps
            : (['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'competition'] as const)
                .filter((k) => (liveAnalysis.meddic as any)?.[k]?.status !== 'confirmed')
                .map((k) => k),
    };

    return {
        ...summaryData,
        bant: reconciledBant,
        meddicc: reconciledMeddicc,
        salesCoachReview: {
            ...summaryData?.salesCoachReview,
            whatIDidRight: buildConfirmedWhatIDidRight(reconciledBant, reconciledMeddicc),
        },
    };
}

const buildSummaryPrompt = (liveAnalysis?: LiveAnalysisData | null, companyIntel?: Record<string, any> | null): string => {

    // ── With live analysis: structured data is the authoritative BANT/MEDDIC source ──
    // The live analysis is the already-distilled output of the entire call, built
    // incrementally from every prospect turn. Re-deriving BANT/MEDDIC from the raw
    // transcript is redundant and wastes tokens. Instead:
    //   • BANT/MEDDIC  → copy directly from live analysis; only override with clear
    //                    transcript evidence that contradicts or upgrades a field.
    //   • Overview, dealStatus, followUpEmail, salesCoachReview, nextCallPlaybook
    //     → derive from the full transcript as normal.
    if (liveAnalysis) {
        const objectionsBlock = liveAnalysis.objections.length > 0
            ? liveAnalysis.objections.map(o => `  - [${o.type}] ${o.quote} (${o.status})`).join('\n')
            : '  None captured';

        const signalsBlock = liveAnalysis.signals.length > 0
            ? liveAnalysis.signals.slice(0, 8).map(s => `  - [${s.category}/${s.intensity}] ${s.quote}`).join('\n')
            : '  None captured';

        const companySection = buildCompanyContextBlock(companyIntel ?? null);
        return `You are an expert B2B sales analyst. A sales call just ended. Generate a structured post-call summary. Return ONLY valid JSON (no markdown code blocks, no commentary).
            ${companySection ? `\n${companySection}\nUse the company intelligence above to enrich your analysis — recognise their known products, competitors, and business model in the transcript.\n` : ''} Generate a structured post-call summary. Return ONLY valid JSON (no markdown code blocks, no commentary).

            ═══════════════════════════════════════
            LIVE ANALYSIS — AUTHORITATIVE BANT + MEDDIC DATA
            ═══════════════════════════════════════
            The following was captured in real-time across the full call. It is the primary source
            of truth for BANT and MEDDIC fields. Copy these values directly into your output.
            Only upgrade a status (e.g. partial → confirmed) if the transcript contains explicit,
            unambiguous new evidence. Never downgrade without a clear contradiction in the transcript.

            BANT:
            - Budget:    ${liveAnalysis.bant.budget.status} | ${liveAnalysis.bant.budget.evidence || 'No evidence'}
            - Authority: ${liveAnalysis.bant.authority.status} | ${liveAnalysis.bant.authority.evidence || 'No evidence'}
            - Need:      ${liveAnalysis.bant.need.status} | ${liveAnalysis.bant.need.evidence || 'No evidence'}
            - Timeline:  ${liveAnalysis.bant.timeline.status} | ${liveAnalysis.bant.timeline.evidence || 'No evidence'}

            MEDDIC:
            - Metrics:           ${liveAnalysis.meddic.metrics.status} | ${liveAnalysis.meddic.metrics.evidence || 'No evidence'}
            - Economic Buyer:    ${liveAnalysis.meddic.economic_buyer.status} | ${liveAnalysis.meddic.economic_buyer.evidence || 'No evidence'}
            - Decision Criteria: ${liveAnalysis.meddic.decision_criteria.status} | ${liveAnalysis.meddic.decision_criteria.evidence || 'No evidence'}
            - Decision Process:  ${liveAnalysis.meddic.decision_process.status} | ${liveAnalysis.meddic.decision_process.evidence || 'No evidence'}
            - Identify Pain:     ${liveAnalysis.meddic.identify_pain.status} | ${liveAnalysis.meddic.identify_pain.evidence || 'No evidence'}
            - Champion:          ${liveAnalysis.meddic.champion.status} | ${liveAnalysis.meddic.champion.evidence || 'No evidence'}
            - Competition:       ${liveAnalysis.meddic.competition.status} | ${liveAnalysis.meddic.competition.evidence || 'No evidence'}

            Status mapping for the output fields below: confirmed → Clear | partial → Partial | missing → Missing
            Evidence strings above map verbatim to the "detail" fields in the output.

            Objections captured during the call (${liveAnalysis.objections.length}):
            ${objectionsBlock}

            Key signals captured during the call (${liveAnalysis.signals.length} total, top 8 shown):
            ${signalsBlock}

            ═══════════════════════════════════════
            YOUR TASK (use the FULL TRANSCRIPT for these sections only):
            ═══════════════════════════════════════
            Use the full transcript to write:
            • overview        — 2-3 sentence summary of what was covered and deal status
            • dealStatus      — current deal stage + one-line summary
            • leadName/company — extract from the transcript
            • salesCoachReview — reference actual call moments, not generic advice
            • nextCallPlaybook — questions that target the weakest BANT/MEDDIC areas above
            • keyPoints / actionItems

            For BANT and MEDDIC in the output: use the live analysis values above as-is.
            Map status: confirmed→Clear, partial→Partial, missing→Missing.
            Use the evidence string verbatim as the "detail" field.

            {
                "overview": "2-3 sentence summary of what the call covered and the current deal status",

                "dealStatus": {
                    "stage": "one of: Discovery / Qualification / Demo / Proposal / Negotiation / Closed Won / Closed Lost / Unknown",
                    "summary": "1 sentence on where the deal stands right now"
                },

                "bant": {
                    "budget":    { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above — only override if transcript shows a clear change" },
                    "authority": { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above — only override if transcript shows a clear change" },
                    "need":      { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above — only override if transcript shows a clear change" },
                    "timeline":  { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above — only override if transcript shows a clear change" }
                },

                "meddicc": {
                    "metrics":          { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above" },
                    "economicBuyer":    { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above" },
                    "decisionCriteria": { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above" },
                    "decisionProcess":  { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above" },
                    "identifyPain":     { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above" },
                    "champion":         { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above" },
                    "competition":      { "status": "Clear | Partial | Missing", "detail": "copy from live analysis evidence above" },
                    "gaps": ["list of MEDDICC components that are Missing or Partial — these need follow-up"]
                },

                "leadName": "extract prospect full name from transcript — first name + last name if mentioned, else null",
                "company": "extract company/organization name from transcript, else null",

                "salesCoachReview": {
                    "whatIDidRight": [
                        "MEDDICC [ComponentName]: [what the rep did well]",
                        "BANT [ComponentName]: [BANT win]"
                    ],
                    "whatICouldHaveDoneBetter": [
                        "Should have pushed harder on [specific topic from call] — ask: [exact question]",
                        "Missed opportunity to [specific action] when prospect said [trigger phrase from transcript]"
                    ],
                    "whatIMissedCompletely": [
                        "Identify Champion: [specific gap]",
                        "Metrics: [specific metric never asked about]",
                        "Authority: [specific authority gap]",
                        "Process: [specific process skipped]",
                        "Pain: [specific pain never addressed]"
                    ]
                },

                "nextCallPlaybook": {
                    "openingRecap": "2-3 sentences to open the next call recapping where things stand",
                    "questionsToAsk": ["5 high-value questions to fill the biggest BANT/MEDDIC gaps identified above"],
                    "valueAndROI": {
                        "quantitative": ["2-3 measurable ROI points to reinforce"],
                        "qualitative": ["2-3 strategic or emotional value points to reinforce"]
                    }
                },

                "keyPoints": ["4-6 bullets — top things to know about this deal right now"],
                "actionItems": ["specific next steps with owners if mentioned, or implied follow-ups"]
            }

            RULES:
            - Do NOT invent information not in the transcript
            - BANT/MEDDIC: use live analysis values verbatim unless the transcript clearly contradicts them
            - Sales coach review must reference actual call moments — not generic advice
            - Next call questions must target the weakest BANT/MEDDIC areas from the live analysis above
            - Return ONLY valid JSON — no markdown, no code blocks, no explanation
            - leadName and company: extract from transcript introductions. Return null if not found.
            - salesCoachReview.whatIMissedCompletely: EVERY item MUST start with a gap category: Identify Champion: | Metrics: | Authority: | Process: | Pain: | Timeline: | Budget:
            - salesCoachReview.whatIDidRight: EVERY item MUST start with a framework label: "MEDDICC Metrics:", "BANT Budget:", etc. Return ONLY items where something genuinely happened. Min 2, max 6.
            - salesCoachReview.whatIDidRight: group MEDDICC items first, then BANT items.
            - salesCoachReview.whatIMissedCompletely: items MUST follow this strict label sequence: Identify Champion, Metrics, Authority, Process, Pain.
            - Reference specific moments, names, numbers from the transcript — never be generic
        `;
    }

    // ── Without live analysis: derive everything from the full transcript ─────────
    return `You are an expert B2B sales analyst. A sales call just ended. Analyze the full transcript and generate a structured post-call summary. Return ONLY valid JSON (no markdown code blocks, no commentary).

        {
            "overview": "2-3 sentence summary of what the call covered and the current deal status",

            "dealStatus": {
                "stage": "one of: Discovery / Qualification / Demo / Proposal / Negotiation / Closed Won / Closed Lost / Unknown",
                "summary": "1 sentence on where the deal stands right now"
            },

            "bant": {
                "budget":    { "status": "Clear | Partial | Missing", "detail": "what was said or implied about budget" },
                "authority": { "status": "Clear | Partial | Missing", "detail": "who the decision maker is and their level of involvement" },
                "need":      { "status": "Clear | Partial | Missing", "detail": "what pain or need was uncovered" },
                "timeline":  { "status": "Clear | Partial | Missing", "detail": "when they want to move or what the urgency is" }
            },

            "meddicc": {
                "metrics":          { "status": "Clear | Partial | Missing", "detail": "quantifiable business impact discussed" },
                "economicBuyer":    { "status": "Clear | Partial | Missing", "detail": "who controls the budget and were they involved" },
                "decisionCriteria": { "status": "Clear | Partial | Missing", "detail": "what criteria will be used to evaluate and choose" },
                "decisionProcess":  { "status": "Clear | Partial | Missing", "detail": "what steps does their buying process follow" },
                "identifyPain":     { "status": "Clear | Partial | Missing", "detail": "specific pain points uncovered and their business impact" },
                "champion":         { "status": "Clear | Partial | Missing", "detail": "who internally will advocate for this solution" },
                "competition":      { "status": "Clear | Partial | Missing", "detail": "any competitors or alternatives mentioned" },
                "gaps": ["list of MEDDICC components that are Missing or Partial — these need follow-up"]
            },

            "leadName": "extract prospect full name from transcript — first name + last name if mentioned, else null",
            "company": "extract company/organization name from transcript, else null",

            "salesCoachReview": {
                "whatIDidRight": [
                    "MEDDICC [ComponentName]: [what the rep did well]",
                    "BANT [ComponentName]: [BANT win]"
                ],
                "whatICouldHaveDoneBetter": [
                    "Should have pushed harder on [specific topic from call] — ask: [exact question]",
                    "Missed opportunity to [specific action] when prospect said [trigger phrase from transcript]"
                ],
                "whatIMissedCompletely": [
                    "Identify Champion: [specific gap]",
                    "Metrics: [specific metric never asked about]",
                    "Authority: [specific authority gap]",
                    "Process: [specific process skipped]",
                    "Pain: [specific pain never addressed]"
                ]
            },

            "nextCallPlaybook": {
                "openingRecap": "2-3 sentences to open the next call recapping where things stand",
                "questionsToAsk": ["5 high-value questions to fill the biggest gaps from this call — focus on Missing MEDDICC/BANT components"],
                "valueAndROI": {
                    "quantitative": ["2-3 measurable ROI points to reinforce"],
                    "qualitative": ["2-3 strategic or emotional value points to reinforce"]
                }
            },

            "keyPoints": ["4-6 bullets — top things to know about this deal right now"],
            "actionItems": ["specific next steps with owners if mentioned, or implied follow-ups"]
        }

        RULES:
        - Do NOT invent information not in the transcript
        - Use "Missing" for any BANT/MEDDICC field with no evidence at all
        - Use "Partial" if mentioned but incomplete or vague
        - Use "Clear" only if explicitly confirmed with specifics
        - Sales coach review must reference actual call moments — not generic advice
        - Next call questions must target the weakest BANT/MEDDICC areas from this call
        - Return ONLY valid JSON — no markdown, no code blocks, no explanation
        - leadName and company: extract from transcript introductions or conversation. Return null if not found.
        - salesCoachReview.whatIMissedCompletely: EVERY item MUST start with a gap category: Identify Champion: | Metrics: | Authority: | Process: | Pain: | Timeline: | Budget:
        - Reference specific moments, names, numbers from the transcript — never be generic
        - salesCoachReview.whatIDidRight: EVERY item MUST start with a framework label followed by the component name: e.g. "MEDDICC Metrics:", "MEDDICC Champion:", "BANT Budget:", "BANT Timeline:"
        - salesCoachReview.whatIDidRight: return ONLY items where something genuinely happened in the call — do NOT pad with generic or empty items. Minimum 2, maximum 6.
        - salesCoachReview.whatIDidRight: group MEDDICC items first, then BANT items.
        - salesCoachReview.whatIMissedCompletely: items MUST follow this strict label sequence: Identify Champion, Metrics, Authority, Process, Pain. Never randomize the order.
    `;
};

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
    public async stopMeeting(meetingTypes?: ('discovery' | 'demo' | 'negotiation')[], tenantId?: string | null): Promise<string | null> {
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
        if (durationMs < 1000) {
            console.log("Meeting too short, ignoring.");
            this.session.reset();
            return null;
        }

        const appState = AppState.getInstance();
        const liveAnalysisData = appState?.getCurrentLiveAnalysis?.() || null;
        console.log('[MeetingPersistence] Retrieved liveAnalysisData:', !!liveAnalysisData);
        if (liveAnalysisData) {
            console.log('[MeetingPersistence] Live analysis keys:', Object.keys(liveAnalysisData));
            appState?.clearCurrentLiveAnalysis?.();
        }

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
        this.processAndSaveMeeting(
            snapshot,
            meetingId,
            metadataSnapshot,
            liveAnalysisData,
            speakerNamesSnapshot,
            undefined,      // companyIntel — not captured at stop time for live calls
            meetingTypes,    // ← rep's live selection, was previously dropped (always undefined)
            tenantId || null
        ).catch(err => {
            console.error('[MeetingPersistence] Background processing failed:', err);
        });

        // 4. Initial Save (Placeholder)
        // Same displayName stamping as the final save in processAndSaveMeeting
        // — without it, this placeholder briefly persists with generic
        // "Other Party" labels until the background save above replaces it.
        const placeholderTranscript = snapshot.transcript.map(segment => ({
            ...segment,
            displayName: segment.displayName
                ?? (segment.speaker === 'user' ? speakerNamesSnapshot.user
                    : (segment.speaker === 'client' || segment.speaker === 'interviewer') ? speakerNamesSnapshot.client
                        : undefined),
        }))

        const placeholder: Meeting = {
            id: meetingId,
            title: "Processing...",
            date: new Date().toISOString(),
            duration: formatDuration(durationMs),
            durationMs: durationMs,
            summary: "Generating summary...",
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

        return meetingId;
    }

    /**
     * Heavy lifting: LLM Title, Summary, and DB Write
     */
    private async processAndSaveMeeting(
        data: { transcript: TranscriptSegment[], usage: any[], startTime: number, endTime?: number, totalPausedMs?: number, durationMs: number, context: string },
        meetingId: string,
        metadata?: { title?: string; calendarEventId?: string; source?: 'manual' | 'calendar' } | null,
        liveAnalysisData?: LiveAnalysisData | null,
        speakerNames?: { user: string; client: string },
        companyIntel?: Record<string, any> | null,
        hintMeetingTypes?: ('discovery' | 'demo' | 'negotiation')[],
        tenantId?: string | null
    ): Promise<void> {
        let title = "Untitled Session";
        let summaryData: { actionItems: string[], keyPoints: string[], liveAnalysis?: LiveAnalysisData, speakerNames?: { user: string, client: string } } = { actionItems: [], keyPoints: [] };

        // Use passed-in metadata snapshot (NOT this.session.getMeetingMetadata() which is already cleared)
        let calendarEventId: string | undefined;
        let source: 'manual' | 'calendar' = 'manual';

        if (metadata) {
            if (metadata.title) title = metadata.title;
            if (metadata.calendarEventId) calendarEventId = metadata.calendarEventId;
            if (metadata.source) source = metadata.source;
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
        const fullTranscriptText = data.transcript
            .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()))
            .map(t => {
                let role = t.speaker === 'user'
                    ? (speakerNames?.user || 'REP')
                    : (speakerNames?.client || 'PROSPECT');
                const idx = (t as any).speakerIndex;
                if (t.speaker !== 'user' && multiClientSpeakers && idx !== undefined) {
                    role = `${role} (Speaker ${idx + 1})`;
                }
                return `${role}: ${t.text}`;
            })
            .join('\n');

        console.log("data.transcript: -> ", data.transcript);

        try {
            // Generate Title (only if not set by calendar)
            if (!metadata || !metadata.title) {
                const titlePrompt = `Generate a concise 3-6 word title for this meeting context. Output ONLY the title text. Do not use quotes or conversational filler.`;
                const groqTitlePrompt = GROQ_TITLE_PROMPT;

                // Use first 5000 chars of full transcript for title (enough context, saves tokens)
                const titleContext = data.transcript
                    .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()))
                    .map(t => `${t.speaker === 'user' ? (speakerNames?.user || 'REP') : (speakerNames?.client || 'PROSPECT')}: ${t.text}`)
                    .join('\n')
                    .substring(0, 5000);

                const generatedTitle = await this.llmHelper.generateMeetingSummary(titlePrompt, titleContext, groqTitlePrompt, 'title');
                if (generatedTitle) title = generatedTitle.replace(/[\"*]/g, '').trim();
            }

            // Generate Structured Summary
            if (data.transcript.length > 2) {

                // Build a compact Groq-compatible system prompt that includes live analysis grounding.
                // Groq has a lower token budget, so we pass only the status+evidence lines.
                const liveAnalysisGroqBlock = liveAnalysisData ? `
                LIVE ANALYSIS REFERENCE (captured during the call):
                BANT: Budget=${liveAnalysisData.bant.budget.status}|${liveAnalysisData.bant.budget.evidence || ''}, Authority=${liveAnalysisData.bant.authority.status}|${liveAnalysisData.bant.authority.evidence || ''}, Need=${liveAnalysisData.bant.need.status}|${liveAnalysisData.bant.need.evidence || ''}, Timeline=${liveAnalysisData.bant.timeline.status}|${liveAnalysisData.bant.timeline.evidence || ''}
                MEDDIC: Metrics=${liveAnalysisData.meddic.metrics.status}|${liveAnalysisData.meddic.metrics.evidence || ''}, EconBuyer=${liveAnalysisData.meddic.economic_buyer.status}|${liveAnalysisData.meddic.economic_buyer.evidence || ''}, Pain=${liveAnalysisData.meddic.identify_pain.status}|${liveAnalysisData.meddic.identify_pain.evidence || ''}, Champion=${liveAnalysisData.meddic.champion.status}|${liveAnalysisData.meddic.champion.evidence || ''}
                Use this as your grounding anchor. Map statuses: confirmed→Clear, partial→Partial, missing→Missing. Use evidence text verbatim in "detail" fields where available.
                ` : '';
                const groqSummaryPrompt = liveAnalysisGroqBlock
                    ? GROQ_SUMMARY_JSON_PROMPT + '\n\n' + liveAnalysisGroqBlock
                    : GROQ_SUMMARY_JSON_PROMPT;

                const baseSummaryPrompt = buildSummaryPrompt(liveAnalysisData, companyIntel);

                // Generate -> verify -> (if low confidence) regenerate with the
                // specific flagged issues fed back in, up to SUMMARY_MAX_ATTEMPTS.
                let correctionAddendum = '';
                let bestParsedSummary: any = null;
                let bestConfidence = -1;

                for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt++) {
                    const generatedSummary = await this.llmHelper.generateMeetingSummary(
                        baseSummaryPrompt + correctionAddendum,
                        fullTranscriptText,
                        groqSummaryPrompt + correctionAddendum,
                        'summary'
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
                        const verification = await verifySummaryAgainstTranscript(this.llmHelper, fullTranscriptText, jsonStr);
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
                    // Guarantee BANT/MEDDIC in the summary matches live
                    // analysis exactly — see reconcileBantMeddicWithLiveAnalysis
                    // for why the prompt instruction alone isn't enough.
                    summaryData = reconcileBantMeddicWithLiveAnalysis({ ...summaryData, ...bestParsedSummary }, liveAnalysisData);
                }
            } else {
                console.log("Transcript too short for summary generation.");
            }
        } catch (e) {
            console.error("Error generating meeting metadata", e);
        }

        // Generate call analysis for uploaded transcripts (no live analysis available)
        if (!liveAnalysisData && data.transcript.length > 2) {
            try {

                const analysisPrompt = `Analyze this sales call transcript and return ONLY a valid JSON object with NO markdown, no backticks, no explanation. Use exactly this structure:
                {
                  "bant": {
                    "budget":    { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" },
                    "authority": { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" },
                    "need":      { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" },
                    "timeline":  { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" }
                  },
                  "meddic": {
                    "metrics":           { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" },
                    "economic_buyer":    { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" },
                    "decision_criteria": { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" },
                    "decision_process":  { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" },
                    "identify_pain":     { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" },
                    "champion":          { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" },
                    "competition":       { "emoji": "✅|⚠️|❌", "status": "confirmed|partial|missing", "evidence": "direct quote or empty string", "suggested_question": "string" }
                  },
                  "objections": [
                    {
                      "type": "customer_question",
                      "quote": "exact quote from transcript",
                      "owner": "customer",
                      "status": "open|deferred",
                      "suggested_answer": "AI suggested rebuttal"
                    }
                  ],
                  "signals": [
                    {
                      "quote": "exact quote from transcript",
                      "signal_type": ["buying_signal|risk|frustration|objection|positive"],
                      "ask_now": "suggested follow-up question or action",
                      "intensity": "high|medium|low",
                      "category": "positive|negative|neutral"
                    }
                  ]
                }
                Rules:
                - emoji must be "✅" for confirmed, "⚠️" for partial, "❌" for missing
                - signal_type is always an ARRAY of strings even if only one value
                - Return raw JSON only, no markdown fences`;

                const transcriptText = data.transcript
                    .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()))
                    .map(t => `${t.speaker === 'user' ? (speakerNames?.user || 'REP') : (speakerNames?.client || 'PROSPECT')}: ${t.text}`)
                    .join('\n')
                    .substring(0, 12000);

                const analysisRaw = await this.llmHelper.generateMeetingSummary(analysisPrompt, transcriptText, analysisPrompt);
                if (analysisRaw) {
                    const jsonMatch = analysisRaw.match(/```json\n([\s\S]*?)\n```/) || [null, analysisRaw];
                    const jsonStr = (jsonMatch[1] || analysisRaw).trim();
                    try {
                        liveAnalysisData = JSON.parse(jsonStr);
                    } catch (e) {
                        console.warn('[MeetingPersistence] Failed to parse call analysis JSON:', e);
                    }
                }
            } catch (e) {
                console.warn('[MeetingPersistence] Call analysis generation failed (non-fatal):', e);
            }
        }

        try {

            let detailedSummary = { ...summaryData };
            if (liveAnalysisData) {
                detailedSummary = { ...summaryData, liveAnalysis: liveAnalysisData };
            }

            // ── Generate Meeting Scorecard ─────────────────────────────────────────────────
            let scorecardResult: MeetingScorecardResult | null = null;

            if (data.transcript.length > 2) {

                const outcome = await this.generateAndPersistScorecard(
                    meetingId,
                    fullTranscriptText,
                    hintMeetingTypes ?? null
                );
                scorecardResult = outcome.scorecardResult;
                if (scorecardResult && !outcome.persisted) {
                    // DB write failed — fall back to embedding it in summary_json so the UI still gets data
                    detailedSummary = { ...detailedSummary, scorecard: scorecardResult } as any;
                }
            }

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
            // real company name.
            const transcriptWithDisplayNames = data.transcript.map(segment => ({
                ...segment,
                displayName: segment.displayName
                    ?? (segment.speaker === 'user' ? resolvedSpeakerNames.user
                        : (segment.speaker === 'client' || segment.speaker === 'interviewer') ? resolvedSpeakerNames.client
                            : undefined),
            }));

            const meetingData: Meeting = {
                id: meetingId,
                title: title,
                date: new Date().toISOString(),
                duration: formatDuration(data.durationMs),
                durationMs: data.durationMs,
                summary: "See detailed summary",
                detailedSummary: detailedSummary,
                transcript: transcriptWithDisplayNames,
                usage: data.usage,
                calendarEventId: calendarEventId,
                source: source,
                isProcessed: true,
                tenantId: tenantId || null
            };

            DatabaseManager.getInstance().saveMeeting(meetingData, data.startTime, data.endTime ?? (data.startTime + data.durationMs), data.totalPausedMs ?? 0);

            // Metadata was already snapshotted before session.reset() — nothing to clear here.

            // Toast the user that their summary is ready — same native,
            // display-aware toast used for pause/resume, so it's visible
            // regardless of which screen (or app) the user is currently on.
            // Fires here specifically because this is the point the summary,
            // scorecard, and title have all actually finished generating AND
            // been persisted — not just "processing kicked off".
            AppState.getInstance()?.notifyMeetingSummaryReady?.(title);

            // Notify Frontend to refresh list
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));
            // Separate, analytics-specific signal from 'meetings-updated' above —
            // that event also fires on paths that aren't "a meeting successfully
            // finished processing" (e.g. list refreshes), so it's not a safe
            // proxy for counting completed meetings. This one fires exactly once
            // per successfully saved meeting.
            wins.forEach((w: any) => w.webContents.send('meeting-completed'));

        } catch (error) {
            console.error('[MeetingPersistence] Failed to save meeting:', error);
        }
    }

    /**
     * Generates a meeting scorecard via the LLM and persists it to `meeting_scorecards`
     * (mirroring to Supabase). Single source of truth for: loading scoring criteria,
     * building the prompt, stripping ```json fences, parsing, normalizing
     * `categoryBreakdown`, saving, and mirroring — used by both the initial
     * post-meeting scorecard generation and manual regeneration so the two paths
     * can't drift.
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
        hintTypes: ('discovery' | 'demo' | 'negotiation')[] | null
    ): Promise<{ scorecardResult: MeetingScorecardResult | null; persisted: boolean }> {
        let customScoringCriteria: import('../src/types').ScoringCriteriaSettings | null = null;
        try {
            customScoringCriteria = DatabaseManager.getInstance().getScoringCriteria();
        } catch (criteriaErr) {
            console.warn('[MeetingPersistence] Could not load custom scoring criteria, using defaults:', criteriaErr);
        }

        let scorecardResult: MeetingScorecardResult | null = null;
        try {
            const scorecardPrompt = buildScorecardPrompt(customScoringCriteria, hintTypes ?? null);
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
                        categoryBreakdown: Array.isArray(sc.categoryBreakdown)
                            ? sc.categoryBreakdown
                            : Object.values(sc.categoryBreakdown ?? {}),
                    })),
                } as MeetingScorecardResult;
            }
        } catch (e) {
            console.warn('[MeetingPersistence] Scorecard generation failed (non-fatal):', e);
            return { scorecardResult: null, persisted: false };
        }

        if (!scorecardResult) {
            return { scorecardResult: null, persisted: false };
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
            const { SupabaseMirrorService } = require('./db/SupabaseMirrorService');
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
     */

    private async regenerateScorecard(
        meetingId: string,
        transcriptContext: string,
        detectedMeetingTypes: ('discovery' | 'demo' | 'negotiation')[] | null
    ): Promise<void> {
        const { scorecardResult } = await this.generateAndPersistScorecard(
            meetingId,
            transcriptContext,
            detectedMeetingTypes ?? null
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

            // Build the same context string as original processing
            const fullRegenerateContext = meeting.transcript
                .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()))
                .map(t => `${t.speaker === 'user' ? 'SALES PERSON (Me)' : 'PROSPECT (Client)'}: ${t.text}`)
                .join('\n');

            // Re-use live analysis from detailedSummary if present so the regen is also grounded
            const existingLiveAnalysis = (meeting.detailedSummary as any)?.liveAnalysis as LiveAnalysisData | undefined;
            const groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT;

            const generatedSummary = await this.llmHelper.generateMeetingSummary(
                buildSummaryPrompt(existingLiveAnalysis),
                fullRegenerateContext,
                groqSummaryPrompt,
                'summary'
            );

            if (!generatedSummary) return false;

            const jsonMatch = generatedSummary.match(/```json\n([\s\S]*?)\n```/) || [null, generatedSummary];
            const jsonStr = (jsonMatch[1] || generatedSummary).trim();
            let summaryData = JSON.parse(jsonStr);
            // Same guarantee as the initial save path — regenerating must not
            // let BANT/MEDDIC drift from the meeting's stored live analysis.
            summaryData = reconcileBantMeddicWithLiveAnalysis(summaryData, existingLiveAnalysis);

            DatabaseManager.getInstance().updateMeetingSummary(meetingId, summaryData);
            console.log(`[MeetingPersistence] Regenerated summary for meeting ${meetingId}`);

            // Re-score using the latest criteria so any criteria changes made before
            // clicking "regenerate" are reflected in the scorecard shown in the UI.
            // const existingTypes = (meeting.detailedSummary as any)?.scorecard?.detectedTypes ?? null;
            // try {
            //     await this.regenerateScorecard(meetingId, fullRegenerateContext, existingTypes);
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
     * DEV ONLY: Upload a raw transcript text and process it as a real meeting
     */
    public async uploadTranscript(
        rawText: string,
        title?: string,
        meetingTypes?: ('discovery' | 'demo' | 'negotiation')[]
    ): Promise<string | null> {
        try {
            // Parse lines like "[00:00:12] REP: text" or "REP: text" or plain text
            const transcript: TranscriptSegment[] = [];
            const lines = rawText.split('\n').filter(l => l.trim());

            // Helper to parse "[HH:MM:SS]" or "[MM:SS]" into milliseconds
            const parseTimestamp = (raw: string): number | null => {
                const parts = raw.replace(/[\[\]]/g, '').split(':').map(Number);
                if (parts.some(isNaN)) return null;
                if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
                if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
                return null;
            };

            let lastParsedTs = 0;
            lines.forEach((line, i) => {
                const withTimestamp = line.match(/^(\[[\d:]+\])\s*(REP|PROSPECT|CLIENT|ME|THEM|USER|SPEAKER\s*\d*|[A-Z][A-Z\s]{0,15}):\s*(.+)/i);
                const withoutTimestamp = line.match(/^(REP|PROSPECT|CLIENT|ME|THEM|USER|SPEAKER\s*\d*|[A-Z][A-Z\s]{0,15}):\s*(.+)/i);

                if (withTimestamp) {
                    const tsRaw = withTimestamp[1];
                    const speakerRaw = withTimestamp[2].trim().toUpperCase();
                    const text = withTimestamp[3].trim();
                    const parsedTs = parseTimestamp(tsRaw);
                    const timestamp = parsedTs !== null ? parsedTs : lastParsedTs + 5000;
                    lastParsedTs = timestamp;
                    const speaker = ['REP', 'ME', 'USER', 'SALES', 'SELLER'].includes(speakerRaw) ? 'user' : 'client';
                    transcript.push({ speaker, text, timestamp, final: true });
                } else if (withoutTimestamp) {
                    const speakerRaw = withoutTimestamp[1].trim().toUpperCase();
                    const text = withoutTimestamp[2].trim();
                    const timestamp = lastParsedTs + 5000;
                    lastParsedTs = timestamp;
                    const speaker = ['REP', 'ME', 'USER', 'SALES', 'SELLER'].includes(speakerRaw) ? 'user' : 'client';
                    transcript.push({ speaker, text, timestamp, final: true });
                } else if (line.trim()) {
                    const timestamp = lastParsedTs + 5000;
                    lastParsedTs = timestamp;
                    transcript.push({ speaker: 'client', text: line.trim(), timestamp, final: true });
                }
            });

            if (transcript.length < 2) {
                console.warn('[MeetingPersistence] Upload: transcript too short');
                return null;
            }

            const meetingId = crypto.randomUUID();
            const now = Date.now();
            // Use actual first→last segment timestamps for real duration.
            // Fall back to now - 60s minimum if timestamps are missing/zero.
            const firstTs = transcript[0]?.timestamp ?? 0;
            const lastTs = transcript[transcript.length - 1]?.timestamp ?? 0;
            // Use real parsed timestamps if available (lastTs > 0 means timestamps were found)
            // Otherwise estimate from line count: avg 15 seconds per exchange
            const durationMs = lastTs > 0
                ? lastTs - firstTs
                : Math.max(transcript.length * 15_000, 60_000);
            const startTimeMs = now - durationMs;
            const context = transcript.map(t => `${t.speaker === 'user' ? 'Me' : 'Them'}: ${t.text}`).join('\n');

            // Save placeholder immediately so it appears in the list
            const placeholder: Meeting = {
                id: meetingId,
                title: 'Processing...',
                date: new Date().toISOString(),
                duration: formatDuration(durationMs),
                durationMs: durationMs,
                summary: 'Generating summary...',
                detailedSummary: { actionItems: [], keyPoints: [] },
                // Same reasoning as the live-meeting placeholder — the full
                // transcript is already parsed and sitting in memory at this
                // point, no reason to withhold it until background processing.
                transcript,
                usage: [],
                isProcessed: false,
            };

            DatabaseManager.getInstance().saveMeeting(placeholder, startTimeMs, startTimeMs + durationMs, 0);
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));

            // Pass the user's title as metadata so processAndSaveMeeting uses it
            // instead of generating a new one from the transcript
            this.processAndSaveMeeting(
                { transcript, usage: [], startTime: startTimeMs, durationMs, context },
                meetingId,
                { title: title || undefined, source: 'manual' },
                null,           // liveAnalysisData — not available for uploads
                undefined,      // speakerNames
                null,           // companyIntel
                meetingTypes    // ← pass through
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

                const parts = (details.duration || '0:00').split(':');
                // Use the raw durationMs if available (always present when loaded from DB).
                // Fallback: re-parse the formatted string only for very old DB rows that might
                // lack duration_ms. Handles both mm:ss and hh:mm:ss safely.
                let durationMs: number;
                if (details.durationMs != null && details.durationMs > 0) {
                    durationMs = details.durationMs;
                } else if (parts.length === 3) {
                    // hh:mm:ss
                    durationMs = ((parseInt(parts[0]) || 0) * 3600 + (parseInt(parts[1]) || 0) * 60 + (parseInt(parts[2]) || 0)) * 1000;
                } else {
                    // mm:ss
                    durationMs = ((parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0)) * 1000;
                }
                const startTime = new Date(details.date).getTime();

                const snapshot = {
                    transcript: details.transcript as TranscriptSegment[],
                    usage: details.usage,
                    startTime: startTime,
                    durationMs: durationMs,
                    context: context
                };

                await this.processAndSaveMeeting(snapshot, m.id);
                console.log(`[MeetingPersistence] Recovered meeting ${m.id}`);

            } catch (e) {
                console.error(`[MeetingPersistence] Failed to recover meeting ${m.id}`, e);
            }
        }
    }


}