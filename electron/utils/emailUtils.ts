// electron/utils/emailUtils.ts
// Utilities for follow-up email functionality

/**
 * Extract email addresses from transcript text
 * Uses regex to find email patterns mentioned in conversation
 */
export function extractEmailsFromTranscript(transcript: Array<{ text: string }>): string[] {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = new Set<string>();

    for (const entry of transcript) {
        const matches = entry.text.match(emailRegex);
        if (matches) {
            matches.forEach(email => emails.add(email.toLowerCase()));
        }
    }

    return Array.from(emails);
}

/**
 * Build a mailto: link with pre-filled content
 * @param to - Recipient email(s), comma-separated
 * @param subject - Email subject line
 * @param body - Email body text
 */
export function buildMailtoLink(to: string, subject: string, body: string): string {
    const params = new URLSearchParams();
    params.set('subject', subject);
    params.set('body', body);

    // URLSearchParams encodes spaces as '+', but mailto expects '%20'
    const queryString = params.toString().replace(/\+/g, '%20');

    return `mailto:${encodeURIComponent(to)}?${queryString}`;
}

/**
 * Build a Gmail composition URL
 * Opens Gmail web interface with pre-filled content
 */
export function buildGmailComposeUrl(to: string, subject: string, body: string): string {
    const params = new URLSearchParams();
    params.set('view', 'cm');
    params.set('fs', '1');
    params.set('to', to);
    params.set('su', subject);
    params.set('body', body);

    return `https://mail.google.com/mail/?${params.toString()}`;
}


/**
 * Generate a suggested email subject from meeting title
 */
export function generateEmailSubject(meetingTitle: string, meetingType: string = 'meeting'): string {
    const cleanTitle = meetingTitle.replace(/["\*]/g, '').trim();

    if (meetingType === 'interview') {
        return `Following up on our conversation - ${cleanTitle}`;
    }

    return `Following up - ${cleanTitle}`;
}

/**
 * Build the input payload for follow-up email LLM generation
 */
export interface FollowUpEmailInput {
    meeting_type: 'interview' | 'call' | 'demo' | 'discussion' | 'meeting';
    title: string;
    summary?: string;
    action_items?: string[];
    key_points?: string[];
    recipient_name?: string;
    sender_name?: string;
    tone?: 'friendly' | 'neutral' | 'formal';
}

export function buildFollowUpEmailPromptInput(input: any): string {
    const parts: string[] = [];

    if (input.title) parts.push(`Meeting Title: ${input.title}`);
    if (input.date) parts.push(`Date: ${new Date(input.date).toLocaleDateString()}`);

    // Prospect name: prefer structured leadName, fall back to recipient_name passed by the modal
    const prospectName = input.leadName || input.recipient_name;
    if (prospectName) parts.push(`Prospect Name: ${prospectName}`);

    if (input.company) parts.push(`Company: ${input.company}`);

    // Rep/sender name: surface it explicitly so the model can use it in the signature.
    // Fall back to user profile fields when the modal doesn't pass sender_name directly.
    const repName = input.sender_name || input.userName || input.userDisplayName;
    if (repName) parts.push(`Sales Rep Name: ${repName}`);

    // summary is the field name used by Path B (modal LLM path); overview is used by the post-call path
    if (input.overview) parts.push(`\nCall Overview:\n${input.overview}`);
    else if (input.summary) parts.push(`\nCall Overview:\n${input.summary}`);

    if (input.keyPoints?.length) {
        parts.push(`\nKey Discussion Points:\n${input.keyPoints.map((p: string) => `- ${p}`).join('\n')}`);
    }

    if (input.bant) {
        parts.push(`\nBANT:\n- Budget: ${input.bant.budget?.detail || 'Unknown'}\n- Authority: ${input.bant.authority?.detail || 'Unknown'}\n- Need: ${input.bant.need?.detail || 'Unknown'}\n- Timeline: ${input.bant.timeline?.detail || 'Unknown'}`);
    }

    if (input.followUpEmail?.sections) {
        const s = input.followUpEmail.sections;
        if (s.whatWeDiscussed?.length) parts.push(`\nWhat Was Discussed:\n${s.whatWeDiscussed.map((p: string) => `- ${p}`).join('\n')}`);
        if (s.currentProcess) parts.push(`\nCurrent Process:\n${s.currentProcess}`);
        if (s.scopeOfImprovement?.length) parts.push(`\nScope of Improvement:\n${s.scopeOfImprovement.map((p: string) => `- ${p}`).join('\n')}`);
        if (s.howOurSolutionHelps?.length) parts.push(`\nHow Solution Helps:\n${s.howOurSolutionHelps.map((p: string) => `- ${p}`).join('\n')}`);
        if (s.expectedBusinessImpact?.length) parts.push(`\nExpected Business Impact:\n${s.expectedBusinessImpact.map((p: string) => `- ${p}`).join('\n')}`);
        if (s.nextSteps?.length) parts.push(`\nAgreed Next Steps:\n${s.nextSteps.map((p: string) => `- ${p}`).join('\n')}`);
    }

    if (input.actionItems?.length) {
        parts.push(`\nAction Items:\n${input.actionItems.map((a: string) => `- ${a}`).join('\n')}`);
    }

    if (input.transcript?.length) {
        const transcriptText = input.transcript
            .slice(-60) // last 60 segments to stay within token limits
            .map((t: any) => `${t.speaker === 'user' ? 'Rep' : 'Prospect'}: ${t.text}`)
            .join('\n');
        parts.push(`\nTranscript Excerpt:\n${transcriptText}`);
    }

    return parts.join('\n');
}

/**
 * Parse attendee name from calendar data or transcript
 * Extracts first name from full name or email
 */
export function extractRecipientName(attendeeInfo: string): string {
    // If it's an email, extract the part before @
    if (attendeeInfo.includes('@')) {
        const localPart = attendeeInfo.split('@')[0];
        // Convert something like "john.doe" to "John"
        const firstName = localPart.split(/[._-]/)[0];
        return firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
    }

    // If it's a full name, take the first word
    const firstName = attendeeInfo.split(' ')[0];
    return firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
}

/**
 * Copy text to clipboard (renderer process helper)
 */
export function copyToClipboard(text: string): Promise<void> {
    return navigator.clipboard.writeText(text);
}
