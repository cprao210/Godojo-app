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
        source?: 'manual' | 'calendar';
        attendees?: Array<{ email: string; name?: string; organizer?: boolean; self?: boolean }>;
        organizer?: string;
    } | null = null;

    private speakerNameMap: { user: string; client: string } = {
        user: 'Me',
        client: 'Them'
    };

    // Full Session Tracking (Persisted)
    private fullTranscript: TranscriptSegment[] = [];
    private fullUsage: any[] = []; // UsageInteraction
    private sessionStartTime: number = Date.now();
    private totalPausedMs: number = 0;       // cumulative ms spent paused this session
    private pauseStartedAt: number | null = null;  // wall-clock time when current pause began

    // Rolling summarization: epoch summaries preserve early context when arrays are compacted
    private static readonly MAX_EPOCH_SUMMARIES = 5;
    private transcriptEpochSummaries: string[] = [];
    private isCompacting: boolean = false;

    // Track interim client segment
    private lastInterimClient: TranscriptSegment | null = null;
    // Track interim user (microphone) segment — flushed on meeting stop just like client
    private lastInterimUser: TranscriptSegment | null = null;

    // Detected coding question from transcript or screenshot extraction
    private detectedCodingQuestion: string | null = null;
    private codingQuestionSource: 'screenshot' | 'transcript' | null = null;
    private codingQuestionSetAt: number | null = null;

    // Rolling buffer for multi-segment client question detection
    private recentClientBuffer: { text: string; timestamp: number }[] = [];
    private static readonly INTERVIEWER_BUFFER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    // Screenshot-detected question stays sticky for 3 min before transcript can override
    private static readonly SCREENSHOT_STALE_MS = 3 * 60 * 1000;

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
        this.speakerNameMap = { user: 'Me', client: 'Them' };

        const attendees: any[] = metadata?.attendees || [];

        if (attendees.length === 0) {
            // No attendee list — try to extract the opposite party's name from the meeting title.
            if (metadata?.title) {
                const fromTitle = this.extractNameFromTitle(metadata.title);
                if (fromTitle) this.speakerNameMap.client = fromTitle;
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
        // then derive from email local-part. Used only when domain is personal (no company label).
        const resolveName = (attendee: any): string | null => {
            if (attendee.displayName && attendee.displayName.trim()) {
                return attendee.displayName.trim();
            }
            if (attendee.name && attendee.name.trim()) {
                return attendee.name.trim();
            }
            if (attendee.email) {
                const prefix = attendee.email.split('@')[0];
                const parts = prefix.split(/[._\-+]/).filter(Boolean);
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

        if (others.length >= 1) {
            // Apply company-domain labeling rules for ALL cases (1 or more opposite attendees).
            // BUG FIX: previously this logic only ran for others.length > 1, so a single
            // professional-domain attendee (e.g. peter@salesforce.com) incorrectly fell through
            // to resolveName() and showed "Peter" instead of "Salesforce".
            const companyLabels: string[] = [];
            let hasPersonalDomain = false;

            for (const attendee of others) {
                if (!attendee.email) continue;
                const company = companyFromEmail(attendee.email);
                if (company) {
                    if (!companyLabels.includes(company)) companyLabels.push(company);
                } else {
                    hasPersonalDomain = true;
                }
            }

            if (companyLabels.length > 0 && !hasPersonalDomain) {
                // All professional domains → e.g. "Salesforce" or "Instagram, Facebook"
                this.speakerNameMap.client = companyLabels.join(', ');
            } else if (companyLabels.length > 0 && hasPersonalDomain) {
                // Mix of professional and personal → e.g. "Salesforce + Other Party"
                this.speakerNameMap.client = companyLabels.join(', ') + ' + Other Party';
            } else {
                // All personal/unknown domains → use display name (single attendee) or generic fallback.
                if (others.length === 1) {
                    const name = resolveName(others[0]);
                    if (name) this.speakerNameMap.client = name;
                } else {
                    this.speakerNameMap.client = 'Other Party';
                }
            }
        } else {
            // No non-self attendees at all — try meeting title as last resort.
            if (metadata?.title) {
                const fromTitle = this.extractNameFromTitle(metadata.title);
                if (fromTitle) this.speakerNameMap.client = fromTitle;
            }
        }
        console.log('[SessionTracker] Speaker name map resolved:', this.speakerNameMap);
    }

    /**
     * Attempt to extract an opposite-party name from a meeting title.
     * Handles common patterns like "Meeting with John Doe" or "John Doe - Interview".
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
    public getSpeakerNameMap(): { user: string; client: string } {
        return { ...this.speakerNameMap };
    }

    public updateSpeakerNames(names: { user: string; client: string }): void {
        if (names.user && names.user.trim()) {
            this.speakerNameMap.user = names.user.trim();
        }
        if (names.client && names.client.trim()) {
            this.speakerNameMap.client = names.client.trim();
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
    // Coding Question Tracking
    // ============================================

    /**
     * Set the current coding question.
     * Priority rules (avoids stale Q1 blocking Q2 detection in multi-question interviews):
     *  - Screenshot → always stored immediately (explicit user action via Solve)
     *  - Transcript → stored if nothing is known yet, OR if existing question is also from
     *    transcript (newer detection = newer question), OR if screenshot question is stale
     *    (> 3 min old — user likely moved to the next question)
     */
    setCodingQuestion(question: string, source: 'screenshot' | 'transcript'): void {
        const now = Date.now();
        const trimmed = question.trim();
        if (!trimmed) return;

        if (this.detectedCodingQuestion === null) {
            // Nothing stored — accept any source
            this.detectedCodingQuestion = trimmed;
            this.codingQuestionSource = source;
            this.codingQuestionSetAt = now;
            console.log(`[SessionTracker] Coding question stored (source: ${source}): "${trimmed.substring(0, 80)}..."`);
            return;
        }

        if (source === 'screenshot') {
            // Screenshot always updates immediately (explicit user Solve action)
            this.detectedCodingQuestion = trimmed;
            this.codingQuestionSource = source;
            this.codingQuestionSetAt = now;
            console.log(`[SessionTracker] Coding question updated via screenshot: "${trimmed.substring(0, 80)}..."`);
            return;
        }

        // source === 'transcript'
        const isStale = this.codingQuestionSetAt !== null
            && (now - this.codingQuestionSetAt) > SessionTracker.SCREENSHOT_STALE_MS;
        const canOverride = this.codingQuestionSource === 'transcript' || isStale;

        if (canOverride) {
            this.detectedCodingQuestion = trimmed;
            this.codingQuestionSource = source;
            this.codingQuestionSetAt = now;
            console.log(`[SessionTracker] Coding question updated via transcript (prev was ${this.codingQuestionSource}, stale=${isStale}): "${trimmed.substring(0, 80)}..."`);
        } else {
            console.log(`[SessionTracker] Transcript question ignored — screenshot question is recent (< ${SessionTracker.SCREENSHOT_STALE_MS / 1000}s)`);
        }
    }

    getDetectedCodingQuestion(): { question: string | null; source: 'screenshot' | 'transcript' | null } {
        return { question: this.detectedCodingQuestion, source: this.codingQuestionSource };
    }

    clearCodingQuestion(): void {
        this.detectedCodingQuestion = null;
        this.codingQuestionSource = null;
        this.codingQuestionSetAt = null;
        this.recentClientBuffer = [];
    }

    /**
     * Heuristic to decide if an client statement looks like a coding question.
     * Requires ≥2 of the signal patterns and minimum length to avoid false positives
     * on casual conversation ("can you implement X?" → yes, "sounds good!" → no).
     */
    private looksLikeCodingQuestion(text: string): boolean {
        if (text.length < 50) return false;
        const patterns = [
            /\b(implement|write|code|solve|design|build|create)\b/i,
            /\b(given\s+(an?|the)\s+(array|string|list|tree|graph|matrix|number|integer|node|linked list|stack|queue|heap))\b/i,
            /\b(return|find\s+(all|the|a|any)|count|check\s+if|determine|calculate|maximize|minimize|sort)\b/i,
            /\b(function|method|algorithm|data structure|class)\b/i,
            /\b(O\(n\)|time complexity|space complexity|optimal|efficient|brute force)\b/i,
            /\b(two sum|three sum|binary search|dynamic programming|BFS|DFS|palindrome|anagram|substring|subarray|rotation)\b/i,
        ];
        const matchCount = patterns.filter(p => p.test(text)).length;
        return matchCount >= 2;
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
            timestamp: segment.timestamp
        });

        this.evictOldEntries();

        // Filter out internal system prompts that might be passed via IPC
        const isInternalPrompt = text.startsWith("You are a real-time interview assistant") ||
            text.startsWith("You are a helper") ||
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

        // Natively-style filtering
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

                // Add segment to rolling buffer and evict old entries
                this.recentClientBuffer.push({ text: segment.text, timestamp: segment.timestamp });
                const bufferCutoff = Date.now() - SessionTracker.INTERVIEWER_BUFFER_WINDOW_MS;
                this.recentClientBuffer = this.recentClientBuffer.filter(e => e.timestamp >= bufferCutoff);

                // Test single segment first; if no match, test accumulated recent turns
                // (client may state a problem across multiple speech segments)
                if (this.looksLikeCodingQuestion(segment.text)) {
                    this.setCodingQuestion(segment.text, 'transcript');
                } else if (this.recentClientBuffer.length > 1) {
                    const combinedText = this.recentClientBuffer.map(e => e.text).join(' ');
                    if (this.looksLikeCodingQuestion(combinedText)) {
                        this.setCodingQuestion(combinedText, 'transcript');
                    }
                }
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
     * Get formatted context string for LLM prompts
     */
    getFormattedContext(lastSeconds: number = 120): string {
        const items = this.getContext(lastSeconds);
        return items.map(item => {
            const label = item.role === 'client' ? (this.speakerNameMap.client || 'CLIENT').toUpperCase() :
                item.role === 'user' ? (this.speakerNameMap.user || 'ME').toUpperCase() :
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
        const recentTranscript = this.fullTranscript.map(segment => {
            const role = this.mapSpeakerToRole(segment.speaker);
            const label = role === 'client' ? (this.speakerNameMap.client || 'CLIENT').toUpperCase() :
                role === 'user' ? (this.speakerNameMap.user || 'ME').toUpperCase() :
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
        this.sessionStartTime = Date.now();
        this.totalPausedMs = 0;
        this.pauseStartedAt = null;
        this.lastAssistantMessage = null;
        this.assistantResponseHistory = [];
        this.lastInterimClient = null;
        this.lastInterimUser = null;
        this.detectedCodingQuestion = null;
        this.codingQuestionSource = null;
        this.codingQuestionSetAt = null;
        this.recentClientBuffer = [];
        this.speakerNameMap = { user: 'Me', client: 'Them' };

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
        if (this.fullTranscript.length <= 1800 || this.isCompacting) return;

        this.isCompacting = true;
        try {
            // Take the oldest 500 entries to summarize
            const summarizeCount = 500;
            const oldEntries = this.fullTranscript.slice(0, summarizeCount);
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
                        this.transcriptEpochSummaries.push(epochSummary.trim());
                        console.log(`[SessionTracker] Epoch summary created (${this.transcriptEpochSummaries.length} total)`);
                    } else {
                        // Empty LLM response — store a basic marker so context is not lost
                        const marker = `[Earlier discussion: ${oldEntries.length} segments — ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                        this.transcriptEpochSummaries.push(marker);
                    }
                } catch (e) {
                    // If summarization fails, store a simple marker
                    const fallback = `[Earlier discussion: ${oldEntries.length} segments, topics: ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                    this.transcriptEpochSummaries.push(fallback);
                    console.warn('[SessionTracker] Epoch summarization failed, using fallback marker');
                }
            } else {
                // BUG-03 fix: recapLLM not yet available — always push a plain marker so early
                // context is not silently discarded with no record in transcriptEpochSummaries.
                const marker = `[Earlier discussion (no LLM): ${oldEntries.length} segments — ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                this.transcriptEpochSummaries.push(marker);
                console.warn('[SessionTracker] recapLLM not available — storing plain epoch marker');
            }

            // Cap epoch summaries to prevent LLM context window overflow
            if (this.transcriptEpochSummaries.length > SessionTracker.MAX_EPOCH_SUMMARIES) {
                this.transcriptEpochSummaries = this.transcriptEpochSummaries.slice(-SessionTracker.MAX_EPOCH_SUMMARIES);
            }

            // Evict ONLY the exact 500 oldest entries that we just summarized
            this.fullTranscript = this.fullTranscript.slice(summarizeCount);
        } finally {
            this.isCompacting = false;
        }
    }
}