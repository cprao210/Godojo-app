import React from 'react';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { IMAGES } from '@/lib/assets';
import { useGlobalChat, useResolvedTheme } from '@/hooks';
import { GlobalChatOverlayProps } from '@/types';

import TypingIndicator from './TypingIndicator';
import { UserMessage, AssistantMessage } from './ChatMessage';
import EmptyState from './EmptyState';
import ChatInputBar from './ChatInputBar';
import ChatSessionSidebar from './ChatSessionSidebar';

// ============================================
// Main Component
// ============================================
// Centered modal-style chat widget. All state, streaming, and DOM listeners
// (auto-scroll, auto-focus, outside-click, Escape) live in useGlobalChat —
// this component is rendering-only, composed from the pieces above.
const GlobalChatOverlay: React.FC<GlobalChatOverlayProps> = ({ isOpen, onClose, initialQuery = '', onOpenMeeting }) => {

    const globalChatStates = useGlobalChat({ isOpen, onClose, initialQuery });
    const isLight = useResolvedTheme() === "light";
    const { messages, chatState, errorMessage, statusText, query, setQuery } = globalChatStates;
    const { messagesEndRef, chatWindowRef, inputRef, submitQuestion, handleInputKeyDown } = globalChatStates;
    const { handleSendClick, resetOnExit, sessionId, sessions, isLoadingSessions } = globalChatStates;
    const { startNewChat, loadSession, deleteSession } = globalChatStates;

    return (
        <AnimatePresence onExitComplete={resetOnExit}>
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
                        className={`pointer-events-auto relative w-[960px] h-[82vh] max-w-[calc(100vw-64px)] max-h-[calc(100vh-64px)] rounded-[22px] border border-border-subtle shadow-[0_24px_70px_-12px_rgba(0,0,0,0.5)] overflow-hidden flex ${isLight ? "bg-blue-50/80" : "bg-bg-secondary/95"} backdrop-blur-2xl`}
                    >
                        <ChatSessionSidebar
                            sessions={sessions}
                            activeSessionId={sessionId}
                            isLoading={isLoadingSessions}
                            onSelectSession={loadSession}
                            onNewChat={startNewChat}
                            onDeleteSession={deleteSession}
                        />
                        <div className="flex-1 flex flex-col min-w-0">
                            {/* Header */}
                            <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-border-subtle shrink-0 bg-gradient-to-b from-bg-elevated/60 to-transparent">
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <div className="relative shrink-0">
                                        <div className="w-8 h-8 rounded-full bg-accent-primary/15 border border-accent-primary/20 flex items-center justify-center shadow-[0_2px_10px_rgba(37,99,235,0.25)]">
                                            <img src={IMAGES.godojoLogoIcon} alt="Godojo" className="w-4 h-4" />
                                        </div>
                                        <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-bg-secondary" />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-[13px] font-semibold text-text-primary leading-tight truncate">Godojo Chat Assistant</div>
                                        <div className="text-[11px] text-text-tertiary leading-tight">
                                            {/* {isBusy ? (statusText ?? 'Typing…') : 'Online · searches all meetings'} */}
                                            Online · searches all meetings
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

                            {/* Input bar */}
                            <ChatInputBar
                                query={query}
                                onChange={setQuery}
                                onKeyDown={handleInputKeyDown}
                                onSend={handleSendClick}
                                inputRef={inputRef}
                            />
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};

export default GlobalChatOverlay;