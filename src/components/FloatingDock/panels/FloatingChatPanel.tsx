import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Brain, AlertCircle, Search, ShieldAlert, RefreshCw,
    Lightbulb, ArrowRight, Zap, Copy, Check, RotateCcw
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Message {
    id: string;
    role: 'user' | 'system' | 'interviewer';
    text: string;
    isStreaming?: boolean;
    intent?: string;
}

interface FloatingChatPanelProps {
    transcriptRef: React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>;
    rollingTranscript: string;
    isInterviewerSpeaking: boolean;
    showTranscript: boolean;
    currentModel: string;
    onSelectModel: (m: string) => void;
    speakerNames: { user: string; interviewer: string };
    // Lifted state — preserves history across panel switches
    messages: Message[];
    onMessagesChange: (updater: Message[] | ((prev: Message[]) => Message[])) => void;
}

const CHIP_ACTIONS = [
    { id: 'missing', label: 'What am I missing?', icon: AlertCircle, intent: 'what_am_i_missing' },
    { id: 'discovery', label: 'Discovery', icon: Search, intent: 'discovery' },
    { id: 'objection', label: 'Objection', icon: ShieldAlert, intent: 'objection_handler' },
    { id: 'recap', label: 'Recap', icon: RefreshCw, intent: 'recap' },
    { id: 'brainstorm', label: 'Brainstorm', icon: Lightbulb, intent: 'brainstorm' },
];

