// Per-document indexing details for the Knowledge Base list (Settings → Company Context).
//
// Collapsed by default; expanding fetches the backend's view of the document:
//   - index status (polled while queued / processing),
//   - quality warnings (missing pages, merged-cell tables, OCR, instruction-like text, conflicts
//     with another document, superseded),
//   - stored versions (each opens in the viewer),
//   - admin actions: re-index from the stored original, visibility, restore a superseded version.
// Contract: the backend's docs/document_rag_api.md.

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Eye, History, Loader2, RotateCcw } from 'lucide-react';
import {
    documentsApi, qualityWarnings,
    type DocumentStatus, type DocumentVersion, type DocumentVisibility,
} from '@/api/documentsApi';
import { openDocumentViewer } from './DocumentViewer';

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
    indexed: { label: 'Indexed', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    queued: { label: 'Queued', cls: 'text-blue-400 border-blue-500/30 bg-blue-500/10' },
    processing: { label: 'Indexing', cls: 'text-blue-400 border-blue-500/30 bg-blue-500/10' },
    empty: { label: 'No text', cls: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
    failed: { label: 'Failed', cls: 'text-red-400 border-red-500/30 bg-red-500/10' },
    unknown: { label: 'Not indexed', cls: 'text-text-tertiary border-border-subtle' },
};

const VISIBILITY_LABEL: Record<DocumentVisibility, string> = {
    tenant: 'Whole team',
    admins: 'Admins only',
    owner: 'Only me',
};

const POLL_MS = 3000;

export const DocumentDetails: React.FC<{ assetId: string; label: string; readOnly?: boolean }> = ({
    assetId, label, readOnly = false,
}) => {
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<DocumentStatus | null>(null);
    const [versions, setVersions] = useState<DocumentVersion[] | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const [s, v] = await Promise.all([
                documentsApi.status(assetId),
                documentsApi.versions(assetId).catch(() => [] as DocumentVersion[]),
            ]);
            setStatus(s);
            setVersions(v);
            setError(null);
        } catch (e: any) {
            setError(e?.message || 'Could not load the document status.');
        }
    }, [assetId]);

    useEffect(() => {
        if (open) void load();
    }, [open, load]);

    // Poll while the server is still working on it.
    useEffect(() => {
        if (!open || !status || !['queued', 'processing'].includes(status.status)) return;
        const t = window.setTimeout(() => void load(), POLL_MS);
        return () => window.clearTimeout(t);
    }, [open, status, load]);

    const act = async (name: string, fn: () => Promise<unknown>) => {
        setBusy(name);
        try {
            await fn();
            await load();
        } catch (e: any) {
            setError(e?.message || 'That didn’t work — try again.');
        } finally {
            setBusy(null);
        }
    };

    const warnings = qualityWarnings(status);
    const badge = STATUS_LABEL[status?.status || ''] || null;
    const small = 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-input transition-colors disabled:opacity-50';

    return (
        <div className="mt-1.5">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-1 text-[10.5px] text-text-tertiary hover:text-text-secondary"
                aria-expanded={open}
            >
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                Index details
                {!open && status && warnings.length > 0 && <AlertTriangle size={10} className="text-amber-400" />}
            </button>
            {open && (
                <div className="mt-1.5 space-y-2 text-[11px] text-text-secondary">
                    {!status && !error && <Loader2 size={12} className="animate-spin text-text-tertiary" />}
                    {error && <p className="text-red-400">{error}</p>}
                    {status && (
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                                {badge && (
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${badge.cls}`}>
                                        {badge.label}{status.status === 'processing' && status.step ? ` · ${status.step}` : ''}
                                    </span>
                                )}
                                {status.chunks != null && <span>{status.chunks} passages</span>}
                                {status.pages_total != null && <span>· {status.pages_total} pages</span>}
                                {status.version != null && <span>· v{status.version}</span>}
                                {status.indexed_at && <span>· indexed {new Date(status.indexed_at).toLocaleDateString()}</span>}
                            </div>
                            {warnings.length > 0 && (
                                <ul className="space-y-1">
                                    {warnings.map((w, i) => (
                                        <li key={i} className="flex gap-1.5 text-amber-400/90">
                                            <AlertTriangle size={11} className="shrink-0 mt-[1px]" />
                                            <span>{w}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div className="flex flex-wrap items-center gap-1.5">
                                <button type="button" className={small} onClick={() => openDocumentViewer({ id: assetId, title: label })}>
                                    <Eye size={11} /> Open
                                </button>
                                {!readOnly && (
                                    <button
                                        type="button"
                                        className={small}
                                        disabled={!!busy || ['queued', 'processing'].includes(status.status)}
                                        onClick={() => act('reindex', () => documentsApi.reindex(assetId))}
                                        title="Rebuild the searchable index from the stored original"
                                    >
                                        {busy === 'reindex' ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />} Re-index
                                    </button>
                                )}
                                {!readOnly && status.is_current === false && (
                                    <button
                                        type="button"
                                        className={small}
                                        disabled={!!busy}
                                        onClick={() => act('restore', () => documentsApi.update(assetId, { is_current: true }))}
                                    >
                                        Restore as current
                                    </button>
                                )}
                                {!readOnly && status.visibility && (
                                    <label className="inline-flex items-center gap-1">
                                        <span className="text-text-tertiary">Visible to</span>
                                        <select
                                            className="bg-bg-input border border-border-subtle rounded-md px-1.5 py-0.5 text-[10.5px] text-text-primary"
                                            value={status.visibility}
                                            disabled={!!busy}
                                            onChange={(e) => {
                                                const visibility = e.target.value as DocumentVisibility;
                                                void act('visibility', () => documentsApi.update(assetId, { visibility }));
                                            }}
                                        >
                                            {(Object.keys(VISIBILITY_LABEL) as DocumentVisibility[]).map((v) => (
                                                <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>
                                            ))}
                                        </select>
                                    </label>
                                )}
                            </div>
                            {versions && versions.length > 1 && (
                                <div>
                                    <div className="flex items-center gap-1 text-text-tertiary mb-1"><History size={11} /> Versions</div>
                                    <ul className="space-y-0.5">
                                        {versions.map((v) => (
                                            <li key={v.version} className="flex items-center gap-2">
                                                <span className="tabular-nums">v{v.version}</span>
                                                <span className="truncate text-text-tertiary">{v.filename}</span>
                                                {v.created_at && <span className="text-text-tertiary">{new Date(v.created_at).toLocaleDateString()}</span>}
                                                {v.duplicate_of && <span className="text-text-tertiary">(same file as another document)</span>}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
};
