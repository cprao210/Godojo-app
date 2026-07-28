import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStreamBuffer } from '../hooks/useStreamBuffer';
import { X, Copy, Check, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import nativelyIcon from './icon.png';
import { chatApi, type ChatSources, type StreamHandle } from '../lib/chatApi';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { chatMarkdownComponents } from '../lib/markdownComponents';

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

interface MeetingContext {
    id?: string;  // Required for RAG queries
    title: string;
    summary?: string;
    keyPoints?: string[];
    actionItems?: string[];
    transcript?: Array<{ speaker: string; text: string; timestamp: number }>;
}

interface MeetingChatOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    meetingContext: MeetingContext;
    initialQuery?: { text: string; id: number } | null;
    messages: Message[];
    onMessagesChange: React.Dispatch<React.SetStateAction<Message[]>>;
}

type ChatState = 'idle' | 'opening' | 'waiting_for_llm' | 'streaming_response' | 'error' | 'closing';

// ============================================
// Typing Indicator Component
// ============================================

const TypingIndicator: React.FC = () => (
    <div className="flex items-center gap-1 py-4">
        <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
                <motion.div
                    key={i}
                    className="w-2 h-2 rounded-full bg-text-tertiary"
                    animate={{ opacity: [0.4, 1, 0.4] }}
                    transition={{
                        duration: 0.6,
                        repeat: Infinity,
                        delay: i * 0.15,
                        ease: "easeInOut"
                    }}
                />
            ))}
        </div>
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

