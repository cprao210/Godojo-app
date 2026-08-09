import React, { useState } from 'react';
import { X, Copy, Check, FileText, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { IMAGES } from '@/lib/assets';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { chatMarkdownComponents } from '@/features/chat';
import { useMeetingChat } from '@/hooks';
import { ChatSources, MeetingChatOverlayProps } from '@/types';

// ============================================
// Typing Indicator Component
// ============================================

const TypingIndicator: React.FC<{ label?: string }> = ({ label }) => (
    <div className="flex items-center py-4">
        <motion.span
            className="w-2 h-2 rounded-full bg-accent-primary mr-2.5 shrink-0"
            animate={{ opacity: [0.35, 1, 0.35] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
        />
        <AnimatePresence mode="wait">
            <motion.span
                key={label ?? 'thinking'}
                initial={{ opacity: 0, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.15 }}
                className="text-[13px] text-text-tertiary whitespace-nowrap"
            >
                {label ?? 'Thinking…'}
            </motion.span>
        </AnimatePresence>
    </div>
);

// ============================================
// Message Components
// ============================================

const UserMessage: React.FC<{ content: string }> = ({ content }) => (
    <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="flex justify-end mb-6"
    >
        <div className="bg-accent-primary text-white px-5 py-3 rounded-2xl rounded-tr-md max-w-[70%] text-[15px] leading-relaxed">
            {content}
        </div>
    </motion.div>
);

// ============================================
// Sources Display
// ============================================
// Renders retrieved meeting sources under an assistant message, mirroring the
// "Sources" affordance of most RAG chat apps:
//  - Nothing rendered at all if there are no sources.
//  - Exactly one meeting source: shown as a clickable chip (opens that meeting).
//  - Multiple meeting sources: shown as plain (non-clickable) text —
//    "Title of First +N" — since there's no single obvious place to navigate.
// Asset sources (company knowledge base docs) are counted but not clickable,
// since there's no meeting to open for them.
const SourcesDisplay: React.FC<{ sources: ChatSources; onOpenMeeting?: (meetingId: string) => void }> = ({ sources, onOpenMeeting }) => {
    const { meetings, assets } = sources;
    const totalCount = meetings.length + assets.length;
    if (totalCount === 0) return null;

    // Single meeting, no assets → clickable chip with the real title.
    if (meetings.length === 1 && assets.length === 0) {
        const meeting = meetings[0];
        const isClickable = !!onOpenMeeting;
        const Tag: any = isClickable ? 'button' : 'span';
        return (
            <Tag
                {...(isClickable ? { onClick: () => onOpenMeeting!(meeting.id) } : {})}
                className={`flex items-center gap-1.5 text-[13px] text-text-tertiary max-w-[280px] ${isClickable ? 'hover:text-text-secondary hover:underline transition-colors cursor-pointer' : ''}`}
                title={meeting.title}
            >
                <FileText size={13} className="shrink-0" />
                <span className="truncate">{meeting.title}</span>
                {isClickable && <ExternalLink size={11} className="shrink-0" />}
            </Tag>
        );
    }

    // Multiple sources (any mix of meetings/assets) → plain text summary,
    // "First Title +N" — not clickable, since there's no single destination.
    const firstTitle = meetings[0]?.title ?? assets[0]?.title ?? '';
    const extraCount = totalCount - 1;
    return (
        <span className="flex items-center gap-1.5 text-[13px] text-text-tertiary max-w-[320px]" title={[...meetings, ...assets].map(s => s.title).join(', ')}>
            <FileText size={13} className="shrink-0" />
            <span className="truncate">
                {firstTitle}{extraCount > 0 ? ` +${extraCount}` : ''}
            </span>
        </span>
    );
};

const AssistantMessage: React.FC<{ content: string; isStreaming?: boolean; sources?: ChatSources; onOpenMeeting?: (meetingId: string) => void }> = ({ content, isStreaming, sources, onOpenMeeting }) => {
    const [copied, setCopied] = useState(false);

    // While waiting for the first frame the assistant placeholder has no
    // content yet — render nothing here and let the single TypingIndicator
    // (rendered by the parent list) own the "thinking" state. Without this,
    // an empty bubble + blinking cursor would show *alongside* the 3-dot
    // indicator, which is the "two loaders" bug.
    if (isStreaming && !content) return null;

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col items-start mb-6"
        >
            <div className="text-text-primary text-[15px] leading-relaxed max-w-[85%]">
                <div className="markdown-content">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={chatMarkdownComponents}
                    >
                        {content}
                    </ReactMarkdown>
                </div>
                {isStreaming && (
                    <motion.span
                        className="inline-block w-0.5 h-4 bg-text-secondary ml-0.5 align-middle"
                        animate={{ opacity: [1, 0] }}
                        transition={{ duration: 0.5, repeat: Infinity }}
                    />
                )}
            </div>
            {!isStreaming && content && (
                <div className="flex items-center gap-4 mt-3">
                    <button
                        onClick={handleCopy}
                        className="flex items-center gap-2 text-[13px] text-text-tertiary hover:text-text-secondary transition-colors"
                    >
                        {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                        {copied ? 'Copied' : 'Copy message'}
                    </button>
                    {sources && <SourcesDisplay sources={sources} onOpenMeeting={onOpenMeeting} />}
                </div>
            )}
        </motion.div>
    );
};

// ============================================
// Main Component
// ============================================

const MeetingChatOverlay: React.FC<MeetingChatOverlayProps> = ({
    isOpen,
    onClose,
    onMessagesChange,
    messages,
    meetingContext,
    initialQuery,
    onOpenMeeting,
}) => {
    const {
        chatState,
        errorMessage,
        statusText,
        messagesEndRef,
        chatWindowRef,
        handleBackdropClick,
        handleClose,
    } = useMeetingChat({ isOpen, onClose, onMessagesChange, messages, meetingContext, initialQuery });

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="absolute inset-0 z-40 flex flex-col justify-end"
                    onClick={handleBackdropClick}
                >
                    {/* Backdrop with blur */}
                    <motion.div
                        initial={{ backdropFilter: 'blur(0px)' }}
                        animate={{ backdropFilter: 'blur(8px)' }}
                        exit={{ backdropFilter: 'blur(0px)' }}
                        transition={{ duration: 0.16 }}
                        className="absolute inset-0 bg-black/40"
                    />

                    {/* Chat Window - extends to bottom, leaves room for input */}
                    <motion.div
                        ref={chatWindowRef}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "85vh", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                            height: { type: "spring", stiffness: 300, damping: 30, mass: 0.8 },
                            opacity: { duration: 0.2 }
                        }}
                        className="relative mx-auto w-full max-w-[680px] mb-0 bg-bg-secondary rounded-t-[24px] border-t border-x border-border-subtle shadow-2xl overflow-hidden flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header with close button */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
                            <div className="flex items-center gap-2 text-text-tertiary">
                                <img src={IMAGES.godojoLogoIcon} className="w-3.5 h-3.5 force-black-icon opacity-50" alt="logo" />
                                <span className="text-[13px] font-medium">Search this meeting</span>
                            </div>
                            <button
                                onClick={handleClose}
                                className="p-2 transition-colors group"
                            >
                                <X size={16} className="text-text-tertiary group-hover:text-red-500 group-hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-all duration-300" />
                            </button>
                        </div>

                        {/* Messages area - scrollable */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 pb-32 custom-scrollbar">
                            {messages.map((msg) => (
                                msg.role === 'user'
                                    ? <UserMessage key={msg.id} content={msg.content} />
                                    : <AssistantMessage key={msg.id} content={msg.content} isStreaming={msg.isStreaming} sources={msg.sources} onOpenMeeting={onOpenMeeting} />
                            ))}

                            {chatState === 'waiting_for_llm' && <TypingIndicator label={statusText ?? undefined} />}

                            {errorMessage && (
                                <motion.div
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="text-[#FF6B6B] text-[13px] py-2"
                                >
                                    {errorMessage}
                                </motion.div>
                            )}

                            <div ref={messagesEndRef} />
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default MeetingChatOverlay;