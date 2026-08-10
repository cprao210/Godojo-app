/**
 * useCompanyContext
 * Manages all state and logic for the Company Context tab.
 * Returns state variables, derived data, and action handlers.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { intelligenceApi } from '@/api/intelligenceApi';
import { CompanyContextData, CompanyContextTabProps, CompanyIdentity } from '@/types';
import { Competitor, KnowledgeAsset, TargetPersona } from '@/types';
import { BookOpen, FileText, FlaskConical, Presentation } from 'lucide-react';

// ─── Constants ────────────────────────────────────────────────────────────────
export const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx'];
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

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
>) => {
    // ── Local draft state ──────────────────────────────────────────────────────
    const [draft, setDraft] = useState<CompanyContextData>(() => normalizeContext(companyContext));
    const savedSnapshot = useRef<CompanyContextData>(draft);
    const [isDirty, setIsDirty] = useState(false);

    // ── Modal states ──────────────────────────────────────────────────────────
    const [personaModalOpen, setPersonaModalOpen] = useState(false);
    const [editingPersona, setEditingPersona] = useState<TargetPersona | null>(null);

    const [competitorModalOpen, setCompetitorModalOpen] = useState(false);
    const [editingCompetitor, setEditingCompetitor] = useState<Competitor | null>(null);

    // ── Handlers that open modals ────────────────────────────────────────────
    const openAddPersona = () => {
        setEditingPersona(null);
        setPersonaModalOpen(true);
    };

    const openEditPersona = (p: TargetPersona) => {
        setEditingPersona(p);
        setPersonaModalOpen(true);
    };

    const closePersonaModal = () => {
        setPersonaModalOpen(false);
        setEditingPersona(null);
    };

    const openAddCompetitor = () => {
        setEditingCompetitor(null);
        setCompetitorModalOpen(true);
    };

    const openEditCompetitor = (c: Competitor) => {
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
            const normalized = normalizeContext(companyContext);
            setDraft(normalized);
            savedSnapshot.current = normalized;
            setIsDirty(false);
        }
    }, [companyContext]);

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
        setDraft(prev => ({ ...prev, ...updates }));
        setIsDirty(true);
    }, []);

    const patchIdentity = useCallback((updates: Partial<CompanyIdentity>) => {
        setDraft(prev => ({ ...prev, identity: { ...prev.identity, ...updates } }));
        setIsDirty(true);
    }, []);

    // ── Save ──────────────────────────────────────────────────────────────────
    const handleSave = useCallback(async () => {
        setCompanyError('');
        setCompanySaving(true);
        try {
            const result = await (window as any).electronAPI?.companySaveContext?.(draft);
            if (result?.success) {
                setCompanyContext(draft);
                savedSnapshot.current = draft;
                setIsDirty(false);
                // Trigger reindex (best-effort)
                intelligenceApi.reindexCompanyAssets().catch(err =>
                    console.error('[CompanyContext] Failed to reindex:', err)
                );
            } else {
                setCompanyError(result?.error || 'Save failed');
            }
        } catch (e: any) {
            setCompanyError(e.message || 'Save failed');
        } finally {
            setCompanySaving(false);
        }
    }, [draft, setCompanyContext, setCompanyError, setCompanySaving]);

    const handleDiscard = useCallback(() => {
        setDraft(JSON.parse(JSON.stringify(savedSnapshot.current)));
        setIsDirty(false);
        setCompanyError('');
    }, [setCompanyError]);

    // ── Asset upload ──────────────────────────────────────────────────────────
    const handleUploadAsset = useCallback(async (type: KnowledgeAsset['type']) => {
        try {
            const fileResult = await (window as any).electronAPI?.companySelectFile?.();
            if (fileResult?.cancelled || !fileResult?.files?.length) return;

            for (const file of fileResult.files as { filePath: string; fileName: string; fileSize: number }[]) {
                const ext = file.fileName.slice(file.fileName.lastIndexOf('.')).toLowerCase();
                if (!ALLOWED_EXTENSIONS.includes(ext)) {
                    setCompanyError(`Unsupported file type "${ext}" in "${file.fileName}".`);
                    continue;
                }
                if (file.fileSize > MAX_FILE_SIZE_BYTES) {
                    const mb = (file.fileSize / (1024 * 1024)).toFixed(1);
                    setCompanyError(`"${file.fileName}" is too large (${mb} MB). Max 5 MB.`);
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
                    const mappedAsset = { ...result.asset, label: file.fileName, status: 'mapped' as const };
                    setDraft(prev => ({
                        ...prev,
                        assets: prev.assets.map(a => a.id === tempId ? mappedAsset : a),
                    }));
                    setIsDirty(true);
                    await window.electronAPI?.profileSetMode?.(true);
                } else {
                    setDraft(prev => ({ ...prev, assets: prev.assets.filter(a => a.id !== tempId) }));
                    setCompanyError(result?.error || `Upload failed for "${file.fileName}"`);
                }
            }
        } catch (e: any) {
            setCompanyError(e.message || 'Upload failed');
        } finally {
            setAssetUploading(null);
        }
    }, [setCompanyError, setAssetUploading]);

    const handleDeleteAsset = useCallback((assetId: string) => {
        if (!confirm('Remove this knowledge asset?')) return;
        setDraft(prev => ({ ...prev, assets: prev.assets.filter(a => a.id !== assetId) }));
        setIsDirty(true);
    }, []);

    const handleDeleteAllForType = useCallback((type: KnowledgeAsset['type']) => {
        const cfgLabel = ASSET_CONFIG[type].label;
        if (!confirm(`Remove all ${cfgLabel} files?`)) return;
        setDraft(prev => ({ ...prev, assets: prev.assets.filter(a => a.type !== type) }));
        setIsDirty(true);
    }, []);

    const handleSyncAsset = useCallback((assetId: string) => {
        setDraft(prev => ({
            ...prev,
            assets: prev.assets.map(a =>
                a.id === assetId
                    ? { ...a, status: 'mapped' as const, lastUpdated: new Date().toISOString() }
                    : a
            ),
        }));
        setIsDirty(true);
    }, []);

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