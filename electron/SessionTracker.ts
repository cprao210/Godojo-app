// SessionTracker.ts
// Manages session state, transcript arrays, context windows, and epoch compaction.
// Extracted from IntelligenceManager to decouple state management from LLM orchestration.

import { RecapLLM } from './llm';
import { isVerboseLogging } from './verboseLog';

export interface TranscriptSegment {
    marker?: string;
    speaker: string;
    text: string;
    timestamp: number;
    final: boolean;
    confidence?: number;
    /** 'chat' segments come from the assistant chat panel — exclude from saved transcript */
    source?: 'stt' | 'chat' | 'manual';
    /**
     * Resolved display label for this segment's speaker (e.g. "Raksham" —
     * the company-domain-derived label from speakerNameMap, not just the
     * raw 'client'/'user' role). Stamped in at save time by
     * MeetingPersistence, NOT set when the segment is first created live —
     * DatabaseManager.saveMeeting() reads this field when persisting each
     * transcript row, falling back to a hardcoded generic label if absent.
     */
    displayName?: string;
    /**
     * Diarization speaker index within the client stream (Deepgram, finals
     * only). Distinguishes multiple far-end participants; undefined when
     * diarization is off or unavailable.
     */
    speakerIndex?: number;
}

export interface SuggestionTrigger {
    context: string;
    lastQuestion: string;
    confidence: number;
}

// Context item matching Swift ContextManager structure
export interface ContextItem {
    role: 'client' | 'user' | 'assistant';
    text: string;
    timestamp: number;
    /** Diarized far-end speaker index (client role only). */
    speakerIndex?: number;
}

export interface AssistantResponse {
    text: string;
    timestamp: number;
    questionContext: string;
}

export class SessionTracker {
    // Context management (mirrors Swift ContextManager)
    private contextItems: ContextItem[] = [];
    private readonly contextWindowDuration: number = 120; // 120 seconds
    private readonly maxContextItems: number = 500;

    // Last assistant message for follow-up mode
    private lastAssistantMessage: string | null = null;

    // Temporal RAG: Track all assistant responses in session for anti-repetition
    private assistantResponseHistory: AssistantResponse[] = [];

    // Meeting metadata
    private currentMeetingMetadata: {
        title?: string;
        calendarEventId?: string;
        source?: 'manual' | 'calendar' | 'upload';
        attendees?: Array<{ email: string; name?: string; organizer?: boolean; self?: boolean }>;
        organizer?: string;
        /** Full raw calendar event payload, carried through verbatim to persistence. */
        calendarEvent?: any;
    } | null = null;

    private speakerNameMap: { user: string; client: string; clientDiarized: string } = {
        user: 'Me',
        client: 'Them',
        clientDiarized: 'Other Party'
    };

    // Full Session Tracking (Persisted)
    private fullTranscript: TranscriptSegment[] = [];
    private fullUsage: any[] = []; // UsageInteraction
    private sessionStartTime: number = Date.now();
    private totalPausedMs: number = 0;       // cumulative ms spent paused this session
    private pauseStartedAt: number | null = null;  // wall-clock time when current pause began

    // Rolling summarization: epoch summaries preserve early context when arrays are compacted
    private static readonly MAX_EPOCH_SUMMARIES = 5;
    // Compact once the unsummarized tail exceeds THRESHOLD; each pass summarizes the oldest BATCH
    static readonly COMPACT_THRESHOLD = 1800;
    static readonly COMPACT_BATCH = 500;
    private transcriptEpochSummaries: string[] = [];
    private isCompacting: boolean = false;
    // fullTranscript is never trimmed (it is what gets saved); LLM context starts at this index,
    // everything before it is represented by transcriptEpochSummaries
    private summarizedCount: number = 0;
    // Bumped on reset() so a summary still in flight cannot write into the next session
    private sessionGeneration: number = 0;

    // Track interim client segment
    private lastInterimClient: TranscriptSegment | null = null;
    // Track interim user (microphone) segment — flushed on meeting stop just like client
    private lastInterimUser: TranscriptSegment | null = null;

