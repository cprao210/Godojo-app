import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// Small pulsing-dot + status-label pill shown while waiting for the LLM to
// start responding. `label` swaps in backend status updates (e.g.
// "Searching meetings…") when available, falling back to "Thinking…".
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

export default TypingIndicator;