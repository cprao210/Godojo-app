// MeetingPersistence.ts
// Handles meeting lifecycle: stop, save, and recovery.
// Extracted from IntelligenceManager to decouple DB operations from LLM orchestration.

import { SessionTracker, TranscriptSegment } from './SessionTracker';
import { LLMHelper } from './LLMHelper';
import { DatabaseManager, Meeting, formatDuration } from './db/DatabaseManager';
import { GROQ_TITLE_PROMPT, GROQ_SUMMARY_JSON_PROMPT } from './llm';
import { LiveAnalysisData } from '../src/types/liveAnalysis';
import { AppState } from './main';
import { buildCompanyContextBlock } from '../electron/utils/salesBriefUtils';
const crypto = require('crypto');

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
    public async stopMeeting(): Promise<string | null> {
        console.log('[MeetingPersistence] Stopping meeting and queueing save...');

        // 0. Force-save any pending interim transcript
        this.session.flushInterimTranscript();

        // 1. Snapshot valid data BEFORE resetting
        // subtract accumulated pause time to get true active duration
        const rawDurationMs = Date.now() - this.session.getSessionStartTime();
        const durationMs = Math.max(0, rawDurationMs - this.session.getTotalPausedMs());
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
            startTime: this.session.getSessionStartTime(),
            durationMs: durationMs,
            context: this.session.getFullSessionContext()
        };

        // console.log("==> this.session.getFullSessionContext(): ", this.session.getFullSessionContext());
        // console.log("==> this.session.getFullTranscript(): ", this.session.getFullTranscript());

        // BUG-04 fix: snapshot metadata BEFORE reset() clears it so the
        // background processAndSaveMeeting worker receives the calendar info.
        const metadataSnapshot = this.session.getMeetingMetadata();
        const speakerNamesSnapshot = this.session.getSpeakerNameMap();

        // 2. Reset state immediately so new meeting can start or UI is clean
        this.session.reset();

        const meetingId = crypto.randomUUID();
        this.processAndSaveMeeting(snapshot, meetingId, metadataSnapshot, liveAnalysisData, speakerNamesSnapshot).catch(err => {
            console.error('[MeetingPersistence] Background processing failed:', err);
        });

        // 4. Initial Save (Placeholder)
        const placeholder: Meeting = {
            id: meetingId,
            title: "Processing...",
            date: new Date().toISOString(),
            duration: formatDuration(durationMs),
            durationMs: durationMs,
            summary: "Generating summary...",
            detailedSummary: { actionItems: [], keyPoints: [] },
            transcript: snapshot.transcript,
            usage: snapshot.usage,
            isProcessed: false
        };

        console.log("--> stopMeeting (snapshot): ", snapshot);
        console.log("--> stopMeeting (placeholder): ", placeholder);

        try {
            DatabaseManager.getInstance().saveMeeting(placeholder, snapshot.startTime, durationMs);
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
        data: { transcript: TranscriptSegment[], usage: any[], startTime: number, durationMs: number, context: string },
        meetingId: string,
        metadata?: { title?: string; calendarEventId?: string; source?: 'manual' | 'calendar' } | null,
        liveAnalysisData?: LiveAnalysisData | null,
        speakerNames?: { user: string; client: string },
        companyIntel?: Record<string, any> | null   // ← new param
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

                const generatedTitle = await this.llmHelper.generateMeetingSummary(titlePrompt, titleContext, groqTitlePrompt);
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

                // Build full transcript text directly from the transcript array so the
                // LLM sees the complete call. The pre-built data.context is capped at
                // 10,000 chars which silently cuts off the second half of longer calls.
                // Average ~60 chars per turn × 1500 turns = 90,000 chars — well within
                // Gemini/Claude/GPT context windows. Groq has a 100k token guard already.
                const fullTranscriptText = data.transcript
                    .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase()))
                    .map(t => {
                        const role = t.speaker === 'user'
                            ? (speakerNames?.user || 'REP')
                            : (speakerNames?.client || 'PROSPECT');
                        return `${role}: ${t.text}`;
                    })
                    .join('\n');

                const generatedSummary = await this.llmHelper.generateMeetingSummary(buildSummaryPrompt(liveAnalysisData, companyIntel), fullTranscriptText, groqSummaryPrompt);

                if (generatedSummary) {
                    const jsonMatch = generatedSummary.match(/```json\n([\s\S]*?)\n```/) || [null, generatedSummary];
                    const jsonStr = (jsonMatch[1] || generatedSummary).trim();
                    try {
                        summaryData = JSON.parse(jsonStr);
                    } catch (e) { console.error("Failed to parse summary JSON", e); }
                }
            } else {
                console.log("Transcript too short for summary generation.");
            }
        } catch (e) {
            console.error("Error generating meeting metadata", e);
        }

        try {

            let detailedSummary = { ...summaryData };
            if (liveAnalysisData) {
                detailedSummary = { ...summaryData, liveAnalysis: liveAnalysisData };
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

            const meetingData: Meeting = {
                id: meetingId,
                title: title,
                date: new Date().toISOString(),
                duration: formatDuration(data.durationMs),
                durationMs: data.durationMs,
                summary: "See detailed summary",
                detailedSummary: detailedSummary,
                transcript: data.transcript,
                usage: data.usage,
                calendarEventId: calendarEventId,
                source: source,
                isProcessed: true
            };

            console.log("processAndSaveMeeting (meetingData): ", meetingData);

            DatabaseManager.getInstance().saveMeeting(meetingData, data.startTime, data.durationMs);

            // Metadata was already snapshotted before session.reset() — nothing to clear here.

            // Notify Frontend to refresh list
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));

        } catch (error) {
            console.error('[MeetingPersistence] Failed to save meeting:', error);
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

            console.log("--> buildSummaryPrompt: ", buildSummaryPrompt(existingLiveAnalysis));
            console.log("--> fullRegenerateContext: ", fullRegenerateContext);
            console.log("--> groqSummaryPrompt: ", groqSummaryPrompt);
            const generatedSummary = await this.llmHelper.generateMeetingSummary(
                buildSummaryPrompt(existingLiveAnalysis),
                fullRegenerateContext,
                groqSummaryPrompt
            );

            if (!generatedSummary) return false;

            const jsonMatch = generatedSummary.match(/```json\n([\s\S]*?)\n```/) || [null, generatedSummary];
            const jsonStr = (jsonMatch[1] || generatedSummary).trim();
            const summaryData = JSON.parse(jsonStr);

            DatabaseManager.getInstance().updateMeetingSummary(meetingId, summaryData);
            console.log(`[MeetingPersistence] Regenerated summary for meeting ${meetingId}`);
            return true;

        } catch (e) {

            console.error('[MeetingPersistence] Failed to regenerate summary:', e);
            return false;

        }
    }

    /**
     * DEV ONLY: Upload a raw transcript text and process it as a real meeting
     */
    public async uploadTranscript(
        rawText: string,
        title?: string
    ): Promise<string | null> {
        try {
            // Parse lines like "[00:00:12] REP: text" or "REP: text" or plain text
            const transcript: TranscriptSegment[] = [];
            const lines = rawText.split('\n').filter(l => l.trim());

            lines.forEach((line, i) => {
                // Match "[timestamp] SPEAKER: text" or "SPEAKER: text"
                const withTimestamp = line.match(/^\[[\d:]+\]\s*(REP|PROSPECT|ME|THEM|USER|SPEAKER\s*\d*|[A-Z][A-Z\s]{0,15}):\s*(.+)/i);
                const withoutTimestamp = line.match(/^(REP|PROSPECT|ME|THEM|USER|SPEAKER\s*\d*|[A-Z][A-Z\s]{0,15}):\s*(.+)/i);
                const match = withTimestamp || withoutTimestamp;

                if (match) {
                    const speakerRaw = match[1].trim().toUpperCase();
                    const text = match[2].trim();
                    // Map common speaker names to user/other
                    const speaker = ['REP', 'ME', 'USER', 'SALES', 'SELLER'].includes(speakerRaw) ? 'user' : 'client';
                    transcript.push({
                        speaker, text, timestamp: i * 5000,
                        final: true
                    });
                } else if (line.trim()) {
                    // Plain line — treat as client (remote/other party)
                    transcript.push({
                        speaker: 'client', text: line.trim(), timestamp: i * 5000,
                        final: true
                    });
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
            const durationMs = (firstTs > 0 && lastTs > firstTs)
                ? (lastTs - firstTs)
                : 60_000;
            const startTimeMs = firstTs > 0 ? firstTs : now - durationMs;
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
                transcript,
                usage: [],
                isProcessed: false,
            };

            DatabaseManager.getInstance().saveMeeting(placeholder, startTimeMs, durationMs);
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));

            // Pass the user's title as metadata so processAndSaveMeeting uses it
            // instead of generating a new one from the transcript
            this.processAndSaveMeeting(
                { transcript, usage: [], startTime: startTimeMs, durationMs, context },
                meetingId,
                { title: title || undefined, source: 'manual' }
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