    // Reference to RecapLLM for epoch summarization (injected later)
    private recapLLM: RecapLLM | null = null;

    // ============================================
    // Configuration
    // ============================================

    public setRecapLLM(recapLLM: RecapLLM | null): void {
        this.recapLLM = recapLLM;
    }

    /**
     * Get display name for a speaker role
     * Used by UI to show real names instead of 'Me'/'Them'
     */
    public getDisplayNameForSpeaker(role: 'user' | 'client' | 'assistant'): string {
        if (role === 'user') {
            return this.speakerNameMap.user;
        }
        if (role === 'client') {
            return this.speakerNameMap.client;
        }
        return 'Assistant';
    }

    public setMeetingMetadata(metadata: any): void {
        this.currentMeetingMetadata = metadata;

        // Reset to defaults first so a re-used session never bleeds names from a previous meeting.
        this.speakerNameMap = { user: 'Me', client: 'Them', clientDiarized: 'Other Party' };

        const attendees: any[] = metadata?.attendees || [];

        if (attendees.length === 0) {
            // No attendee list — try to extract the opposite party's name from the meeting title.
            if (metadata?.title) {
                const fromTitle = this.extractNameFromTitle(metadata.title);
                if (fromTitle) {
                    this.speakerNameMap.client = fromTitle;
                    this.speakerNameMap.clientDiarized = fromTitle;
                }
            }
            console.log('[SessionTracker] Speaker name map resolved (no attendees):', this.speakerNameMap);
            return;
        }

        // Personal/free email domains that must NOT be treated as company names.
        const PERSONAL_DOMAINS = new Set([
            'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
            'icloud.com', 'proton.me', 'protonmail.com', 'live.com',
            'msn.com', 'aol.com', 'ymail.com', 'mail.com',
        ]);

        /**
         * Returns a capitalised company name from a professional email domain,
         * or null for personal/free providers.
         *   peter@salesforce.com  → "Salesforce"
         *   john@instagram.com    → "Instagram"
         *   kane@stripe.io        → "Stripe"
         *   abc@gmail.com         → null
         */
        const companyFromEmail = (email: string): string | null => {
            const domain = email.split('@')[1];
            if (!domain) return null;
            if (PERSONAL_DOMAINS.has(domain.toLowerCase())) return null;
            // Take the segment just before the TLD(s).
            // "salesforce.com" → "salesforce", "sub.company.co.uk" → "company"
            const parts = domain.split('.');
            const namePart = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
            return namePart.charAt(0).toUpperCase() + namePart.slice(1).toLowerCase();
        };

        // Extract a display name from an attendee: prefer displayName, fall back to name,
        // then derive from email local-part. Used both for personal-domain attendees
        // (name only) and combined with company for professional-domain attendees.
        const resolveName = (attendee: any): string | null => {
            if (attendee.displayName && attendee.displayName.trim()) {
                return attendee.displayName.trim();
            }
            if (attendee.name && attendee.name.trim()) {
                return attendee.name.trim();
            }
            if (attendee.email) {
                const prefix = attendee.email.split('@')[0];
                const parts = prefix
                    .split(/[._\-+]/)
                    // Strip trailing digits from each part — email local-parts often
                    // carry a numeric suffix (rahulgandhi123, vijay007) that isn't part
                    // of the actual name. "rahulgandhi123" -> "rahulgandhi" -> "Rahulgandhi".
                    .map((p: string) => p.replace(/\d+$/, ''))
                    .filter(Boolean);
                if (parts.length === 0) return null;
                return parts.map((p: string) =>
                    p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
                ).join(' ');
            }
            return null;
        };

        // The attendee with self:true is the local user (microphone = 'user' channel).
        // Self-attendees always use their display name regardless of domain.
        const selfAttendee = attendees.find(a => a.self);
        const selfName = selfAttendee ? resolveName(selfAttendee) : null;
        if (selfName) {
            this.speakerNameMap.user = selfName;
        }

        // The remaining non-self attendees are the remote participants (system audio = 'client').
        const others = attendees.filter(a => !a.self);

        if (others.length === 1) {
            // Single opposite-party attendee: full company/personal-domain
            // resolution — e.g. "Salesforce", "Rahul (Raksham)", or a plain
            // personal name for a personal-domain email.
            const attendee = others[0];
            const company = attendee.email ? companyFromEmail(attendee.email) : null;
            if (company) {
                // Combine person + company (e.g. "Rahul (Raksham)") instead of
                // just the company name alone. Without the person's name here,
                // an LLM query like "what are Rahul's pain points?" has no way
                // to resolve "Rahul" against a transcript that only ever shows
                // "Raksham" as the speaker label — it has to guess/hallucinate.
                // Embedding the name directly in displayName means every
                // downstream consumer (transcript tab, DB, LLM prompt context)
                // gets it for free with no separate lookup.
                const personName = resolveName(attendee);
                this.speakerNameMap.client = personName ? `${personName} (${company})` : company;
                this.speakerNameMap.clientDiarized = company;
            } else {
                const name = resolveName(attendee);
                if (name) this.speakerNameMap.client = name;
                this.speakerNameMap.clientDiarized = 'Other Party';
            }
        } else if (others.length > 1) {
            // 2+ opposite-party attendees all share the same 'client' audio
            // channel (system audio isn't diarized per-attendee), so there's
            // no reliable way to attribute a given turn to one of them. This
            // used to build a label out of every attendee — e.g. "Salesforce,
            // Instagram" or "Salesforce + Other Party" — which reads as if
            // those are separate identified speakers when they're really one
            // undifferentiated channel. One flat, honest label for the whole
            // channel avoids that: it never claims more precision than the
            // audio actually gives us, and it renders sanely at any attendee
            // count instead of growing an ever-longer joined string. "Other
            // Party" also matches the existing all-personal-domain and
            // mixed-domain fallbacks it's replacing, so this doesn't
            // introduce a new term into the UI.
            this.speakerNameMap.client = 'Other Party';
            this.speakerNameMap.clientDiarized = 'Other Party';
        } else {
            // No non-self attendees at all — try meeting title as last resort.
            if (metadata?.title) {
                const fromTitle = this.extractNameFromTitle(metadata.title);
                if (fromTitle) {
                    this.speakerNameMap.client = fromTitle;
                    this.speakerNameMap.clientDiarized = fromTitle;
                }
            }
        }
        console.log('[SessionTracker] Speaker name map resolved:', this.speakerNameMap);
    }

