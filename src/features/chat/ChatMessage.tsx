import React, { useState } from 'react';
import { Copy, Check, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { chatMarkdownComponents } from './markdownComponents';
import SourcesDisplay from './SourcesDisplay';
import { ChatSources } from '@/types';

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
        <div className="bg-gradient-to-br from-blue-500 to-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-tr-md max-w-[80%] text-[13.5px] leading-relaxed shadow-sm">
            {content}
        </div>
    </motion.div>
);

interface AssistantMessageProps {
    content: string;
    isStreaming?: boolean;
    sources?: ChatSources;
    onOpenMeeting?: (meetingId: string) => void;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ content, isStreaming, sources, onOpenMeeting }) => {
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
                <div className="bg-bg-item-surface text-text-primary text-[13.5px] leading-relaxed px-4 py-2.5 rounded-2xl rounded-tl-md">
                    <div className="markdown-content">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                            components={chatMarkdownComponents}
                        >
                            {content}
                        </ReactMarkdown>
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
                        {sources && <SourcesDisplay sources={sources} onOpenMeeting={onOpenMeeting} />}
                    </div>
                )}
            </div>
        </motion.div>
    );
};