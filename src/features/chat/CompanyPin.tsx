// Company pinned to a global chat session: a chip above the input ("Company" → search → pick; ×
// removes it) and the suggestion list the input shows while the user types "@company". The pin
// itself lives in useGlobalChat and is sent with every question.

import React, { useEffect, useRef, useState } from 'react';
import { Building2, Plus, X } from 'lucide-react';
import { useCompanySearch } from '@/hooks/useCompanySearch';
import type { ChatCompanyPin, Company } from '@/types';

interface SuggestionListProps {
    results: Company[];
    loading: boolean;
    highlighted: number;
    onPick: (company: Company) => void;
    onHover?: (index: number) => void;
    emptyLabel?: string;
}

export const CompanySuggestionList: React.FC<SuggestionListProps> = ({
    results, loading, highlighted, onPick, onHover, emptyLabel = 'No matching companies',
}) => (
    <div className="max-h-56 overflow-y-auto py-1" role="listbox" aria-label="Companies">
        {loading && results.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-text-tertiary">Searching…</div>
        )}
        {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-text-tertiary">{emptyLabel}</div>
        )}
        {results.map((c, i) => (
            <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={i === highlighted}
                // mousedown, not click: picking must happen before the textarea's blur.
                onMouseDown={(e) => { e.preventDefault(); onPick(c); }}
                onMouseEnter={() => onHover?.(i)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors ${i === highlighted ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:bg-bg-item-hover'}`}
            >
                <Building2 size={12} className="shrink-0 text-text-tertiary" />
                <span className="truncate">{c.name}</span>
                {c.domain && <span className="ml-auto shrink-0 text-[11px] text-text-tertiary">{c.domain}</span>}
            </button>
        ))}
    </div>
);

interface CompanyPinChipProps {
    pinned: ChatCompanyPin | null;
    onPin: (company: ChatCompanyPin) => void;
    onClear: () => void;
}

export const CompanyPinChip: React.FC<CompanyPinChipProps> = ({ pinned, onPin, onClear }) => {
    const [open, setOpen] = useState(false);
    const [term, setTerm] = useState('');
    const [highlighted, setHighlighted] = useState(0);
    const { results, loading } = useCompanySearch(open ? term : null);
    const boxRef = useRef<HTMLDivElement>(null);

    useEffect(() => setHighlighted(0), [results]);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    const pick = (c: Company) => {
        onPin({ id: c.id, name: c.name });
        setOpen(false);
        setTerm('');
    };

    if (pinned) {
        return (
            <div className="flex items-center gap-1.5 px-1 pb-2">
                <span
                    className="inline-flex items-center gap-1.5 max-w-full rounded-full border border-accent-primary/30 bg-accent-primary/10 pl-2.5 pr-1 py-0.5 text-[12px] text-text-primary"
                    title={`Every question in this chat is about ${pinned.name}`}
                >
                    <Building2 size={12} className="shrink-0 text-accent-primary" />
                    <span className="truncate">{pinned.name}</span>
                    <button
                        type="button"
                        onClick={onClear}
                        className="ml-0.5 p-0.5 rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-item-hover"
                        aria-label={`Remove ${pinned.name} from this chat`}
                    >
                        <X size={11} />
                    </button>
                </span>
                <span className="text-[11px] text-text-tertiary truncate">Answers use this company's calls</span>
            </div>
        );
    }

    return (
        <div ref={boxRef} className="relative flex items-center px-1 pb-2">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-muted px-2.5 py-0.5 text-[12px] text-text-tertiary hover:text-text-primary hover:border-accent-primary/40 transition-colors"
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <Plus size={11} /> Company
            </button>
            <span className="ml-2 text-[11px] text-text-tertiary">or type @ to pick one</span>
            {open && (
                <div className="absolute bottom-full left-1 mb-1.5 w-72 rounded-xl border border-border-subtle bg-bg-elevated shadow-lg z-20">
                    <input
                        autoFocus
                        value={term}
                        onChange={(e) => setTerm(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, results.length - 1)); }
                            else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); }
                            else if (e.key === 'Enter' && results[highlighted]) { e.preventDefault(); pick(results[highlighted]); }
                            else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
                        }}
                        placeholder="Search companies…"
                        className="w-full px-3 py-2 bg-transparent border-b border-border-subtle text-[12.5px] text-text-primary placeholder-text-tertiary focus:outline-none"
                    />
                    <CompanySuggestionList
                        results={results}
                        loading={loading}
                        highlighted={highlighted}
                        onPick={pick}
                        onHover={setHighlighted}
                    />
                </div>
            )}
        </div>
    );
};
