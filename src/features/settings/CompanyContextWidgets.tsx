import React, { useState, useRef, useEffect } from 'react';
import {
    Building2, Globe, Layers, FileText, RefreshCw, Trash2,
    AlertCircle, X, BarChart2,
    Plus, ExternalLink, Users, Swords, MoreVertical, Edit2, Save
} from 'lucide-react';
import {
    CompanyContextData, CompanyIdentity,
    Competitor, KnowledgeAsset, TargetPersona,
    CompetitorModalProps, MeatballMenuProps, PersonaModalProps
} from '@/types';
import { ASSET_CONFIG, STATUS_BADGE } from '@/hooks';

/** Ring showing completeness percentage */
export const CompletenessRing = ({ percentage }: { percentage: number }) => {
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
                    stroke={color}
                    strokeWidth="4"
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

/** Three‑dot menu for edit/delete */
export const MeatballMenu: React.FC<MeatballMenuProps> = ({ onEdit, onDelete, isLight, direction = 'down' }) => {
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
                    className={`absolute right-0 z-50 min-w-[130px] rounded-xl border shadow-xl py-1 ${direction === 'up' ? 'bottom-8' : 'top-8'
                        } ${isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-border-subtle'}`}
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

/** Persona modal */
export const PersonaModal: React.FC<PersonaModalProps> = ({ persona, onSave, onClose, isLight }) => {
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
                className={`relative w-full max-w-md rounded-2xl border shadow-2xl ${isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-border-subtle'
                    }`}
                onClick={e => e.stopPropagation()}
                style={{ boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}
            >
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
                <div className="p-5 space-y-4">
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

/** Competitor modal */
export const CompetitorModal: React.FC<CompetitorModalProps> = ({ competitor, onSave, onClose, isLight }) => {
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
                className={`relative w-full max-w-md rounded-2xl border shadow-2xl ${isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-border-subtle'
                    }`}
                onClick={e => e.stopPropagation()}
                style={{ boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}
            >
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

/** Skeleton loader */
export const SkeletonBlock: React.FC<{ className?: string; isLight: boolean }> = ({ className = '', isLight }) => (
    <div
        className={`animate-pulse rounded-lg ${isLight ? 'bg-slate-200' : 'bg-bg-input'} ${className}`}
    />
);

export const CompanyContextSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => {
    const card = isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle';
    return (
        <div className="space-y-6 animated fadeIn pb-10" aria-busy="true" aria-label="Loading company context">
            <div className="mb-5 space-y-2">
                <SkeletonBlock isLight={isLight} className="h-4 w-40" />
                <SkeletonBlock isLight={isLight} className="h-3 w-72" />
            </div>
            <div className={`${card} rounded-xl border p-5 space-y-4`}>
                <div className="flex items-center gap-4">
                    <SkeletonBlock isLight={isLight} className="w-10 h-10 rounded-full" />
                    <div className="space-y-2 flex-1">
                        <SkeletonBlock isLight={isLight} className="h-3.5 w-32" />
                        <SkeletonBlock isLight={isLight} className="h-3 w-24" />
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <SkeletonBlock isLight={isLight} className="h-9" />
                    <SkeletonBlock isLight={isLight} className="h-9" />
                </div>
                <SkeletonBlock isLight={isLight} className="h-9" />
            </div>
            <div className={`${card} rounded-xl border p-5 space-y-3`}>
                <SkeletonBlock isLight={isLight} className="h-3.5 w-36" />
                <SkeletonBlock isLight={isLight} className="h-20" />
            </div>
            {[0, 1, 2].map(i => (
                <SkeletonBlock key={i} isLight={isLight} className="h-16" />
            ))}
        </div>
    );
};

// ─── Section Components ──────────────────────────────────────────────────────

/** Company Identity + Completeness */
export const CompanyIdentitySection: React.FC<{
    draft: CompanyContextData;
    completeness: number;
    patchIdentity: (updates: Partial<CompanyIdentity>) => void;
    isLight: boolean;
}> = ({ draft, completeness, patchIdentity, isLight }) => {
    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-blue-500/30 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-accent-primary/20 focus:border-accent-primary/50';
    const card = isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle';

    return (
        <div className={`${card} rounded-xl border flex flex-col justify-between overflow-hidden`}>
            <div className="p-5 pb-4">
                <div className="flex items-center justify-between">
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
                    <div className="flex items-center gap-3">
                        <CompletenessRing percentage={completeness} />
                    </div>
                </div>
            </div>

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
    );
};

/** Core Value Proposition */
export const ValuePropositionSection: React.FC<{
    value: string;
    onChange: (val: string) => void;
    isLight: boolean;
}> = ({ value, onChange, isLight }) => {
    const card = isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle';
    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-blue-500/30 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-accent-primary/20 focus:border-accent-primary/50';

    return (
        <div>
            <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Core Value Proposition</h4>
            <div className={`${card} rounded-xl border`}>
                <div className="p-5 pb-3">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <Layers size={14} className="text-text-tertiary" />
                            <h5 className="text-sm font-bold text-text-primary">Company Pitch</h5>
                        </div>
                        {value.trim().length > 20 && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full tracking-widest uppercase bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                                AI OPTIMIZED
                            </span>
                        )}
                    </div>
                    <textarea
                        rows={4}
                        value={value}
                        onChange={e => onChange(e.target.value)}
                        placeholder="Describe what your company does, who it serves, and the unique value it delivers. The AI will use this to generate tailored sales messaging during calls."
                        className={`w-full rounded-lg border px-3 py-2 text-xs outline-none transition-all focus:ring-1 resize-none leading-relaxed ${inputCls}`}
                    />
                    <p className="text-[10px] text-text-tertiary mt-1.5">
                        {value.trim().length} chars{value.trim().length < 20 && value.length > 0 ? ' — add more detail for AI optimization' : ''}
                    </p>
                </div>
            </div>
        </div>
    );
};

/** Knowledge Base – renders all asset categories */
export const KnowledgeBaseSection: React.FC<{
    assets: KnowledgeAsset[];
    assetUploading: string | null;
    onUpload: (type: KnowledgeAsset['type']) => void;
    onDelete: (id: string) => void;
    onDeleteAll: (type: KnowledgeAsset['type']) => void;
    onSync: (id: string) => void;
    isLight: boolean;
    /**
     * When true, no Upload/Delete-all/Delete/Reprocess button is rendered at
     * all — not just disabled. Used for read-only team members: they can see
     * what the admin has uploaded, but there's nothing clickable anywhere in
     * this section. Defaults to false so every existing (admin/solo) caller
     * is unaffected.
     */
    readOnly?: boolean;
}> = ({ assets, assetUploading, onUpload, onDelete, onDeleteAll, onSync, isLight, readOnly = false }) => {
    const assetTypes: KnowledgeAsset['type'][] = ['sales_deck', 'product_specs', 'case_studies'];

    return (
        <div>
            <div className="flex items-center justify-between mb-2 px-1">
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider">Knowledge Base</h4>
            </div>
            <div className="space-y-2.5">
                {assetTypes.map(type => {
                    const cfg = ASSET_CONFIG[type];
                    const assetsForType = assets.filter(a => a.type === type);
                    const hasAssets = assetsForType.length > 0;
                    const isCategoryUploading = assetsForType.some(a => a.id === assetUploading);

                    return (
                        <div
                            key={type}
                            className={`rounded-xl border transition-all ${isCategoryUploading ? 'ring-1' : ''}`}
                            style={{
                                background: hasAssets ? cfg.accentBg : (isLight ? '#fff' : 'var(--bg-item-surface)'),
                                borderColor: hasAssets ? cfg.accentBorder : (isLight ? 'rgba(0,0,0,0.1)' : 'var(--border-subtle)'),
                                ...(isCategoryUploading ? { boxShadow: `0 0 0 1px ${cfg.accentBorder}` } : {}),
                            }}
                        >
                            <div className="p-4 flex items-center justify-between gap-4">
                                <div className="flex items-center gap-4 min-w-0">
                                    <div
                                        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                                        style={{ background: cfg.accentBg, border: `1px solid ${cfg.accentBorder}`, color: cfg.accent }}
                                    >
                                        {isCategoryUploading ? <RefreshCw size={18} className="animate-spin" /> : cfg.icon}
                                    </div>
                                    <div className="min-w-0">
                                        <h5 className="text-sm font-bold text-text-primary">{cfg.label}</h5>
                                        <p className="text-[10px] text-text-tertiary mt-0.5">
                                            {isCategoryUploading
                                                ? 'Processing…'
                                                : hasAssets
                                                    ? `${assetsForType.length} file${assetsForType.length > 1 ? 's' : ''} uploaded`
                                                    : readOnly
                                                        ? 'No files uploaded yet'
                                                        : 'Upload to enable AI-powered context injection'}
                                        </p>
                                    </div>
                                </div>

                                {/* No button of any kind renders here for a read-only member —
                                    not even a disabled one. */}
                                {!readOnly && (
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        {hasAssets && (
                                            <button
                                                onClick={() => onDeleteAll(type)}
                                                disabled={!!assetUploading}
                                                title={`Remove all ${cfg.label} files`}
                                                className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-all border border-border-subtle disabled:opacity-50"
                                            >
                                                <Trash2 size={13} />
                                            </button>
                                        )}
                                        <button
                                            onClick={() => onUpload(type)}
                                            disabled={!!assetUploading}
                                            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-wait disabled:hover:brightness-100 whitespace-nowrap ${hasAssets
                                                ? 'hover:brightness-110'
                                                : 'bg-blue-600 text-white hover:bg-blue-500'
                                                }`}
                                            style={hasAssets
                                                ? { background: cfg.accentBg, color: cfg.accent, border: `1px solid ${cfg.accentBorder}` }
                                                : undefined
                                            }
                                        >
                                            <span className="flex items-center gap-1">
                                                <Plus size={11} /> Upload
                                            </span>
                                        </button>
                                    </div>
                                )}
                            </div>

                            {hasAssets && (
                                <div className="px-4 pb-4 space-y-1.5 max-h-[180px] overflow-y-auto">
                                    {assetsForType.map(asset => {
                                        const isUploading = assetUploading === asset.id;
                                        const badge = STATUS_BADGE[asset.status];
                                        return (
                                            <div
                                                key={asset.id}
                                                className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 border"
                                                style={{
                                                    background: isLight ? '#fff' : 'var(--bg-item-surface)',
                                                    borderColor: isLight ? 'rgba(0,0,0,0.08)' : 'var(--border-subtle)',
                                                }}
                                            >
                                                <div className="flex items-center gap-2 min-w-0">
                                                    {isUploading
                                                        ? <RefreshCw size={12} className="animate-spin text-text-tertiary shrink-0" />
                                                        : <FileText size={12} className="text-text-tertiary shrink-0" />}
                                                    <span className="text-xs text-text-primary truncate">{asset.label}</span>
                                                    {badge && (
                                                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${badge.className}`}>
                                                            {badge.label}
                                                        </span>
                                                    )}
                                                </div>
                                                {/* Same rule as above: nothing clickable at all when readOnly. */}
                                                {!readOnly && (
                                                    <div className="flex items-center gap-1 shrink-0">
                                                        <button
                                                            onClick={() => onSync(asset.id)}
                                                            disabled={!!assetUploading || isUploading}
                                                            title="Re-process file"
                                                            className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-input transition-all disabled:opacity-50"
                                                        >
                                                            <RefreshCw size={11} />
                                                        </button>
                                                        <button
                                                            onClick={() => onDelete(asset.id)}
                                                            title="Remove file"
                                                            className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-all"
                                                        >
                                                            <Trash2 size={11} />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

/** Target Personas */
export const TargetPersonasSection: React.FC<{
    personas: TargetPersona[];
    onAdd: () => void;
    onEdit: (p: TargetPersona) => void;
    onDelete: (id: string) => void;
    isLight: boolean;
}> = ({ personas, onAdd, onEdit, onDelete, isLight }) => {
    const card = isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle';

    return (
        <div>
            <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2">
                    <Users size={12} className="text-text-tertiary" />
                    <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider">Target Personas</h4>
                    {personas.length > 0 && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                            {personas.length}
                        </span>
                    )}
                </div>
                <button
                    onClick={onAdd}
                    className="flex items-center gap-1.5 text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors px-2.5 py-1 rounded-full border border-indigo-500/25 hover:border-indigo-500/50 hover:bg-indigo-500/10"
                >
                    <Plus size={10} /> Add New Role
                </button>
            </div>

            {personas.length === 0 ? (
                <div
                    className={`${card} rounded-xl border border-dashed p-6 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-indigo-500/30 transition-colors group`}
                    onClick={onAdd}
                >
                    <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center group-hover:scale-105 transition-transform">
                        <Users size={16} className="text-indigo-400" />
                    </div>
                    <p className="text-xs text-text-tertiary text-center">No personas yet. Define the roles your AI<br />should tailor messaging for.</p>
                    <span className="text-[10px] font-semibold text-indigo-400">+ Add your first persona</span>
                </div>
            ) : (
                <div className="grid grid-cols-3 gap-3">
                    {personas.map(persona => (
                        <div
                            key={persona.id}
                            className={`${card} rounded-xl border p-4 flex flex-col gap-3 relative group hover:border-indigo-500/30 transition-colors`}
                        >
                            <div className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <MeatballMenu
                                    isLight={isLight}
                                    onEdit={() => onEdit(persona)}
                                    onDelete={() => onDelete(persona.id)}
                                />
                            </div>
                            <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0 text-base">
                                <Users size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h5 className="text-xs font-bold text-text-primary leading-tight mb-1 pr-5 truncate">{persona.role}</h5>
                                <p className="text-[10px] text-text-secondary leading-relaxed line-clamp-3">
                                    {persona.description || <span className="text-text-tertiary italic">No description</span>}
                                </p>
                            </div>
                            <button
                                onClick={() => onEdit(persona)}
                                className="flex items-center gap-1 text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors self-start"
                            >
                                VIEW DETAILS <ExternalLink size={9} />
                            </button>
                        </div>
                    ))}
                    <div
                        className={`rounded-xl border border-dashed p-4 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-indigo-500/30 transition-colors group min-h-[140px] ${isLight ? 'border-slate-200' : 'border-border-subtle'
                            }`}
                        onClick={onAdd}
                    >
                        <div className="w-7 h-7 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center group-hover:border-indigo-500/40 transition-colors">
                            <Plus size={13} className="text-text-tertiary group-hover:text-indigo-400 transition-colors" />
                        </div>
                        <span className="text-[10px] font-medium text-text-tertiary group-hover:text-indigo-400 transition-colors">Add Role</span>
                    </div>
                </div>
            )}
        </div>
    );
};

/** Competitors */
export const CompetitorsSection: React.FC<{
    competitors: Competitor[];
    onAdd: () => void;
    onEdit: (c: Competitor) => void;
    onDelete: (id: string) => void;
    isLight: boolean;
}> = ({ competitors, onAdd, onEdit, onDelete, isLight }) => {
    const card = isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle';

    return (
        <div>
            <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2">
                    <Swords size={12} className="text-text-tertiary" />
                    <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider">Competitive Positioning</h4>
                    {competitors.length > 0 && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20">
                            {competitors.length}
                        </span>
                    )}
                </div>
                <button
                    onClick={onAdd}
                    className="flex items-center gap-1.5 text-[10px] font-semibold text-violet-400 hover:text-violet-300 transition-colors px-2.5 py-1 rounded-full border border-violet-500/25 hover:border-violet-500/50 hover:bg-violet-500/10"
                >
                    <Plus size={10} /> Add Competitor
                </button>
            </div>

            {competitors.length === 0 ? (
                <div
                    className={`${card} rounded-xl border border-dashed p-6 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-violet-500/30 transition-colors group`}
                    onClick={onAdd}
                >
                    <div className="w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center group-hover:scale-105 transition-transform">
                        <Swords size={16} className="text-violet-400" />
                    </div>
                    <p className="text-xs text-text-tertiary text-center">No competitors tracked yet. Add rivals and<br />your differentiating moat against each.</p>
                    <span className="text-[10px] font-semibold text-violet-400">+ Add your first competitor</span>
                </div>
            ) : (
                <div className={`${card} rounded-xl border`}>
                    <div className="grid grid-cols-[1fr_1fr_140px_36px] gap-4 px-4 py-2.5 border-b border-border-subtle">
                        <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-widest">Competitor</span>
                        <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-widest">Our Moat</span>
                        <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-widest">Win-Rate</span>
                        <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-widest text-right">Action</span>
                    </div>
                    {competitors.map((comp, idx) => {
                        const initial = comp.name ? comp.name.charAt(0).toUpperCase() : '?';
                        const winColor = comp.winRate >= 60 ? '#6366f1' : comp.winRate >= 40 ? '#f59e0b' : '#ef4444';
                        const isLast = idx === competitors.length - 1;
                        return (
                            <div
                                key={comp.id}
                                className={`grid grid-cols-[1fr_1fr_140px_36px] gap-4 items-center px-4 py-3 hover:bg-bg-input/30 transition-colors ${!isLast ? 'border-b border-border-subtle' : ''
                                    }`}
                            >
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <div className="w-7 h-7 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-[11px] font-bold text-text-secondary shrink-0">
                                        {initial}
                                    </div>
                                    <span className="text-xs font-semibold text-text-primary truncate">{comp.name}</span>
                                </div>
                                <div className="min-w-0">
                                    {comp.moat ? (
                                        <span className="inline-block text-[10px] font-medium px-2.5 py-1 rounded border border-border-subtle bg-bg-input text-text-secondary truncate max-w-full">
                                            {comp.moat}
                                        </span>
                                    ) : (
                                        <span className="text-[10px] text-text-tertiary italic">—</span>
                                    )}
                                </div>
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
                                <div className="flex justify-end">
                                    <MeatballMenu
                                        isLight={isLight}
                                        onEdit={() => onEdit(comp)}
                                        onDelete={() => onDelete(comp.id)}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

/** Error Banner */
export const ErrorBanner: React.FC<{ error: string; onDismiss: () => void }> = ({ error, onDismiss }) => (
    <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[11px] text-red-500 font-medium animated fadeIn">
        <AlertCircle size={13} className="shrink-0" />
        {error}
        <button onClick={onDismiss} className="ml-auto"><X size={12} /></button>
    </div>
);

/** Sticky Save Bar */
export const SaveBar: React.FC<{
    isDirty: boolean;
    saving: boolean;
    onSave: () => void;
    onDiscard: () => void;
    isLight: boolean;
}> = ({ isDirty, saving, onSave, onDiscard, isLight }) => {
    if (!isDirty) return null;
    return (
        <div className="sticky bottom-0 pt-3 pb-1 animated fadeIn">
            <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border ${isLight ? 'bg-white border-slate-200' : 'bg-bg-elevated border-border-subtle'
                } shadow-lg`}>
                <p className="text-xs text-text-secondary">You have unsaved changes</p>
                <div className="flex items-center gap-2">
                    <button
                        onClick={onDiscard}
                        disabled={saving}
                        className="px-4 py-1.5 rounded-full text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-input transition-all border border-border-subtle disabled:opacity-50"
                    >
                        Discard Changes
                    </button>
                    <button
                        onClick={onSave}
                        disabled={saving}
                        className="px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-wait bg-text-primary text-bg-main hover:opacity-90 shadow"
                    >
                        {saving ? <RefreshCw size={12} className="animate-spin" /> : <BarChart2 size={12} />}
                        {saving ? 'Saving…' : 'Save Intelligence Base'}
                    </button>
                </div>
            </div>
        </div>
    );
};  