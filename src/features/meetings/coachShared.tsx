import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Small pieces shared across the Coach-tab panels (Game Plan, Coach's notes,
 * the demo/negotiation follow-up panels) so they stay visually identical.
 */

/** Small icon-button that copies text to the clipboard and flashes a check. */
export function CopyButton({ text, label, isLight }: { text: string; label: string; isLight: boolean }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
        } catch {
            // Clipboard unavailable (permissions) — the click is just a no-op.
        }
    };
    return (
        <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : `Copy ${label}`}
            title={copied ? 'Copied!' : `Copy ${label}`}
            className={`shrink-0 rounded-md p-1.5 transition-colors ${isLight
                ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                : 'text-white/30 hover:bg-white/10 hover:text-white/70'
                }`}
        >
            {copied
                ? <Check size={13} className="text-emerald-400" />
                : <Copy size={13} />}
        </button>
    );
}

/**
 * Placeholder for a section whose data is empty while its parent panel still
 * renders — a quiet dashed card instead of a blank gap. Never fabricates
 * content; the message states that nothing was captured.
 */
export function EmptySectionNote({ text, isLight }: { text: string; isLight: boolean }) {
    return (
        <div className={`rounded-xl border border-dashed px-4 py-3.5 ${isLight
            ? 'border-slate-300 bg-slate-50/50'
            : 'border-white/10 bg-white/[0.015]'
            }`}>
            <p className={`text-[12.5px] italic leading-relaxed ${isLight ? 'text-slate-400' : 'text-white/30'}`}>
                {text}
            </p>
        </div>
    );
}
