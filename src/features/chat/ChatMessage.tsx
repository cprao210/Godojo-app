import React, { useState } from 'react';
import { Copy, Check, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { chatMarkdownComponents } from './markdownComponents';
import { CitationProvider, rehypeCitations, CiteChip } from './citations';
import { SourceMapEntry } from '@/types';

// ============================================
// Message Components
// ============================================

export const UserMessage: React.FC<{ content: string }> = ({ content }) => (
    <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="flex justify-end mb-4"
    >
        <div className="bg-gradient-to-br from-blue-500 to-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-tr-md max-w-[80%] min-w-0 text-[13.5px] leading-relaxed shadow-sm break-words">
            {content}
        </div>
    </motion.div>
);

interface AssistantMessageProps {
    content: string;
    isStreaming?: boolean;
    /** [n] -> source map from the `source_map` frame: ONLY the entries the
     * answer cites inline. Sources are shown solely as these inline chips +
     * hover cards (each with the exact excerpt used) — no separate list. */
    sourceMap?: Record<number, SourceMapEntry>;
    /** Citation indices that failed semantic verification — dim those chips. */
    unverifiedCitations?: number[];
    /** Backend discarded a partial answer and is re-streaming — dim + badge
     * instead of wiping (handled in the reset callbacks of the hooks). */
    rewriting?: boolean;
    onOpenMeeting?: (meetingId: string) => void;
    /** Opens a cited company-asset document (resolvable file_url). Omitting
     * it leaves doc chips on the preview-card fallback. */
    onOpenAsset?: (src: SourceMapEntry) => void;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ content, isStreaming, sourceMap, unverifiedCitations, rewriting, onOpenMeeting, onOpenAsset }) => {
    const [copied, setCopied] = useState(false);

    // While waiting for the first frame the assistant placeholder has no
    // content yet — render nothing here and let the single TypingIndicator
    // (rendered by the parent list) own the "thinking" state. Without this,
    // an empty bubble + blinking cursor would show *alongside* the status
    // pill, which is the "two loaders" bug.
    if (isStreaming && !content) return null;

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="flex items-start gap-2.5 mb-4"
        >
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
                <Sparkles size={11} className="text-white" />
            </div>
            <div className="flex flex-col items-start min-w-0 max-w-[85%]">
                <div className="bg-bg-item-surface text-text-primary text-[13.5px] leading-relaxed px-4 py-2.5 rounded-2xl rounded-tl-md min-w-0 max-w-full transition-opacity" style={rewriting ? { opacity: 0.55 } : undefined}>
                    {rewriting && (
                        <div className="mb-1.5 text-[10px] uppercase tracking-wide text-text-tertiary animate-pulse">
                            Rewriting…
                        </div>
                    )}
                    {/* overflow-x-clip (not -hidden): hidden forces overflow-y to
                        auto, turning this box into a scroll container that clips
                        the citation hover cards escaping above the first line. */}
                    <div className="markdown-content min-w-0 max-w-full overflow-x-clip">
                        <CitationProvider
                            map={sourceMap}
                            unverified={unverifiedCitations}
                            onOpenMeeting={onOpenMeeting}
                            onOpenAsset={onOpenAsset}
                        >
                            <ReactMarkdown
                                // No math plugin here on purpose: sales answers are
                                // dense with currency ("$204,000 and $173,400"),
                                // which remark-math/KaTeX happily parses as an
                                // inline $…$ equation — the mixed-font artifact in
                                // pricing answers. All other markdown surfaces in
                                // the app render plain GFM; stay consistent.
                                remarkPlugins={[remarkGfm]}
                                rehypePlugins={[rehypeCitations]}
                                components={{
                                    ...chatMarkdownComponents,
                                    cite: CiteChip as any,
                                }}
                            >
                                {content}
                            </ReactMarkdown>
                        </CitationProvider>
                    </div>
                    {isStreaming && (
                        <motion.span
                            className="inline-block w-0.5 h-3.5 bg-text-secondary ml-0.5 align-middle"
                            animate={{ opacity: [1, 0] }}
                            transition={{ duration: 0.5, repeat: Infinity }}
                        />
                    )}
                </div>
                {!isStreaming && content && (
                    <div className="flex items-center gap-3 mt-1.5 px-1">
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
                        >
                            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                            {copied ? 'Copied' : 'Copy'}
                        </button>
                    </div>
                )}
            </div>
        </motion.div>
    );
};