import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
    Building2, Globe, Layers, FileText, RefreshCw,
    Trash2, AlertCircle, X, BarChart2,
    BookOpen, Presentation, FlaskConical, Plus, ExternalLink,
    Users, Swords, MoreVertical, Edit2, Save, Zap, Info,
} from 'lucide-react';
import { intelligenceApi } from '../../lib/intelligenceApi';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompanyIdentity {
    name: string;
    website: string;
    industry: string;
}

export interface KnowledgeAsset {
    id: string;
    type: 'sales_deck' | 'product_specs' | 'case_studies' | 'custom';
    label: string;
    status: 'mapped' | 'processing' | 'need_update';
    lastUpdated?: string;
    filePath?: string;
}

export interface TargetPersona {
    id: string;
    role: string;
    description: string;
}

export interface Competitor {
    id: string;
    name: string;
    moat: string;
    winRate: number;
}

export interface CompanyContextData {
    identity: CompanyIdentity;
    coreValueProposition: string;
    assets: KnowledgeAsset[];
    targetPersonas: TargetPersona[];
    competitors: Competitor[];
    dataCompleteness: number;
    completenessBreakdown: {
        hasIdentity: boolean;
        hasValueProp: boolean;
        hasAssets: boolean;
    };
}

interface CompanyContextTabProps {
    companyContext: CompanyContextData | null;
    setCompanyContext: (d: CompanyContextData | null) => void;
    companyLoading: boolean;
    setCompanyLoading: (v: boolean) => void;
    companySaving: boolean;
    setCompanySaving: (v: boolean) => void;
    companyError: string;
    setCompanyError: (v: string) => void;
    assetUploading: string | null;
    setAssetUploading: (id: string | null) => void;
    isPremium?: boolean;
    setIsPremiumModalOpen?: (v: boolean) => void;
    isLight: boolean;
}

// ─── Completeness Ring ────────────────────────────────────────────────────────

const CompletenessRing = ({ percentage }: { percentage: number }) => {
    const r = 22;
    const circ = 2 * Math.PI * r;
    const offset = circ - (percentage / 100) * circ;
    const color = percentage >= 75 ? '#10b981' : percentage >= 40 ? '#f59e0b' : '#6b7280';
    return (
        <div className="relative w-14 h-14 flex items-center justify-center shrink-0">
            <svg width="56" height="56" className="-rotate-90" viewBox="0 0 56 56">
                <circle cx="28" cy="28" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
                <circle
                    cx="28" cy="28" r={r} fill="none"
                    stroke={color} strokeWidth="4"
                    strokeDasharray={circ}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.4s ease' }}
                />
            </svg>
            <span className="absolute text-[11px] font-bold text-text-primary" style={{ color }}>
                {percentage}%
            </span>
        </div>
    );
};

