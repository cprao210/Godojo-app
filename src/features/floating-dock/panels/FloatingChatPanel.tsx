import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, Copy, Check, RotateCcw, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { guardSession } from '@/lib/firebase';
import remarkGfm from 'remark-gfm';
import { useStreamBuffer } from '@/hooks';
import { chatApi, statusLabel } from '@/api';
import { chatMarkdownComponents } from '@/features/chat';
import { ChatHistoryTurn, FloatingChatPanelProps, LiveTranscriptSegment, Message, StreamHandle } from '@/types';

interface FilmRollTranscriptProps {
    text: string;
    speakerLabel: string;
    speakerColor?: string;
    dotColor?: string;
    liveColor?: string;
}

// ── Film-roll transcript — text streams right-to-left like a ticker ──────────
const FilmRollTranscript: React.FC<FilmRollTranscriptProps> = ({ text, speakerLabel, speakerColor = 'text-white/55', dotColor = 'bg-blue-400', liveColor = '#f87171' }) => {
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to end whenever text grows
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollLeft = el.scrollWidth;
    }, [text]);

    return (
        <div className="flex items-center gap-2 w-full min-w-0">
            {/* Live dot */}
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor} animate-pulse shrink-0`} />

            {/* Speaker label — fixed, never scrolls */}
            <span className={`text-[11px] font-medium shrink-0 ${speakerColor}`}>
                {speakerLabel === 'Them' ? "Client" : speakerLabel}:
            </span>

            {/* Scrolling film strip */}
            <div
                ref={scrollRef}
                className="flex-1 -mt-[4px] min-w-0 overflow-hidden"
                style={{
                    maskImage: 'linear-gradient(to right, transparent 0%, black 8%, black 100%)',
                    WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 8%, black 100%)',
                }}
            >
                <motion.p
                    className="text-[11px] text-white/40 leading-relaxed whitespace-nowrap"
                    animate={{ x: 0 }}
                    style={{ display: 'inline-block' }}
                >
                    {text}
                </motion.p>
            </div>

            {/* LIVE badge */}
            <span
                className="text-[10px] font-bold shrink-0 ml-1"
                style={{ color: liveColor }}
            >
                LIVE
            </span>
        </div>
    );
};

const TypingDots: React.FC<{ label?: string }> = ({ label }) => (
    <div className="flex items-center gap-2 py-2">
        <div className="flex items-center gap-1">
            {[0, 1, 2].map(i => (
                <motion.div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: 'rgba(255,255,255,0.3)' }}
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }}
                />
            ))}
        </div>
        {label && (
            <motion.span
                key={label}
                initial={{ opacity: 0, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
                className="text-[12px]"
                style={{ color: 'rgba(255,255,255,0.4)' }}
            >
                {label}
            </motion.span>
        )}
    </div>
);

const MessageBubble: React.FC<{ msg: Message }> = ({ msg }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(msg.text).catch(() => { });
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (msg.role === 'user') {
        return (
            <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex justify-end mb-4"
            >
                <div
                    className="px-4 py-2.5 rounded-2xl rounded-tr-sm text-[13px] leading-relaxed text-white max-w-[70%]"
                    style={{ background: 'rgba(59,130,246,0.25)', border: '1px solid rgba(59,130,246,0.3)' }}
                >
                    {msg.text}
                </div>
            </motion.div>
        );
    }

    if (msg.role === 'client') {
        return (
            <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex justify-start mb-4"
            >
                <div
                    className="px-4 py-2.5 rounded-2xl rounded-tl-sm text-[13px] leading-relaxed max-w-[70%]"
                    style={{
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.07)',
                        color: 'rgba(255,255,255,0.55)',
                    }}
                >
                    {msg.text}
                </div>
            </motion.div>
        );
    }

    // System / AI response
    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex gap-2.5 mb-4 group"
        >
            <div
                className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
                style={{ background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(139,92,246,0.3)' }}
            >
                <Brain size={13} className="text-violet-400" />
            </div>
            <div className="flex-1 min-w-0">
                <div
                    className="px-4 py-3 rounded-2xl rounded-tl-sm text-[13px] leading-relaxed relative"
                    style={{
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.07)',
                        color: 'rgba(255,255,255,0.85)',
                    }}
                >
                    {msg.isStreaming && msg.text === '' ? (
                        <TypingDots label={msg.status} />
                    ) : (
                        <>
                            <div className="markdown-content">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
                                    {msg.text}
                                </ReactMarkdown>
                                {msg.ragAnswer && (
                                    <div className="mt-2 text-[10px] text-white/35 flex items-center gap-2">
                                        <span>{Math.round(msg.ragAnswer.confidence * 100)}% confidence</span>
                                        {msg.ragAnswer.sourceCount > 0 && (
                                            <span>· {msg.ragAnswer.sourceCount} source{msg.ragAnswer.sourceCount > 1 ? 's' : ''}</span>
                                        )}
                                    </div>
                                )}
                            </div>
                            {!msg.isStreaming && (
                                <button
                                    onClick={handleCopy}
                                    className="absolute top-2 right-2 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                                    style={{ background: 'rgba(255,255,255,0.06)' }}
                                >
                                    {copied
                                        ? <Check size={11} className="text-emerald-400" />
                                        : <Copy size={11} className="text-white/30" />
                                    }
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </motion.div>
    );
};

export const FloatingChatPanel: React.FC<FloatingChatPanelProps> = ({ transcriptRef, meetingId, rollingTranscriptUser, rollingTranscriptClient, isClientSpeaking, isUserSpeaking, isMeetingPaused, showTranscript, speakerNames, messages, onMessagesChange }) => {

    const setMessages = onMessagesChange;
    const [inputValue, setInputValue] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    // const [tavilySearchingFor, setTavilySearchingFor] = useState<string | null>(null);
    const streamBuffer = useStreamBuffer();
    const activeStreamRef = useRef<StreamHandle | null>(null);
    const pendingQuestionRef = useRef<string | null>(null);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Stream event listeners
    // useEffect(() => {
    //     const cleanups: (() => void)[] = [];

    //     // ── Gemini free-form chat stream (onGeminiStreamToken / onGeminiStreamDone) ──
    //     if (window.electronAPI?.onGeminiStreamToken) {
    //         cleanups.push(window.electronAPI.onGeminiStreamToken((token: string) => {
    //             setMessages(prev => {
    //                 const last = prev[prev.length - 1];
    //                 if (last?.isStreaming && last.role === 'system' && !last.intent) {
    //                     const updated = [...prev];
    //                     updated[prev.length - 1] = { ...last, text: last.text + token };
    //                     return updated;
    //                 }
    //                 return [...prev, { id: Date.now().toString(), role: 'system', text: token, isStreaming: true }];
    //             });
    //         }));
    //     }

    //     if (window.electronAPI?.onGeminiStreamDone) {
    //         cleanups.push(window.electronAPI.onGeminiStreamDone(() => {
    //             setIsProcessing(false);
    //             setMessages(prev => {
    //                 const last = prev[prev.length - 1];
    //                 if (last?.isStreaming && !last.intent) {
    //                     return [...prev.slice(0, -1), { ...last, isStreaming: false }];
    //                 }
    //                 return prev;
    //             });
    //         }));
    //     }

    //     if (window.electronAPI?.onGeminiStreamError) {
    //         cleanups.push(window.electronAPI.onGeminiStreamError((error: string) => {
    //             setIsProcessing(false);
    //             setMessages(prev => {
    //                 // Remove the empty streaming placeholder and add error
    //                 const last = prev[prev.length - 1];
    //                 if (last?.isStreaming) {
    //                     return [...prev.slice(0, -1), { id: Date.now().toString(), role: 'system', text: `❌ ${error}` }];
    //                 }
    //                 return [...prev, { id: Date.now().toString(), role: 'system', text: `❌ ${error}` }];
    //             });
    //         }));
    //     }

    //     // ── RAG stream (used when ragQueryLive handles the question) ──
    //     if (window.electronAPI?.onRAGStreamChunk) {
    //         cleanups.push(window.electronAPI.onRAGStreamChunk((data) => {
    //             setMessages(prev => {
    //                 const last = prev[prev.length - 1];
    //                 if (last?.isStreaming && last.role === 'system' && !last.intent) {
    //                     const updated = [...prev];
    //                     updated[prev.length - 1] = { ...last, text: last.text + data.chunk };
    //                     return updated;
    //                 }
    //                 return prev;
    //             });
    //         }));
    //     }

    //     if (window.electronAPI?.onRAGStreamComplete) {
    //         cleanups.push(window.electronAPI.onRAGStreamComplete(() => {
    //             setIsProcessing(false);
    //             setMessages(prev => {
    //                 const last = prev[prev.length - 1];
    //                 if (last?.isStreaming && !last.intent) {
    //                     return [...prev.slice(0, -1), { ...last, isStreaming: false }];
    //                 }
    //                 return prev;
    //             });
    //         }));
    //     }

    //     if (window.electronAPI?.onTavilySearching) {
    //         cleanups.push(window.electronAPI.onTavilySearching((data) => {
    //             setTavilySearchingFor(data.entity);
    //         }));
    //     }

    //     if (window.electronAPI?.onTavilySearchDone) {
    //         cleanups.push(window.electronAPI.onTavilySearchDone(() => {
    //             setTavilySearchingFor(null);
    //         }));
    //     }

    //     return () => cleanups.forEach(fn => fn());

    // }, []);

    // Abort any in-flight stream on unmount (panel switch, meeting end)
    useEffect(() => {
        return () => activeStreamRef.current?.abort();
    }, []);

    // Auto-resize textarea
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 96)}px`; // max ~4 lines
    }, [inputValue]);

    // const addUserMessage = (text: string) => {
    //     setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', text }]);
    //     setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: 'system', text: '', isStreaming: true }]);
    //     setIsProcessing(true);
    // };

    // const handleSend = async () => {
    //     const text = inputValue.trim();
    //     if (!text || isProcessing) return;
    //     setInputValue('');
    //     addUserMessage(text);
    //     try {

    //         const sessionActive = await guardSession();
    //         if (!sessionActive) {
    //             setIsProcessing(false);
    //             return;
    //         }

    //         // Try RAG first (context-aware live query)
    //         const ragResult = await window.electronAPI?.ragQueryLive?.(text);
    //         if (ragResult?.success) {
    //             // Response streams via onRAGStreamChunk / onRAGStreamComplete
    //             return;
    //         }
    //         // Fallback to direct Gemini chat
    //         await window.electronAPI?.streamGeminiChat(text, undefined, undefined, undefined);
    //     } catch (err: any) {
    //         setIsProcessing(false);
    //         setMessages(prev => {
    //             const last = prev[prev.length - 1];
    //             if (last?.isStreaming) {
    //                 return [...prev.slice(0, -1), { id: Date.now().toString(), role: 'system', text: `❌ Error: ${err?.message}` }];
    //             }
    //             return [...prev, { id: Date.now().toString(), role: 'system', text: `❌ Error: ${err?.message}` }];
    //         });
    //     }
    // };

    // Build the {role, content} history the endpoint expects from our local
    // Message[] shape. 'client' rows are rolling-transcript display only —
    // not chat turns — so they're excluded.
    const buildHistory = (msgs: Message[]): ChatHistoryTurn[] =>
        msgs
            .filter(m => (m.role === 'user' || m.role === 'system') && m.text)
            .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));

    const buildTranscript = (): LiveTranscriptSegment[] =>
        (transcriptRef?.current ?? []).map((t, i) => ({
            text: t.text,
            speaker: t.speaker,
            timestamp: t.timestamp,
            meeting_id: '',
            chunk_index: i,
        }));

    const submitQuestion = async (question: string) => {
        if (!question.trim()) return;
        if (isProcessing) {
            pendingQuestionRef.current = question; // queue, don't drop
            return;
        }
        if (!meetingId) {
            setErrorMessage("Live chat isn't ready yet — the meeting session hasn't started.");
            return;
        }

        const sessionActive = await guardSession();
        if (!sessionActive) return;

        setErrorMessage(null);
        setIsProcessing(true);
        const userMessage: Message = { id: `user-${Date.now()}`, role: 'user', text: question };
        const assistantId = `assistant-${Date.now()}`;
        setMessages(prev => [...prev, userMessage, { id: assistantId, role: 'system', text: '', isStreaming: true }]);

        const historyBeforeThisTurn = buildHistory(messages);

        // Local to THIS call — not shared with any other question, so there's
        // no way for a concurrent/overlapping/duplicate call, or leftover
        // state from a prior turn, to reset or overwrite this turn's text.
        let localBuffer = '';
        let rafId: number | null = null;
        const flush = () => {
            rafId = null;
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, text: localBuffer } : m));
        };

        activeStreamRef.current = chatApi.queryLive(
            meetingId,
            question,
            historyBeforeThisTurn,
            buildTranscript(),
            {
                onStatus: (status) => {
                    const label = statusLabel(status);
                    setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, status: label } : m));
                },
                onToken: (chunk) => {
                    localBuffer += chunk;
                    if (rafId === null) rafId = requestAnimationFrame(flush);
                    // First token has arrived — clear the status label so the
                    // dots/status row is replaced by real content, not shown
                    // alongside it.
                    setMessages(prev => prev.map(m => (m.id === assistantId && m.status) ? { ...m, status: undefined } : m));
                },
                onRagAnswer: (rag) => {
                    // Structured answer arrives whole — render as a complete
                    // bubble immediately, don't wait for `done` to stop the
                    // streaming cursor since no `token` frames are coming.
                    setMessages(prev => prev.map(m =>
                        m.id === assistantId
                            ? {
                                ...m,
                                text: rag.answer,
                                isStreaming: false,
                                status: undefined,
                                ragAnswer: { confidence: rag.confidence ?? 0, sourceCount: rag.sources?.length ?? 0 },
                            }
                            : m
                    ));
                },
                onDone: () => {
                    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
                    setMessages(prev => prev.map(m =>
                        // Don't clobber a rag_answer bubble that already set its
                        // final text — only finalize from the token buffer if
                        // this turn actually streamed tokens.
                        m.id === assistantId && !m.ragAnswer
                            ? { ...m, text: localBuffer, isStreaming: false }
                            : m
                    ));
                    setIsProcessing(false);
                    activeStreamRef.current = null;
                    if (pendingQuestionRef.current) {
                        const next = pendingQuestionRef.current;
                        pendingQuestionRef.current = null;
                        setTimeout(() => submitQuestion(next), 50);
                    }
                },
                onError: (error) => {
                    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
                    console.error('[FloatingChatPanel] live chat stream error:', error);
                    setMessages(prev => prev.filter(m => m.id !== assistantId));
                    setErrorMessage(error);
                    setIsProcessing(false);
                    activeStreamRef.current = null;
                },
            },
        );
    };

    const handleSend = () => {
        const text = inputValue.trim();
        if (!text || isProcessing) return;
        setInputValue('');
        submitQuestion(text);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div
            className="rounded-2xl overflow-hidden flex flex-col"
            style={{
                width: 420,
                height: 550,
                background: 'rgba(14, 18, 30, 0.93)',
                backdropFilter: 'blur(28px) saturate(180%)',
                WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.08)',
            }}
        >

            {/* Header */}
            <div
                className="flex items-center justify-between px-5 py-4 shrink-0"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
            >
                <div className="flex items-center gap-3">
                    <div
                        className="w-9 h-9 rounded-xl flex items-center justify-center"
                        style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.25)' }}
                    >
                        <Brain size={17} className="text-violet-400" strokeWidth={1.8} />
                    </div>
                    <div>
                        <div className="text-[13px] font-bold text-white tracking-wide uppercase">GoDojo Chat Assistant</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse block" />
                            <span className="text-[11px] text-emerald-400 font-medium">{isMeetingPaused ? "Paused" : "Listening and Analyzing..."}</span>
                        </div>
                    </div>
                </div>
                {/* Refresh / Clear chat button */}
                <button
                    onClick={() => setMessages([])}
                    disabled={messages.length === 0}
                    className="flex items-center gap-2 p-2 rounded-xl text-[12px] font-bold tracking-wide uppercase transition-all active:scale-95"
                    title="Clear chat history"
                    style={{
                        background: 'rgba(139,92,246,0.15)',
                        border: '1px solid rgba(139,92,246,0.3)',
                        color: '#8b5cf6',
                        opacity: messages.length === 0 ? 0.4 : 1,
                    }}
                >
                    <RotateCcw size={12} />
                </button>
            </div>

            {/* Rolling transcript strip — two rows, one per speaker, never mixed */}
            {showTranscript && (rollingTranscriptClient || rollingTranscriptUser || isClientSpeaking || isUserSpeaking) && (
                <div
                    className="px-5 py-2 shrink-0 flex flex-col gap-1"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}
                >

                    <FilmRollTranscript
                        text={rollingTranscriptClient}
                        speakerLabel={speakerNames.client}
                        dotColor="bg-red-400"
                        liveColor="#f87171"
                    />
                    {/* "Them" row */}
                    {/* {(rollingTranscriptClient || isClientSpeaking) && (
                        <div className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse mt-1 shrink-0" />
                            <p className="text-[11px] text-white/40 leading-relaxed line-clamp-1 flex-1 min-w-0">
                                <span className="text-white/55 font-medium mr-1">{speakerNames.client === "Them" ? "Client" : speakerNames.client}:</span>
                                <AnimatedTranscriptText text={rollingTranscriptClient} />
                                {isClientSpeaking && <span className="ml-1 text-white/25 animate-pulse">...</span>}
                            </p>
                            <span className="text-[10px] text-red-400 font-bold shrink-0 ml-auto">LIVE</span>
                        </div>
                    )} */}
                    {/* "Me" row */}
                    {/* {(rollingTranscriptUser || isUserSpeaking) && (
                        <div className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse mt-1 shrink-0" />
                            <p className="text-[11px] text-white/40 leading-relaxed line-clamp-1 flex-1 min-w-0">
                                <span className="text-white/55 font-medium mr-1">{speakerNames.user === "Me" ? "User" : speakerNames.user}:</span>
                                {rollingTranscriptUser}
                                {isUserSpeaking && <span className="ml-1 text-white/25 animate-pulse">...</span>}
                            </p>
                        </div>
                    )} */}
                </div>
            )}

            {/* Messages */}
            <div
                className="flex-1 overflow-y-auto px-5 py-4 no-drag"
                style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.08) transparent' }}
            >
                {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3 py-8">
                        <div
                            className="w-12 h-12 rounded-2xl flex items-center justify-center"
                            style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.2)' }}
                        >
                            <Brain size={22} className="text-violet-400/60" />
                        </div>
                        <p className="text-[12px] text-white/25 text-center max-w-[200px] leading-relaxed">
                            Ask anything about the live call
                        </p>
                    </div>
                ) : (
                    <AnimatePresence initial={false}>
                        {messages.map(msg => (
                            <MessageBubble key={msg.id} msg={msg} />
                        ))}
                    </AnimatePresence>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* {tavilySearchingFor && (
                <div
                    className="px-5 py-2 shrink-0 flex items-center gap-2"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(139,92,246,0.05)' }}
                >
                    <Search size={11} className="text-violet-400 animate-pulse shrink-0" />
                    <span className="text-[11px] text-violet-300/70">
                        Searching company information for{' '}
                        <span className="font-semibold text-violet-300">{tavilySearchingFor}</span>…
                    </span>
                </div>
            )} */}
            {errorMessage && (
                <div
                    className="px-5 py-2 shrink-0 text-[12px] text-[#FF6B6B]"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
                >
                    {errorMessage}
                </div>
            )}

            {/* Input Area */}
            <div
                className="px-3 pb-3 pt-2 shrink-0"
                style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
            >
                <div
                    className="flex items-end gap-2 rounded-2xl px-3 py-2 transition-all"
                    style={{
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.08)',
                    }}
                >
                    <textarea
                        ref={inputRef}
                        value={inputValue}
                        onChange={e => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask anything about the live call..."
                        rows={1}
                        className="flex-1 bg-transparent resize-none outline-none text-[13px] leading-relaxed placeholder:text-white/20 py-1.5"
                        style={{
                            color: 'rgba(255,255,255,0.85)',
                            maxHeight: 96,
                            overflowY: 'auto',
                            scrollbarWidth: 'none',
                        }}
                    />
                    <motion.button
                        onClick={handleSend}
                        whileTap={{ scale: 0.88 }}
                        disabled={!inputValue.trim() || isProcessing}
                        className="shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all mb-0.5"
                        style={{
                            background: inputValue.trim() && !isProcessing
                                ? 'rgba(139,92,246,0.85)'
                                : 'rgba(255,255,255,0.06)',
                            opacity: isProcessing ? 0.5 : 1,
                        }}
                    >
                        {isProcessing ? (
                            <motion.div
                                className="w-3.5 h-3.5 rounded-full border-2 border-t-transparent"
                                style={{ borderColor: 'rgba(255,255,255,0.4)', borderTopColor: 'transparent' }}
                                animate={{ rotate: 360 }}
                                transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                            />
                        ) : (
                            <Send
                                size={14}
                                style={{ color: inputValue.trim() ? '#fff' : 'rgba(255,255,255,0.2)' }}
                            />
                        )}
                    </motion.button>
                </div>
                <p className="text-[10px] text-white/15 text-center mt-1.5 leading-none">
                    Enter to send · Shift+Enter for new line
                </p>
            </div>
        </div>
    );
};