import React from 'react';
import { X, Target } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { MeetingScope } from '@/types';

// "Scoped to: Acme pricing, Acme intro ✕" — shown above the input whenever the
// conversation is narrowed to meetings the user picked.
//
// This exists because the scope is STICKY: it keeps applying to later
// meeting-related questions, so without a visible marker a user three questions
// later has no way to know why answers suddenly look narrow, or how to undo it.
// The ✕ is the direct undo; saying "search all meetings" also releases it.
const MeetingScopeChip: React.FC<{
    scope: MeetingScope | null;
    onClear: () => void;
    disabled?: boolean;
}> = ({ scope, onClear, disabled }) => {
    const count = scope?.meeting_ids?.length ?? 0;

    return (
        <AnimatePresence initial={false}>
            {count > 0 && (
                <motion.div
                    initial={{ opacity: 0, y: 4, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: 'auto' }}
                    exit={{ opacity: 0, y: 4, height: 0 }}
                    transition={{ duration: 0.15 }}
                    className="px-4 pt-2 shrink-0 overflow-hidden"
                >
                    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl border border-accent-primary/30 bg-accent-primary/[0.07] min-w-0">
                        <Target size={12} className="text-accent-primary shrink-0" />
                        <span className="text-[11px] text-text-tertiary shrink-0">
                            Searching only
                        </span>
                        <span
                            className="text-[11.5px] text-text-primary font-medium truncate min-w-0"
                            title={(scope?.labels ?? []).join(', ')}
                        >
                            {/* Labels can be missing if the pin predates them; fall
                                back to a count so the chip is never blank. */}
                            {scope?.labels?.length
                                ? scope.labels.join(', ')
                                : `${count} meeting${count === 1 ? '' : 's'}`}
                        </span>
                        <button
                            type="button"
                            onClick={onClear}
                            disabled={disabled}
                            aria-label="Search all meetings again"
                            title="Search all meetings again"
                            className="ml-auto p-1 rounded-full hover:bg-bg-item-surface transition-colors group shrink-0 disabled:opacity-50"
                        >
                            <X size={12} className="text-text-tertiary group-hover:text-text-primary transition-colors" />
                        </button>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default MeetingScopeChip;
