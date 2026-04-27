import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { X, Loader2, Briefcase, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useResolvedTheme } from '../hooks/useResolvedTheme';

interface SalesBriefPanelProps {
    eventData: any;
    onClose: () => void;
}

const SalesBriefPanel: React.FC<SalesBriefPanelProps> = ({ eventData, onClose }) => {
    const isLight = useResolvedTheme() === 'light';
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Ensure markdown headings have blank lines before them (streaming can squash them)
    const normalizedContent = useMemo(() => {
        if (!content) return '';
        return content
            .replace(/([^\n])\n(## )/g, '$1\n\n$2')  // ensure blank line before ##
            .replace(/([^\n])\n(- )/g, '$1\n$2');      // keep list items clean
    }, [content]);

    useEffect(() => {
        setContent('');
        setLoading(true);
        setError(null);

        const offToken = window.electronAPI.onSalesBriefStreamToken((token) => {
            setContent(prev => prev + token);
        });
        const offDone = window.electronAPI.onSalesBriefStreamDone(() => {
            setLoading(false);
        });
        const offError = window.electronAPI.onSalesBriefStreamError((err) => {
            setError(err);
            setLoading(false);
        });

        // Pass full event data — no Google API re-fetch needed
        window.electronAPI.streamSalesBrief(eventData);

        return () => { offToken(); offDone(); offError(); };
    }, [eventData.id]);

    // Auto-scroll as content streams in
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [content]);

    const handleCopy = async () => {
        if (!content) return;
        await navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.2 }}
            className={`fixed inset-0 z-[200] flex items-center justify-center p-4 ${isLight ? 'bg-black/20' : 'bg-black/50'}`}
            onClick={onClose}
        >
            <motion.div
                className={`w-full max-w-2xl max-h-[80vh] rounded-2xl overflow-hidden flex flex-col shadow-2xl border ${isLight ? 'bg-bg-elevated border-border-muted' : 'bg-[#1a1a1a] border-white/10'}`}
                onClick={(e) => e.stopPropagation()}
                initial={{ scale: 0.95 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.95 }}
            >
                {/* Header */}
                <div className={`flex items-center justify-between px-6 py-4 border-b ${isLight ? 'border-border-subtle' : 'border-white/10'}`}>
                    <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${isLight ? 'bg-sky-50' : 'bg-sky-500/10'}`}>
                            <Briefcase size={16} className="text-sky-500" />
                        </div>
                        <div>
                            <h3 className="text-sm font-semibold text-text-primary">Sales Meeting Brief</h3>
                            <p className="text-xs text-text-tertiary truncate max-w-[300px]">{eventData.title}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {content && (
                            <button
                                onClick={handleCopy}
                                className={`p-2 rounded-lg text-text-secondary hover:text-text-primary transition-colors ${isLight ? 'hover:bg-bg-item-surface' : 'hover:bg-white/10'}`}
                            >
                                {copied ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
                            </button>
                        )}
                        <button onClick={onClose} className={`p-2 rounded-lg text-text-secondary hover:text-text-primary transition-colors ${isLight ? 'hover:bg-bg-item-surface' : 'hover:bg-white/10'}`}>
                            <X size={16} />
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
                    {error && (
                        <div className="flex flex-col items-center justify-center py-16 gap-3">
                            <p className="text-sm text-red-400">{error}</p>
                        </div>
                    )}

                    {content ? (
                        <div className="sales-brief-content space-y-4">
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    h2: ({ children }) => (
                                        <h2 className={`flex items-center gap-2 text-base font-bold mt-6 mb-2 pb-1.5 border-b ${isLight ? 'text-text-primary border-border-subtle' : 'text-white border-white/10'}`}>
                                            {children}
                                        </h2>
                                    ),
                                    h3: ({ children }) => (
                                        <h3 className={`text-sm font-semibold mt-4 mb-1 ${isLight ? 'text-text-primary' : 'text-white/90'}`}>
                                            {children}
                                        </h3>
                                    ),
                                    ul: ({ children }) => (
                                        <ul className="space-y-1.5 ml-1 list-none">
                                            {children}
                                        </ul>
                                    ),
                                    li: ({ children }) => (
                                        <li className={`flex items-start gap-2 text-[13px] leading-relaxed ${isLight ? 'text-text-secondary' : 'text-white/70'}`}>
                                            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${isLight ? 'bg-sky-500' : 'bg-sky-400'}`} />
                                            <span>{children}</span>
                                        </li>
                                    ),
                                    p: ({ children }) => (
                                        <p className={`text-[13px] leading-relaxed ${isLight ? 'text-text-secondary' : 'text-white/70'}`}>
                                            {children}
                                        </p>
                                    ),
                                    strong: ({ children }) => (
                                        <strong className={`font-semibold ${isLight ? 'text-text-primary' : 'text-white/90'}`}>
                                            {children}
                                        </strong>
                                    ),
                                }}
                            >
                                {normalizedContent}
                            </ReactMarkdown>
                        </div>
                    ) : loading ? (
                        <div className="flex flex-col items-center justify-center py-16 gap-3">
                            <Loader2 size={24} className="animate-spin text-sky-500" />
                            <p className="text-sm text-text-secondary">Generating sales brief...</p>
                        </div>
                    ) : null}

                    {loading && content && (
                        <div className="flex items-center gap-2 mt-4 text-text-tertiary">
                            <Loader2 size={14} className="animate-spin" />
                            <span className="text-xs">Generating...</span>
                        </div>
                    )}
                </div>
            </motion.div>
        </motion.div>
    );
};

export default SalesBriefPanel;
