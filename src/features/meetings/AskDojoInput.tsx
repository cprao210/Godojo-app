import React, { useEffect, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';

interface AskDojoInputProps {
    inputRef: React.RefObject<HTMLTextAreaElement>;
    isLight: boolean;
    isChatOpen: boolean;
    isChatBusy: boolean;
    /** Returns true when the question was accepted (the input then clears). */
    onSubmit: (text: string) => boolean;
    onOpenChat: () => void;
    onStop: () => void;
    /** Bump to clear the input from outside (e.g. when the chat closes). */
    resetSignal: number;
}

/**
 * The meeting page's "Ask about this meeting…" bar.
 *
 * Owns its own text state on purpose: MeetingDetails is one large component
 * (full transcript, every AI answer's markdown), and when the text lived in
 * useMeetingDetails every keystroke re-rendered all of it — visible typing lag
 * on long meetings on low-end machines. Now a keystroke re-renders only this.
 */
export const AskDojoInput: React.FC<AskDojoInputProps> = React.memo(({
    inputRef, isLight, isChatOpen, isChatBusy, onSubmit, onOpenChat, onStop, resetSignal,
}) => {
    const [text, setText] = useState('');

    useEffect(() => { if (resetSignal) setText(''); }, [resetSignal]);

    // Auto-resize textarea
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 96)}px`; // max ~4 lines
    }, [text, inputRef]);

    const submit = () => {
        if (onSubmit(text)) setText('');
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // Shift+Enter inserts a newline — let the textarea handle it
        // natively instead of submitting.
        if (e.key === 'Enter' && e.shiftKey) return;
        if (e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            submit();
        }
    };

    return (
        <div className="w-full max-w-[440px] relative group pointer-events-auto">
            {/* Dark Glass Effect Input (Matching Reference) */}
            <textarea
                value={text}
                ref={inputRef}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                // Clicking/focusing the input opens the panel immediately —
                // if there's existing history it's visible right away,
                // without first having to type and submit a new question.
                onFocus={() => {
                    if (!isChatOpen) onOpenChat();
                }}
                placeholder="Ask about this meeting..."
                rows={1}
                className={`w-full pl-5 pr-12 py-3 backdrop-blur-[24px] backdrop-saturate-[140%] focus:outline-none transition-shadow duration-200 rounded-3xl text-sm text-text-primary placeholder-text-tertiary/70 resize-none leading-relaxed ${isLight ? 'bg-white border border-slate-200 shadow-[0_8px_30px_rgba(0,0,0,0.08)]' : 'bg-bg-secondary border border-white/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)]'}`}
                style={{ maxHeight: 120, overflowY: 'auto' }}
            />
            {isChatBusy ? (
                <button
                    onClick={onStop}
                    className="absolute right-2 bottom-4 p-1.5 rounded-full transition-all duration-200 border border-white/5 bg-bg-item-active text-text-primary hover:bg-bg-item-hover"
                    aria-label="Stop generating"
                    title="Stop generating"
                >
                    <Square size={14} fill="currentColor" />
                </button>
            ) : (
                <button
                    onClick={submit}
                    className={`absolute right-2 bottom-4 p-1.5 rounded-full transition-all duration-200 border border-white/5 ${text.trim() ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-primary hover:bg-bg-item-hover'
                        }`}
                >
                    <ArrowUp size={16} className="transform rotate-45" />
                </button>
            )}
        </div>
    );
});