    /**
     * Attempt to extract an opposite-party name from a meeting title.
     * Handles common patterns like "Meeting with John Doe" or "John Doe - Intro Call".
     */
    private extractNameFromTitle(title: string): string | null {
        const patterns = [
            /with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
            /Meeting:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
            /-\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)$/,
        ];
        for (const pattern of patterns) {
            const match = title.match(pattern);
            if (match?.[1]) return match[1];
        }
        return null;
    }

    // Expose for IPC / display layer:
    public getSpeakerNameMap(): { user: string; client: string; clientDiarized: string } {
        return { ...this.speakerNameMap };
    }

    public updateSpeakerNames(names: { user: string; client: string }): void {
        if (names.user && names.user.trim()) {
            this.speakerNameMap.user = names.user.trim();
        }
        if (names.client && names.client.trim()) {
            this.speakerNameMap.client = names.client.trim();
            this.speakerNameMap.clientDiarized = names.client.trim();
        }
        console.log('[SessionTracker] Speaker names updated manually:', this.speakerNameMap);
    }

    public getMeetingMetadata() {
        return this.currentMeetingMetadata;
    }

    public clearMeetingMetadata(): void {
        this.currentMeetingMetadata = null;
    }

    // ============================================
    // Context Management
    // ============================================

    /**
     * Add a transcript segment to context.
     * Only stores FINAL transcripts.
     * Returns { role, isRefinementCandidate } so the engine can decide whether to trigger follow-up.
     */
    addTranscript(segment: TranscriptSegment): { role: 'client' | 'user' | 'assistant' } | null {
        if (!segment.final) return null;

        const role = this.mapSpeakerToRole(segment.speaker);
        const text = segment.text.trim();

        if (!text) return null;

        // Deduplicate: check if this exact item already exists
        const lastItem = this.contextItems[this.contextItems.length - 1];
        if (lastItem &&
            lastItem.role === role &&
            Math.abs(lastItem.timestamp - segment.timestamp) < 500 &&
            lastItem.text === text) {
            return null;
        }

        this.contextItems.push({
            role,
            text,
            timestamp: segment.timestamp,
            speakerIndex: segment.speakerIndex
        });

        this.evictOldEntries();

        // Filter out internal system prompts that might be passed via IPC
        const isInternalPrompt = text.startsWith("You are a helper") ||
            text.startsWith("CONTEXT:");

        if (!isInternalPrompt && segment.source !== 'chat') {
            // Add to session transcript
            this.fullTranscript.push(segment);
            // Compact transcript with summarization instead of losing early context
            // Fire-and-forget: sync context; errors are caught internally
            void this.compactTranscriptIfNeeded().catch(e =>
                console.warn('[SessionTracker] compactTranscript error (non-fatal):', e)
            );
        }

        return { role };
    }

    /**
     * Add assistant-generated message to context
     */
    addAssistantMessage(text: string): void {
        console.log(`[SessionTracker] addAssistantMessage called with:`, text.substring(0, 50));

        // Filtering
        if (!text) return;

        const cleanText = text.trim();
        if (cleanText.length < 10) {
            console.warn(`[SessionTracker] Ignored short message (<10 chars)`);
            return;
        }

        if (cleanText.includes("I'm not sure") || cleanText.includes("I can't answer")) {
            console.warn(`[SessionTracker] Ignored fallback message`);
            return;
        }

        this.contextItems.push({
            role: 'assistant',
            text: cleanText,
            timestamp: Date.now()
        });

        // Also add to fullTranscript so it persists in the session history (and summaries)
        this.fullTranscript.push({
            speaker: 'assistant',
            text: cleanText,
            timestamp: Date.now(),
            final: true,
            confidence: 1.0
        });

        // Compact transcript with summarization instead of losing early context
        // Fire-and-forget: sync context; errors are caught internally
        void this.compactTranscriptIfNeeded().catch(e =>
            console.warn('[SessionTracker] compactTranscript error (non-fatal):', e)
        );

        this.lastAssistantMessage = cleanText;

        // Temporal RAG: Track response history for anti-repetition
        this.assistantResponseHistory.push({
            text: cleanText,
            timestamp: Date.now(),
            questionContext: this.getLastClientTurn() || 'unknown'
        });

        // Keep history bounded (last 10 responses)
        if (this.assistantResponseHistory.length > 10) {
            this.assistantResponseHistory = this.assistantResponseHistory.slice(-10);
        }

        console.log(`[SessionTracker] lastAssistantMessage updated, history size: ${this.assistantResponseHistory.length}`);
        this.evictOldEntries();
    }

    /**
     * Handle incoming transcript from native audio service
     */
    handleTranscript(segment: TranscriptSegment): { role: 'client' | 'user' | 'assistant' } | null {
        // Track interim segments for client to prevent data loss on stop
        if (segment.speaker === 'user') {
            if (isVerboseLogging() && (Math.random() < 0.05 || segment.final)) {
                console.log(`[SessionTracker] RX User Segment: Final=${segment.final} Text="${segment.text.substring(0, 50)}..."`);
            }
            // Mirror client pattern: keep last interim so flushInterimTranscript can save it
            if (!segment.final) {
                this.lastInterimUser = segment;
            } else {
                this.lastInterimUser = null;
            }
        }
        if (segment.speaker === 'client') {
            if (isVerboseLogging() && (Math.random() < 0.05 || segment.final)) {
                console.log(`[SessionTracker] RX Client Segment: Final=${segment.final} Text="${segment.text.substring(0, 50)}..."`);
            }

            if (!segment.final) {
                this.lastInterimClient = segment;
            } else {
                this.lastInterimClient = null;
            }
        }

        return this.addTranscript(segment);
    }

    public getFormattedTranscript(): Array<{ speaker: string; text: string; timestamp: number }> {
        return this.fullTranscript.map(seg => ({
            ...seg,
            speaker: seg.speaker === 'user'
                ? (this.speakerNameMap.user || 'Me')
                : seg.speaker === 'client'
                    ? (this.speakerNameMap.client || 'Them')
                    : seg.speaker,
        }));
    }

    // ============================================
    // Context Accessors
    // ============================================

    /**
     * Get context items within the last N seconds
     */
    getContext(lastSeconds: number = 120): ContextItem[] {
        const cutoff = Date.now() - (lastSeconds * 1000);
        return this.contextItems.filter(item => item.timestamp >= cutoff);
    }

    getLastAssistantMessage(): string | null {
        return this.lastAssistantMessage;
    }

    getAssistantResponseHistory(): AssistantResponse[] {
        return this.assistantResponseHistory;
    }

    getLastInterimClient(): TranscriptSegment | null {
        return this.lastInterimClient;
    }

    /**
     * True when diarization has attributed client speech to 2+ distinct
     * far-end speakers this session — the threshold for showing speaker
     * suffixes anywhere (1:1 calls stay label-free).
     */
    private hasMultipleClientSpeakers(): boolean {
        const seen = new Set<number>();
        for (const seg of this.fullTranscript) {
            if (seg.speakerIndex !== undefined && this.mapSpeakerToRole(seg.speaker) === 'client') {
                seen.add(seg.speakerIndex);
                if (seen.size >= 2) return true;
            }
        }
        return false;
    }

    private clientSpeakerSuffix(speakerIndex: number | undefined, multi: boolean): string {
        return multi && speakerIndex !== undefined ? ` (SPEAKER ${speakerIndex + 1})` : '';
    }

    /**
     * Get formatted context string for LLM prompts
     */
    getFormattedContext(lastSeconds: number = 120): string {
        const items = this.getContext(lastSeconds);
        const multi = this.hasMultipleClientSpeakers();
        return items.map(item => {
            const label = item.role === 'client'
                ? (this.speakerNameMap.client || 'CLIENT').toUpperCase() + this.clientSpeakerSuffix(item.speakerIndex, multi)
                : item.role === 'user' ? (this.speakerNameMap.user || 'ME').toUpperCase() :
                    'ASSISTANT';
            return `[${label}]: ${item.text}`;
        }).join('\n');
    }

    /**
     * Get the last client turn
     */
    getLastClientTurn(): string | null {
        for (let i = this.contextItems.length - 1; i >= 0; i--) {
            if (this.contextItems[i].role === 'client') {
                return this.contextItems[i].text;
            }
        }
        return null;
    }

    /**
     * Get full session context from accumulated transcript (User + Client + Assistant)
     */
    getFullSessionContext(): string {
        const multi = this.hasMultipleClientSpeakers();
        const recentTranscript = this.fullTranscript.slice(this.summarizedCount).map(segment => {
            const role = this.mapSpeakerToRole(segment.speaker);
            const label = role === 'client'
                ? (this.speakerNameMap.client || 'CLIENT').toUpperCase() + this.clientSpeakerSuffix(segment.speakerIndex, multi)
                : role === 'user' ? (this.speakerNameMap.user || 'ME').toUpperCase() :
                    'ASSISTANT';
            return `[${label}]: ${segment.text}`;
        }).join('\n');

        // Prepend epoch summaries for full session context preservation
        if (this.transcriptEpochSummaries.length > 0) {
            const epochContext = this.transcriptEpochSummaries.join('\n---\n');
            return `[SESSION HISTORY - EARLIER DISCUSSION]\n${epochContext}\n\n[RECENT TRANSCRIPT]\n${recentTranscript}`;
        }

        return recentTranscript;
    }

    // ============================================
    // Session Data Accessors (for MeetingPersistence)
    // ============================================

    getFullTranscript(): TranscriptSegment[] {
        return this.fullTranscript;
    }

    getFullUsage(): any[] {
        return this.fullUsage;
    }

    /**
 * Called when the meeting is paused. Records the wall-clock start of the pause.
 */
    recordPauseStart(): void {
        if (this.pauseStartedAt !== null) return; // already paused — ignore duplicate calls
        this.pauseStartedAt = Date.now();
    }

    /**
     * Called when the meeting resumes. Accumulates the paused interval into totalPausedMs.
     */
    recordPauseEnd(): void {
        if (this.pauseStartedAt === null) return; // wasn't paused — ignore
        this.totalPausedMs += Date.now() - this.pauseStartedAt;
        this.pauseStartedAt = null;
    }

    /**
     * Returns total ms spent paused during this session.
     * Used by MeetingPersistence to compute actual active duration.
     */
    getTotalPausedMs(): number {
        // If the meeting is being stopped while still paused, count that paused interval too.
        if (this.pauseStartedAt !== null) {
            return this.totalPausedMs + (Date.now() - this.pauseStartedAt);
        }
        return this.totalPausedMs;
    }

    getSessionStartTime(): number {
        return this.sessionStartTime;
    }

    /**
     * Resets only the session timer to now, without wiping transcript or context.
     * Call this when recording actually begins so duration = stop − start = real audio length.
     */
    resetSessionTimer(): void {
        this.sessionStartTime = Date.now();
        this.totalPausedMs = 0;
        this.pauseStartedAt = null;
    }

    // ============================================
    // Usage Tracking
    // ============================================

    /**
     * Cap usage array with simple eviction (usage doesn't need summarization)
     */
    capUsageArray(): void {
        if (this.fullUsage.length > 500) {
            this.fullUsage = this.fullUsage.slice(-500);
        }
    }

    /**
     * Public method to log usage from external sources (e.g. IPC direct chat)
     */
    logUsage(type: string, question: string, answer: string): void {
        this.fullUsage.push({
            type,
            timestamp: Date.now(),
            question,
            answer
        });
    }

    pushUsage(entry: any): void {
        this.fullUsage.push(entry);
        this.capUsageArray();
    }

    // ============================================
    // Interim Transcript Flush
    // ============================================

    /**
     * Force-save any pending interim transcript (called on meeting stop).
     * Covers both speakers — client (system audio) and user (microphone).
     * Without this, any in-flight interim segment spoken right as the meeting
     * ends is silently discarded from the post-meeting transcript.
     */
    flushInterimTranscript(): void {
        if (this.lastInterimClient) {
            console.log('[SessionTracker] Force-saving pending interim CLIENT transcript:', this.lastInterimClient.text);
            const finalSegment = { ...this.lastInterimClient, final: true };
            this.addTranscript(finalSegment);
            this.lastInterimClient = null;
        }
        if (this.lastInterimUser) {
            console.log('[SessionTracker] Force-saving pending interim USER transcript:', this.lastInterimUser.text);
            const finalSegment = { ...this.lastInterimUser, final: true };
            this.addTranscript(finalSegment);
            this.lastInterimUser = null;
        }
    }

    // ============================================
    // Reset
    // ============================================

    reset(): void {
        this.contextItems = [];
        this.fullTranscript = [];
        this.fullUsage = [];
        this.transcriptEpochSummaries = [];
        this.summarizedCount = 0;
        this.isCompacting = false;
        this.sessionGeneration++;
        this.sessionStartTime = Date.now();
        this.totalPausedMs = 0;
        this.pauseStartedAt = null;
        this.lastAssistantMessage = null;
        this.assistantResponseHistory = [];
        this.lastInterimClient = null;
        this.lastInterimUser = null;
        this.speakerNameMap = { user: 'Me', client: 'Them', clientDiarized: 'Other Party' };

    }

    // ============================================
    // Private Helpers
    // ============================================

    mapSpeakerToRole(speaker: string): 'client' | 'user' | 'assistant' {
        if (speaker === 'user') return 'user';
        if (speaker === 'assistant') return 'assistant';
        return 'client'; // system audio = client
    }

    private evictOldEntries(): void {
        const cutoff = Date.now() - (this.contextWindowDuration * 1000);
        this.contextItems = this.contextItems.filter(item => item.timestamp >= cutoff);

        // Safety limit
        if (this.contextItems.length > this.maxContextItems) {
            this.contextItems = this.contextItems.slice(-this.maxContextItems);
        }
    }

    /**
     * Compact transcript buffer by summarizing oldest entries into an epoch summary.
     * Called instead of raw slice() to preserve early meeting context.
     */
    private async compactTranscriptIfNeeded(): Promise<void> {
        if (this.fullTranscript.length - this.summarizedCount <= SessionTracker.COMPACT_THRESHOLD || this.isCompacting) return;

        this.isCompacting = true;
        const generation = this.sessionGeneration;
        const start = this.summarizedCount;
        const summarizeCount = SessionTracker.COMPACT_BATCH;
        let epochEntry: string;
        try {
            // Take the oldest unsummarized entries to summarize
            const oldEntries = this.fullTranscript.slice(start, start + summarizeCount);
            const summaryInput = oldEntries.map(seg => {
                const role = this.mapSpeakerToRole(seg.speaker);
                const label = role === 'client' ? (this.speakerNameMap.client || 'CLIENT').toUpperCase() :
                    role === 'user' ? (this.speakerNameMap.user || 'ME').toUpperCase() : 'ASSISTANT';
                return `[${label}]: ${seg.text}`;
            }).join('\n');

            // Fire-and-forget LLM summarization (non-blocking)
            if (this.recapLLM) {
                try {
                    const epochSummary = await this.recapLLM.generate(
                        `Summarize this conversation segment into 3-5 concise bullet points preserving key topics, decisions, and questions:\n\n${summaryInput}`
                    );
                    if (epochSummary && epochSummary.trim().length > 0) {
                        epochEntry = epochSummary.trim();
                    } else {
                        // Empty LLM response — store a basic marker so context is not lost
                        const marker = `[Earlier discussion: ${oldEntries.length} segments — ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                        epochEntry = marker;
                    }
                } catch (e) {
                    // If summarization fails, store a simple marker
                    const fallback = `[Earlier discussion: ${oldEntries.length} segments, topics: ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                    epochEntry = fallback;
                    console.warn('[SessionTracker] Epoch summarization failed, using fallback marker');
                }
            } else {
                // BUG-03 fix: recapLLM not yet available — always push a plain marker so early
                // context is not silently discarded with no record in transcriptEpochSummaries.
                const marker = `[Earlier discussion (no LLM): ${oldEntries.length} segments — ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                epochEntry = marker;
                console.warn('[SessionTracker] recapLLM not available — storing plain epoch marker');
            }
        } finally {
            if (generation === this.sessionGeneration) this.isCompacting = false;
        }

        // Session was reset while the summary was in flight — it belongs to a dead session
        if (generation !== this.sessionGeneration) return;

        this.transcriptEpochSummaries.push(epochEntry);
        console.log(`[SessionTracker] Epoch summary created (${this.transcriptEpochSummaries.length} total)`);

        // Cap epoch summaries to prevent LLM context window overflow
        if (this.transcriptEpochSummaries.length > SessionTracker.MAX_EPOCH_SUMMARIES) {
            this.transcriptEpochSummaries = this.transcriptEpochSummaries.slice(-SessionTracker.MAX_EPOCH_SUMMARIES);
        }

        // Drop the summarized entries from LLM context only; the saved transcript keeps them
        this.summarizedCount = start + summarizeCount;
    }
}