const STATUS_BADGE: Record<KnowledgeAsset['status'], { label: string; className: string }> = {
    mapped: { label: 'MAPPED', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    processing: { label: 'PROCESSING', className: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
    need_update: { label: 'NEEDS UPDATE', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
};


// ── Asset upload ──────────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx'];
const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// ─── Asset type config ────────────────────────────────────────────────────────

const ASSET_CONFIG: Record<KnowledgeAsset['type'], {
    label: string; icon: React.ReactNode; accent: string; accentBg: string; accentBorder: string;
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

// ─── Meatball Menu ────────────────────────────────────────────────────────────
interface MeatballMenuProps {
    onEdit: () => void;
    onDelete: () => void;
    isLight: boolean;
    direction?: 'down' | 'up';
}
const MeatballMenu: React.FC<MeatballMenuProps> = ({ onEdit, onDelete, isLight, direction = 'down' }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        if (open) document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(v => !v)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-input transition-all border border-transparent hover:border-border-subtle"
                title="More options"
            >
                <MoreVertical size={14} />
            </button>
            {open && (
                <div
                    className={`absolute right-0 z-50 min-w-[130px] rounded-xl border shadow-xl py-1 ${direction === 'up' ? 'bottom-8' : 'top-8'} ${isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-border-subtle'}`}
                    style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.32)' }}
                >
                    <button
                        onClick={() => { setOpen(false); onEdit(); }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-text-primary hover:bg-bg-input transition-colors"
                    >
                        <Edit2 size={12} className="text-text-tertiary" /> Edit
                    </button>
                    <button
                        onClick={() => { setOpen(false); onDelete(); }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                        <Trash2 size={12} /> Delete
                    </button>
                </div>
            )}
        </div>
    );
};

// ─── Persona Modal ────────────────────────────────────────────────────────────
interface PersonaModalProps {
    persona: TargetPersona | null; // null = add mode
    onSave: (p: TargetPersona) => void;
    onClose: () => void;
    isLight: boolean;
}
const PersonaModal: React.FC<PersonaModalProps> = ({ persona, onSave, onClose, isLight }) => {
    const [role, setRole] = useState(persona?.role ?? '');
    const [description, setDescription] = useState(persona?.description ?? '');

    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-blue-500/30 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-accent-primary/20 focus:border-accent-primary/50';

    const handleSave = () => {
        if (!role.trim()) return;
        onSave({
            id: persona?.id ?? `persona-${Date.now()}`,
            role: role.trim(),
            description: description.trim(),
        });
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={onClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className={`relative w-full max-w-md rounded-2xl border shadow-2xl ${isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-border-subtle'}`}
                onClick={e => e.stopPropagation()}
                style={{ boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border-subtle">
                    <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                            <Users size={14} className="text-indigo-400" />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">
                            {persona ? 'Edit Persona' : 'Add New Persona'}
                        </h3>
                    </div>
                    <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-input transition-all">
                        <X size={14} />
                    </button>
                </div>

                {/* Body */}
                <div className="p-5 space-y-4">

                    {/* Role */}
                    <div>
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1.5 block">Role / Title *</label>
                        <input
                            autoFocus
                            type="text"
                            value={role}
                            onChange={e => setRole(e.target.value)}
                            placeholder="e.g. Chief Tech Officer"
                            className={`w-full rounded-lg border px-3 py-2 text-xs font-semibold outline-none transition-all focus:ring-1 ${inputCls}`}
                        />
                    </div>

                    {/* Description */}
                    <div>
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1.5 block">Description</label>
                        <textarea
                            rows={3}
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            placeholder="Focused on scalability, security compliance, and ROI on legacy migration."
                            className={`w-full rounded-lg border px-3 py-2 text-xs outline-none transition-all focus:ring-1 resize-none leading-relaxed ${inputCls}`}
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 px-5 pb-5">
                    <button
                        onClick={onClose}
                        className="px-4 py-1.5 rounded-full text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-input transition-all border border-border-subtle"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!role.trim()}
                        className="px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed bg-indigo-500 text-white hover:bg-indigo-400 shadow"
                    >
                        <Save size={11} />
                        {persona ? 'Save Changes' : 'Add Persona'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// ─── Competitor Modal ─────────────────────────────────────────────────────────
interface CompetitorModalProps {
    competitor: Competitor | null; // null = add mode
    onSave: (c: Competitor) => void;
    onClose: () => void;
    isLight: boolean;
}
const CompetitorModal: React.FC<CompetitorModalProps> = ({ competitor, onSave, onClose, isLight }) => {
    const [name, setName] = useState(competitor?.name ?? '');
    const [moat, setMoat] = useState(competitor?.moat ?? '');
    const [winRate, setWinRate] = useState(competitor?.winRate ?? 50);

    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-blue-500/30 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-accent-primary/20 focus:border-accent-primary/50';

    const winColor = winRate >= 60 ? '#6366f1' : winRate >= 40 ? '#f59e0b' : '#ef4444';

    const handleSave = () => {
        if (!name.trim()) return;
        onSave({
            id: competitor?.id ?? `comp-${Date.now()}`,
            name: name.trim(),
            moat: moat.trim(),
            winRate,
        });
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={onClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className={`relative w-full max-w-md rounded-2xl border shadow-2xl ${isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-border-subtle'}`}
                onClick={e => e.stopPropagation()}
                style={{ boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border-subtle">
                    <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                            <Swords size={14} className="text-violet-400" />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">
                            {competitor ? 'Edit Competitor' : 'Add Competitor'}
                        </h3>
                    </div>
                    <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-input transition-all">
                        <X size={14} />
                    </button>
                </div>

                {/* Body */}
                <div className="p-5 space-y-4">
                    <div>
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1.5 block">Competitor Name *</label>
                        <input
                            autoFocus
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="e.g. Stratosphere AI"
                            className={`w-full rounded-lg border px-3 py-2 text-xs font-semibold outline-none transition-all focus:ring-1 ${inputCls}`}
                        />
                    </div>

                    <div>
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1.5 block">Our Moat</label>
                        <input
                            type="text"
                            value={moat}
                            onChange={e => setMoat(e.target.value)}
                            placeholder="e.g. Legacy Integration"
                            className={`w-full rounded-lg border px-3 py-2 text-xs outline-none transition-all focus:ring-1 ${inputCls}`}
                        />
                        <p className="text-[10px] text-text-tertiary mt-1">Our key differentiator against this competitor</p>
                    </div>

                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider">Win-Rate</label>
                            <span className="text-sm font-bold" style={{ color: winColor }}>{winRate}%</span>
                        </div>
                        {/* Visual bar */}
                        <div className="h-2 rounded-full bg-bg-input border border-border-subtle overflow-hidden mb-4">
                            <div
                                className="h-full rounded-full transition-all duration-200"
                                style={{ width: `${winRate}%`, background: winColor }}
                            />
                        </div>
                        <input
                            type="range"
                            min={0} max={100}
                            value={winRate}
                            onChange={e => setWinRate(Number(e.target.value))}
                            className="w-full h-1.5 rounded-full appearance-none bg-slate-500/10 dark:bg-bg-input accent-accent-primary"
                            style={{ WebkitAppearance: 'none' } as React.CSSProperties}
                        />
                        <div className="flex justify-between text-[9px] text-text-tertiary mt-0.5">
                            <span>0%</span><span>50%</span><span>100%</span>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 px-5 pb-5">
                    <button
                        onClick={onClose}
                        className="px-4 py-1.5 rounded-full text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-input transition-all border border-border-subtle"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!name.trim()}
                        className="px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed bg-violet-500 text-white hover:bg-violet-400 shadow"
                    >
                        <Save size={11} />
                        {competitor ? 'Save Changes' : 'Add Competitor'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// ─── Main Component ───────────────────────────────────────────────────────────

export const CompanyContextTab: React.FC<CompanyContextTabProps> = ({
    companyContext,
    setCompanyContext,
    // companyLoading,
    // setCompanyLoading,
    companySaving,
    setCompanySaving,
    companyError,
    setCompanyError,
    assetUploading,
    setAssetUploading,
    // isPremium,
    // setIsPremiumModalOpen,
    isLight,
}) => {
    // Local draft state
    const normalizeContext = (ctx: CompanyContextData | null): CompanyContextData => ctx ? {
        ...ctx,
        coreValueProposition: ctx.coreValueProposition ?? '',
        assets: ctx.assets ?? [],
        targetPersonas: ctx.targetPersonas ?? [],
        competitors: ctx.competitors ?? [],
        identity: {
            name: ctx.identity?.name ?? '',
            website: ctx.identity?.website ?? '',
            industry: ctx.identity?.industry ?? '',
            // personaEngineEnabled: ctx.identity?.personaEngineEnabled ?? false,
        },
        completenessBreakdown: ctx.completenessBreakdown ?? { hasIdentity: false, hasValueProp: false, hasAssets: false },
    } : {
        identity: { name: '', website: '', industry: '' },
        coreValueProposition: '',
        assets: [],
        targetPersonas: [],
        competitors: [],
        dataCompleteness: 0,
        completenessBreakdown: { hasIdentity: false, hasValueProp: false, hasAssets: false },
    };

    const [draft, setDraft] = useState<CompanyContextData>(() => normalizeContext(companyContext));
    const savedSnapshot = useRef<CompanyContextData>(draft);

    const [isDirty, setIsDirty] = useState(false);

    // Persona modal state
    const [personaModalOpen, setPersonaModalOpen] = useState(false);
    const [editingPersona, setEditingPersona] = useState<TargetPersona | null>(null);

    // Competitor modal state
    const [competitorModalOpen, setCompetitorModalOpen] = useState(false);
    const [editingCompetitor, setEditingCompetitor] = useState<Competitor | null>(null);

    // Sync draft when context reloads (e.g. on tab re-entry)
    React.useEffect(() => {
        if (companyContext) {
            const normalized = normalizeContext(companyContext);
            setDraft(normalized);
            savedSnapshot.current = normalized;
            setIsDirty(false);
        }
    }, [companyContext]);

    // Derived completeness
    const completeness = React.useMemo(() => {
        const { identity, coreValueProposition, assets } = draft;
        const hasIdentity = !!(identity.name && identity.industry);
        const hasValueProp = coreValueProposition.trim().length > 20;
        const hasAssets = assets.some(a => a.status === 'mapped');
        const score = [hasIdentity, hasValueProp, hasAssets].filter(Boolean).length;
        return Math.round((score / 3) * 100);
    }, [draft]);

    const patch = useCallback((updates: Partial<CompanyContextData>) => {
        setDraft(prev => ({ ...prev, ...updates }));
        setIsDirty(true);
    }, []);

    const patchIdentity = useCallback((updates: Partial<CompanyIdentity>) => {
        setDraft(prev => ({ ...prev, identity: { ...prev.identity, ...updates } }));
        setIsDirty(true);
    }, []);

    // ── Save ──────────────────────────────────────────────────────────────────
    const handleSave = async () => {
        // if (!isPremium) { setIsPremiumModalOpen(true); return; }
        setCompanyError('');
        setCompanySaving(true);
        try {
            const result = await (window as any).electronAPI?.companySaveContext?.(draft);
            if (result?.success) {
                setCompanyContext(draft);
                savedSnapshot.current = draft;
                setIsDirty(false);
            } else {
                setCompanyError(result?.error || 'Save failed');
            }
        } catch (e: any) {
            setCompanyError(e.message || 'Save failed');
        } finally {
            setCompanySaving(false);
        }
    };

    const handleDiscard = () => {
        // Deep-clone the snapshot so nested arrays (assets, targetPersonas, competitors)
        // don't share references with the saved snapshot after discard.
        setDraft(JSON.parse(JSON.stringify(savedSnapshot.current)));
        setIsDirty(false);
        setCompanyError('');
    };

    // ── Asset upload ──────────────────────────────────────────────────────────
    const handleUploadAsset = async (type: KnowledgeAsset['type']) => {
        // if (!isPremium) { setIsPremiumModalOpen(true); return; }
        try {
            const fileResult = await (window as any).electronAPI?.companySelectFile?.();
            if (fileResult?.cancelled || !fileResult?.filePath) return;

            // ── Validate format ───────────────────────────────────────────────
            const filePath: string = fileResult.filePath;
            const fileName: string = fileResult.fileName ?? filePath.split(/[\\/]/).pop() ?? '';
            const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();

            if (!ALLOWED_EXTENSIONS.includes(ext)) {
                setCompanyError(`Unsupported file type "${ext}". Please upload a PDF, Word (.doc / .docx), or PowerPoint (.ppt / .pptx) file.`);
                return;
            }

            // ── Validate size ─────────────────────────────────────────────────
            // fileResult.fileSize is populated by the Electron file-picker IPC handler.
            // If the backend doesn't return it yet, fall back to a fetch-based check.
            const fileSize: number | undefined = fileResult.fileSize;
            if (fileSize !== undefined && fileSize > MAX_FILE_SIZE_BYTES) {
                const mb = (fileSize / (1024 * 1024)).toFixed(1);
                setCompanyError(`File is too large (${mb} MB). Maximum allowed size is 5 MB.`);
                return;
            }

            // ── Proceed with upload ───────────────────────────────────────────
            const tempId = `${type}-${Date.now()}`;
            setAssetUploading(tempId);

            const placeholder: KnowledgeAsset = {
                id: tempId, type, label: ASSET_CONFIG[type].label,
                status: 'processing', lastUpdated: new Date().toISOString(),
            };
            setDraft(prev => ({ ...prev, assets: [...prev.assets.filter(a => a.type !== type), placeholder] }));

            const result = await (window as any).electronAPI?.companyUploadAsset?.(type, filePath);
            if (result?.success && result.asset) {
                // Mark as 'mapped' immediately so the Knowledge Mode toggle is enabled
                const mappedAsset = { ...result.asset, status: 'mapped' as const };
                setDraft(prev => ({
                    ...prev,
                    assets: prev.assets.map(a => a.id === tempId ? mappedAsset : a),
                }));
                setIsDirty(true);
                await window.electronAPI?.profileSetMode?.(true);

                // Let the backend know the asset set changed so it re-indexes for
                // RAG. Best-effort — the upload itself already succeeded (it's an
                // Electron-local operation), so a reindex failure shouldn't surface
                // as an upload error to the user, just get logged.
                intelligenceApi.reindexCompanyAssets().catch(err =>
                    console.error('[CompanyContextTab] Failed to reindex company assets:', err)
                );

            } else {
                setDraft(prev => ({ ...prev, assets: prev.assets.filter(a => a.id !== tempId) }));
                setCompanyError(result?.error || 'Upload failed');
            }
        } catch (e: any) {
            setCompanyError(e.message || 'Upload failed');
        } finally {
            setAssetUploading(null);
        }
    };

    const handleDeleteAsset = (assetId: string) => {
        if (!confirm('Remove this knowledge asset?')) return;
        // Draft-only: committed to DB on "Save Intelligence Base"
        setDraft(prev => ({ ...prev, assets: prev.assets.filter(a => a.id !== assetId) }));
        setIsDirty(true);
    };

    const handleSyncAsset = (assetId: string) => {
        // Draft-only: marks asset as mapped in draft; committed to DB on "Save Intelligence Base"
        setDraft(prev => ({
            ...prev,
            assets: prev.assets.map(a => a.id === assetId ? { ...a, status: 'mapped' as const, lastUpdated: new Date().toISOString() } : a),
        }));
        setIsDirty(true);
    };

    // Replace the removed profileGetMode useEffect with this
    useEffect(() => {
        if (!window.electronAPI) return;
        const hasMapped = companyContext?.assets?.some(a => a.status === 'mapped');
        if (hasMapped) {
            window.electronAPI?.profileSetMode?.(true).catch(() => { });
        }
    }, [companyContext]);

    // ── Persona CRUD ──────────────────────────────────────────────────────────
    const handlePersonaSave = (p: TargetPersona) => {
        const exists = draft.targetPersonas.some(x => x.id === p.id);
        patch({
            targetPersonas: exists
                ? draft.targetPersonas.map(x => x.id === p.id ? p : x)
                : [...draft.targetPersonas, p],
        });
        setPersonaModalOpen(false);
        setEditingPersona(null);
    };

    const handlePersonaDelete = (id: string) => {
        patch({ targetPersonas: draft.targetPersonas.filter(p => p.id !== id) });
    };

    // ── Competitor CRUD ───────────────────────────────────────────────────────
    const handleCompetitorSave = (c: Competitor) => {
        const exists = draft.competitors.some(x => x.id === c.id);
        patch({
            competitors: exists
                ? draft.competitors.map(x => x.id === c.id ? c : x)
                : [...draft.competitors, c],
        });
        setCompetitorModalOpen(false);
        setEditingCompetitor(null);
    };

    const handleCompetitorDelete = (id: string) => {
        patch({ competitors: draft.competitors.filter(c => c.id !== id) });
    };

    // ─────────────────────────────────────────────────────────────────────────
    const card = isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle';
    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-blue-500/30 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-accent-primary/20 focus:border-accent-primary/50';

    return (
        <>
            <div className="space-y-6 animated fadeIn pb-10">

                {/* ── Header ── */}
                <div className="mb-5">
                    <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-text-primary">Company Context</h3>
                        </div>
                    </div>
                    <p className="text-xs text-text-secondary">
                        Seed the AI engine with your company's identity, value proposition, and sales assets.
                    </p>
                </div>

                {/* ── Company Identity Node ── */}
                <div className={`${card} rounded-xl border flex flex-col justify-between overflow-hidden`}>
                    <div className="p-5 pb-4">
                        <div className="flex items-center justify-between">
                            {/* Left: avatar + name */}
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 rounded-full bg-bg-input border border-border-subtle flex items-center justify-center text-text-primary shadow-sm hover:scale-105 transition-transform duration-300 shrink-0">
                                    <span className="font-bold text-sm tracking-tight">
                                        {draft.identity.name ? draft.identity.name.charAt(0).toUpperCase() : <Building2 size={16} className="text-text-tertiary" />}
                                    </span>
                                </div>
                                <div>
                                    <h4 className="text-sm font-bold text-text-primary tracking-tight">
                                        {draft.identity.name || 'Company Identity Node'}
                                    </h4>
                                    <p className="text-xs text-text-secondary mt-0.5 tracking-wide">
                                        {draft.identity.industry || 'Fill in identity fields to activate'}
                                    </p>
                                </div>
                            </div>

                            {/* Right: completeness ring */}
                            <div className="flex items-center gap-3">
                                <CompletenessRing percentage={completeness} />
                            </div>
                        </div>
                    </div>

                    {/* Identity fields */}
                    <div className="p-5 pt-0 grid grid-cols-1 gap-3">
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 block">Company Name</label>
                                <input
                                    type="text"
                                    value={draft.identity.name}
                                    onChange={e => patchIdentity({ name: e.target.value })}
                                    placeholder="e.g. GoDojo"
                                    className={`w-full rounded-lg border px-3 py-2 text-xs outline-none transition-all focus:ring-1 ${inputCls}`}
                                />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 block">Industry</label>
                                <input
                                    type="text"
                                    value={draft.identity.industry}
                                    onChange={e => patchIdentity({ industry: e.target.value })}
                                    placeholder="e.g. Sales Intelligence"
                                    className={`w-full rounded-lg border px-3 py-2 text-xs outline-none transition-all focus:ring-1 ${inputCls}`}
                                />
                            </div>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 flex items-center gap-1.5">
                                <Globe size={10} /> Website
                            </label>
                            <input
                                type="url"
                                value={draft.identity.website}
                                onChange={e => patchIdentity({ website: e.target.value })}
                                placeholder="https://godojo.ai"
                                className={`w-full rounded-lg border px-3 py-2 text-xs outline-none transition-all focus:ring-1 ${inputCls}`}
                            />
                        </div>

                        {/* Completeness breakdown bar */}
                        <div className="mt-2 bg-bg-input border border-border-subtle rounded-2xl py-3 px-5">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-bold text-text-tertiary uppercase tracking-widest">Intelligence Completeness</span>
                                <span className="text-[10px] font-bold text-text-secondary">{completeness}%</span>
                            </div>
                            <div className="flex items-center gap-3">
                                {([
                                    { key: 'hasIdentity', label: 'Identity', check: !!(draft.identity.name && draft.identity.industry), color: 'bg-blue-500' },
                                    { key: 'hasValueProp', label: 'Value Prop', check: draft.coreValueProposition.trim().length > 20, color: 'bg-purple-500' },
                                    { key: 'hasAssets', label: 'Assets', check: draft.assets.some(a => a.status === 'mapped'), color: 'bg-emerald-500' },
                                ] as const).map(item => (
                                    <div key={item.key} className="flex-1 flex flex-col items-center gap-1">
                                        <div className={`w-full h-1.5 rounded-full ${item.check ? item.color : 'bg-bg-elevated'} transition-colors`} />
                                        <div className="flex items-center gap-1">
                                            <div className={`w-1 h-1 rounded-full ${item.check ? item.color : 'bg-text-tertiary/30'}`} />
                                            <span className="text-[9px] font-medium text-text-tertiary">{item.label}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* ── Core Value Proposition ── */}
                <div>
                    <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Core Value Proposition</h4>
                    <div className={`${card} rounded-xl border`}>
                        <div className="p-5 pb-3">
                            <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2">
                                    <Layers size={14} className="text-text-tertiary" />
                                    <h5 className="text-sm font-bold text-text-primary">Company Pitch</h5>
                                </div>
                                {draft.coreValueProposition.trim().length > 20 && (
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full tracking-widest uppercase bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                                        AI OPTIMIZED
                                    </span>
                                )}
                            </div>
                            <textarea
                                rows={4}
                                value={draft.coreValueProposition}
                                onChange={e => patch({ coreValueProposition: e.target.value })}
                                placeholder="Describe what your company does, who it serves, and the unique value it delivers. The AI will use this to generate tailored sales messaging during calls."
                                className={`w-full rounded-lg border px-3 py-2 text-xs outline-none transition-all focus:ring-1 resize-none leading-relaxed ${inputCls}`}
                            />
                            <p className="text-[10px] text-text-tertiary mt-1.5">
                                {draft.coreValueProposition.trim().length} chars{draft.coreValueProposition.trim().length < 20 && draft.coreValueProposition.length > 0 ? ' — add more detail for AI optimization' : ''}
                            </p>
                        </div>
                    </div>
                </div>

                {/* ── Knowledge Base Setup ── */}
                <div>
                    <div className="flex items-center justify-between mb-2 px-1">
                        <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider">Knowledge Base</h4>
                    </div>
                    <div className="space-y-2.5">
                        {(['sales_deck', 'product_specs', 'case_studies'] as KnowledgeAsset['type'][]).map(type => {
                            const cfg = ASSET_CONFIG[type];
                            const asset = draft.assets.find(a => a.type === type);
                            const isUploading = assetUploading === (asset?.id ?? `${type}-uploading`);
                            const badge = asset ? STATUS_BADGE[asset.status] : null;

                            return (
                                <div
                                    key={type}
                                    className={`rounded-xl border transition-all ${isUploading ? 'ring-1' : ''}`}
                                    style={{
                                        background: asset ? cfg.accentBg : (isLight ? '#fff' : 'var(--bg-item-surface)'),
                                        borderColor: asset ? cfg.accentBorder : (isLight ? 'rgba(0,0,0,0.1)' : 'var(--border-subtle)'),
                                        ...(isUploading ? { boxShadow: `0 0 0 1px ${cfg.accentBorder}` } : {}),
                                    }}
                                >
                                    <div className="p-4 flex items-center justify-between gap-4">
                                        <div className="flex items-center gap-4 min-w-0">
                                            <div
                                                className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                                                style={{ background: cfg.accentBg, border: `1px solid ${cfg.accentBorder}`, color: cfg.accent }}
                                            >
                                                {isUploading ? <RefreshCw size={18} className="animate-spin" /> : cfg.icon}
                                            </div>
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <h5 className="text-sm font-bold text-text-primary">{cfg.label}</h5>
                                                    {badge && (
                                                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${badge.className}`}>
                                                            {badge.label}
                                                        </span>
                                                    )}
                                                </div>
                                                {isUploading ? (
                                                    <div className="flex items-center gap-2 mt-1">
                                                        <div className="h-[3px] w-24 bg-bg-input rounded-full overflow-hidden">
                                                            <div className="h-full rounded-full animate-pulse" style={{ background: cfg.accent, width: '60%' }} />
                                                        </div>
                                                        <span className="text-[10px] text-text-tertiary">Processing…</span>
                                                    </div>
                                                ) : asset ? (
                                                    <p className="text-[10px] text-text-secondary mt-0.5 truncate">
                                                        {asset.lastUpdated ? `Updated ${new Date(asset.lastUpdated).toLocaleDateString()}` : 'Asset loaded'}
                                                    </p>
                                                ) : (
                                                    <p className="text-[10px] text-text-tertiary mt-0.5">
                                                        Upload to enable AI-powered context injection
                                                    </p>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-1.5 shrink-0">
                                            {asset && (
                                                <>
                                                    <button
                                                        onClick={() => handleSyncAsset(asset.id)}
                                                        disabled={!!assetUploading}
                                                        title="Re-process asset"
                                                        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-input transition-all border border-border-subtle disabled:opacity-50"
                                                    >
                                                        <RefreshCw size={13} className={assetUploading === asset.id ? 'animate-spin' : ''} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteAsset(asset.id)}
                                                        title="Remove asset"
                                                        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-all border border-border-subtle"
                                                    >
                                                        <Trash2 size={13} />
                                                    </button>
                                                </>
                                            )}
                                            <button
                                                onClick={() => handleUploadAsset(type)}
                                                disabled={!!assetUploading}
                                                className="px-3 py-1.5 rounded-full text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-wait whitespace-nowrap"
                                                style={asset
                                                    ? { background: cfg.accentBg, color: cfg.accent, border: `1px solid ${cfg.accentBorder}` }
                                                    : { background: isLight ? '#f3f6ff' : '#18202e', color: isLight ? 'var(--bg-bg-item-surface)' : '#495166', opacity: 1 }
                                                }
                                            >
                                                {asset ? 'Replace' : (
                                                    <span className="flex items-center gap-1">
                                                        <Plus size={11} /> Upload
                                                    </span>
                                                )}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* ── Target Personas ── */}
                <div>
                    <div className="flex items-center justify-between mb-3 px-1">
                        <div className="flex items-center gap-2">
                            <Users size={12} className="text-text-tertiary" />
                            <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider">Target Personas</h4>
                            {draft.targetPersonas.length > 0 && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                    {draft.targetPersonas.length}
                                </span>
                            )}
                        </div>
                        <button
                            onClick={() => { setEditingPersona(null); setPersonaModalOpen(true); }}
                            className="flex items-center gap-1.5 text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors px-2.5 py-1 rounded-full border border-indigo-500/25 hover:border-indigo-500/50 hover:bg-indigo-500/10"
                        >
                            <Plus size={10} /> Add New Role
                        </button>
                    </div>

                    {draft.targetPersonas.length === 0 ? (
                        <div
                            className={`${card} rounded-xl border border-dashed p-6 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-indigo-500/30 transition-colors group`}
                            onClick={() => { setEditingPersona(null); setPersonaModalOpen(true); }}
                        >
                            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center group-hover:scale-105 transition-transform">
                                <Users size={16} className="text-indigo-400" />
                            </div>
                            <p className="text-xs text-text-tertiary text-center">No personas yet. Define the roles your AI<br />should tailor messaging for.</p>
                            <span className="text-[10px] font-semibold text-indigo-400">+ Add your first persona</span>
                        </div>
                    ) : (
                        <div className="grid grid-cols-3 gap-3">
                            {draft.targetPersonas.map(persona => (
                                <div
                                    key={persona.id}
                                    className={`${card} rounded-xl border p-4 flex flex-col gap-3 relative group hover:border-indigo-500/30 transition-colors`}
                                >
                                    {/* Meatball top-right */}
                                    <div className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <MeatballMenu
                                            isLight={isLight}
                                            onEdit={() => { setEditingPersona(persona); setPersonaModalOpen(true); }}
                                            onDelete={() => handlePersonaDelete(persona.id)}
                                        />
                                    </div>

                                    {/* Users Icon */}
                                    <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0 text-base">
                                        <Users size={16} />
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0">
                                        <h5 className="text-xs font-bold text-text-primary leading-tight mb-1 pr-5 truncate">{persona.role}</h5>
                                        <p className="text-[10px] text-text-secondary leading-relaxed line-clamp-3">
                                            {persona.description || <span className="text-text-tertiary italic">No description</span>}
                                        </p>
                                    </div>

                                    {/* View Details link */}
                                    <button
                                        onClick={() => { setEditingPersona(persona); setPersonaModalOpen(true); }}
                                        className="flex items-center gap-1 text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors self-start"
                                    >
                                        VIEW DETAILS <ExternalLink size={9} />
                                    </button>
                                </div>
                            ))}

                            {/* Add card */}
                            <div
                                className={`rounded-xl border border-dashed p-4 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-indigo-500/30 transition-colors group min-h-[140px] ${isLight ? 'border-slate-200' : 'border-border-subtle'}`}
                                onClick={() => { setEditingPersona(null); setPersonaModalOpen(true); }}
                            >
                                <div className="w-7 h-7 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center group-hover:border-indigo-500/40 transition-colors">
                                    <Plus size={13} className="text-text-tertiary group-hover:text-indigo-400 transition-colors" />
                                </div>
                                <span className="text-[10px] font-medium text-text-tertiary group-hover:text-indigo-400 transition-colors">Add Role</span>
                            </div>
                        </div>
                    )}
                </div>

                {/* ── Competitive Positioning ── */}
                <div>
                    <div className="flex items-center justify-between mb-3 px-1">
                        <div className="flex items-center gap-2">
                            <Swords size={12} className="text-text-tertiary" />
                            <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider">Competitive Positioning</h4>
                            {draft.competitors.length > 0 && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20">
                                    {draft.competitors.length}
                                </span>
                            )}
                        </div>
                        <button
                            onClick={() => { setEditingCompetitor(null); setCompetitorModalOpen(true); }}
                            className="flex items-center gap-1.5 text-[10px] font-semibold text-violet-400 hover:text-violet-300 transition-colors px-2.5 py-1 rounded-full border border-violet-500/25 hover:border-violet-500/50 hover:bg-violet-500/10"
                        >
                            <Plus size={10} /> Add Competitor
                        </button>
                    </div>

                    {draft.competitors.length === 0 ? (
                        <div
                            className={`${card} rounded-xl border border-dashed p-6 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-violet-500/30 transition-colors group`}
                            onClick={() => { setEditingCompetitor(null); setCompetitorModalOpen(true); }}
                        >
                            <div className="w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center group-hover:scale-105 transition-transform">
                                <Swords size={16} className="text-violet-400" />
                            </div>
                            <p className="text-xs text-text-tertiary text-center">No competitors tracked yet. Add rivals and<br />your differentiating moat against each.</p>
                            <span className="text-[10px] font-semibold text-violet-400">+ Add your first competitor</span>
                        </div>
                    ) : (
                        <div className={`${card} rounded-xl border`}>
                            {/* Table header */}
                            <div className="grid grid-cols-[1fr_1fr_140px_36px] gap-4 px-4 py-2.5 border-b border-border-subtle">
                                <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-widest">Competitor</span>
                                <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-widest">Our Moat</span>
                                <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-widest">Win-Rate</span>
                                <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-widest text-right">Action</span>
                            </div>

                            {draft.competitors.map((comp, idx) => {
                                const initial = comp.name ? comp.name.charAt(0).toUpperCase() : '?';
                                const winColor = comp.winRate >= 60 ? '#6366f1' : comp.winRate >= 40 ? '#f59e0b' : '#ef4444';
                                const isLast = idx === draft.competitors.length - 1;
                                return (
                                    <div
                                        key={comp.id}
                                        className={`grid grid-cols-[1fr_1fr_140px_36px] gap-4 items-center px-4 py-3 hover:bg-bg-input/30 transition-colors ${!isLast ? 'border-b border-border-subtle' : ''}`}
                                    >
                                        {/* Name */}
                                        <div className="flex items-center gap-2.5 min-w-0">
                                            <div className="w-7 h-7 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-[11px] font-bold text-text-secondary shrink-0">
                                                {initial}
                                            </div>
                                            <span className="text-xs font-semibold text-text-primary truncate">{comp.name}</span>
                                        </div>

                                        {/* Moat badge */}
                                        <div className="min-w-0">
                                            {comp.moat ? (
                                                <span className="inline-block text-[10px] font-medium px-2.5 py-1 rounded border border-border-subtle bg-bg-input text-text-secondary truncate max-w-full">
                                                    {comp.moat}
                                                </span>
                                            ) : (
                                                <span className="text-[10px] text-text-tertiary italic">—</span>
                                            )}
                                        </div>

                                        {/* Win-rate */}
                                        <div className="flex items-center gap-2.5">
                                            <div className="flex-1 h-1.5 rounded-full bg-bg-elevated overflow-hidden">
                                                <div
                                                    className="h-full rounded-full transition-all duration-500"
                                                    style={{ width: `${comp.winRate}%`, background: winColor }}
                                                />
                                            </div>
                                            <span className="text-[11px] font-bold shrink-0" style={{ color: winColor, minWidth: '32px' }}>
                                                {comp.winRate}%
                                            </span>
                                        </div>

                                        {/* Meatball */}
                                        <div className="flex justify-end">
                                            <MeatballMenu
                                                isLight={isLight}
                                                onEdit={() => { setEditingCompetitor(comp); setCompetitorModalOpen(true); }}
                                                onDelete={() => handleCompetitorDelete(comp.id)}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* ── Error banner ── */}
                {companyError && (
                    <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[11px] text-red-500 font-medium animated fadeIn">
                        <AlertCircle size={13} className="shrink-0" />
                        {companyError}
                        <button onClick={() => setCompanyError('')} className="ml-auto"><X size={12} /></button>
                    </div>
                )}

                {/* ── Save bar ── */}
                {isDirty && (
                    <div className="sticky bottom-0 pt-3 pb-1 animated fadeIn">
                        <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border ${isLight ? 'bg-white border-slate-200' : 'bg-bg-elevated border-border-subtle'} shadow-lg`}>
                            <p className="text-xs text-text-secondary">You have unsaved changes</p>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleDiscard}
                                    disabled={companySaving}
                                    className="px-4 py-1.5 rounded-full text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-input transition-all border border-border-subtle disabled:opacity-50"
                                >
                                    Discard Changes
                                </button>
                                <button
                                    onClick={handleSave}
                                    // disabled={companySaving || !isPremium}
                                    disabled={companySaving}
                                    className="px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-wait bg-text-primary text-bg-main hover:opacity-90 shadow"
                                >
                                    {companySaving ? <RefreshCw size={12} className="animate-spin" /> : <BarChart2 size={12} />}
                                    {companySaving ? 'Saving…' : 'Save Intelligence Base'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Persona Modal (portal-style, outside scroll container) ── */}
            {personaModalOpen && (
                <PersonaModal
                    persona={editingPersona}
                    onSave={handlePersonaSave}
                    onClose={() => { setPersonaModalOpen(false); setEditingPersona(null); }}
                    isLight={isLight}
                />
            )}

            {/* ── Competitor Modal ── */}
            {competitorModalOpen && (
                <CompetitorModal
                    competitor={editingCompetitor}
                    onSave={handleCompetitorSave}
                    onClose={() => { setCompetitorModalOpen(false); setEditingCompetitor(null); }}
                    isLight={isLight}
                />
            )}
        </>
    );
};

export default CompanyContextTab;