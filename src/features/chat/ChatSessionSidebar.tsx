import React from 'react';
import { Plus, MessageSquare, Trash2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { ChatSessionSidebarProps } from '@/types';

// ============================================
// Chat Session Sidebar — list of past global-chat
// conversations + "New Chat" entry point.
// ============================================
const ChatSessionSidebar: React.FC<ChatSessionSidebarProps> = ({
    sessions,
    activeSessionId,
    isLoading,
    onSelectSession,
    onNewChat,
    onDeleteSession,
}) => {
    return (
        <div className="w-[220px] shrink-0 border-r border-border-subtle flex flex-col bg-bg-elevated/40">
            <div className="p-2.5 border-b border-border-subtle">
                <button
                    onClick={onNewChat}
                    className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12.5px] font-medium text-text-primary bg-bg-item-surface hover:bg-accent-primary/10 hover:text-accent-primary border border-border-subtle transition-colors"
                >
                    <Plus size={14} />
                    New Chat
                </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-1.5 py-1.5">
                {isLoading ? (
                    <div className="px-2 py-2 text-[11.5px] text-text-tertiary">Loading…</div>
                ) : sessions.length === 0 ? (
                    <div className="px-2 py-2 text-[11.5px] text-text-tertiary leading-relaxed">
                        No conversations yet. Start one above.
                    </div>
                ) : (
                    sessions.map((session) => {
                        const isActive = session.id === activeSessionId;
                        return (
                            <motion.button
                                key={session.id}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                onClick={() => onSelectSession(session.id)}
                                className={`group w-full flex items-start gap-2 px-2.5 py-2 mb-0.5 rounded-lg text-left transition-colors ${isActive
                                    ? 'bg-accent-primary/12 text-accent-primary'
                                    : 'text-text-secondary hover:bg-bg-item-surface hover:text-text-primary'
                                    }`}
                            >
                                <MessageSquare size={13} className="mt-0.5 shrink-0 opacity-70" />
                                <span className="text-[12px] leading-snug truncate flex-1">{session.title}</span>
                                <span
                                    role="button"
                                    aria-label="Delete conversation"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDeleteSession(session.id);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded hover:bg-red-500/15 hover:text-red-400 transition-opacity"
                                >
                                    <Trash2 size={12} />
                                </span>
                            </motion.button>
                        );
                    })
                )}
            </div>
        </div>
    );
};

export default ChatSessionSidebar;