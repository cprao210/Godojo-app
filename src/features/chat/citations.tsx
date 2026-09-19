// Inline citation chips for chat answers.
//
// The backend streams answers with [n] / [n, m] markers and emits a
// `source_map` frame BEFORE the first token mapping each index to its exact
// source (doc page/section or meeting speaker/section + snippet). This module
// turns those markers into numbered chips with hover cards, and dims chips the
// post-stream `sources_verified` frame flagged as unsupported.
//
// Design notes:
// - A rehype (hast) plugin, not remark: hast element nodes render straight
//   through react-markdown's `components` map, no mdast->hast conversion
//   gymnastics for custom nodes.
// - Text inside links (`[label](url)`), inline code, code blocks, and table
//   cells is skipped — a `[1]` in a table cell is cell content by design (the
//   backend treats it that way too), and `[n](...)` is a markdown link.
// - Markers with no map entry (history reloads, fast-path answers with no
//   source_map) render as plain [n] text — never a dead chip.

import React, { createContext, useContext, useState } from 'react';
import { visit, SKIP } from 'unist-util-visit';
import type { SourceMapEntry } from '@/types';

// Digit-only bracket groups, comma lists allowed: [1] [1, 2] [10,11].
// Negative lookahead keeps markdown links ([text](url)) and reference-style
// definitions out of the match.
const CITE_RE = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?![(\w])/g;

/** Tags whose text is never a citation position. td/th: table cells keep [n]
 *  as literal content; a/code: markup, not prose. */
const SKIP_TAGS = new Set(['a', 'code', 'pre', 'inlineCode', 'td', 'th', 'cite']);

export function rehypeCitations() {
    return (tree: any) => {
        visit(tree, 'element', (node: any) => {
            if (SKIP_TAGS.has(node.tagName)) return SKIP;
            if (!Array.isArray(node.children) || !node.children.some(
                (c: any) => c.type === 'text' && /\[\d{1,2}[, \d]*\]/.test(c.value),
            )) return;
            const out: any[] = [];
            let changed = false;
            for (const child of node.children) {
                if (child.type !== 'text' || !/\[\d{1,2}[, \d]*\]/.test(child.value)) {
                    out.push(child);
                    continue;
                }
                let last = 0;
                for (const m of child.value.matchAll(CITE_RE)) {
                    if (m.index! > last) out.push({ type: 'text', value: child.value.slice(last, m.index) });
                    out.push({
                        type: 'element',
                        tagName: 'cite',
                        properties: { indices: m[1].split(',').map((s: string) => parseInt(s.trim(), 10)) },
                        children: [],
                    });
                    last = m.index! + m[0].length;
                    changed = true;
                }
                if (last < child.value.length) out.push({ type: 'text', value: child.value.slice(last) });
            }
            if (changed) node.children = out;
        });
    };
}

interface CitationCtx {
    map?: Record<number, SourceMapEntry>;
    unverified?: number[];
    onOpenMeeting?: (meetingId: string, startMs?: number) => void;
    /** Doc citations: open the source document (a resolvable file_url from
     * the backend). Optional — without it (or without a resolvable URL) a doc
     * chip pins its preview card open on click instead of doing nothing. */
    onOpenAsset?: (src: SourceMapEntry) => void;
}

const CitationContext = createContext<CitationCtx>({});

/** Wrap a ReactMarkdown surface so its [n] markers resolve to chips. */
export const CitationProvider: React.FC<CitationCtx & { children: React.ReactNode }> = ({
    map, unverified, onOpenMeeting, onOpenAsset, children,
}) => (
    <CitationContext.Provider value={{ map, unverified, onOpenMeeting, onOpenAsset }}>
        {children}
    </CitationContext.Provider>
);

export const indexSourceMap = (entries: SourceMapEntry[]): Record<number, SourceMapEntry> =>
    Object.fromEntries(entries.map(e => [e.index, e]));

