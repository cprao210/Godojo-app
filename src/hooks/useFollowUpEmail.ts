/**
 * useFollowUpEmail.ts
 *
 * Owns every piece of state and logic behind the follow-up email modal:
 * loading the recipient (from the calendar event or the transcript),
 * generating the email body (prebuilt LLM data if available, otherwise a
 * fresh LLM call), and the copy/reset/edit-mode affordances. The modal
 * component itself only renders what this hook gives it.
 */
import { useState, useEffect } from 'react';
import { guardSession } from '@/lib/firebase';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import type { Meeting } from '@/types';
import { normalizeBant, confirmedOnly, BANT_ORDER } from '@/lib/bantMeddic';

export function useFollowUpEmail(isOpen: boolean, meeting: Meeting) {
    const [recipientEmail, setRecipientEmail] = useState('');
    const [senderName, setSenderName] = useState('');
    const [recipientName, setRecipientName] = useState('');
    const [subject, setSubject] = useState('');
    const [emailBody, setEmailBody] = useState('');
    const [isCopied, setIsCopied] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [isEditMode, setIsEditMode] = useState(false);
    const [isRegeneratedEmail, setIsRegeneratedEmail] = useState(false);

    useEffect(() => {
        if (isOpen) initializeFields();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, meeting]);

    const initializeFields = async () => {
        setIsRegeneratedEmail(false);
        const cleanTitle = meeting.title.replace(/["*]/g, '').trim();
        setSubject(`Follow up - ${cleanTitle}`);

        const storedName = localStorage.getItem('godojo_user_name');
        if (storedName) setSenderName(storedName);

        let loadedRecipientEmail = '';
        let loadedRecipientName = '';

        try {
            if (meeting.calendarEventId) {
                // @ts-ignore
                const attendees = await window.electronAPI?.invoke('get-calendar-attendees', meeting.calendarEventId);
                if (attendees?.length > 0) {
                    loadedRecipientEmail = attendees[0].email;
                    if (attendees[0].name) loadedRecipientName = attendees[0].name.split(' ')[0];
                }
            }
            if (!loadedRecipientEmail && meeting.transcript) {
                // @ts-ignore
                const extracted = await window.electronAPI?.invoke('extract-emails-from-transcript', meeting.transcript);
                if (extracted?.length > 0) loadedRecipientEmail = extracted[0];
            }
        } catch (e) {
            console.error(e);
        }

        if (loadedRecipientEmail) setRecipientEmail(loadedRecipientEmail);
        if (loadedRecipientName) setRecipientName(loadedRecipientName);

        if (!emailBody && !isGenerating) {
            generateEmail(loadedRecipientName, storedName || '');
        }
    };

    // ── Helpers ────────────────────────────────────────────────────────────────

    // Resolve the best available recipient first name.
    // Priority: recipientName from calendar → leadName from transcript extraction → placeholder
    const resolveRecipientName = (rName?: string): string => {
        const name = rName || recipientName || meeting.detailedSummary?.leadName || '';
        if (!name.trim()) return '[Prospect Name]';
        // Use first name only
        return name.trim().split(' ')[0];
    };

    // Resolve sender name.
    // Priority: senderName state (from localStorage) → placeholder
    const resolveSenderName = (sName?: string): string => {
        const name = sName || senderName || '';
        if (!name.trim()) return '[Your Name]';
        return name.trim().split(' ')[0];
    };

    // Resolve company name for the closing context line.
    const resolveCompany = (): string => {
        return meeting.detailedSummary?.company || '[Company Name]';
    };

    // Wrap the raw body content with a proper greeting and sign-off.
    const wrapWithGreetingAndSignoff = (bodyContent: string, rName: string, sName: string, omitOpeningLine = false): string => {
        const greeting = `Dear ${rName},`;
        const openingLine = `It was great connecting with you and understanding how things currently run.\n\nTo recap our discussion, here's a summary of the key points, identified needs, potential areas of improvement, and the proposed next steps from our conversation:`;
        const signoff = `Thank you for your time. Looking forward to our next conversation.\n\nWarm regards,\n${sName}`;
        if (omitOpeningLine) {
            return `${greeting}\n\n${bodyContent.trim()}\n\n${signoff}`;
        }
        return `${greeting}\n\n${openingLine}\n\n${bodyContent.trim()}\n\n${signoff}`;
    };

    // ── Main generator ─────────────────────────────────────────────────────────

    const generateEmail = async (rName?: string, sName?: string) => {
        // Always generated on demand — the summary JSON no longer carries a
        // prebuilt followUpEmail (dropped from the generation contract to
        // save tokens); this LLM call owns the email end-to-end.
        const resolvedRecipient = resolveRecipientName(rName);
        const resolvedSender = resolveSenderName(sName);
        const company = resolveCompany();

        // ── Generate via LLM ───────────────────────────────────────────────────
        setIsGenerating(true);
        try {
            const ds = meeting.detailedSummary;
            const input = {
                meeting_type: 'meeting' as const,
                meeting_id: meeting.id, // usage analytics attribution (electron IPC)
                title: meeting.title,
                date: meeting.date,

                // Both field names — buildFollowUpEmailPromptInput checks both
                overview: ds?.overview || meeting.summary,
                summary: ds?.overview || meeting.summary,

                // Structured lists
                keyPoints: ds?.keyPoints || [],
                actionItems: ds?.actionItems || [],
                key_points: ds?.keyPoints || [],    // legacy alias
                action_items: ds?.actionItems || [],   // legacy alias

                // People / company — used for prompt personalisation
                leadName: ds?.leadName || '',
                company: ds?.company || '',
                recipient_name: resolvedRecipient,
                sender_name: resolvedSender,

                bant: (() => {
                    const normalized = normalizeBant((ds as any)?.liveAnalysis?.bant);
                    const rows = confirmedOnly(normalized, BANT_ORDER);
                    if (!rows.length) return null;
                    return Object.fromEntries(rows.map(({ label, detail }) => [label, detail]));
                })(),

                // Pre-structured email sections (impact bullets, next steps, etc.)
                followUpEmail: ds?.followUpEmail || null,

                // Full transcript — gives the LLM direct access to numbers & quotes
                // Capped at 80 segments inside buildFollowUpEmailPromptInput already
                transcript: meeting.transcript || [],

                tone: 'neutral' as const,
            };

            const sessionActive = await guardSession();
            if (!sessionActive) return;
            const generatedBody = await window.electronAPI?.generateFollowupEmail(input);

            if (generatedBody) {
                // Strip the Subject: line if the LLM prefixed it
                let body = generatedBody;
                const subjectMatch = body.match(/^Subject:\s*(.+)/m);
                if (subjectMatch) {
                    setSubject(subjectMatch[1].trim());
                    body = body.replace(/^Subject:\s*.+\n?/m, '').trimStart();
                }

                // Strip any greeting/sign-off the LLM wrote so we control the format
                body = body
                    .replace(/^(dear|hi|hello|hey)[^,\n]*[,\n]\s*/i, '')
                    .replace(/\n(warm regards|sincerely|best regards|best|thank you|regards|cheers)[^\n]*(\n[\s\S]*)?$/i, '')
                    .trim();

                setEmailBody(wrapWithGreetingAndSignoff(body, resolvedRecipient, resolvedSender, true));
                setIsRegeneratedEmail(true);
            }
        } catch (error) {
            console.error('Failed to generate email:', error);
            // Fallback: a minimal but properly structured email
            const fallbackBody = `I wanted to follow up on our conversation about ${company}.\n\nWHAT WE DISCUSSED\n• We reviewed your current workflow and operational challenges.\n• We discussed how our solution addresses your core needs.\n• We aligned on potential next steps.\n\nNEXT STEPS\n• Please review the materials shared during our call.\n• Let us know if any additional stakeholders should be looped in.\n• We will follow up by [Date] to confirm timing.`;
            setEmailBody(wrapWithGreetingAndSignoff(fallbackBody, resolvedRecipient, resolvedSender, true));
        } finally {
            setIsGenerating(false);
        }
    };

    const handleReset = () => {
        posthogAnalytics.trackFollowUpRegenerate();
        generateEmail();
    };

    const handleCopy = async () => {
        const fullEmail = subject ? `Subject: ${subject}\n\n${emailBody}` : emailBody;
        try {
            await navigator.clipboard.writeText(fullEmail);
            posthogAnalytics.trackFollowUpCopy();
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy email:', err);
        }
    };

    return {
        recipientEmail, setRecipientEmail,
        subject, setSubject,
        emailBody, setEmailBody,
        isCopied,
        isGenerating,
        isEditMode, setIsEditMode,
        isRegeneratedEmail,
        handleReset,
        handleCopy,
    };
}