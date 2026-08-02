import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStreamBuffer } from '../hooks/useStreamBuffer';
import { X, Copy, Check, ArrowUp, FileText, ExternalLink, Sparkles, Search, Users } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { chatApi, statusLabel, type ChatSources, type StreamHandle } from '../lib/chatApi';
import godojoLogo from '../assets/logo-variant-2.svg';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { chatMarkdownComponents } from '../lib/markdownComponents';

// Renders retrieved sources under an assistant message — nothing if there are
// none, a single clickable chip for exactly one meeting source, or a chip for
// the first source plus a "+N" badge that opens a popover listing every
// source when there's more than one. Meetings are clickable (open the
// meeting); assets are shown plainly since there's nowhere to route them yet.
const SourcesDisplay: React.FC<{ sources: ChatSources; onOpenMeeting?: (meetingId: string) => void }> = ({ sources, onOpenMeeting }) => {
    const { meetings, assets } = sources;
    const totalCount = meetings.length + assets.length;
    const [expanded, setExpanded] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close on outside click / Escape
    useEffect(() => {
        if (!expanded) return;
        const handleClick = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setExpanded(false);
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setExpanded(false);
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [expanded]);

    if (totalCount === 0) return null;

    const allSources = [
        ...meetings.map(m => ({ ...m, type: 'meeting' as const })),
        ...assets.map(a => ({ ...a, type: 'asset' as const })),
    ];

    // Single source, no popover needed — just a plain (or clickable) chip.
    if (totalCount === 1) {
        const only = allSources[0];
        const isClickable = only.type === 'meeting' && !!onOpenMeeting;
        const Tag: any = isClickable ? 'button' : 'span';
        return (
            <Tag
                {...(isClickable ? { onClick: () => onOpenMeeting!(only.id) } : {})}
                className={`flex items-center gap-1.5 text-[12px] text-text-tertiary max-w-[240px] ${isClickable ? 'hover:text-accent-primary hover:underline transition-colors cursor-pointer' : ''}`}
                title={only.title}
            >
                <FileText size={12} className="shrink-0" />
                <span className="truncate">{only.title}</span>
                {isClickable && <ExternalLink size={10} className="shrink-0" />}
            </Tag>
        );
    }

    // Multiple sources — first title as a chip, "+N" badge opens the full list.
    const firstTitle = allSources[0].title;
    const extraCount = totalCount - 1;

    return (
        <div ref={containerRef} className="relative">
            <button
                onClick={() => setExpanded(v => !v)}
                className="flex items-center gap-1.5 text-[12px] text-text-tertiary hover:text-text-secondary transition-colors max-w-[280px]"
                title={allSources.map(s => s.title).join(', ')}
            >
                <FileText size={12} className="shrink-0" />
                <span className="truncate">{firstTitle}</span>
                <span className={`shrink-0 text-[11px] font-medium px-1.5 py-[1px] rounded-full transition-colors ${expanded ? 'bg-accent-primary/20 text-accent-primary' : 'bg-bg-item-active text-text-tertiary'}`}>
                    +{extraCount}
                </span>
            </button>

            <AnimatePresence>
                {expanded && (
                    <motion.div
                        initial={{ opacity: 0, y: 4, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 4, scale: 0.97 }}
                        transition={{ duration: 0.12 }}
                        style={{ transformOrigin: 'bottom left' }}
                        className="absolute bottom-full left-0 mb-1.5 w-[260px] max-h-[220px] overflow-y-auto rounded-xl border border-border-subtle bg-bg-elevated shadow-[0_12px_32px_-8px_rgba(0,0,0,0.45)] py-1.5 z-10"
                    >
                        <div className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary">
                            {totalCount} sources
                        </div>
                        {allSources.map((s, i) => {
                            const isClickable = s.type === 'meeting' && !!onOpenMeeting;
                            const Tag: any = isClickable ? 'button' : 'div';
                            return (
                                <Tag
                                    key={`${s.type}-${s.id}-${i}`}
                                    {...(isClickable ? { onClick: () => { onOpenMeeting!(s.id); setExpanded(false); } } : {})}
                                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-text-secondary transition-colors ${isClickable ? 'hover:bg-bg-item-active hover:text-text-primary cursor-pointer' : ''}`}
                                >
                                    <FileText size={12} className="shrink-0 text-text-tertiary" />
                                    <span className="truncate flex-1">{s.title}</span>
                                    {isClickable && <ExternalLink size={11} className="shrink-0 text-text-tertiary" />}
                                </Tag>
                            );
                        })}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ============================================
// Types
// ============================================

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    isStreaming?: boolean;
    sources?: ChatSources;
}

interface GlobalChatOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    initialQuery?: string;
    /** Opens a different meeting's details — used when the person clicks a
     * single-source chip under an assistant answer. Omit to render the chip
     * as plain (non-clickable) text instead. */
    onOpenMeeting?: (meetingId: string) => void;
}

// ============================================
// Typing Indicator Component
// ============================================

const TypingIndicator: React.FC<{ label?: string }> = ({ label }) => (
    <div className="flex items-center py-2 pl-1">
        <div className="flex items-center gap-2 bg-bg-item-surface rounded-full px-3 py-2">
            <motion.span
                className="w-1.5 h-1.5 rounded-full bg-accent-primary shrink-0"
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
                    className="text-[12px] text-text-tertiary whitespace-nowrap"
                >
                    {label ?? 'Thinking…'}
                </motion.span>
            </AnimatePresence>
        </div>
    </div>
);

// ============================================
// Message Components
// ============================================

const UserMessage: React.FC<{ content: string }> = ({ content }) => (
    <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="flex justify-end mb-4"
    >
        <div className="bg-gradient-to-br from-blue-500 to-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-tr-md max-w-[80%] text-[13.5px] leading-relaxed shadow-sm">
            {content}
        </div>
    </motion.div>
);

const AssistantMessage: React.FC<{ content: string; isStreaming?: boolean; sources?: ChatSources; onOpenMeeting?: (meetingId: string) => void }> = ({ content, isStreaming, sources, onOpenMeeting }) => {
    const [copied, setCopied] = useState(false);

    // While waiting for the first frame the assistant placeholder has no
    // content yet — render nothing here and let the single TypingIndicator
    // (rendered by the parent list) own the "thinking" state. Without this,
    // an empty bubble + blinking cursor would show *alongside* the status
    // pill, which is the "two loaders" bug.
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
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="flex items-start gap-2.5 mb-4"
        >
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
                <Sparkles size={11} className="text-white" />
            </div>
            <div className="flex flex-col items-start min-w-0 max-w-[85%]">
                <div className="bg-bg-item-surface text-text-primary text-[13.5px] leading-relaxed px-4 py-2.5 rounded-2xl rounded-tl-md">
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
                            className="inline-block w-0.5 h-3.5 bg-text-secondary ml-0.5 align-middle"
                            animate={{ opacity: [1, 0] }}
                            transition={{ duration: 0.5, repeat: Infinity }}
                        />
                    )}
                </div>
                {!isStreaming && content && (
                    <div className="flex items-center gap-3 mt-1.5 px-1">
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
                        >
                            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                            {copied ? 'Copied' : 'Copy'}
                        </button>
                        {sources && <SourcesDisplay sources={sources} onOpenMeeting={onOpenMeeting} />}
                    </div>
                )}
            </div>
        </motion.div>
    );
};

// ============================================
// Empty State — friendly welcome + suggestion chips
// ============================================

const SUGGESTIONS = [
    { icon: Search, label: 'What did we discuss last week?' },
    { icon: Users, label: 'Summarize my recent meetings' },
];

const EmptyState: React.FC<{ onPick: (text: string) => void }> = ({ onPick }) => (
    <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2, delay: 0.05 }}
        className="flex-1 flex flex-col items-center justify-center px-6 text-center"
    >
        <div className="w-12 h-12 rounded-full bg-accent-primary/15 border border-accent-primary/20 flex items-center justify-center shadow-[0_8px_24px_rgba(37,99,235,0.2)] mb-4">
            <img src={godojoLogo} alt="Godojo" className="w-6 h-6" />
        </div>
        <h3 className="text-[15px] font-semibold text-text-primary mb-1">Ask me anything</h3>
        <p className="text-[13px] text-text-tertiary mb-5 max-w-[260px] leading-relaxed">
            I can search across all your meetings and give you straight answers.
        </p>
        <div className="flex flex-col gap-2 w-full max-w-[300px]">
            {SUGGESTIONS.map((s, i) => (
                <button
                    key={i}
                    onClick={() => onPick(s.label)}
                    className="flex items-center gap-2.5 text-left px-3.5 py-2.5 rounded-xl bg-bg-item-surface hover:bg-bg-item-active text-[12.5px] text-text-secondary hover:text-text-primary transition-colors"
                >
                    <s.icon size={14} className="text-text-tertiary shrink-0" />
                    <span className="truncate">{s.label}</span>
                </button>
            ))}
        </div>
    </motion.div>
);

// ============================================
// Main Component
// ============================================

type ChatState = 'idle' | 'waiting_for_llm' | 'streaming_response' | 'error';

const GlobalChatOverlay: React.FC<GlobalChatOverlayProps> = ({
    isOpen,
    onClose,
    initialQuery = '',
    onOpenMeeting
}) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatState, setChatState] = useState<ChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [statusText, setStatusText] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const streamBuffer = useStreamBuffer();
    const activeStreamRef = useRef<StreamHandle | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Focus the input as soon as the widget opens
    useEffect(() => {
        if (isOpen) {
            const t = setTimeout(() => inputRef.current?.focus(), 250);
            return () => clearTimeout(t);
        }
    }, [isOpen]);

    // Submit initial query when overlay opens
    useEffect(() => {
        if (isOpen && initialQuery && messages.length === 0) {
            setTimeout(() => {
                submitQuestion(initialQuery);
            }, 100);
        }
    }, [isOpen, initialQuery]);

    // Listen for new queries from parent
    useEffect(() => {
        if (isOpen && initialQuery && messages.length > 0) {
            // This is a follow-up query
            submitQuestion(initialQuery);
        }
    }, [initialQuery]);

    // ESC key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Click outside handler — the widget floats in the corner rather than
    // behaving like a modal, so we watch for clicks outside the panel
    // itself instead of relying on a full-screen backdrop.
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('[data-global-chat-fab]')) return; // the FAB's own onClick owns the toggle
            if (chatWindowRef.current && !chatWindowRef.current.contains(target)) {
                activeStreamRef.current?.abort();
                onClose();
            }
        };

        // Delay to avoid closing immediately from the click that opened it
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside);
        }, 150);

        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen, onClose]);

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            submitQuestion(query);
            setQuery('');
        }
    };

    // Cancel any in-flight stream if the overlay unmounts / closes mid-response.
    useEffect(() => () => activeStreamRef.current?.abort(), []);

    // Submit question using global RAG
    const submitQuestion = useCallback(async (question: string) => {
        if (!question.trim() || chatState === 'waiting_for_llm' || chatState === 'streaming_response') return;

        const userMessage: Message = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: question
        };
        setMessages(prev => [...prev, userMessage]);
        setChatState('waiting_for_llm');
        setErrorMessage(null);
        setStatusText(null);

        const assistantMessageId = `assistant-${Date.now()}`;

        // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
        await new Promise(resolve => setTimeout(resolve, 200));

        // Create assistant message placeholder
        setMessages(prev => [...prev, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            isStreaming: true
        }]);

        streamBuffer.reset();
        let sources: ChatSources | undefined;

        activeStreamRef.current = chatApi.queryGlobal(question, {
            onStatus: (status) => setStatusText(statusLabel(status)),
            onSources: (s) => { sources = s; },
            onToken: (chunk) => {
                setChatState('streaming_response');
                setStatusText(null);
                streamBuffer.appendToken(chunk, (content) => {
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId ? { ...msg, content } : msg
                    ));
                });
            },
            // Backend decided this was a factual/RAG query and returned the
            // complete answer in one frame — render it directly, skip the
            // token buffer entirely (no `token` frames will follow).
            onRagAnswer: (ragAnswer) => {
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: ragAnswer.answer, isStreaming: false, sources }
                        : msg
                ));
                setChatState('idle');
                setStatusText(null);
            },
            onDone: () => {
                const finalContent = streamBuffer.getBufferedContent();
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId && msg.isStreaming
                        ? { ...msg, content: finalContent, isStreaming: false, sources }
                        : msg
                ));
                setChatState('idle');
                setStatusText(null);
                streamBuffer.reset();
                activeStreamRef.current = null;
            },
            onError: (error) => {
                console.error('[GlobalChat] Stream error:', error);
                setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                setErrorMessage("Couldn't get a response. Please try again.");
                setChatState('error');
                setStatusText(null);
                streamBuffer.reset();
                activeStreamRef.current = null;
            },
        });
    }, [chatState]);

    const isBusy = chatState === 'waiting_for_llm' || chatState === 'streaming_response';

    return (
        <AnimatePresence
            onExitComplete={() => {
                setChatState('idle');
                setMessages([]);
                setErrorMessage(null);
            }}
        >
            {isOpen && (
                <div className="absolute inset-0 z-[355] pointer-events-none flex items-center justify-center">
                    {/* Dimmed backdrop — now that the window is centered rather than a
                        corner popover, a backdrop makes it read as a modal and gives an
                        obvious click-outside-to-close target. */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="pointer-events-auto absolute inset-0 bg-black/40 backdrop-blur-sm"
                    />

                    {/* Chat Window — centered over the app, sized up for markdown-heavy
                        answers (code blocks, lists, tables need more room than a small
                        corner popover can give). */}
                    <motion.div
                        ref={chatWindowRef}
                        initial={{ opacity: 0, scale: 0.94, y: 12 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: 8 }}
                        transition={{
                            type: "spring",
                            stiffness: 340,
                            damping: 30,
                            mass: 0.8
                        }}
                        style={{ transformOrigin: 'center' }}
                        className="pointer-events-auto relative w-[760px] h-[82vh] max-w-[calc(100vw-64px)] max-h-[calc(100vh-64px)] rounded-[22px] border border-border-subtle shadow-[0_24px_70px_-12px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col bg-bg-secondary/95 backdrop-blur-2xl"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-border-subtle shrink-0 bg-gradient-to-b from-bg-elevated/60 to-transparent">
                            <div className="flex items-center gap-2.5 min-w-0">
                                <div className="relative shrink-0">
                                    <div className="w-8 h-8 rounded-full bg-accent-primary/15 border border-accent-primary/20 flex items-center justify-center shadow-[0_2px_10px_rgba(37,99,235,0.25)]">
                                        <img src={godojoLogo} alt="Godojo" className="w-4 h-4" />
                                    </div>
                                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-bg-secondary" />
                                </div>
                                <div className="min-w-0">
                                    <div className="text-[13px] font-semibold text-text-primary leading-tight truncate">Godojo Chat Assistant</div>
                                    <div className="text-[11px] text-text-tertiary leading-tight">
                                        {isBusy ? (statusText ?? 'Typing…') : 'Online · searches all meetings'}
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-1.5 rounded-full hover:bg-bg-item-surface transition-colors group shrink-0"
                                aria-label="Close chat"
                            >
                                <X size={16} className="text-text-tertiary group-hover:text-text-primary transition-colors" />
                            </button>
                        </div>

                        {/* Messages area - scrollable, or empty state */}
                        {messages.length === 0 ? (
                            <EmptyState onPick={(text) => submitQuestion(text)} />
                        ) : (
                            <div className="flex-1 overflow-y-auto px-4 py-4 custom-scrollbar">
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
                                        className="text-[#FF6B6B] text-[12.5px] py-2"
                                    >
                                        {errorMessage}
                                    </motion.div>
                                )}

                                <div ref={messagesEndRef} />
                            </div>
                        )}

                        {/* Input bar — sits in normal flow at the bottom of the panel,
                            never overlaps the message list */}
                        <div className="shrink-0 px-3 py-3 border-t border-border-subtle bg-bg-secondary/80">
                            <div className="relative flex items-center">
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={handleInputKeyDown}
                                    placeholder="Message AI Assistant…"
                                    className="w-full pl-4 pr-11 py-2.5 bg-bg-input border border-border-muted rounded-full text-[13px] text-text-primary placeholder-text-tertiary/70 focus:outline-none focus:border-accent-primary/50 transition-colors"
                                />
                                <button
                                    onClick={() => {
                                        if (query.trim()) {
                                            submitQuestion(query);
                                            setQuery('');
                                        }
                                    }}
                                    disabled={!query.trim()}
                                    className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full transition-all duration-200 ${query.trim()
                                        ? 'bg-gradient-to-br from-blue-500 to-blue-600 text-white hover:scale-105 shadow-sm'
                                        : 'bg-bg-item-active text-text-tertiary cursor-default'
                                        }`}
                                    aria-label="Send message"
                                >
                                    <ArrowUp size={14} />
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};

export default GlobalChatOverlay;