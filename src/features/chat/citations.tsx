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

import React, {
    createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
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

// Hover card geometry (px).
const CARD_W = 320;        // preferred width, shrinks on narrow viewports
const CARD_MAX_H = 340;    // taller content scrolls inside the card instead of being cut off
const CARD_MIN_H = 120;
const GAP = 8;             // visual gap between chip and card (bridged, see below)
const EDGE = 8;            // minimum distance kept from the viewport edges
const CLOSE_DELAY = 150;   // ms grace period when the pointer moves chip <-> card

interface CardPos {
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    placement: 'top' | 'bottom';
}

// NotebookLM-style hover card: title bar with metadata, preview text, and clickable action.
//
// Rendered through a portal into <body> with `position: fixed`. The chat
// surfaces wrap messages in `overflow-x-clip` / `overflow-y-auto` / `overflow-hidden`
// containers, and an absolutely-positioned child of the chip gets cut off by
// every one of them. Escaping to <body> makes the card immune to ancestor
// clipping; the position is computed from the chip's viewport rect, clamped to
// the window, and flipped below the chip when there is no room above.
//
// The card is pointer-interactive and reports enter/leave to the chip so it
// stays open while the pointer is over either of them. A transparent padding
// strip on the side facing the chip (the GAP) bridges the space between them,
// so the pointer never "falls off" while travelling from chip to card.
const HoverCard: React.FC<{
    src: SourceMapEntry;
    anchorRef: React.RefObject<HTMLElement>;
    onOpen?: () => void;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
}> = ({ src, anchorRef, onOpen, onPointerEnter, onPointerLeave }) => {
    const bodyRef = useRef<HTMLDivElement>(null);
    // Hidden until the first measurement so the card never flashes at 0,0.
    const [pos, setPos] = useState<CardPos | null>(null);

    // Use enhanced fields from backend when available, fall back to legacy
    const previewText = src.preview_text || src.snippet;

    // Build metadata line: prefer timestamp_label from backend, fall back to formatted start_ms.
    // Live moments already carry "This call, MM:SS" in the title — just the speaker here.
    const where = src.type === 'doc'
        ? [src.page ? `p. ${src.page}` : null, src.section].filter(Boolean).join(' · ')
        : src.type === 'live_moment'
        ? (src.speaker ?? '')
        : [
            src.section,
            src.speaker,
            src.timestamp_label || (src.start_ms ? `@ ${fmtClock(src.start_ms)}` : null)
        ].filter(Boolean).join(' · ');

    const reposition = useCallback(() => {
        const anchor = anchorRef.current;
        const body = bodyRef.current;
        if (!anchor || !body) return;

        const r = anchor.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const width = Math.min(CARD_W, vw - EDGE * 2);
        const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - width / 2, vw - width - EDGE));

        // Natural (unconstrained) height: scrollHeight ignores the current
        // max-height; add the border back since scrollHeight excludes it.
        const natural = body.scrollHeight + (body.offsetHeight - body.clientHeight);

        const spaceAbove = r.top - EDGE - GAP;
        const spaceBelow = vh - r.bottom - EDGE - GAP;
        const placement: CardPos['placement'] =
            natural <= spaceAbove || spaceAbove >= spaceBelow ? 'top' : 'bottom';

        const avail = placement === 'top' ? spaceAbove : spaceBelow;
        const maxHeight = Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, avail));
        const outerH = Math.min(natural, maxHeight) + GAP;
        const top = placement === 'top'
            ? Math.max(EDGE, r.top - outerH)
            : r.bottom;

        setPos((prev) =>
            prev && prev.top === top && prev.left === left && prev.width === width
                && prev.maxHeight === maxHeight && prev.placement === placement
                ? prev
                : { top, left, width, maxHeight, placement },
        );
    }, [anchorRef]);

    // Mounted only while open, so this runs on every open. Keep the card glued
    // to the chip while the chat scrolls (capture: scroll doesn't bubble) or
    // the window resizes.
    useLayoutEffect(() => {
        reposition();
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        return () => {
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
        };
    }, [reposition]);

    return createPortal(
        <div
            onMouseEnter={onPointerEnter}
            onMouseLeave={onPointerLeave}
            style={{
                position: 'fixed',
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                width: pos?.width ?? CARD_W,
                zIndex: 99999,
                visibility: pos ? 'visible' : 'hidden',
                // Transparent hover bridge on the side facing the chip.
                paddingBottom: pos?.placement === 'top' ? GAP : 0,
                paddingTop: pos?.placement === 'bottom' ? GAP : 0,
            }}
        >
            <div
                ref={bodyRef}
                role="tooltip"
                className="custom-scrollbar overflow-y-auto overscroll-contain rounded-lg border border-border-subtle bg-bg-elevated shadow-2xl text-left"
                style={{ maxHeight: pos?.maxHeight ?? CARD_MAX_H }}
            >
                <div className="sticky top-0 px-3 py-2 text-[12px] font-semibold leading-snug text-text-primary bg-bg-hover border-b border-border-subtle break-words">
                    {src.title}
                </div>
                <div className="px-3 py-2.5">
                    {where && <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-text-tertiary">{where}</div>}
                    {previewText && (
                        <div className="text-[12px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
                            {previewText}
                        </div>
                    )}
                </div>
                {onOpen && (
                    <button
                        type="button"
                        onClick={onOpen}
                        className="sticky bottom-0 block w-full px-3 py-2 text-left border-t border-border-subtle bg-bg-elevated text-[12px] text-blue-400 hover:text-blue-300 hover:bg-bg-hover transition-colors cursor-pointer"
                    >
                        View source
                    </button>
                )}
            </div>
        </div>,
        document.body,
    );
};

