import React from 'react';
import { ArrowUp, Square } from 'lucide-react';

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
}

// Sits in normal flow at the bottom of the panel, never overlaps the
// message list. Purely presentational — all behaviour is owned by
// useGlobalChat and passed in as props.
const ChatInputBar: React.FC<ChatInputBarProps> = ({ query, onChange, onKeyDown, onSend, inputRef, isBusy = false, onStop }) => (
    <div className="shrink-0 px-3 py-3 border-t border-border-subtle bg-bg-secondary/80">
        <div className="relative flex items-end">
            <textarea
                ref={inputRef}
                value={query}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Message AI Assistant…"
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

export default ChatInputBar;