import React from 'react';
import { Search, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import { IMAGES } from '@/lib/assets';

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
            <img src={IMAGES.godojoLogoIcon} alt="Godojo" className="w-6 h-6" />
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

export default EmptyState;