/** One numbered chip + its hover card. A component of its own (not inlined in
 *  the `indices.map`) so every chip owns its open state and timers. */
const CitationPill: React.FC<{ index: number; src: SourceMapEntry }> = ({ index, src }) => {
    const { unverified, onOpenMeeting, onOpenAsset } = useContext(CitationContext);
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLSpanElement>(null);
    const closeTimer = useRef<number | undefined>(undefined);

    const show = useCallback(() => {
        window.clearTimeout(closeTimer.current);
        setOpen(true);
    }, []);
    // Delayed close: lets the pointer cross from chip to card (and back)
    // without flicker. Any enter on chip or card cancels it via show().
    const hideSoon = useCallback(() => {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY);
    }, []);
    const hideNow = useCallback(() => {
        window.clearTimeout(closeTimer.current);
        setOpen(false);
    }, []);

    useEffect(() => () => window.clearTimeout(closeTimer.current), []);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    const dim = unverified?.includes(index);
    const isClickable =
        (src.type === 'meeting' && !!onOpenMeeting && src.id !== 'live') ||
        src.type === 'doc';

    const handleClick = () => {
        // Meeting citations: use onOpenMeeting callback
        if (src.type === 'meeting' && onOpenMeeting && src.id !== 'live') {
            hideNow();
            onOpenMeeting(src.id, src.start_ms);
            return;
        }
        // Doc citations: open the real file when a resolvable URL exists.
        // The app-relative asset_url (/assets/{id}#page=n) has no route in
        // this Electron app yet — without file_url, just make sure the preview
        // card is showing (covers click/tap devices) instead of a dead click.
        // TODO: in-app asset viewer routed by asset_url.
        if (src.type === 'doc') {
            if (onOpenAsset && src.file_url) {
                hideNow();
                onOpenAsset(src);
                return;
            }
            show();
        }
    };

    return (
        <span ref={anchorRef} className="relative inline-block align-baseline mx-0.5">
            <button
                type="button"
                onClick={isClickable ? handleClick : undefined}
                onMouseEnter={show}
                onMouseLeave={hideSoon}
                onFocus={show}
                onBlur={hideSoon}
                className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10.5px] font-medium transition-all ${dim
                    ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 opacity-50'
                    : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50'
                    } ${isClickable ? 'cursor-pointer' : 'cursor-default'}`}
            >
                {index}
            </button>
            {open && (
                <HoverCard
                    src={src}
                    anchorRef={anchorRef}
                    onOpen={isClickable ? handleClick : undefined}
                    onPointerEnter={show}
                    onPointerLeave={hideSoon}
                />
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
    const { map } = useContext(CitationContext);

    return (
        <>
            {indices.map((i) => {
                const src = map?.[i];
                if (!src) return <sup key={i} className="text-text-tertiary">[{i}]</sup>;
                return <CitationPill key={i} index={i} src={src} />;
            })}
        </>
    );
};