const TypingDots: React.FC = () => (
    <div className="flex items-center gap-1 py-2">
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

    if (msg.role === 'interviewer') {
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
                        <TypingDots />
                    ) : (
                        <>
                            <div className="markdown-content prose prose-invert prose-sm max-w-none">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {msg.text}
                                </ReactMarkdown>
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

export const FloatingChatPanel: React.FC<FloatingChatPanelProps> = ({
    transcriptRef,
    rollingTranscript,
    isInterviewerSpeaking,
    showTranscript,
    speakerNames,
    messages,
    onMessagesChange,
}) => {
    const setMessages = onMessagesChange;
    const [inputValue, setInputValue] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [isManualRecording, setIsManualRecording] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const isRecordingRef = useRef(false);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Stream event listeners
    useEffect(() => {
        const cleanups: (() => void)[] = [];

        // ── Gemini free-form chat stream (onGeminiStreamToken / onGeminiStreamDone) ──
        if (window.electronAPI?.onGeminiStreamToken) {
            cleanups.push(window.electronAPI.onGeminiStreamToken((token: string) => {
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.role === 'system' && !last.intent) {
                        const updated = [...prev];
                        updated[prev.length - 1] = { ...last, text: last.text + token };
                        return updated;
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: token, isStreaming: true }];
                });
            }));
        }

        if (window.electronAPI?.onGeminiStreamDone) {
            cleanups.push(window.electronAPI.onGeminiStreamDone(() => {
                setIsProcessing(false);
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && !last.intent) {
                        return [...prev.slice(0, -1), { ...last, isStreaming: false }];
                    }
                    return prev;
                });
            }));
        }

        if (window.electronAPI?.onGeminiStreamError) {
            cleanups.push(window.electronAPI.onGeminiStreamError((error: string) => {
                setIsProcessing(false);
                setMessages(prev => {
                    // Remove the empty streaming placeholder and add error
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming) {
                        return [...prev.slice(0, -1), { id: Date.now().toString(), role: 'system', text: `❌ ${error}` }];
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: `❌ ${error}` }];
                });
            }));
        }

        // ── RAG stream (used when ragQueryLive handles the question) ──
        if (window.electronAPI?.onRAGStreamChunk) {
            cleanups.push(window.electronAPI.onRAGStreamChunk((data) => {
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.role === 'system' && !last.intent) {
                        const updated = [...prev];
                        updated[prev.length - 1] = { ...last, text: last.text + data.chunk };
                        return updated;
                    }
                    return prev;
                });
            }));
        }

        if (window.electronAPI?.onRAGStreamComplete) {
            cleanups.push(window.electronAPI.onRAGStreamComplete(() => {
                setIsProcessing(false);
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && !last.intent) {
                        return [...prev.slice(0, -1), { ...last, isStreaming: false }];
                    }
                    return prev;
                });
            }));
        }

        // ── Intelligence chip events (correct API names from electron.d.ts) ──

        // What Am I Missing
        if (window.electronAPI?.onWhatAmIMissingToken) {
            cleanups.push(window.electronAPI.onWhatAmIMissingToken((data) => {
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.intent === 'what_am_i_missing') {
                        const updated = [...prev];
                        updated[prev.length - 1] = { ...last, text: last.text + data.token };
                        return updated;
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: data.token, isStreaming: true, intent: 'what_am_i_missing' }];
                });
            }));
        }
        if (window.electronAPI?.onWhatAmIMissing) {
            cleanups.push(window.electronAPI.onWhatAmIMissing((data) => {
                setIsProcessing(false);
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.intent === 'what_am_i_missing') {
                        return [...prev.slice(0, -1), { ...last, text: data.answer, isStreaming: false }];
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: data.answer, intent: 'what_am_i_missing' }];
                });
            }));
        }

        // Discovery
        if (window.electronAPI?.onDiscoveryToken) {
            cleanups.push(window.electronAPI.onDiscoveryToken((data) => {
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.intent === 'discovery') {
                        const updated = [...prev];
                        updated[prev.length - 1] = { ...last, text: last.text + data.token };
                        return updated;
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: data.token, isStreaming: true, intent: 'discovery' }];
                });
            }));
        }
        if (window.electronAPI?.onDiscovery) {
            cleanups.push(window.electronAPI.onDiscovery((data) => {
                setIsProcessing(false);
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.intent === 'discovery') {
                        return [...prev.slice(0, -1), { ...last, text: data.answer, isStreaming: false }];
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: data.answer, intent: 'discovery' }];
                });
            }));
        }

        // Objection Handler
        if (window.electronAPI?.onObjectionHandlerToken) {
            cleanups.push(window.electronAPI.onObjectionHandlerToken((data) => {
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.intent === 'objection_handler') {
                        const updated = [...prev];
                        updated[prev.length - 1] = { ...last, text: last.text + data.token };
                        return updated;
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: data.token, isStreaming: true, intent: 'objection_handler' }];
                });
            }));
        }
        if (window.electronAPI?.onObjectionHandler) {
            cleanups.push(window.electronAPI.onObjectionHandler((data) => {
                setIsProcessing(false);
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.intent === 'objection_handler') {
                        return [...prev.slice(0, -1), { ...last, text: data.answer, isStreaming: false }];
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: data.answer, intent: 'objection_handler' }];
                });
            }));
        }

        // Recap  (token: onIntelligenceRecapToken, final: onIntelligenceRecap)
        if (window.electronAPI?.onIntelligenceRecapToken) {
            cleanups.push(window.electronAPI.onIntelligenceRecapToken((data) => {
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.intent === 'recap') {
                        const updated = [...prev];
                        updated[prev.length - 1] = { ...last, text: last.text + data.token };
                        return updated;
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: data.token, isStreaming: true, intent: 'recap' }];
                });
            }));
        }
        if (window.electronAPI?.onIntelligenceRecap) {
            cleanups.push(window.electronAPI.onIntelligenceRecap((data) => {
                setIsProcessing(false);
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.isStreaming && last.intent === 'recap') {
                        return [...prev.slice(0, -1), { ...last, text: data.summary, isStreaming: false }];
                    }
                    return [...prev, { id: Date.now().toString(), role: 'system', text: data.summary, intent: 'recap' }];
                });
            }));
        }

        return () => cleanups.forEach(fn => fn());
    }, []);

    const addUserMessage = (text: string) => {
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', text }]);
        setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: 'system', text: '', isStreaming: true }]);
        setIsProcessing(true);
    };

    const handleSend = async () => {
        const text = inputValue.trim();
        if (!text || isProcessing) return;
        setInputValue('');
        addUserMessage(text);
        try {
            // Try RAG first (context-aware live query)
            const ragResult = await window.electronAPI?.ragQueryLive?.(text);
            if (ragResult?.success) {
                // Response streams via onRAGStreamChunk / onRAGStreamComplete
                return;
            }
            // Fallback to direct Gemini chat
            await window.electronAPI?.streamGeminiChat(text, undefined, undefined, undefined);
        } catch (err) {
            setIsProcessing(false);
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.isStreaming) {
                    return [...prev.slice(0, -1), { id: Date.now().toString(), role: 'system', text: `❌ Error: ${err}` }];
                }
                return [...prev, { id: Date.now().toString(), role: 'system', text: `❌ Error: ${err}` }];
            });
        }
    };

    const handleChip = async (intent: string, label: string) => {
        if (isProcessing) return;
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', text: label }]);
        // Placeholder streaming bubble
        setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: 'system', text: '', isStreaming: true, intent }]);
        setIsProcessing(true);

        try {
            if (intent === 'what_am_i_missing') await window.electronAPI.generateWhatAmIMissing();
            else if (intent === 'discovery') await window.electronAPI.generateDiscovery();
            else if (intent === 'objection_handler') await window.electronAPI.generateObjectionHandler();
            else if (intent === 'recap') await window.electronAPI.generateRecap();
            else if (intent === 'brainstorm') await window.electronAPI.generateBrainstorm();
        } catch (err) {
            setIsProcessing(false);
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.isStreaming) {
                    return [...prev.slice(0, -1), { id: Date.now().toString(), role: 'system', text: `❌ Error: ${err}` }];
                }
                return [...prev, { id: Date.now().toString(), role: 'system', text: `❌ Error: ${err}` }];
            });
        }
    };

    const handleAnswerNow = async () => {
        if (isManualRecording) {
            isRecordingRef.current = false;
            setIsManualRecording(false);
            try {
                await window.electronAPI?.finalizeMicSTT?.();
            } catch (err) {
                console.error('[FloatingChatPanel] finalizeMicSTT error:', err);
            }
        } else {
            isRecordingRef.current = true;
            setIsManualRecording(true);
            // Voice input is captured by the main STT pipeline; result streams back via Gemini events
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const recentTranscript = transcriptRef.current?.slice(-3) || [];

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
                boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 4px 24px rgba(0,0,0,0.4)',
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
                        <div className="text-[13px] font-bold text-white tracking-wide uppercase">Live Chat Assistant</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse block" />
                            <span className="text-[11px] text-emerald-400 font-medium">Listening and Analyzing...</span>
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

            {/* Rolling transcript strip */}
            {showTranscript && (rollingTranscript || isInterviewerSpeaking) && (
                <div
                    className="px-5 py-2.5 shrink-0"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}
                >
                    <div className="flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse mt-1 shrink-0" />
                        <p className="text-[11px] text-white/40 leading-relaxed line-clamp-2">
                            <span className="text-white/55 font-medium mr-1">{speakerNames.interviewer}:</span>
                            {rollingTranscript}
                            {isInterviewerSpeaking && <span className="ml-1 text-white/25 animate-pulse">...</span>}
                        </p>
                        <span className="text-[10px] text-red-400 font-bold shrink-0 ml-auto">LIVE</span>
                    </div>
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
                            Ask anything about the live call or use the action chips below
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

            {/* Quick Action Chips */}
            <div
                className="px-4 py-3 flex flex-wrap gap-1.5 shrink-0"
                style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
            >
                {CHIP_ACTIONS.map(chip => {
                    const Icon = chip.icon;
                    return (
                        <motion.button
                            key={chip.id}
                            onClick={() => chip.id === 'answer' ? handleAnswerNow() : handleChip(chip.intent, chip.label)}
                            whileHover={{ scale: 1.03 }}
                            whileTap={{ scale: 0.95 }}
                            disabled={isProcessing}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors"
                            style={{
                                background: 'rgba(255,255,255,0.05)',
                                border: '1px solid rgba(255,255,255,0.08)',
                                color: 'rgba(255,255,255,0.55)',
                                opacity: isProcessing ? 0.5 : 1,
                            }}
                        >
                            <Icon size={11} />
                            {chip.label}
                        </motion.button>
                    );
                })}
                <motion.button
                    onClick={handleAnswerNow}
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.95 }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors"
                    style={{
                        background: isManualRecording ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.05)',
                        border: isManualRecording ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(255,255,255,0.08)',
                        color: isManualRecording ? '#f87171' : 'rgba(255,255,255,0.55)',
                    }}
                >
                    {isManualRecording
                        ? <><div className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" /> Stop</>
                        : <><Zap size={11} /> Answer</>
                    }
                </motion.button>
            </div>

            {/* Input Area */}
            <div
                className="px-4 pb-4 pt-2 shrink-0 flex flex-col gap-2"
                style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
            >
                <textarea
                    ref={inputRef}
                    value={inputValue}
                    onChange={e => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything about the live call..."
                    rows={2}
                    className="w-full bg-transparent resize-none outline-none text-[13px] leading-relaxed placeholder:text-white/20"
                    style={{ color: 'rgba(255,255,255,0.85)' }}
                />
                <div className="flex justify-end">
                    {/* <ModelSelector currentModel={currentModel} onSelectModel={onSelectModel} /> */}
                    <motion.button
                        onClick={handleSend}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.93 }}
                        disabled={!inputValue.trim() || isProcessing}
                        className="w-9 h-9 rounded-xl flex items-center justify-center transition-all"
                        style={{
                            background: inputValue.trim() && !isProcessing ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.08)',
                            opacity: isProcessing ? 0.5 : 1,
                        }}
                    >
                        <ArrowRight
                            size={16}
                            style={{ color: inputValue.trim() ? '#0f172a' : 'rgba(255,255,255,0.3)' }}
                        />
                    </motion.button>
                </div>
            </div>
        </div>
    );
};