/**
 * useCompanyContext
 * Manages all state and logic for the Company Context tab.
 * Returns state variables, derived data, and action handlers.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { intelligenceApi } from '@/api/intelligenceApi';
import { companyContextApi } from '@/api/companyContextApi';
import { ApiError } from '@/lib/apiClient';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import { CompanyContextData, CompanyContextTabProps, CompanyIdentity } from '@/types';
import { Competitor, KnowledgeAsset, TargetPersona } from '@/types';
import { BookOpen, FileText, FlaskConical, Presentation } from 'lucide-react';
import { settingsToast } from '@/lib/settingsToastBus';

// ─── Constants ────────────────────────────────────────────────────────────────
// Images included: the backend's /company-assets/upload routes image files
// through Document AI OCR + Gemini vision (png/jpeg/gif/webp supported), and
// the main-process upload IPC already maps their MIMEs.
export const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.csv', '.xlsx', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Per-asset commit progress streamed from main during the Save-time upload. */
export interface AssetUploadProgress {
    phase: 'uploading' | 'indexing';
    percent: number;
}

export const ASSET_CONFIG: Record<KnowledgeAsset['type'], {
    label: string;
    icon: React.ReactNode;
    accent: string;
    accentBg: string;
    accentBorder: string;
}> = {
    sales_deck: {
        label: 'Sales Deck',
        icon: <Presentation size={18} />,
        accent: '#60a5fa',
        accentBg: 'rgba(96,165,250,0.08)',
        accentBorder: 'rgba(96,165,250,0.2)',
    },
    product_specs: {
        label: 'Product Specs',
        icon: <FlaskConical size={18} />,
        accent: '#a78bfa',
        accentBg: 'rgba(167,139,250,0.08)',
        accentBorder: 'rgba(167,139,250,0.2)',
    },
    case_studies: {
        label: 'Case Studies',
        icon: <BookOpen size={18} />,
        accent: '#34d399',
        accentBg: 'rgba(52,211,153,0.08)',
        accentBorder: 'rgba(52,211,153,0.2)',
    },
    custom: {
        label: 'Custom Asset',
        icon: <FileText size={18} />,
        accent: '#fb923c',
        accentBg: 'rgba(251,146,60,0.08)',
        accentBorder: 'rgba(251,146,60,0.2)',
    },
};

