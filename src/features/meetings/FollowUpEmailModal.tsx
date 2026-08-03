import React, { useState, useEffect } from 'react';
import { X, RotateCcw, Check, Copy } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { guardSession } from '@/lib/firebase';
import { FollowUpEmailModalProps } from '@/types';

// ─── EmailPreview ─────────────────────────────────────────────────────────────
// Renders the plain-text email body with Gmail-ready visual formatting.
// Rules:
//   - Blank lines between paragraphs → rendered as paragraph breaks
//   - Lines starting with "•" or "-" or "*" → rendered as bullet points
//   - ALL-CAPS lines (section headers like "NEXT STEPS") → styled as labels
//   - Everything else → plain paragraph text
const EmailPreview: React.FC<{ body: string; isLight: boolean }> = ({ body, isLight }) => {
    if (!body.trim()) {
        return (
            <p className="text-[13px] text-text-tertiary italic">Your email will appear here...</p>
        );
    }

    // Split into logical blocks separated by blank lines
    const rawBlocks = body.split(/\n{2,}/);

    return (
        <div className="space-y-4 text-[14px] leading-7">
            {rawBlocks.map((block, blockIdx) => {
                const lines = block.split('\n').map(l => l.trimEnd()).filter(l => l !== '');
                if (lines.length === 0) return null;

                // Check if the first line is an ALL-CAPS section header
                const firstLine = lines[0];
                const isSectionHeader =
                    firstLine === firstLine.toUpperCase() &&
                    firstLine.length > 3 &&
                    !/^[•\-*]/.test(firstLine) &&
                    /[A-Z]/.test(firstLine);

                if (isSectionHeader) {
                    // Render header + its bullet lines together as a labeled group
                    const bulletLines = lines.slice(1);
                    return (
                        <div key={blockIdx}>
                            <p className={`text-[11px] font-bold uppercase tracking-widest mb-2 ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                                {firstLine}
                            </p>
                            {bulletLines.length > 0 && (
                                <ul className="space-y-1.5">
                                    {bulletLines.map((line, i) => {
                                        const text = line.replace(/^[•\-\*]\s*/, '');
                                        return (
                                            <li key={i} className={`flex items-start gap-2 ${isLight ? 'text-slate-700' : 'text-white/75'}`}>
                                                <span className={`mt-2.5 w-1.5 h-1.5 rounded-full shrink-0 ${isLight ? 'bg-slate-400' : 'bg-white/30'}`} />
                                                <span>{text}</span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    );
                }

                // Check if ALL lines in this block are bullets
                const allBullets = lines.every(l => /^[•\-\*]/.test(l.trim()));
                if (allBullets) {
                    return (
                        <ul key={blockIdx} className="space-y-1.5">
                            {lines.map((line, i) => {
                                const text = line.replace(/^[•\-\*]\s*/, '');
                                return (
                                    <li key={i} className={`flex items-start gap-2 ${isLight ? 'text-slate-700' : 'text-white/75'}`}>
                                        <span className={`mt-2.5 w-1.5 h-1.5 rounded-full shrink-0 ${isLight ? 'bg-slate-400' : 'bg-white/30'}`} />
                                        <span>{text}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    );
                }

                // Mixed block: render line by line
                return (
                    <div key={blockIdx} className="space-y-1.5">
                        {lines.map((line, i) => {
                            const isBullet = /^[•\-\*]/.test(line.trim());
                            if (isBullet) {
                                const text = line.replace(/^[•\-\*]\s*/, '');
                                return (
                                    <div key={i} className={`flex items-start gap-2 ${isLight ? 'text-slate-700' : 'text-white/75'}`}>
                                        <span className={`mt-2.5 w-1.5 h-1.5 rounded-full shrink-0 ${isLight ? 'bg-slate-400' : 'bg-white/30'}`} />
                                        <span>{text}</span>
                                    </div>
                                );
                            }
                            return (
                                <p key={i} className={isLight ? 'text-slate-700' : 'text-white/75'}>
                                    {line}
                                </p>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
};

const FollowUpEmailModal: React.FC<FollowUpEmailModalProps> = ({ isOpen, onClose, meeting, isLight = false }) => {
    const [recipientEmail, setRecipientEmail] = useState('');
    const [senderName, setSenderName] = useState('');
    const [recipientName, setRecipientName] = useState('');
    const [subject, setSubject] = useState('');
    const [emailBody, setEmailBody] = useState('');
    const [isCopied, setIsCopied] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [hasGeneratedOnce, setHasGeneratedOnce] = useState(false);
    const [isEditMode, setIsEditMode] = useState(false);
    const [isRegeneratedEmail, setIsRegeneratedEmail] = useState(false);

    useEffect(() => {
        if (isOpen) initializeFields();
    }, [isOpen, meeting]);

    const initializeFields = async () => {
        setIsRegeneratedEmail(false);
        const cleanTitle = meeting.title.replace(/["*]/g, '').trim();
        setSubject(`Follow up - ${cleanTitle}`);

        const storedName = localStorage.getItem('natively_user_name');
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
        const prebuilt = meeting.detailedSummary?.followUpEmail;
        const resolvedRecipient = resolveRecipientName(rName);
        const resolvedSender = resolveSenderName(sName);
        const company = resolveCompany();

        // ── Path A: use prebuilt data from the post-call LLM ──────────────────
        if (prebuilt && !hasGeneratedOnce) {
            if (prebuilt.subject) setSubject(prebuilt.subject);

            let bodyContent = '';

            if (prebuilt.fullEmail?.trim()) {
                // fullEmail exists — strip any greeting/sign-off the LLM may have
                // included so we can re-wrap consistently with resolved names.
                bodyContent = prebuilt.fullEmail
                    .replace(/^(dear|hi|hello|hey)[^,\n]*[,\n]\s*/i, '')  // strip existing greeting
                    // Sign-off: match from the last occurrence of a closing phrase to end,
                    // using a non-greedy line-anchored pattern so body content is never eaten
                    .replace(/\n(warm regards|sincerely|best regards|best|thank you|regards|cheers)[^\n]*(\n[\s\S]*)?$/i, '')
                    .trim();
            } else if (prebuilt.sections) {
                // No fullEmail — build the body from structured sections.
                const sections = prebuilt.sections;
                const lines: string[] = [];

                if (sections.whatWeDiscussed?.length)
                    lines.push(`WHAT WE DISCUSSED\n${sections.whatWeDiscussed.map((s: string) => `• ${s}`).join('\n')}`);
                if (sections.whatIsTheNeed?.length)
                    lines.push(`WHAT IS THE NEED\n${sections.whatIsTheNeed.map((s: string) => `• ${s}`).join('\n')}`);
                if (sections.scopeOfImprovement?.length)
                    lines.push(`SCOPE OF IMPROVEMENT\n${sections.scopeOfImprovement.map((s: string) => `• ${s}`).join('\n')}`);
                if (sections.whatYouWillAchieveAfterTransformation?.length)
                    lines.push(`WHAT YOU WILL ACHIEVE\n${sections.whatYouWillAchieveAfterTransformation.map((s: string) => `• ${s}`).join('\n')}`);
                if (sections.nextSteps?.length)
                    lines.push(`NEXT STEPS\n${sections.nextSteps.map((s: string) => `• ${s}`).join('\n')}`);

                bodyContent = lines.join('\n\n');
            }

            // Always wrap with greeting + sign-off regardless of which path was used
            setEmailBody(wrapWithGreetingAndSignoff(
                bodyContent || `I wanted to follow up on our conversation about ${company}.`,
                resolvedRecipient,
                resolvedSender
            ));
            setHasGeneratedOnce(true);
            return;
        }

        // ── Path B: generate via LLM (no prebuilt data, or forced regeneration) ─
        setIsGenerating(true);
        try {
            const ds = meeting.detailedSummary;
            const input = {
                meeting_type: 'meeting' as const,
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

                // BANT — budget/need often contain the metrics the rep wants in the email
                bant: (ds as any)?.bant || null,

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
                setHasGeneratedOnce(true);
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

    const handleReset = () => generateEmail();

    const handleCopy = async () => {
        const fullEmail = subject ? `Subject: ${subject}\n\n${emailBody}` : emailBody;
        try {
            await navigator.clipboard.writeText(fullEmail);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy email:', err);
        }
    };

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm transition-opacity"
                    />

                    {/* Modal Container */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        transition={{ duration: 0.25, type: 'spring', damping: 25, stiffness: 300 }}
                        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
                    >
                        <div className={`w-full max-w-[640px] rounded-2xl flex flex-col pointer-events-auto overflow-hidden border shadow-[var(--shadow-card)] ${isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-border-muted'}`}>

                            {/* ── Header ─────────────────────────────────────────────── */}
                            <div className={`flex px-6 py-4 justify-between items-center border-b ${isLight ? 'border-slate-200' : 'border-border-subtle'}`}>
                                <h2 className="text-sm font-semibold tracking-wide text-text-primary">Draft Follow-up</h2>
                                <button
                                    onClick={onClose}
                                    className={`p-1.5 rounded-full transition-colors ${isLight ? 'text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200' : 'text-text-tertiary hover:text-text-primary bg-bg-item-surface hover:bg-bg-item-active'}`}
                                >
                                    <X size={14} />
                                </button>
                            </div>

                            {/* ── Input Fields ────────────────────────────────────────── */}
                            <div className="px-8 pt-6 space-y-5">

                                {/* TO */}
                                <div className="flex items-start gap-6 group">
                                    <label className="text-[13px] w-[50px] font-medium pt-2 text-text-tertiary">To</label>
                                    <div className="flex-1 min-h-[32px] flex items-center border-b border-border-subtle group-focus-within:border-border-muted transition-colors pb-1">
                                        {recipientEmail ? (
                                            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[13px] shadow-sm animate-in fade-in zoom-in duration-200 bg-bg-component border border-border-muted text-text-primary">
                                                {/* Intentional green dot — status indicator, keep explicit color */}
                                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
                                                {recipientEmail}
                                                <button
                                                    onClick={() => setRecipientEmail('')}
                                                    className="transition-colors ml-1 text-text-tertiary hover:text-text-primary"
                                                >
                                                    <X size={12} />
                                                </button>
                                            </div>
                                        ) : (
                                            <input
                                                type="email"
                                                value={recipientEmail}
                                                onChange={(e) => setRecipientEmail(e.target.value)}
                                                placeholder="Recipient email"
                                                className="w-full bg-transparent focus:outline-none text-[14px] text-text-primary placeholder-text-tertiary"
                                                autoFocus
                                            />
                                        )}
                                    </div>
                                </div>

                                {/* SUBJECT */}
                                <div className="flex items-center gap-6 group">
                                    <label className="text-[13px] w-[50px] font-medium text-text-tertiary">Subject</label>
                                    <div className="flex-1 border-b border-border-subtle group-focus-within:border-border-muted transition-colors pb-1">
                                        <input
                                            type="text"
                                            value={subject}
                                            onChange={(e) => setSubject(e.target.value)}
                                            className="w-full bg-transparent focus:outline-none text-[14px] font-medium text-text-primary placeholder-text-tertiary"
                                            placeholder="Subject line"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* ── Body ────────────────────────────────────────────────── */}
                            <div className="flex-1 px-8 py-6 min-h-[320px] relative">
                                {isGenerating ? (
                                    <div className={`absolute inset-0 flex items-center justify-center z-10 backdrop-blur-[2px] ${isLight ? 'bg-white/70' : 'bg-bg-elevated/50'}`}>
                                        <div className="flex flex-col items-center gap-4">
                                            <div className="relative">
                                                <div className="w-10 h-10 border-2 rounded-full animate-spin border-border-muted border-t-accent-primary" />
                                                <div className="absolute inset-0 flex items-center justify-center">
                                                    <div className="w-2 h-2 rounded-full animate-pulse bg-accent-primary" />
                                                </div>
                                            </div>
                                            <span className="text-xs font-medium animate-pulse text-text-tertiary">
                                                Drafting perfect follow-up...
                                            </span>
                                        </div>
                                    </div>
                                ) : isEditMode ? (
                                    <textarea
                                        value={emailBody}
                                        onChange={(e) => setEmailBody(e.target.value)}
                                        className="w-full h-[300px] bg-transparent text-[13px] leading-6 focus:outline-none resize-none font-mono text-text-secondary placeholder-text-tertiary"
                                        placeholder="Write your email..."
                                        spellCheck={false}
                                    />
                                ) : (
                                    <div className="h-[300px] overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}>
                                        <EmailPreview body={emailBody} isLight={isLight} />
                                    </div>
                                )}
                            </div>

                            {/* ── Footer ──────────────────────────────────────────────── */}
                            <div className={`flex items-center justify-between px-6 py-5 border-t ${isLight ? 'border-slate-200 bg-slate-50/70' : 'border-border-subtle bg-bg-secondary/50'}`}>
                                {/* Left */}
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={handleCopy}
                                        disabled={isGenerating}
                                        className="flex items-center gap-2 text-xs font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-text-secondary hover:text-text-primary"
                                    >
                                        {isCopied
                                            ? <Check size={14} className="text-emerald-500" />
                                            : <Copy size={14} />}
                                        {isCopied ? 'Copied' : 'Copy'}
                                    </button>
                                </div>

                                {/* Right */}
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={handleReset}
                                        disabled={isGenerating}
                                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed group text-text-tertiary hover:text-text-primary hover:bg-bg-item-surface"
                                        title="Regenerate"
                                    >
                                        <RotateCcw
                                            size={15}
                                            className={`group-hover:rotate-180 transition-transform duration-500 ${isGenerating ? 'animate-spin' : ''}`}
                                        />
                                        <span className="text-[13px] font-medium">Re-generate</span>
                                    </button>
                                </div>
                            </div>

                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};

export default FollowUpEmailModal;