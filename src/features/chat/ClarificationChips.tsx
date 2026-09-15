import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { motion } from 'framer-motion';
import { Clarification } from '@/types';

// Choices under an assistant message that asked a clarifying question
// ("You've got more than one person matching that — which one?").
//
// Two modes, driven by `clarification.multi_select`:
//   - single (members): one tap sends immediately.
//   - multi (meetings): tick several, then confirm. A question often spans more
//     than one call, and forcing a single pick throws the rest away.
//
// Deliberately does NOT render `clarification.question`: the backend streams it
// as ordinary `token` frames so clients that ignore the `clarification` frame
// still show it, which means it is already in the bubble above. Rendering it
// here too would print it twice.
//
// Picking matters — it is the ONLY thing that narrows the search. A typed reply
// naming the meeting or person still matches everything sharing that name, so
// the backend falls back to an unscoped answer.
const ClarificationChips: React.FC<{
    clarification: Clarification;
    disabled?: boolean;
    onPick: (clarification: Clarification, optionIds: string[], labels: string[]) => void;
}> = ({ clarification, disabled, onPick }) => {
    const { options, multi_select: multi } = clarification;
    const [ticked, setTicked] = useState<string[]>([]);

    if (!options?.length) return null;

    const toggle = (id: string) => {
        if (disabled) return;
        setTicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    };

    const send = (ids: string[]) => {
        if (disabled || !ids.length) return;
        const labels = ids
            .map((id) => options.find((o) => o.id === id)?.label)
            .filter((l): l is string => Boolean(l));
        onPick(clarification, ids, labels);
    };

    const chipClass = (active: boolean) =>
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[12px] transition-colors ' +
        (disabled
            ? 'border-border-subtle text-text-tertiary opacity-60 cursor-default'
            : active
                ? 'border-accent-primary/60 bg-accent-primary/10 text-text-primary cursor-pointer'
                : 'border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-item-surface hover:border-accent-primary/40 cursor-pointer');

    return (
        <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col gap-1.5 mt-2 px-1"
        >
            <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={multi ? 'Pick one or more to continue' : 'Pick one to continue'}
            >
                {options.map((opt) => {
                    const active = ticked.includes(opt.id);
                    return (
                        <button
                            key={opt.id}
                            type="button"
                            disabled={disabled}
                            aria-pressed={multi ? active : undefined}
                            onClick={() => (multi ? toggle(opt.id) : send([opt.id]))}
                            title={opt.detail || undefined}
                            className={chipClass(Boolean(multi) && active)}
                        >
                            {multi && (
                                <span
                                    className={
                                        'w-3 h-3 rounded-[4px] border flex items-center justify-center shrink-0 ' +
                                        (active
                                            ? 'bg-accent-primary border-accent-primary'
                                            : 'border-border-subtle')
                                    }
                                >
                                    {active && <Check size={9} className="text-white" strokeWidth={3} />}
                                </span>
                            )}
                            <span className="font-medium truncate max-w-[220px]">{opt.label}</span>
                            {opt.detail && (
                                <span className="text-[11px] text-text-tertiary truncate max-w-[180px]">
                                    {opt.detail}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Multi-select needs an explicit commit — ticking is not sending. */}
            {multi && !disabled && (
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        disabled={!ticked.length}
                        onClick={() => send(ticked)}
                        className={
                            'px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ' +
                            (ticked.length
                                ? 'bg-accent-primary text-white hover:opacity-90 cursor-pointer'
                                : 'bg-bg-item-surface text-text-tertiary cursor-default')
                        }
                    >
                        {ticked.length > 1 ? `Search these ${ticked.length}` : 'Search this one'}
                    </button>
                    {ticked.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setTicked([])}
                            className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
                        >
                            Clear
                        </button>
                    )}
                </div>
            )}
        </motion.div>
    );
};

export default ClarificationChips;
