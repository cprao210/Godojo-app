import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useCompanySearch } from '@/hooks/useCompanySearch';
import { findMention, removeMention } from '@/lib/chatCompanyPin';
import type { ChatCompanyPin, Company } from '@/types';
import { CompanyPinChip, CompanySuggestionList } from './CompanyPin';

interface ChatInputBarProps {
    query: string;
    onChange: (value: string) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onSend: () => void;
    inputRef: React.RefObject<HTMLTextAreaElement>;
    /** True while a response is being generated. Swaps the send button for
     * a stop button, same as ChatGPT/Claude's own chat inputs. */
    isBusy?: boolean;
    /** Cancels the in-flight generation. Required when isBusy is used. */
    onStop?: () => void;
    /** Company pinned to this chat — shown as a chip above the input. Pass onPinCompany to enable
     * the chip and "@" mentions; without it the bar behaves exactly as before. */
    pinnedCompany?: ChatCompanyPin | null;
    onPinCompany?: (company: ChatCompanyPin) => void;
    onClearCompany?: () => void;
}

// Sits in normal flow at the bottom of the panel, never overlaps the
// message list. Presentational — chat behaviour is owned by useGlobalChat and
// passed in as props; the only local state is the "@company" suggestion list.
const ChatInputBar: React.FC<ChatInputBarProps> = ({
    query, onChange, onKeyDown, onSend, inputRef, isBusy = false, onStop,
    pinnedCompany = null, onPinCompany, onClearCompany,
}) => {
    const companiesEnabled = Boolean(onPinCompany);
    const mention = useMemo(() => (companiesEnabled ? findMention(query) : null), [companiesEnabled, query]);
    // Escape dismisses the list for the "@" being typed; a new "@" opens it again.
    const [dismissedAt, setDismissedAt] = useState<number | null>(null);
    const mentionOpen = Boolean(mention) && mention!.start !== dismissedAt;
    const { results, loading } = useCompanySearch(mentionOpen ? mention!.query : null);
    const [highlighted, setHighlighted] = useState(0);
    useEffect(() => setHighlighted(0), [results]);
    useEffect(() => {
        if (!mention) setDismissedAt(null);
    }, [mention]);

    const pickFromMention = (c: Company) => {
        if (!mention) return;
        onPinCompany?.({ id: c.id, name: c.name });
        onChange(removeMention(query, mention));
        inputRef.current?.focus();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (mentionOpen) {
            if (e.key === 'ArrowDown' && results.length) {
                e.preventDefault();
                setHighlighted((h) => Math.min(h + 1, results.length - 1));
                return;
            }
            if (e.key === 'ArrowUp' && results.length) {
                e.preventDefault();
                setHighlighted((h) => Math.max(h - 1, 0));
                return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && results[highlighted]) {
                e.preventDefault();
                pickFromMention(results[highlighted]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDismissedAt(mention!.start);
                return;
            }
        }
        onKeyDown(e);
    };

    const placeholder = pinnedCompany
        ? `Ask about ${pinnedCompany.name}…`
        : companiesEnabled
            ? 'Message AI Assistant… (type @ to pick a company)'
            : 'Message AI Assistant…';

    return (
        <div className="shrink-0 px-3 py-3 border-t border-border-subtle bg-bg-secondary/80">
            {companiesEnabled && (
                <CompanyPinChip
                    pinned={pinnedCompany}
                    onPin={(c) => onPinCompany?.(c)}
                    onClear={() => onClearCompany?.()}
                />
            )}
            <div className="relative flex items-end">
                {mentionOpen && (
                    <div className="absolute bottom-full left-2 mb-1.5 w-72 rounded-xl border border-border-subtle bg-bg-elevated shadow-lg z-20">
                        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                            Pin a company to this chat
                        </div>
                        <CompanySuggestionList
                            results={results}
                            loading={loading}
                            highlighted={highlighted}
                            onPick={pickFromMention}
                            onHover={setHighlighted}
                        />
                    </div>
                )}
                <textarea
                    ref={inputRef}
                    value={query}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    rows={1}
                    className="w-full pl-4 pr-11 py-2.5 bg-bg-input border border-border-muted rounded-3xl text-[13px] text-text-primary placeholder-text-tertiary/70 focus:outline-none focus:border-accent-primary/50 transition-colors resize-none leading-relaxed"
                    style={{ maxHeight: 120, overflowY: 'auto' }}
                />
                {isBusy ? (
                    <button
                        onClick={onStop}
                        className="absolute right-1.5 bottom-1.5 w-7 h-7 flex items-center justify-center rounded-full bg-bg-item-active text-text-primary hover:bg-bg-item-hover transition-all duration-200"
                        aria-label="Stop generating"
                        title="Stop generating"
                    >
                        <Square size={12} fill="currentColor" />
                    </button>
                ) : (
                    <button
                        onClick={onSend}
                        disabled={!query.trim()}
                        className={`absolute right-1.5 bottom-1.5 w-7 h-7 flex items-center justify-center rounded-full transition-all duration-200 ${query.trim()
                            ? 'bg-gradient-to-br from-blue-500 to-blue-600 text-white hover:scale-105 shadow-sm'
                            : 'bg-bg-item-active text-text-tertiary cursor-default'
                            }`}
                        aria-label="Send message"
                    >
                        <ArrowUp size={14} />
                    </button>
                )}
            </div>
        </div>
    );
};

export default ChatInputBar;
