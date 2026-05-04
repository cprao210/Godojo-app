// MeetingPersistence.ts
// Handles meeting lifecycle: stop, save, and recovery.
// Extracted from IntelligenceManager to decouple DB operations from LLM orchestration.

import { SessionTracker, TranscriptSegment } from './SessionTracker';
import { LLMHelper } from './LLMHelper';
import { DatabaseManager, Meeting } from './db/DatabaseManager';
import { GROQ_TITLE_PROMPT, GROQ_SUMMARY_JSON_PROMPT } from './llm';
const crypto = require('crypto');

const summaryPrompt = `You are an expert B2B sales analyst. A sales call just ended. Analyze the full transcript and generate a structured post-call summary. Return ONLY valid JSON (no markdown code blocks, no commentary).

{
    "overview": "2-3 sentence summary of what the call covered and the current deal status",

    "dealStatus": {
        "stage": "one of: Discovery / Qualification / Demo / Proposal / Negotiation / Closed Won / Closed Lost / Unknown",
        "summary": "1 sentence on where the deal stands right now"
    },

    "bant": {
        "budget": { "status": "Clear | Partial | Missing", "detail": "what was said or implied about budget" },
        "authority": { "status": "Clear | Partial | Missing", "detail": "who the decision maker is and their level of involvement" },
        "need": { "status": "Clear | Partial | Missing", "detail": "what pain or need was uncovered" },
        "timeline": { "status": "Clear | Partial | Missing", "detail": "when they want to move or what the urgency is" }
    },

    "meddicc": {
        "metrics": { "status": "Clear | Partial | Missing", "detail": "quantifiable business impact discussed" },
        "economicBuyer": { "status": "Clear | Partial | Missing", "detail": "who controls the budget and were they involved" },
        "decisionCriteria": { "status": "Clear | Partial | Missing", "detail": "what criteria will be used to evaluate and choose" },
        "decisionProcess": { "status": "Clear | Partial | Missing", "detail": "what steps does their buying process follow" },
        "identifyPain": { "status": "Clear | Partial | Missing", "detail": "specific pain points uncovered and their business impact" },
        "champion": { "status": "Clear | Partial | Missing", "detail": "who internally will advocate for this solution" },
        "competition": { "status": "Clear | Partial | Missing", "detail": "any competitors or alternatives mentioned" },
        "gaps": ["list of MEDDICC components that are Missing or Partial — these need follow-up"]
    },

    "followUpEmail": {
        "subject": "email subject line",
        "sections": {
            "whatWeDiscussed": ["3-4 bullets of key discussion points"],
            "currentProcess": "1-2 sentences on their current state/workflow",
            "scopeOfImprovement": ["2-3 bullets on identified gaps or problems"],
            "howOurSolutionHelps": ["2-3 bullets on how the solution addresses their specific pain"],
            "expectedBusinessImpact": ["2-3 bullets on quantitative and qualitative ROI"],
            "nextSteps": ["specific agreed next steps with owners and timelines if mentioned"]
        }
    },

    "leadName": "extract prospect full name from transcript — first name + last name if mentioned, else null",
    "company": "extract company/organization name from transcript, else null",

    "salesCoachReview": {
         "whatIDidRight": [
            "MEDDICC [ComponentName]: [what the rep did well — e.g. MEDDICC Metrics: Quantified the cost of manual mapping at $15k/mo using an implication question]",
            "MEDDICC [ComponentName]: [second MEDDICC win — e.g. MEDDICC EconomicBuyer: Identified Sarah Chen (CFO) as the budget owner early in the conversation]",
            "BANT [ComponentName]: [BANT win — e.g. BANT Budget: Confirmed budget allocated specifically for Operational Efficiency in FY24]",
            "BANT [ComponentName]: [second BANT win — e.g. BANT Timeline: Solidified Dec 15th as a hard deadline for system parity]",
            "MEDDICC [ComponentName]: [optional additional win if applicable — else omit this item entirely]"
        ],
        "whatICouldHaveDoneBetter": [
            "Should have pushed harder on [specific topic from call] — ask: [exact question]",
            "Missed opportunity to [specific action] when prospect said [trigger phrase from transcript]",
            "Over-explained [topic] instead of focusing on business outcome",
            "Didn't ask for [specific thing] during [moment in call]",
            "Talked over prospect when they mentioned [topic] — should have probed deeper"
        ],
        "whatIMissedCompletely": [
            "Identify Champion: [specific gap about champion identification]",
            "Metrics: [specific metric that was never asked about]",
            "Authority: [specific authority/stakeholder gap]",
            "Process: [specific process that was skipped]",
            "Pain: [specific pain point that was never addressed]"
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
- The follow-up email tone must be: simple, clear, no jargon, client-friendly
- Sales coach review must reference actual call moments — not generic advice
- Next call questions must target the weakest BANT/MEDDICC areas from this call
- Return ONLY valid JSON — no markdown, no code blocks, no explanation
- leadName and company: extract from transcript introductions or conversation. Return null if not found.
- salesCoachReview.whatIDidRight: EVERY item MUST start with a framework label: MEDDICC: | BANT: | SPIN: | DISCOVERY:
- salesCoachReview.whatIMissedCompletely: EVERY item MUST start with a gap category: Identify Champion: | Metrics: | Authority: | Process: | Pain: | Timeline: | Budget:
- Reference specific moments, names, numbers from the transcript — never be generic
- salesCoachReview.whatIDidRight: EVERY item MUST start with a framework label followed by the component name: e.g. "MEDDICC Metrics:", "MEDDICC Champion:", "BANT Budget:", "BANT Timeline:"
- salesCoachReview.whatIDidRight: return ONLY items where something genuinely happened in the call — do NOT pad with generic or empty items. Minimum 2, maximum 6.
- salesCoachReview.whatIDidRight: group MEDDICC items first, then BANT items. No fixed count required — only include items grounded in actual transcript moments.
- salesCoachReview.whatIMissedCompletely: items MUST follow this strict label sequence: Identify Champion, Metrics, Authority, Process, Pain. Never randomize the order.
`;

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
        const durationMs = Date.now() - this.session.getSessionStartTime();
        if (durationMs < 1000) {
            console.log("Meeting too short, ignoring.");
            this.session.reset();
            return null;
        }

        const snapshot = {
            transcript: [...this.session.getFullTranscript()],
            usage: [...this.session.getFullUsage()],
            startTime: this.session.getSessionStartTime(),
            durationMs: durationMs,
            context: this.session.getFullSessionContext()
        };

        // BUG-04 fix: snapshot metadata BEFORE reset() clears it so the
        // background processAndSaveMeeting worker receives the calendar info.
        const metadataSnapshot = this.session.getMeetingMetadata();

        // 2. Reset state immediately so new meeting can start or UI is clean
        this.session.reset();

        const meetingId = crypto.randomUUID();
        this.processAndSaveMeeting(snapshot, meetingId, metadataSnapshot).catch(err => {
            console.error('[MeetingPersistence] Background processing failed:', err);
        });

        // 4. Initial Save (Placeholder)
        const minutes = Math.floor(durationMs / 60000);
        const seconds = ((durationMs % 60000) / 1000).toFixed(0);
        const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

        const placeholder: Meeting = {
            id: meetingId,
            title: "Processing...",
            date: new Date().toISOString(),
            duration: durationStr,
            summary: "Generating summary...",
            detailedSummary: { actionItems: [], keyPoints: [] },
            transcript: snapshot.transcript,
            usage: snapshot.usage,
            isProcessed: false
        };

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
        // BUG-04 fix: accept metadata snapshot so calendar info is not lost after session.reset()
        metadata?: { title?: string; calendarEventId?: string; source?: 'manual' | 'calendar' } | null
    ): Promise<void> {
        let title = "Untitled Session";
        let summaryData: { actionItems: string[], keyPoints: string[] } = { actionItems: [], keyPoints: [] };

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

                const generatedTitle = await this.llmHelper.generateMeetingSummary(titlePrompt, data.context.substring(0, 5000), groqTitlePrompt);
                if (generatedTitle) title = generatedTitle.replace(/["*]/g, '').trim();
            }

            // Generate Structured Summary
            if (data.transcript.length > 2) {

                const groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT;

                const generatedSummary = await this.llmHelper.generateMeetingSummary(summaryPrompt, data.context.substring(0, 10000), groqSummaryPrompt);

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
            const minutes = Math.floor(data.durationMs / 60000);
            const seconds = ((data.durationMs % 60000) / 1000).toFixed(0);
            const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

            const meetingData: Meeting = {
                id: meetingId,
                title: title,
                date: new Date().toISOString(),
                duration: durationStr,
                summary: "See detailed summary",
                detailedSummary: summaryData,
                transcript: data.transcript,
                usage: data.usage,
                calendarEventId: calendarEventId,
                source: source,
                isProcessed: true
            };

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
            const context = meeting.transcript
                .map(t => `${t.speaker === 'user' ? 'Me' : 'Them'}: ${t.text}`)
                .join('\n');

            const groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT;

            const generatedSummary = await this.llmHelper.generateMeetingSummary(
                summaryPrompt,
                context.substring(0, 10000),
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
                    const label = t.speaker === 'interviewer' ? 'INTERVIEWER' :
                        t.speaker === 'user' ? 'ME' : 'ASSISTANT';
                    return `[${label}]: ${t.text}`;
                }).join('\n') || "";

                const parts = (details.duration || '0:00').split(':');
                // EC-07 fix: guard against malformed duration strings (e.g. corrupted DB row)
                const mins = parseInt(parts[0]) || 0;
                const secs = parseInt(parts[1]) || 0;
                const durationMs = ((mins * 60) + secs) * 1000;
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
