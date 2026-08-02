import React from 'react';
import { MessageCircle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { isMac } from '../utils/platformUtils';

interface FloatingChatButtonProps {
    isOpen: boolean;
    onClick: () => void;
    /** Optional label shown in the hover tooltip when closed. */
    label?: string;
}

// Bottom-right floating action button that toggles the Global Chat widget.
// Lives on the Launcher screen only — mirrors the "chat bubble" pattern
// used by Intercom / Drift / etc. so the entry point is unmistakably a
// separate assistant, not part of meeting search.
const FloatingChatButton: React.FC<FloatingChatButtonProps> = ({
    isOpen,
    onClick,
    label = 'Ask AI'
}) => {
    const shortcutKeys = isMac ? ['⌘', 'Space'] : ['Ctrl', 'Space'];

    return (
        <div data-global-chat-fab className="group fixed bottom-6 right-6 z-[360] no-drag flex flex-col w-[50px] items-end gap-3">
            {/* Tooltip card — mirrors the app's glass surfaces, shows the keyboard shortcut */}
            {!isOpen && (
                <div className="pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full bg-bg-elevated/95 backdrop-blur-xl border border-border-muted shadow-[0_8px_24px_rgba(0,0,0,0.25)]">
                    <span className="text-[12px] font-medium text-text-primary whitespace-nowrap">{label}</span>
                    <span className="flex items-center gap-0.5">
                        {shortcutKeys.map((k) => (
                            <kbd
                                key={k}
                                className="min-w-[20px] px-1.5 py-0.5 rounded-md bg-bg-item-surface border border-border-muted text-[10px] font-semibold text-text-tertiary text-center leading-none"
                            >
                                {k}
                            </kbd>
                        ))}
                    </span>
                </div>
            )}

            {/* The button itself */}
            <motion.button
                onClick={onClick}
                initial={false}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.93 }}
                className="relative w-14 h-14 rounded-full flex items-center justify-center focus:outline-none"
                aria-label={isOpen ? 'Close chat' : label}
            >
                {/* Idle breathing glow — subtle, invites the first click, hidden once open */}
                {!isOpen && (
                    <motion.span
                        className="absolute inset-0 rounded-full bg-blue-500/35 blur-[2px]"
                        animate={{ scale: [1, 1.28, 1], opacity: [0.45, 0, 0.45] }}
                        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
                    />
                )}

                {/* Core orb */}
                <motion.span
                    animate={{
                        background: isOpen
                            ? 'linear-gradient(135deg, #334155 0%, #1e293b 100%)'
                            : 'linear-gradient(135deg, #60A5FA 0%, #2563EB 60%, #1D4ED8 100%)'
                    }}
                    transition={{ duration: 0.25 }}
                    className="absolute inset-1 rounded-full shadow-[0_10px_30px_rgba(37,99,235,0.45),inset_0_1px_0_rgba(255,255,255,0.25)] border border-white/10"
                />

                {/* Specular highlight for a glassy feel */}
                <span className="absolute top-1 left-2 right-2 h-4 rounded-full pointer-events-none" />

                <AnimatePresence mode="wait" initial={false}>
                    {isOpen ? (
                        <motion.span
                            key="close"
                            initial={{ opacity: 0, rotate: -45, scale: 0.6 }}
                            animate={{ opacity: 1, rotate: 0, scale: 1 }}
                            exit={{ opacity: 0, rotate: 45, scale: 0.6 }}
                            transition={{ duration: 0.18 }}
                            className="relative z-10 flex items-center justify-center"
                        >
                            <X size={22} className="text-white" strokeWidth={2.25} />
                        </motion.span>
                    ) : (
                        <motion.span
                            key="open"
                            initial={{ opacity: 0, scale: 0.6 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.6 }}
                            transition={{ duration: 0.18 }}
                            className="relative z-10 flex items-center justify-center"
                        >
                            <MessageCircle size={22} className="text-white" strokeWidth={2.1} />
                        </motion.span>
                    )}
                </AnimatePresence>

            </motion.button>
        </div>
    );
};

export default FloatingChatButton;