const AssistantMessage: React.FC<{ content: string; isStreaming?: boolean; sources?: ChatSources }> = ({ content, isStreaming, sources }) => {
    const [copied, setCopied] = useState(false);

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
                    {sources && sources.sourceIds.length > 0 && (
                        <span className="flex items-center gap-1.5 text-[13px] text-text-tertiary">
                            <FileText size={13} />
                            {sources.sourceIds.length} source{sources.sourceIds.length > 1 ? 's' : ''}
                        </span>
                    )}
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
}) => {
    const [chatState, setChatState] = useState<ChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);
    const streamBuffer = useStreamBuffer();
    const activeStreamRef = useRef<StreamHandle | null>(null);

    const pendingQuestionRef = useRef<string | null>(null);
    const chatStateRef = useRef<ChatState>('idle');

    useEffect(() => () => activeStreamRef.current?.abort(), []);

    useEffect(() => {
        chatStateRef.current = chatState;
    }, [chatState]);

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Submit initial query when overlay opens
    useEffect(() => {
        if (isOpen && initialQuery?.text) {
            // Small delay so overlay is visible before question fires
            const t = setTimeout(() => submitQuestion(initialQuery.text), 100);
            return () => clearTimeout(t);
        }
    }, [isOpen, initialQuery?.id]); // ← id changes every time, even same question text

    // Reset state when overlay closes
    useEffect(() => {
        if (!isOpen) {
            setChatState('idle');
            setErrorMessage(null);
            activeStreamRef.current?.abort();
        }
    }, [isOpen]);

    // ESC key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                handleClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    // Click outside handler
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            handleClose();
        }
    }, []);

    const handleClose = useCallback(() => {
        onClose();
    }, [onClose]);

    // Build context string for LLM
    // const buildContextString = useCallback((): string => {
    //     const parts: string[] = [];

    //     parts.push(`MEETING: ${meetingContext.title}`);

    //     if (meetingContext.summary) {
    //         parts.push(`\nSUMMARY:\n${meetingContext.summary}`);
    //     }

    //     if (meetingContext.keyPoints?.length) {
    //         parts.push(`\nKEY POINTS:\n${meetingContext.keyPoints.map(p => `- ${p}`).join('\n')}`);
    //     }

    //     if (meetingContext.actionItems?.length) {
    //         parts.push(`\nACTION ITEMS:\n${meetingContext.actionItems.map(a => `- ${a}`).join('\n')}`);
    //     }

    //     if (meetingContext.transcript?.length) {
    //         const recentTranscript = meetingContext.transcript.slice(-20);
    //         const transcriptText = recentTranscript
    //             .map(t => `[${t.speaker === 'user' ? 'Me' : 'Them'}]: ${t.text}`)
    //             .join('\n');
    //         parts.push(`\nRECENT TRANSCRIPT:\n${transcriptText}`);
    //     }

    //     return parts.join('\n');
    // }, [meetingContext]);


    // Submit question using RAG streaming
    // const submitQuestion = useCallback(async (question: string) => {
    //     if (!question.trim()) return;
    //     if (chatStateRef.current === 'waiting_for_llm' || chatStateRef.current === 'streaming_response') {
    //         pendingQuestionRef.current = question; // store it, don't drop it
    //         return;
    //     }

    //     const userMessage: Message = {
    //         id: `user-${Date.now()}`,
    //         role: 'user',
    //         content: question
    //     };
    //     onMessagesChange((prev) => [...prev, userMessage]);
    //     setChatState('waiting_for_llm');
    //     setErrorMessage(null);

    //     const assistantMessageId = `assistant-${Date.now()}`;

    //     try {
    //         // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
    //         await new Promise(resolve => setTimeout(resolve, 200));

    //         // Create assistant message placeholder
    //         onMessagesChange(prev => [...prev, {
    //             id: assistantMessageId,
    //             role: 'assistant',
    //             content: '',
    //             isStreaming: true
    //         }]);

    //         // Set up RAG streaming listeners (RAF-batched to avoid per-token re-renders)
    //         streamBuffer.reset();
    //         const tokenCleanup = window.electronAPI?.onRAGStreamChunk((data: { chunk: string }) => {
    //             setChatState('streaming_response');
    //             streamBuffer.appendToken(data.chunk, (content) => {
    //                 onMessagesChange(prev => prev.map(msg =>
    //                     msg.id === assistantMessageId
    //                         ? { ...msg, content }
    //                         : msg
    //                 ));
    //             });
    //         });

    //         const doneCleanup = window.electronAPI?.onRAGStreamComplete(() => {
    //             // Final commit — flush any remaining buffered content
    //             const finalContent = streamBuffer.getBufferedContent();
    //             onMessagesChange(prev => prev.map(msg =>
    //                 msg.id === assistantMessageId
    //                     ? { ...msg, content: finalContent, isStreaming: false }
    //                     : msg
    //             ));
    //             setChatState('idle');
    //             if (pendingQuestionRef.current) {
    //                 const next = pendingQuestionRef.current;
    //                 pendingQuestionRef.current = null;
    //                 setTimeout(() => submitQuestion(next), 50);
    //             }
    //             streamBuffer.reset();
    //             tokenCleanup?.();
    //             doneCleanup?.();
    //             errorCleanup?.();
    //         });

    //         const errorCleanup = window.electronAPI?.onRAGStreamError((data: { error: string }) => {
    //             console.error('[MeetingChat] RAG stream error:', data.error);
    //             onMessagesChange(prev => prev.filter(msg => msg.id !== assistantMessageId));
    //             setErrorMessage("Couldn't get a response. Please try again.");
    //             setChatState('error');
    //             if (pendingQuestionRef.current) {
    //                 const next = pendingQuestionRef.current;
    //                 pendingQuestionRef.current = null;
    //                 setTimeout(() => submitQuestion(next), 50);
    //             }
    //             streamBuffer.reset();
    //             tokenCleanup?.();
    //             doneCleanup?.();
    //             errorCleanup?.();
    //         });

    //         // Get meeting ID from context for RAG queries
    //         const meetingId = meetingContext.id;

    //         if (meetingId) {
    //             // Use RAG-powered meeting query
    //             const result = await window.electronAPI?.ragQueryMeeting(meetingId, question);

    //             // If RAG not available (or failed), fall back to context-window chat
    //             if (result?.fallback) {
    //                 console.log("[MeetingChat] RAG unavailable, using context window fallback");
    //                 // Cleanup RAG listeners since we won't use them
    //                 tokenCleanup?.();
    //                 doneCleanup?.();
    //                 errorCleanup?.();

    //                 // FALLBACK LOGIC
    //                 const contextString = buildContextString();
    //                 const systemPrompt = `You are recalling a specific meeting. Answer questions ONLY about this meeting. Be concise (2-4 sentences). Sound natural, like a human recalling. If information is not present, say so briefly. Never guess.

    //                 ${contextString}`;

    //                 streamBuffer.reset();
    //                 const oldTokenCleanup = window.electronAPI?.onGeminiStreamToken((token: string) => {
    //                     setChatState('streaming_response');
    //                     streamBuffer.appendToken(token, (content) => {
    //                         onMessagesChange(prev => prev.map(msg =>
    //                             msg.id === assistantMessageId
    //                                 ? { ...msg, content }
    //                                 : msg
    //                         ));
    //                     });
    //                 });

    //                 const oldDoneCleanup = window.electronAPI?.onGeminiStreamDone(() => {
    //                     const finalContent = streamBuffer.getBufferedContent();
    //                     onMessagesChange(prev => prev.map(msg =>
    //                         msg.id === assistantMessageId
    //                             ? { ...msg, content: finalContent, isStreaming: false }
    //                             : msg
    //                     ));
    //                     setChatState('idle');
    //                     streamBuffer.reset();
    //                     oldTokenCleanup?.();
    //                     oldDoneCleanup?.();
    //                     oldErrorCleanup?.();
    //                 });

    //                 const oldErrorCleanup = window.electronAPI?.onGeminiStreamError((error: string) => {
    //                     console.error('[MeetingChat] Gemini stream error (fallback):', error);
    //                     onMessagesChange(prev => prev.filter(msg => msg.id !== assistantMessageId));
    //                     setErrorMessage("Couldn't get a response. Please check your settings.");
    //                     setChatState('error');
    //                     streamBuffer.reset();
    //                     oldTokenCleanup?.();
    //                     oldDoneCleanup?.();
    //                     oldErrorCleanup?.();
    //                 });

    //                 await window.electronAPI?.streamGeminiChat(
    //                     question,
    //                     undefined,
    //                     systemPrompt,
    //                     { skipSystemPrompt: true }
    //                 );
    //             }
    //         } else {
    //             // No meeting ID, standard fallback
    //             const contextString = buildContextString();
    //             const systemPrompt = `You are recalling a specific meeting. Answer questions ONLY about this meeting. Be concise (2-4 sentences). Sound natural, like a human recalling. If information is not present, say so briefly. Never guess.

    //             ${contextString}`;

    //             // Switch to Gemini streaming (RAF-batched)
    //             streamBuffer.reset();
    //             const oldTokenCleanup = window.electronAPI?.onGeminiStreamToken((token: string) => {
    //                 setChatState('streaming_response');
    //                 streamBuffer.appendToken(token, (content) => {
    //                     onMessagesChange(prev => prev.map(msg =>
    //                         msg.id === assistantMessageId
    //                             ? { ...msg, content }
    //                             : msg
    //                     ));
    //                 });
    //             });

    //             const oldDoneCleanup = window.electronAPI?.onGeminiStreamDone(() => {
    //                 const finalContent = streamBuffer.getBufferedContent();
    //                 onMessagesChange(prev => prev.map(msg =>
    //                     msg.id === assistantMessageId
    //                         ? { ...msg, content: finalContent, isStreaming: false }
    //                         : msg
    //                 ));
    //                 setChatState('idle');
    //                 streamBuffer.reset();
    //                 oldTokenCleanup?.();
    //                 oldDoneCleanup?.();
    //                 oldErrorCleanup?.();
    //             });

    //             const oldErrorCleanup = window.electronAPI?.onGeminiStreamError((error: string) => {
    //                 console.error('[MeetingChat] Gemini stream error:', error);
    //                 onMessagesChange(prev => prev.filter(msg => msg.id !== assistantMessageId));
    //                 setErrorMessage("Couldn't get a response. Please check your settings.");
    //                 setChatState('error');
    //                 streamBuffer.reset();
    //                 oldTokenCleanup?.();
    //                 oldDoneCleanup?.();
    //                 oldErrorCleanup?.();
    //             });

    //             await window.electronAPI?.streamGeminiChat(
    //                 question,
    //                 undefined,
    //                 systemPrompt,
    //                 { skipSystemPrompt: true }
    //             );
    //         }

    //     } catch (error) {
    //         console.error('[MeetingChat] Error:', error);
    //         onMessagesChange(prev => prev.filter(msg => msg.id !== assistantMessageId));
    //         setErrorMessage("Something went wrong. Please try again.");
    //         setChatState('error');
    //     }
    // }, [chatState, buildContextString, meetingContext]);

    // Submit question using RAG streaming
    const submitQuestion = useCallback(async (question: string) => {
        if (!question.trim()) return;
        if (chatStateRef.current === 'waiting_for_llm' || chatStateRef.current === 'streaming_response') {
            pendingQuestionRef.current = question; // store it, don't drop it
            return;
        }

        if (!meetingContext.id) {
            setErrorMessage("This meeting hasn't been processed for chat yet.");
            setChatState('error');
            return;
        }

        const userMessage: Message = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: question
        };
        onMessagesChange((prev) => [...prev, userMessage]);
        setChatState('waiting_for_llm');
        setErrorMessage(null);

        const assistantMessageId = `assistant-${Date.now()}`;

        // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
        await new Promise(resolve => setTimeout(resolve, 200));

        onMessagesChange(prev => [...prev, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            isStreaming: true
        }]);

        streamBuffer.reset();
        let sources: ChatSources | undefined;

        activeStreamRef.current = chatApi.queryMeeting(meetingContext.id, question, {
            onSources: (s) => { sources = s; },
            onToken: (chunk) => {
                setChatState('streaming_response');
                streamBuffer.appendToken(chunk, (content) => {
                    onMessagesChange(prev => prev.map(msg =>
                        msg.id === assistantMessageId ? { ...msg, content } : msg
                    ));
                });
            },
            // Backend decided this was a factual/RAG query and returned the
            // complete answer in one frame — render it directly, skip the
            // token buffer entirely (no `token` frames will follow).
            onRagAnswer: (ragAnswer) => {
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: ragAnswer.answer, isStreaming: false, sources }
                        : msg
                ));
                setChatState('idle');
            },
            onDone: () => {
                const finalContent = streamBuffer.getBufferedContent();
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId && msg.isStreaming
                        ? { ...msg, content: finalContent, isStreaming: false, sources }
                        : msg
                ));
                setChatState('idle');
                streamBuffer.reset();
                activeStreamRef.current = null;
                if (pendingQuestionRef.current) {
                    const next = pendingQuestionRef.current;
                    pendingQuestionRef.current = null;
                    setTimeout(() => submitQuestion(next), 50);
                }
            },
            onError: (error) => {
                console.error('[MeetingChat] Stream error:', error);
                onMessagesChange(prev => prev.filter(msg => msg.id !== assistantMessageId));
                setErrorMessage("Couldn't get a response. Please try again.");
                setChatState('error');
                streamBuffer.reset();
                activeStreamRef.current = null;
                if (pendingQuestionRef.current) {
                    const next = pendingQuestionRef.current;
                    pendingQuestionRef.current = null;
                    setTimeout(() => submitQuestion(next), 50);
                }
            },
        });
    }, [chatState, meetingContext.id]);

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
                                <img src={nativelyIcon} className="w-3.5 h-3.5 force-black-icon opacity-50" alt="logo" />
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
                                    : <AssistantMessage key={msg.id} content={msg.content} isStreaming={msg.isStreaming} sources={msg.sources} />
                            ))}

                            {chatState === 'waiting_for_llm' && <TypingIndicator />}

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