const fmtClock = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// NotebookLM-style hover card: title bar with metadata, preview text, and clickable action.
// `pinned` keeps the card visible after a click (hover-only cards are unreachable
// on click/tap devices) until the pointer leaves the chip.
const HoverCard: React.FC<{ src: SourceMapEntry; onOpen?: () => void; pinned?: boolean }> = ({ src, onOpen, pinned }) => {
    // Use enhanced fields from backend when available, fall back to legacy
    const previewText = src.preview_text || src.snippet;

    // Build metadata line: prefer timestamp_label from backend, fall back to formatted start_ms
    const where = src.type === 'doc'
        ? [src.page ? `p. ${src.page}` : null, src.section].filter(Boolean).join(' · ')
        : [
            src.section,
            src.speaker,
            src.timestamp_label || (src.start_ms ? `@ ${fmtClock(src.start_ms)}` : null)
          ].filter(Boolean).join(' · ');

    return (
        <span className={`${pinned ? 'block' : 'hidden'} group-hover:block group-focus-within:block absolute bottom-[130%] left-1/2 -translate-x-1/2 z-50 w-72 overflow-hidden rounded-lg border border-border-subtle bg-bg-item-surface shadow-2xl text-left pointer-events-none`}>
            <span className="block px-3 py-2 text-[12px] font-semibold text-text-primary bg-bg-hover border-b border-border-subtle truncate" title={src.title}>
                {src.title}
            </span>
            <span className="block px-3 py-2.5">
                {where && <span className="block mb-1.5 text-[10.5px] uppercase tracking-wide text-text-tertiary">{where}</span>}
                {previewText && (
                    <span className="block text-[12px] leading-relaxed text-text-secondary whitespace-pre-wrap line-clamp-6">
                        {previewText}
                    </span>
                )}
            </span>
            {onOpen && (
                <span className="block px-3 py-2 border-t border-border-subtle text-[12px] text-blue-400">
                    View source
                </span>
            )}
        </span>
    );
};

/** react-markdown `components.cite` target — renders NotebookLM-style numbered chips */
export const CiteChip: React.FC<{
    indices?: number[] | string;
    node?: any;
} & React.HTMLAttributes<HTMLElement>> = (props) => {
    // react-markdown routes hast properties through hast-util-to-jsx-runtime,
    // which flattens unknown array attributes into a space-joined STRING —
    // `indices` arrives as "1 2", not [1, 2]. The original array survives on
    // the hast node; fall back to re-parsing the flattened string when the
    // node isn't handed to us.
    const raw: unknown = props.node?.properties?.indices ?? props.indices;
    const indices: number[] = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/))
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0);
    const { map, unverified, onOpenMeeting, onOpenAsset } = useContext(CitationContext);
    // Doc chips without a resolvable URL pin their preview card open on click
    // (hover-only cards are unreachable on click/tap devices); keyed by index
    // so a multi-citation chip ([1, 2]) pins one card at a time.
    const [pinnedIdx, setPinnedIdx] = useState<number | null>(null);

    const handleClick = (src: SourceMapEntry, i: number) => {
        // Meeting citations: use onOpenMeeting callback
        if (src.type === 'meeting' && onOpenMeeting && src.id !== 'live') {
            onOpenMeeting(src.id, src.start_ms);
            return;
        }
        // Doc citations: open the real file when a resolvable URL exists.
        // The app-relative asset_url (/assets/{id}#page=n) has no route in
        // this Electron app yet — without file_url, pin the preview card
        // instead of a dead click.
        // TODO: in-app asset viewer routed by asset_url.
        if (src.type === 'doc') {
            if (onOpenAsset && src.file_url) {
                onOpenAsset(src);
                return;
            }
            setPinnedIdx((cur) => (cur === i ? null : i));
        }
    };

    return (
        <>
            {indices.map((i) => {
                const src = map?.[i];
                if (!src) return <sup key={i} className="text-text-tertiary">[{i}]</sup>;

                const dim = unverified?.includes(i);
                const isClickable =
                    (src.type === 'meeting' && onOpenMeeting && src.id !== 'live') ||
                    src.type === 'doc';

                return (
                    <span
                        key={i}
                        // z-0 traps the card in this chip's own stacking context so it
                        // always paints above the surrounding bare inline text; on
                        // hover/focus the whole chip jumps above neighboring content.
                        className="relative z-0 inline-block align-baseline group mx-0.5 hover:z-50 focus-within:z-50"
                        onMouseLeave={() => setPinnedIdx(null)}
                    >
                        <button
                            type="button"
                            onClick={isClickable ? () => handleClick(src, i) : undefined}
                            className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10.5px] font-medium transition-all ${
                                dim
                                    ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 opacity-50'
                                    : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50'
                            } ${
                                isClickable ? 'cursor-pointer' : 'cursor-default'
                            }`}
                        >
                            {i}
                        </button>
                        <HoverCard
                            src={src}
                            pinned={pinnedIdx === i}
                            onOpen={isClickable ? () => handleClick(src, i) : undefined}
                        />
                    </span>
                );
            })}
        </>
    );
};
