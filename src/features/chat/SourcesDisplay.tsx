import React, { useEffect, useRef, useState } from 'react';
import { FileText, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChatSources, SourceMapEntry } from '@/types';

// Renders retrieved sources under an assistant message — nothing if there are
// none, a single clickable chip for exactly one meeting source, or a chip for
// the first source plus a "+N" badge that opens a popover listing every
// source when there's more than one. Meetings are clickable (open the
// meeting); assets are clickable when the backend supplied a resolvable
// file_url — otherwise they stay plain (the /assets/{id} route doesn't exist
// in this Electron app yet).
//
// Each chip carries a small round index badge matching its inline [n]
// citation chip (looked up in the source_map), NotebookLM-style, so the row
// visually pairs with the numbered chips inside the answer.

/** Round numbered badge mirroring the inline CiteChip styling, so a source
 *  chip and its inline citation visibly refer to each other. */
const IndexBadge: React.FC<{ indices: number[] }> = ({ indices }) => {
    if (!indices.length) return null;
    return (
        <span className="shrink-0 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-[10px] font-medium leading-none">
            {indices.join('·')}
        </span>
    );
};

const SourcesDisplay: React.FC<{
    sources: ChatSources;
    onOpenMeeting?: (meetingId: string) => void;
    onOpenAsset?: (src: SourceMapEntry) => void;
    /** [n] -> source map from the `source_map` frame; powers the index badges. */
    sourceMap?: Record<number, SourceMapEntry>;
    /** source index -> the number its inline chip shows (order of first appearance). */
    labels?: Map<number, number>;
}> = ({ sources, onOpenMeeting, onOpenAsset, sourceMap, labels }) => {

    const { meetings, assets } = sources;
    const totalCount = meetings.length + assets.length;
    const [expanded, setExpanded] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // First citation index (all of them, ascending) whose source_map entry
    // matches this source id — same id the inline chips resolve through.
    const indicesFor = (id: string): number[] => {
        if (!sourceMap) return [];
        const idxs = Object.entries(sourceMap)
            .filter(([, e]) => e.id === id)
            .map(([idx]) => Number(idx));
        // Show the numbers the inline chips show; only indices the answer actually cites.
        const shown = labels ? idxs.filter((i) => labels.has(i)).map((i) => labels.get(i)!) : idxs;
        return [...new Set(shown)].sort((a, b) => a - b);
    };

    // An asset chip is clickable only when its citation entry carries a
    // resolvable file URL to hand to onOpenAsset.
    const assetEntry = (id: string): SourceMapEntry | undefined => {
        const entry = sourceMap && Object.values(sourceMap).find((e) => e.id === id);
        return entry?.file_url ? entry : undefined;
    };

    // Close on outside click / Escape
    useEffect(() => {
        if (!expanded) return;
        const handleClick = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setExpanded(false);
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setExpanded(false);
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [expanded]);

    if (totalCount === 0) return null;

    const allSources = [
        ...meetings.map(m => ({ ...m, type: 'meeting' as const })),
        ...assets.map(a => ({ ...a, type: 'asset' as const })),
    ];

    // Single source, no popover needed — just a plain (or clickable) chip.
    if (totalCount === 1) {
        const only = allSources[0];
        const assetSrc = only.type === 'asset' ? assetEntry(only.id) : undefined;
        const isClickable =
            (only.type === 'meeting' && !!onOpenMeeting) ||
            (only.type === 'asset' && !!assetSrc && !!onOpenAsset);
        const Tag: any = isClickable ? 'button' : 'span';
        return (
            <Tag
                {...(isClickable
                    ? { onClick: () => (only.type === 'meeting' ? onOpenMeeting!(only.id) : onOpenAsset!(assetSrc!)) }
                    : {})}
                className={`flex items-center gap-1.5 text-[12px] text-text-tertiary max-w-[240px] ${isClickable ? 'hover:text-accent-primary hover:underline transition-colors cursor-pointer' : ''}`}
                title={only.title}
            >
                <FileText size={12} className="shrink-0" />
                <IndexBadge indices={indicesFor(only.id)} />
                <span className="truncate">{only.title}</span>
                {isClickable && <ExternalLink size={10} className="shrink-0" />}
            </Tag>
        );
    }

    // Multiple sources — first title as a chip, "+N" badge opens the full list.
    const firstTitle = allSources[0].title;
    const extraCount = totalCount - 1;

    return (
        <div ref={containerRef} className="relative">
            <button
                onClick={() => setExpanded(v => !v)}
                className="flex items-center gap-1.5 text-[12px] text-text-tertiary hover:text-text-secondary transition-colors max-w-[280px]"
                title={allSources.map(s => s.title).join(', ')}
            >
                <FileText size={12} className="shrink-0" />
                <IndexBadge indices={indicesFor(allSources[0].id)} />
                <span className="truncate">{firstTitle}</span>
                <span className={`shrink-0 text-[11px] font-medium px-1.5 py-[1px] rounded-full transition-colors ${expanded ? 'bg-accent-primary/20 text-accent-primary' : 'bg-bg-item-active text-text-tertiary'}`}>
                    +{extraCount}
                </span>
            </button>

            <AnimatePresence>
                {expanded && (
                    <motion.div
                        initial={{ opacity: 0, y: 4, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 4, scale: 0.97 }}
                        transition={{ duration: 0.12 }}
                        style={{ transformOrigin: 'bottom left' }}
                        className="absolute bottom-full left-0 mb-1.5 w-[260px] max-h-[220px] overflow-y-auto rounded-xl border border-border-subtle bg-bg-elevated shadow-[0_12px_32px_-8px_rgba(0,0,0,0.45)] py-1.5 z-10"
                    >
                        <div className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary">
                            {totalCount} sources
                        </div>
                        {allSources.map((s, i) => {
                            const assetSrc = s.type === 'asset' ? assetEntry(s.id) : undefined;
                            const isClickable =
                                (s.type === 'meeting' && !!onOpenMeeting) ||
                                (s.type === 'asset' && !!assetSrc && !!onOpenAsset);
                            const Tag: any = isClickable ? 'button' : 'div';
                            return (
                                <Tag
                                    key={`${s.type}-${s.id}-${i}`}
                                    {...(isClickable
                                        ? {
                                            onClick: () => {
                                                if (s.type === 'meeting') onOpenMeeting!(s.id);
                                                else onOpenAsset!(assetSrc!);
                                                setExpanded(false);
                                            },
                                        }
                                        : {})}
                                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-text-secondary transition-colors ${isClickable ? 'hover:bg-bg-item-active hover:text-text-primary cursor-pointer' : ''}`}
                                >
                                    <FileText size={12} className="shrink-0 text-text-tertiary" />
                                    <IndexBadge indices={indicesFor(s.id)} />
                                    <span className="truncate flex-1">{s.title}</span>
                                    {isClickable && <ExternalLink size={11} className="shrink-0 text-text-tertiary" />}
                                </Tag>
                            );
                        })}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default SourcesDisplay;
