/**
 * FollowUpEmailModal.tsx
 *
 * Draft/edit/copy the AI-generated follow-up email for a meeting. All the
 * generation logic (recipient resolution, prebuilt-vs-LLM paths, copy/reset)
 * lives in `useFollowUpEmail`; this file is purely the modal chrome + form.
 */
import React from 'react';
import { X, RotateCcw, Check, Copy } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { FollowUpEmailModalProps } from '@/types';
import { useFollowUpEmail } from '@/hooks';
import { EmailPreview } from './EmailPreview';

const FollowUpEmailModal: React.FC<FollowUpEmailModalProps> = ({ isOpen, onClose, meeting, isLight = false }) => {
    const {
        recipientEmail, setRecipientEmail,
        subject, setSubject,
        emailBody, setEmailBody,
        isCopied,
        isGenerating,
        isEditMode, setIsEditMode,
        handleReset,
        handleCopy,
    } = useFollowUpEmail(isOpen, meeting);

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