export const STATUS_BADGE: Record<KnowledgeAsset['status'], { label: string; className: string }> = {
    mapped: { label: 'MAPPED', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    processing: { label: 'PROCESSING', className: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
    need_update: { label: 'NEEDS UPDATE', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
};

// ─── Helper: Normalise context ──────────────────────────────────────────────
export const normalizeContext = (ctx: CompanyContextData | null): CompanyContextData => ctx
    ? {
        ...ctx,
        coreValueProposition: ctx.coreValueProposition ?? '',
        assets: ctx.assets ?? [],
        targetPersonas: ctx.targetPersonas ?? [],
        competitors: ctx.competitors ?? [],
        identity: {
            name: ctx.identity?.name ?? '',
            website: ctx.identity?.website ?? '',
            industry: ctx.identity?.industry ?? '',
        },
        completenessBreakdown: ctx.completenessBreakdown ?? {
            hasIdentity: false,
            hasValueProp: false,
            hasAssets: false,
        },
    }
    : {
        identity: { name: '', website: '', industry: '' },
        coreValueProposition: '',
        assets: [],
        targetPersonas: [],
        competitors: [],
        dataCompleteness: 0,
        completenessBreakdown: { hasIdentity: false, hasValueProp: false, hasAssets: false },
    };

export const useCompanyContext = ({
    companyContext,
    setCompanyContext,
    companyLoading,
    companySaving,
    setCompanySaving,
    companyError,
    setCompanyError,
    assetUploading,
    setAssetUploading,
    readOnly = false,
}: Pick<
    CompanyContextTabProps,
    | 'companyContext'
    | 'setCompanyContext'
    | 'companyLoading'
    | 'companySaving'
    | 'setCompanySaving'
    | 'companyError'
    | 'setCompanyError'
    | 'assetUploading'
    | 'setAssetUploading'
    | 'readOnly'
>) => {
    // Every mutating handler below short-circuits when readOnly (team member,
    // not admin). The UI already disables the inputs/buttons via a <fieldset
    // disabled>, and the backend independently 403s any write from a member —
    // this is a third, defense-in-depth layer so a stray call (e.g. a
    // keyboard shortcut bound to Save) can't slip a write through.
    const blockIfReadOnly = () => {
        if (readOnly) {
            settingsToast.error("Only your team's admin can edit company context.");
        }
        return readOnly;
    };

    // ── Local draft state ──────────────────────────────────────────────────────
    const [draft, setDraft] = useState<CompanyContextData>(() => normalizeContext(companyContext));

    // ── Backend commit progress ────────────────────────────────────────────────
    // company:uploadAssetToBackend streams byte-level 'uploading' percents from
    // the main process, then flips to 'indexing' once the bytes are sent — the
    // backend's parse → vision → embed pipeline runs synchronously inside the
    // request, so "indexing" stays indeterminate until the response lands.
    const [assetProgress, setAssetProgress] = useState<Record<string, AssetUploadProgress>>({});

    useEffect(() => {
        const unsubscribe = window.electronAPI?.onCompanyUploadProgress?.((p) => {
            if (!p?.assetId) return;
            setAssetProgress(prev => (
                // Only track assets whose commit is currently in flight —
                // stale events from an aborted/failed Save must not resurrect
                // a bar that has no promise left to clear it.
                prev[p.assetId]
                    ? { ...prev, [p.assetId]: { phase: p.phase, percent: p.percent ?? 0 } }
                    : prev
            ));
        });
        return () => unsubscribe?.();
    }, []);
    const savedSnapshot = useRef<CompanyContextData>(draft);
    const [isDirty, setIsDirty] = useState(false);

    // Asset ids removed in the draft but not yet purged server-side.
    // Actual deletion is deferred until the user clicks Save.
    const pendingDeletedAssetIds = useRef<Set<string>>(new Set());

    // Assets added this session that still need to be pushed to the backend on Save.
    // Keyed by asset id → the info needed to upload (local file path + metadata).
    const pendingUploads = useRef<Map<string, { filePath: string; label: string; type: KnowledgeAsset['type'] }>>(new Map());


    // ── Modal states ──────────────────────────────────────────────────────────
    const [personaModalOpen, setPersonaModalOpen] = useState(false);
    const [editingPersona, setEditingPersona] = useState<TargetPersona | null>(null);

    const [competitorModalOpen, setCompetitorModalOpen] = useState(false);
    const [editingCompetitor, setEditingCompetitor] = useState<Competitor | null>(null);

    // ── Handlers that open modals ────────────────────────────────────────────
    const openAddPersona = () => {
        if (blockIfReadOnly()) return;
        setEditingPersona(null);
        setPersonaModalOpen(true);
    };

    const openEditPersona = (p: TargetPersona) => {
        if (blockIfReadOnly()) return;
        setEditingPersona(p);
        setPersonaModalOpen(true);
    };

    const closePersonaModal = () => {
        setPersonaModalOpen(false);
        setEditingPersona(null);
    };

    const openAddCompetitor = () => {
        if (blockIfReadOnly()) return;
        setEditingCompetitor(null);
        setCompetitorModalOpen(true);
    };

    const openEditCompetitor = (c: Competitor) => {
        if (blockIfReadOnly()) return;
        setEditingCompetitor(c);
        setCompetitorModalOpen(true);
    };

    const closeCompetitorModal = () => {
        setCompetitorModalOpen(false);
        setEditingCompetitor(null);
    };

    // ── Sync draft when context reloads ───────────────────────────────────────
    useEffect(() => {
        if (companyContext) {
            // Never clobber the draft mid-Save: the commit loop's draft (staged
            // rows, upload progress, committed flips) is newer than whatever
            // this reload carries. The next companyContext change after the
            // save settles re-syncs normally.
            if (companySaving || Object.keys(assetProgress).length > 0) return;
            const normalized = normalizeContext(companyContext);
            setDraft(normalized);
            savedSnapshot.current = normalized;
            setIsDirty(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [companyContext]);

    // Hydrate the shared, tenant-scoped asset list from the backend. For a team
    // member this is the ONLY way the admin's uploaded docs appear (local SQLite
    // is per-device); for an admin it reconciles what the backend actually has
    // indexed. Best-effort — falls back silently to local draft.assets.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const backendAssets = await intelligenceApi.listCompanyAssets();
                if (cancelled || !backendAssets?.length) return;
                const mapped: KnowledgeAsset[] = backendAssets.map(a => ({
                    id: a.id,
                    type: (a.type as KnowledgeAsset['type']) ?? 'custom',
                    label: a.label,
                    status: a.status === 'processing' ? 'processing' : 'mapped',
                    lastUpdated: a.last_updated,
                }));
                setDraft(prev => {
                    const localOnly = prev.assets.filter(l => !mapped.some(m => m.id === l.id));
                    const next = { ...prev, assets: [...mapped, ...localOnly] };
                    savedSnapshot.current = { ...savedSnapshot.current, assets: next.assets };
                    return next;
                });
            } catch (err) {
                console.warn('[useCompanyContext] listCompanyAssets failed:', err);
            }
        })();
        return () => { cancelled = true; };
    }, []);


    // ── Derived completeness ──────────────────────────────────────────────────
    const completeness = useMemo(() => {
        const { identity, coreValueProposition, assets } = draft;
        const hasIdentity = !!(identity.name && identity.industry);
        const hasValueProp = coreValueProposition.trim().length > 20;
        const hasAssets = assets.some(a => a.status === 'mapped');
        const score = [hasIdentity, hasValueProp, hasAssets].filter(Boolean).length;
        return Math.round((score / 3) * 100);
    }, [draft]);

    // ── Patch helpers ──────────────────────────────────────────────────────────
    const patch = useCallback((updates: Partial<CompanyContextData>) => {
        if (blockIfReadOnly()) return;
        setDraft(prev => ({ ...prev, ...updates }));
        setIsDirty(true);
    }, [readOnly]);

    const patchIdentity = useCallback((updates: Partial<CompanyIdentity>) => {
        if (blockIfReadOnly()) return;
        setDraft(prev => ({ ...prev, identity: { ...prev.identity, ...updates } }));
        setIsDirty(true);
    }, [readOnly]);

    // ── Save ──────────────────────────────────────────────────────────────────
    // Identity / value prop / personas / competitors go to the FastAPI
    // /company-context routes. There's no bulk endpoint for personas or
    // competitors, so we diff the draft against the last-saved snapshot and
    // issue individual create/update/delete calls for whatever changed.
    // Assets remain on the legacy IPC path (electronAPI.company*) — they're
    // not part of this API and have their own upload/index pipeline.
    const handleSave = useCallback(async () => {
        if (blockIfReadOnly()) return;
        setCompanyError('');
        setCompanySaving(true);
        try {
            // Purge any assets removed in this session before saving the rest.
            const idsToDelete = Array.from(pendingDeletedAssetIds.current);
            for (const assetId of idsToDelete) {
                const delResult = await (window as any).electronAPI?.companyDeleteAsset?.(assetId);
                if (!delResult?.success) {
                    const message = delResult?.error || 'Failed to delete asset';
                    setCompanyError(message);
                    settingsToast.error(message);
                    setCompanySaving(false);
                    return;
                }
            }
            pendingDeletedAssetIds.current.clear();

            // Commit staged asset uploads to the backend now (chunking + embeddings happen
            // server-side here, not on the upload button). Do this before reindex so vectors exist.
            const uploads = Array.from(pendingUploads.current.entries());
            const committedAssetIds = new Set<string>();
            for (const [assetId, info] of uploads) {
                setAssetProgress(prev => ({ ...prev, [assetId]: { phase: 'uploading', percent: 0 } }));
                try {
                    await intelligenceApi.uploadCompanyAsset({
                        filePath: info.filePath,
                        assetId,
                        label: info.label,
                        assetType: info.type,
                    });
                    committedAssetIds.add(assetId);
                    pendingUploads.current.delete(assetId);
                    // Flip the committed asset to 'mapped' in the draft and drop the
                    // staged file — it's on the server now; the draft doesn't need to
                    // hold a base64 copy of an indexed document.
                    setDraft(prev => ({
                        ...prev,
                        assets: prev.assets.map(a => a.id === assetId
                            ? { ...a, status: 'mapped' as const, fileData: undefined }
                            : a),
                    }));
                } catch (err: any) {
                    const message = err?.status === 415
                        ? err.message
                        : err?.code === 'timeout'
                            ? 'The server is still indexing this document — large PDFs can take a few minutes. Keep this window open and try Save again shortly; the file may already have finished indexing.'
                            : err?.status === 403
                                ? "Only your team's admin can upload company assets."
                                : (err?.message ? `Backend upload failed for "${info.label}": ${err.message}` : `Backend upload failed for "${info.label}"`);

                    console.log("upload error:: ", err);
                    setCompanyError(message);
                    settingsToast.error(message);
                    setCompanySaving(false);
                    setAssetProgress(prev => {
                        const next = { ...prev };
                        delete next[assetId];
                        return next;
                    });
                    return; // leave remaining uploads staged + isDirty true so the user can retry Save
                }
                setAssetProgress(prev => {
                    const next = { ...prev };
                    delete next[assetId];
                    return next;
                });
            }

            // 1. Upsert the singleton identity + value prop fields.
            await companyContextApi.upsert({
                name: draft.identity.name,
                website: draft.identity.website,
                industry: draft.identity.industry,
                core_value_proposition: draft.coreValueProposition,
            });

            // 2. Diff + sync personas against what was last saved.
            const savedPersonas = savedSnapshot.current.targetPersonas;
            const savedPersonaIds = new Set(savedPersonas.map(p => p.id));
            const draftPersonaIds = new Set(draft.targetPersonas.map(p => p.id));

            for (const p of savedPersonas) {
                if (!draftPersonaIds.has(p.id)) {
                    await companyContextApi.deletePersona(p.id);
                }
            }
            for (const [i, p] of draft.targetPersonas.entries()) {
                if (savedPersonaIds.has(p.id)) {
                    await companyContextApi.updatePersona(p.id, { role: p.role, description: p.description, sort_order: i });
                } else {
                    await companyContextApi.createPersona({ id: p.id, role: p.role, description: p.description, sort_order: i });
                }
            }

            // 3. Diff + sync competitors the same way.
            const savedCompetitors = savedSnapshot.current.competitors;
            const savedCompetitorIds = new Set(savedCompetitors.map(c => c.id));
            const draftCompetitorIds = new Set(draft.competitors.map(c => c.id));

            for (const c of savedCompetitors) {
                if (!draftCompetitorIds.has(c.id)) {
                    await companyContextApi.deleteCompetitor(c.id);
                }
            }
            for (const [i, c] of draft.competitors.entries()) {
                if (savedCompetitorIds.has(c.id)) {
                    await companyContextApi.updateCompetitor(c.id, { name: c.name, moat: c.moat, win_rate: c.winRate, sort_order: i });
                } else {
                    await companyContextApi.createCompetitor({ id: c.id, name: c.name, moat: c.moat, win_rate: c.winRate, sort_order: i });
                }
            }

            // 4. Mirror assets into the local SQLite store. This used to be the
            // ONLY path that POSTed a staged file to /company-assets/upload —
            // step above now owns that (once per asset; the backend endpoint is
            // fully synchronous, so doing it twice per Save meant two complete
            // vision+embedding pipelines per document). companySaveContext still
            // persists local state and re-mirrors identity/personas/competitors
            // into SQLite, which company:getContext uses as its offline
            // fallback — so this call stays, with committed assets' staged
            // bytes stripped (the `draft` closure here predates the commit
            // loop's setDraft calls, so the stripping is applied explicitly).
            const draftForSave = committedAssetIds.size
                ? {
                    ...draft,
                    assets: draft.assets.map(a => committedAssetIds.has(a.id)
                        ? { ...a, fileData: undefined, status: 'mapped' as const }
                        : a),
                }
                : draft;
            const assetSaveResult = await (window as any).electronAPI?.companySaveContext?.(draftForSave);
            if (!assetSaveResult?.success) {
                const message = assetSaveResult?.error || 'Failed to save uploaded documents';
                setCompanyError(message);
                settingsToast.error(message);
                setCompanySaving(false);
                return; // isDirty stays true so the user can retry Save
            }

            posthogAnalytics.trackCompanyContextSave();
            // Publish the SAME committed-aware draft handed to companySaveContext
            // above — the raw `draft` closure predates the commit loop's flips, so
            // publishing it would re-seed the tab (and the [companyContext]
            // draft-sync effect) with pre-commit 'processing' rows.
            setCompanyContext(draftForSave);
            savedSnapshot.current = draftForSave;
            setIsDirty(false);
            settingsToast.success('Saved Successfully');
            // Native cross-screen toast — same pipeline as "Summary Ready" and the
            // meeting pause/resume toasts, so the result follows the user even if
            // they've left the app while a large document was indexing (the
            // backend's upload endpoint runs its full parse → vision → embed
            // pipeline synchronously, which can take minutes).
            const assetNote = committedAssetIds.size > 0
                ? ` ${committedAssetIds.size} document${committedAssetIds.size === 1 ? '' : 's'} uploaded and indexed.`
                : '';
            window.electronAPI?.showAppNotification?.(
                'Company Context Saved',
                `Your company knowledge base is up to date.${assetNote}`,
            ).catch(() => { });
            // Trigger reindex (best-effort)
            intelligenceApi.reindexCompanyAssets().catch(err =>
                console.error('[CompanyContext] Failed to reindex:', err)
            );
        } catch (e: any) {
            // A tenant member trying to write shared context gets a clear
            // permissions message instead of a generic "save failed".
            const message = e instanceof ApiError && e.code === 'forbidden'
                ? "You don't have permission to edit your team's company context."
                : e.message || 'Save failed';
            setCompanyError(message);
            settingsToast.error(message);
        } finally {
            setCompanySaving(false);
        }
    }, [draft, setCompanyContext, setCompanyError, setCompanySaving, readOnly]);

    const handleDiscard = useCallback(() => {
        if (blockIfReadOnly()) return;
        // Undo any queued-but-unsaved deletions along with the rest of the draft.
        pendingDeletedAssetIds.current.clear();
        pendingUploads.current.clear();
        setDraft(JSON.parse(JSON.stringify(savedSnapshot.current)));
        setIsDirty(false);
        setCompanyError('');
    }, [setCompanyError, readOnly]);

    // ── Asset upload ──────────────────────────────────────────────────────────
    const handleUploadAsset = useCallback(async (type: KnowledgeAsset['type']) => {
        if (blockIfReadOnly()) return;
        try {
            const fileResult = await (window as any).electronAPI?.companySelectFile?.();
            if (fileResult?.cancelled || !fileResult?.files?.length) return;

            for (const file of fileResult.files as { filePath: string; fileName: string; fileSize: number }[]) {
                const ext = file.fileName.slice(file.fileName.lastIndexOf('.')).toLowerCase();
                if (!ALLOWED_EXTENSIONS.includes(ext)) {
                    settingsToast.error(`Unsupported file type "${ext}"`);
                    setCompanyError(`Unsupported file type "${ext}" in "${file.fileName}".`);
                    posthogAnalytics.trackDocumentUploadFailed('unsupported_type');
                    continue;
                }
                if (file.fileSize > MAX_FILE_SIZE_BYTES) {
                    const mb = (file.fileSize / (1024 * 1024)).toFixed(1);
                    setCompanyError(`"${file.fileName}" is too large (${mb} MB). Max 5 MB.`);
                    settingsToast.error(`File size exceeds. Max 5 MB.`);
                    posthogAnalytics.trackDocumentUploadFailed('too_large');
                    continue;
                }

                const tempId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                setAssetUploading(tempId);

                const placeholder: KnowledgeAsset = {
                    id: tempId,
                    type,
                    label: file.fileName,
                    status: 'processing',
                    lastUpdated: new Date().toISOString(),
                };
                setDraft(prev => ({ ...prev, assets: [...prev.assets, placeholder] }));

                const result = await (window as any).electronAPI?.companyUploadAsset?.(type, file.filePath);
                if (result?.success && result.asset) {
                    const backendAssetId = result.asset.id ?? tempId;
                    const mappedAsset = { ...result.asset, id: backendAssetId, label: file.fileName, status: 'processing' as const };
                    setDraft(prev => ({
                        ...prev,
                        assets: prev.assets.map(a => a.id === tempId ? mappedAsset : a),
                    }));
                    // Stage for backend upload on Save — nothing is chunked/embedded server-side
                    // until the user commits with "Save Intelligence Base".
                    pendingUploads.current.set(backendAssetId, {
                        filePath: file.filePath,
                        label: file.fileName,
                        type,
                    });
                    setIsDirty(true);
                    posthogAnalytics.trackDocumentUploadCompleted(type);
                    await window.electronAPI?.profileSetMode?.(true);

                } else {

                    setDraft(prev => ({ ...prev, assets: prev.assets.filter(a => a.id !== tempId) }));
                    setCompanyError(result?.error || `Upload failed for "${file.fileName}"`);
                    settingsToast.error(`Upload failed for "${file.fileName}"`);
                    posthogAnalytics.trackDocumentUploadFailed('upload_error');
                }
            }
        } catch (e: any) {
            setCompanyError(e.message || 'Upload failed');
            settingsToast.error(`Upload failed!`);
        } finally {
            setAssetUploading(null);
        }
    }, [setCompanyError, setAssetUploading, readOnly]);

    const handleDeleteAsset = useCallback(async (assetId: string) => {
        if (blockIfReadOnly()) return;
        if (!confirm('Remove this knowledge asset?')) return;
        // If it was only staged this session (never uploaded to the backend), just
        // drop the staged upload — no server-side delete needed.
        if (pendingUploads.current.has(assetId)) {
            pendingUploads.current.delete(assetId);
        } else {
            pendingDeletedAssetIds.current.add(assetId);
        }
        setDraft(prev => ({ ...prev, assets: prev.assets.filter(a => a.id !== assetId) }));
        setIsDirty(true);
    }, [readOnly]);

    const handleDeleteAllForType = useCallback((type: KnowledgeAsset['type']) => {
        if (blockIfReadOnly()) return;
        const cfgLabel = ASSET_CONFIG[type].label;
        if (!confirm(`Remove all ${cfgLabel} files?`)) return;
        setDraft(prev => {
            prev.assets.filter(a => a.type === type).forEach(a => {
                if (pendingUploads.current.has(a.id)) pendingUploads.current.delete(a.id);
                else pendingDeletedAssetIds.current.add(a.id);
            });
            return { ...prev, assets: prev.assets.filter(a => a.type !== type) };
        });

        setIsDirty(true);
    }, [readOnly]);

    const handleSyncAsset = useCallback((assetId: string) => {
        if (blockIfReadOnly()) return;
        setDraft(prev => ({
            ...prev,
            assets: prev.assets.map(a =>
                a.id === assetId
                    ? { ...a, status: 'mapped' as const, lastUpdated: new Date().toISOString() }
                    : a
            ),
        }));
        setIsDirty(true);
    }, [readOnly]);

    // ── Persona CRUD ──────────────────────────────────────────────────────────
    const handlePersonaSave = useCallback((p: TargetPersona) => {
        const exists = draft.targetPersonas.some(x => x.id === p.id);
        patch({
            targetPersonas: exists
                ? draft.targetPersonas.map(x => x.id === p.id ? p : x)
                : [...draft.targetPersonas, p],
        });
    }, [draft.targetPersonas, patch]);

    const handlePersonaDelete = useCallback((id: string) => {
        patch({ targetPersonas: draft.targetPersonas.filter(p => p.id !== id) });
    }, [draft.targetPersonas, patch]);

    // ── Competitor CRUD ────────────────────────────────────────────────────────
    const handleCompetitorSave = useCallback((c: Competitor) => {
        const exists = draft.competitors.some(x => x.id === c.id);
        patch({
            competitors: exists
                ? draft.competitors.map(x => x.id === c.id ? c : x)
                : [...draft.competitors, c],
        });
    }, [draft.competitors, patch]);

    const handleCompetitorDelete = useCallback((id: string) => {
        patch({ competitors: draft.competitors.filter(c => c.id !== id) });
    }, [draft.competitors, patch]);

    // ── Enable profile mode when mapped assets exist ────────────────────────
    useEffect(() => {
        if (!window.electronAPI) return;
        const hasMapped = companyContext?.assets?.some(a => a.status === 'mapped');
        if (hasMapped) {
            window.electronAPI?.profileSetMode?.(true).catch(() => { });
        }
    }, [companyContext]);

    return {
        draft,
        completeness,
        isDirty,
        companyLoading,
        companySaving,
        companyError,
        assetUploading,
        assetProgress,
        patch,
        patchIdentity,
        handleSave,
        handleDiscard,
        handleUploadAsset,
        handleDeleteAsset,
        handleDeleteAllForType,
        handleSyncAsset,
        handlePersonaSave,
        handlePersonaDelete,
        handleCompetitorSave,
        handleCompetitorDelete,
        setCompanyError,
        personaModalOpen,
        editingPersona,
        competitorModalOpen,
        editingCompetitor,
        openAddPersona,
        openEditPersona,
        closePersonaModal,
        openAddCompetitor,
        openEditCompetitor,
        closeCompetitorModal
    };
};