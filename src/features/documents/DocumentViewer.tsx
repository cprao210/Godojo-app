// In-app document viewer for citation chips.
//
// A doc citation opens the stored original (GET /company-assets/{id}/file) at the cited page with
// the quoted lines highlighted: the backend's source_map entry carries `page` and `bbox` — boxes
// in page-relative coordinates (0..1, top-left origin) for the lines that hold the quote. Only
// digital PDFs indexed with pipeline v4+ have boxes; other PDFs open at the page, and non-PDF
// files show the quote with an "Open file" button (the system app).
//
// Opened from anywhere with `openDocumentViewer(src)` — a window event, so chat surfaces don't
// need a callback threaded through them. <DocumentViewerHost/> (mounted once per window) listens.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { SourceMapEntry } from '@/types';
import { documentsApi } from '@/api/documentsApi';

const OPEN_EVENT = 'godojo:open-document';

export interface DocumentTarget {
    id: string;
    title: string;
    page?: number;
    quote?: string;
    bbox?: { page: number; bbox: [number, number, number, number] }[];
}

/** Open the viewer on this citation (no-op in a window without a host). */
export function openDocumentViewer(src: Pick<SourceMapEntry, 'id' | 'title' | 'page' | 'quote' | 'bbox'>): void {
    window.dispatchEvent(new CustomEvent<DocumentTarget>(OPEN_EVENT, {
        detail: { id: src.id, title: src.title, page: src.page, quote: src.quote, bbox: src.bbox },
    }));
}

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<any>; destroy: () => Promise<void> };

let pdfjsPromise: Promise<any> | null = null;
/** pdf.js is ~1 MB: loaded on the first document opened, never at app start. */
function loadPdfjs(): Promise<any> {
    if (!pdfjsPromise) {
        pdfjsPromise = Promise.all([
            import('pdfjs-dist'),
            import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]).then(([lib, worker]) => {
            lib.GlobalWorkerOptions.workerSrc = worker.default;
            return lib;
        });
    }
    return pdfjsPromise;
}

const PdfPage: React.FC<{ doc: PdfDoc; page: number; scale: number; boxes: DocumentTarget['bbox'] }> = ({
    doc, page, scale, boxes,
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);

    useEffect(() => {
        let cancelled = false;
        let task: any;
        (async () => {
            const p = await doc.getPage(page);
            if (cancelled) return;
            const viewport = p.getViewport({ scale });
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ratio = window.devicePixelRatio || 1;
            canvas.width = Math.floor(viewport.width * ratio);
            canvas.height = Math.floor(viewport.height * ratio);
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            setSize({ w: viewport.width, h: viewport.height });
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            task = p.render({ canvasContext: ctx, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
            await task.promise.catch(() => undefined);
        })();
        return () => {
            cancelled = true;
            task?.cancel?.();
        };
    }, [doc, page, scale]);

    const pageBoxes = (boxes || []).filter((b) => b.page === page);
    return (
        <div className="relative mx-auto shadow-lg bg-white" style={size ? { width: size.w, height: size.h } : undefined}>
            <canvas ref={canvasRef} className="block" />
            {size && pageBoxes.map((b, i) => (
                <div
                    key={i}
                    data-testid="doc-highlight"
                    className="absolute rounded-sm pointer-events-none"
                    style={{
                        left: b.bbox[0] * size.w - 2,
                        top: b.bbox[1] * size.h - 2,
                        width: (b.bbox[2] - b.bbox[0]) * size.w + 4,
                        height: (b.bbox[3] - b.bbox[1]) * size.h + 4,
                        background: 'rgba(250, 204, 21, 0.28)',
                        outline: '2px solid rgba(234, 179, 8, 0.85)',
                    }}
                />
            ))}
        </div>
    );
};

export const DocumentViewer: React.FC<{ target: DocumentTarget; onClose: () => void }> = ({ target, onClose }) => {
    const [state, setState] = useState<
        | { kind: 'loading' }
        | { kind: 'pdf'; doc: PdfDoc }
        | { kind: 'other'; url: string; filename: string; mime: string }
        | { kind: 'error'; message: string }
    >({ kind: 'loading' });
    const [page, setPage] = useState(target.page || target.bbox?.[0]?.page || 1);
    const [scale, setScale] = useState(1.3);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        let doc: PdfDoc | null = null;
        let objectUrl: string | null = null;
        setState({ kind: 'loading' });
        documentsApi.file(target.id)
            .then(async ({ data, mime, filename }) => {
                if (cancelled) return;
                if (mime.includes('pdf') || filename.toLowerCase().endsWith('.pdf')) {
                    const pdfjs = await loadPdfjs();
                    doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
                    if (cancelled) { void doc?.destroy(); return; }
                    setPage((p) => Math.min(Math.max(1, p), doc!.numPages));
                    setState({ kind: 'pdf', doc: doc! });
                } else {
                    objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
                    setState({ kind: 'other', url: objectUrl, filename, mime });
                }
            })
            .catch((e) => !cancelled && setState({ kind: 'error', message: e?.message || 'Could not open the document.' }));
        return () => {
            cancelled = true;
            void doc?.destroy();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [target.id]);

    // Bring the first highlight into view once the page has laid out.
    useEffect(() => {
        if (state.kind !== 'pdf') return;
        const t = window.setTimeout(() => {
            scrollRef.current?.querySelector('[data-testid="doc-highlight"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 350);
        return () => window.clearTimeout(t);
    }, [state.kind, page, scale]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            if (state.kind !== 'pdf') return;
            if (e.key === 'ArrowRight') setPage((p) => Math.min(state.doc.numPages, p + 1));
            if (e.key === 'ArrowLeft') setPage((p) => Math.max(1, p - 1));
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, state]);

    const numPages = state.kind === 'pdf' ? state.doc.numPages : 0;
    const btn = 'w-7 h-7 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 transition-colors';

    return createPortal(
        <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
            <div
                role="dialog"
                aria-label={target.title}
                className="flex flex-col w-full max-w-4xl h-full max-h-[92vh] rounded-xl border border-border-subtle bg-bg-elevated shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
                    <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold text-text-primary truncate">{target.title}</div>
                        {target.quote && (
                            <div className="text-[11px] text-text-tertiary truncate" title={target.quote}>“{target.quote}”</div>
                        )}
                    </div>
                    {state.kind === 'pdf' && (
                        <div className="flex items-center gap-1 shrink-0">
                            <button className={btn} onClick={() => setScale((s) => Math.max(0.6, s - 0.2))} title="Zoom out"><ZoomOut size={14} /></button>
                            <button className={btn} onClick={() => setScale((s) => Math.min(3, s + 0.2))} title="Zoom in"><ZoomIn size={14} /></button>
                            <button className={btn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)} title="Previous page"><ChevronLeft size={14} /></button>
                            <span className="text-[11px] text-text-secondary tabular-nums w-14 text-center">{page} / {numPages}</span>
                            <button className={btn} disabled={page >= numPages} onClick={() => setPage((p) => p + 1)} title="Next page"><ChevronRight size={14} /></button>
                        </div>
                    )}
                    <button className={btn} onClick={onClose} title="Close (Esc)"><X size={15} /></button>
                </div>
                <div ref={scrollRef} className="flex-1 overflow-auto custom-scrollbar bg-bg-main p-4">
                    {state.kind === 'loading' && (
                        <div className="h-full flex items-center justify-center text-text-tertiary"><Loader2 className="animate-spin" size={20} /></div>
                    )}
                    {state.kind === 'error' && (
                        <div className="max-w-md mx-auto mt-10 text-center text-[13px] text-text-secondary space-y-3">
                            <p>{state.message}</p>
                            {target.quote && <blockquote className="text-left border-l-2 border-blue-400/60 pl-3 text-text-tertiary">“{target.quote}”</blockquote>}
                        </div>
                    )}
                    {state.kind === 'pdf' && <PdfPage doc={state.doc} page={page} scale={scale} boxes={target.bbox} />}
                    {state.kind === 'other' && (
                        <div className="max-w-md mx-auto mt-10 text-center text-[13px] text-text-secondary space-y-4">
                            {target.page != null && <p>Cited from page / slide {target.page}.</p>}
                            {target.quote && <blockquote className="text-left border-l-2 border-blue-400/60 pl-3 text-text-tertiary">“{target.quote}”</blockquote>}
                            <a
                                href={state.url}
                                download={state.filename}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-600 text-white text-xs hover:bg-blue-500"
                            >
                                <ExternalLink size={12} /> Open {state.filename}
                            </a>
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
};

/** Mount once per window: opens the viewer on `openDocumentViewer(...)`. */
export const DocumentViewerHost: React.FC = () => {
    const [target, setTarget] = useState<DocumentTarget | null>(null);
    useEffect(() => {
        const onOpen = (e: Event) => setTarget((e as CustomEvent<DocumentTarget>).detail);
        window.addEventListener(OPEN_EVENT, onOpen);
        return () => window.removeEventListener(OPEN_EVENT, onOpen);
    }, []);
    const close = useCallback(() => setTarget(null), []);
    return target ? <DocumentViewer key={`${target.id}:${target.page}`} target={target} onClose={close} /> : null;
};
