/**
 * ScoringCriteriaTab.tsx
 *
 * Settings tab for customizing per-meeting-type scoring rubrics.
 * Fully self-contained: loads from / saves to `scoring_criteria` DB table.
 * Design system mirrors CompanyContextTab — CSS vars, card styles, sticky save bar, modals.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, X, Save, RefreshCw, AlertCircle, CheckCircle2, BarChart3 } from 'lucide-react';
import { GripVertical, MoreVertical, Edit2, Info, RotateCcw, Sparkles, Tag, Weight, Search, Monitor, Handshake } from 'lucide-react';
import { MeetingType, ScoringCriteriaSettings, CustomScorecardConfig, CustomCategoryConfig, MeetingTypeMeta, CategoryModalProps, ScoringCategoryRowProps, MeetingTypeSectionProps } from '@/types';
import { SCORECARD_CONFIGS } from "@/lib/utils";
import { useResolvedTheme } from '@/hooks';

// ─── Constants ────────────────────────────────────────────────────────────────

const MEETING_TYPE_META: Record<MeetingType, MeetingTypeMeta> = {
    discovery: {
        label: 'Discovery',
        color: '#a78bfa',
        accentBg: (isLight) => isLight ? 'rgba(167,139,250,0.10)' : 'rgba(167,139,250,0.08)',
        accentBorder: (isLight) => isLight ? 'rgba(167,139,250,0.30)' : 'rgba(167,139,250,0.20)',
        description: 'First-touch calls focused on uncovering pain, budget, and stakeholder fit.',
        Icon: ({ size, color }) => <Search size={size} color={color} strokeWidth={1.75} />,
    },
    demo: {
        label: 'Demo',
        color: '#34d399',
        accentBg: (isLight) => isLight ? 'rgba(52,211,153,0.10)' : 'rgba(52,211,153,0.07)',
        accentBorder: (isLight) => isLight ? 'rgba(52,211,153,0.28)' : 'rgba(52,211,153,0.18)',
        description: 'Product walkthroughs and proof-of-concept sessions.',
        Icon: ({ size, color }) => <Monitor size={size} color={color} strokeWidth={1.75} />,
    },
    negotiation: {
        label: 'Negotiation',
        color: '#f59e0b',
        accentBg: (isLight) => isLight ? 'rgba(245,158,11,0.10)' : 'rgba(245,158,11,0.07)',
        accentBorder: (isLight) => isLight ? 'rgba(245,158,11,0.30)' : 'rgba(245,158,11,0.18)',
        description: 'Commercial discussions, pricing, procurement, and closing calls.',
        Icon: ({ size, color }) => <Handshake size={size} color={color} strokeWidth={1.75} />,
    },
};

const FRAMEWORK_SUGGESTIONS = ['MEDDIC', 'BANT', 'SPIN', 'GPCT', 'SNAP', 'Challenger', 'Custom'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function totalWeight(cats: CustomCategoryConfig[]): number {
    return cats.reduce((s, c) => s + (Number(c.weight) || 0), 0);
}

function defaultCustomConfig(meetingType: MeetingType): CustomScorecardConfig {
    const builtin = SCORECARD_CONFIGS.find(c => c.meetingType === meetingType)!;
    return {
        meetingType,
        enabled: false,
        categories: builtin.categories.map(cat => ({
            key: cat.key,
            label: cat.label,
            weight: cat.weight,
            checkpoints: [...cat.checkpoints],
            framework: '',
        })),
    };
}

function buildDefaultSettings(): ScoringCriteriaSettings {
    return {
        configs: (['discovery', 'demo', 'negotiation'] as MeetingType[]).map(defaultCustomConfig),
    };
}

// ─── Category Edit Modal ──────────────────────────────────────────────────────

const CategoryModal: React.FC<CategoryModalProps> = ({ category, accentColor, onSave, onClose, isLight }) => {
    const [label, setLabel] = useState(category?.label ?? '');
    const [framework, setFramework] = useState(category?.framework ?? '');
    const [weight, setWeight] = useState(category?.weight ?? 20);
    const [checkpointText, setCheckpointText] = useState(
        (category?.checkpoints ?? []).join('\n')
    );
    const [showFrameworkSuggestions, setShowFrameworkSuggestions] = useState(false);

    const isAddMode = !category;
    const checkpoints = checkpointText.split('\n').map(l => l.trim()).filter(Boolean);

    const canSave = label.trim().length > 0 && weight >= 1 && weight <= 100;

    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-2 focus:ring-accent-primary/20 focus:border-accent-primary/50';

    const handleSave = () => {
        if (!canSave) return;
        onSave({
            key: category?.key ?? `cat_${Date.now()}`,
            label: label.trim(),
            framework: framework.trim(),
            weight,
            checkpoints,
        });
    };

    const weightColor = weight > 50 ? '#f59e0b' : accentColor;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={onClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className={`relative w-full max-w-lg rounded-2xl border shadow-2xl ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'}`}
                onClick={e => e.stopPropagation()}
                style={{ boxShadow: isLight ? '0 24px 64px rgba(0,0,0,0.18)' : '0 24px 64px rgba(0,0,0,0.60)', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
            >
                {/* Header */}
                <div className={`flex items-center justify-between px-4 pt-4 pb-3 shrink-0 border-b ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                    <div className="flex items-center gap-2.5">
                        <div
                            className="w-7 h-7 rounded-lg flex items-center justify-center"
                            style={{ background: `${accentColor}18`, border: `1px solid ${accentColor}30` }}
                        >
                            <BarChart3 size={14} style={{ color: accentColor }} />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">
                            {isAddMode ? 'Add Scoring Category' : 'Edit Category'}
                        </h3>
                    </div>
                    <button
                        onClick={onClose}
                        className={`w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary transition-all ${isLight ? 'hover:text-slate-700 hover:bg-slate-100' : 'hover:text-text-primary hover:bg-bg-input'}`}
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* Body — scrollable */}
                <div className="px-4 py-3 space-y-3 overflow-y-auto">

                    {/* Label */}
                    <div>
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 block">
                            Category Name <span className="text-red-400">*</span>
                        </label>
                        <input
                            autoFocus
                            type="text"
                            value={label}
                            onChange={e => setLabel(e.target.value)}
                            placeholder="e.g. Value Creation, Objection Handling"
                            className={`w-full rounded-lg border px-3 py-2 text-xs font-semibold outline-none transition-all ${inputCls}`}
                        />
                    </div>

                    {/* Framework tag */}
                    <div className="relative">
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 flex items-center gap-1.5">
                            <Tag size={9} />
                            Framework / Tag
                            <span className={`text-[9px] font-normal normal-case ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`}>(optional)</span>
                        </label>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={framework}
                                onChange={e => setFramework(e.target.value)}
                                onFocus={() => setShowFrameworkSuggestions(true)}
                                onBlur={() => setTimeout(() => setShowFrameworkSuggestions(false), 150)}
                                placeholder="e.g. MEDDIC, BANT, Custom"
                                className={`flex-1 rounded-lg border px-3 py-2 text-xs outline-none transition-all ${inputCls}`}
                            />
                        </div>
                        {/* Suggestion chips */}
                        {showFrameworkSuggestions && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                                {FRAMEWORK_SUGGESTIONS.map(fw => (
                                    <button
                                        key={fw}
                                        onMouseDown={() => setFramework(fw)}
                                        className="text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-all"
                                        style={{
                                            color: accentColor,
                                            background: `${accentColor}12`,
                                            borderColor: `${accentColor}30`,
                                        }}
                                    >
                                        {fw}
                                    </button>
                                ))}
                            </div>
                        )}
                        <p className={`text-[10px] mt-1 ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`}>
                            Appears as a badge on the category row.
                        </p>
                    </div>

                    {/* Weight */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider flex items-center gap-1.5">
                                <Weight size={9} />
                                Weight
                            </label>
                            <span className="text-sm font-bold tabular-nums" style={{ color: weightColor }}>
                                {weight}%
                            </span>
                        </div>
                        {/* Visual bar */}
                        <div className={`h-1.5 rounded-full mb-2 overflow-hidden ${isLight ? 'bg-slate-100' : 'bg-bg-input'}`}>
                            <div
                                className="h-full rounded-full transition-all duration-150"
                                style={{ width: `${weight}%`, background: weightColor }}
                            />
                        </div>
                        <input
                            type="range"
                            min={5} max={100} step={5}
                            value={weight}
                            onChange={e => setWeight(Number(e.target.value))}
                            className="w-full h-1.5 rounded-full appearance-none bg-slate-900/10 dark:bg-bg-input accent-accent-primary"
                            style={{ accentColor: weightColor }}
                        />
                        <div className={`flex justify-between text-[9px] mt-0.5 ${isLight ? 'text-slate-300' : 'text-gray-600'}`}>
                            <span className={`text-gray-500`}>5%</span>
                            <span className={`text-gray-500 mr-4`}>50%</span>
                            <span className={`text-gray-500`}>100%</span>
                        </div>
                        <p className={`text-[10px] mt-1 ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`}>
                            All weights across categories must total 100% to save.
                        </p>
                    </div>

                    {/* Checkpoints */}
                    <div>
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 block">
                            Checkpoints
                            <span className={`ml-1.5 font-normal normal-case ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`}>
                                — one per line
                            </span>
                        </label>
                        <textarea
                            rows={4}
                            value={checkpointText}
                            onChange={e => setCheckpointText(e.target.value)}
                            placeholder={"Budget confirmed or range established\nDecision maker identified\nPain clearly articulated\nTimeline or urgency established"}
                            className={`w-full rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed outline-none transition-all resize-none font-mono ${inputCls}`}
                        />
                        <div className="flex items-center gap-1.5 mt-1">
                            <Info size={10} className={`mt-0.5 shrink-0 ${isLight ? 'text-slate-300' : 'text-gray-600'}`} />
                            <p className={`text-[10px] leading-relaxed ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`}>
                                The AI evaluates each checkpoint when scoring this category.
                                {checkpoints.length > 0 && (
                                    <span className="ml-1 font-semibold" style={{ color: accentColor }}>
                                        {checkpoints.length} checkpoint{checkpoints.length !== 1 ? 's' : ''} defined.
                                    </span>
                                )}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className={`flex items-center justify-end gap-2 px-4 py-3 border-t shrink-0 ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                    <button
                        onClick={onClose}
                        className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all border ${isLight
                            ? 'text-slate-600 hover:text-slate-800 hover:bg-slate-50 border-slate-200'
                            : 'text-text-secondary hover:text-text-primary hover:bg-bg-input border-border-subtle'
                            }`}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!canSave}
                        className="px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed text-white shadow"
                        style={{ background: canSave ? accentColor : undefined }}
                    >
                        <Save size={11} />
                        {isAddMode ? 'Add Category' : 'Save Changes'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// ─── Category Row ─────────────────────────────────────────────────────────────

const CategoryRow: React.FC<ScoringCategoryRowProps> = ({ category, accent, totalCats, isLight, onEdit, onDelete }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        if (menuOpen) document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menuOpen]);

    const barWidth = `${Math.min(category.weight, 100)}%`;

    return (
        <div className={`group flex items-center gap-3 px-4 py-3 rounded-xl border transition-all hover:border-opacity-60 ${isLight ? 'bg-white border-slate-200/80 hover:border-slate-300' : 'bg-bg-item-surface border-border-subtle hover:border-white/15'}`}>

            {/* Drag handle (decorative) */}
            <GripVertical size={13} className={`shrink-0 ${isLight ? 'text-slate-200' : 'text-white/10'} group-hover:opacity-60 transition-opacity`} />

            {/* Weight ring / badge */}
            <div
                className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold tabular-nums"
                style={{ background: `${accent}14`, border: `1px solid ${accent}28`, color: accent }}
            >
                {category.weight}%
            </div>

            {/* Main content */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-xs font-semibold truncate ${isLight ? 'text-slate-800' : 'text-text-primary'}`}>
                        {category.label || <span className="italic opacity-40">Unnamed</span>}
                    </span>
                    {category.framework && (
                        <span
                            className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                            style={{ color: accent, background: `${accent}14`, border: `1px solid ${accent}28` }}
                        >
                            {category.framework}
                        </span>
                    )}
                    {category.checkpoints.length > 0 && (
                        <span className={`text-[9px] px-1.5 py-0.5 my-1 rounded shrink-0 ${isLight ? 'bg-slate-100 text-slate-400' : 'bg-white/[0.05] text-text-tertiary'}`}>
                            {category.checkpoints.length} pts
                        </span>
                    )}
                </div>

                {/* Weight bar */}
                <div className={`h-[3px] rounded-full overflow-hidden ${isLight ? 'bg-slate-100' : 'bg-white/[0.05]'}`}>
                    <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: barWidth, background: accent }}
                    />
                </div>
            </div>

            {/* Meatball menu */}
            <div ref={menuRef} className="relative shrink-0">
                <button
                    onClick={() => setMenuOpen(v => !v)}
                    className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all border border-transparent opacity-0 group-hover:opacity-100 ${isLight
                        ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100 hover:border-slate-200'
                        : 'text-text-tertiary hover:text-text-primary hover:bg-bg-input hover:border-border-subtle'
                        }`}
                >
                    <MoreVertical size={13} />
                </button>
                {menuOpen && (
                    <div
                        className={`absolute right-0 top-8 z-50 min-w-[130px] rounded-xl border shadow-xl py-1 ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'}`}
                        style={{ boxShadow: isLight ? '0 8px 32px rgba(0,0,0,0.12)' : '0 8px 32px rgba(0,0,0,0.48)' }}
                    >
                        <button
                            onClick={() => { setMenuOpen(false); onEdit(); }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium transition-colors ${isLight
                                ? 'text-slate-700 hover:bg-slate-50'
                                : 'text-text-primary hover:bg-bg-input'
                                }`}
                        >
                            <Edit2 size={12} className={isLight ? 'text-slate-400' : 'text-text-tertiary'} /> Edit
                        </button>
                        <button
                            onClick={() => { setMenuOpen(false); onDelete(); }}
                            disabled={totalCats <= 1}
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <Trash2 size={12} /> Delete
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

// ─── Weight Gauge ─────────────────────────────────────────────────────────────

const WeightGauge: React.FC<{ total: number; accent: string; isLight: boolean }> = ({ total }) => {
    const isValid = total === 100;
    const isOver = total > 100;
    const diff = Math.abs(100 - total);

    if (isValid) {
        return (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
                <span className="text-[10.5px] font-semibold text-emerald-400">Weights total 100% — ready to save</span>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <AlertCircle size={11} className="text-amber-400 shrink-0" />
            <span className="text-[10.5px] font-semibold text-amber-400">
                {total}% total — {isOver ? `${diff}% over` : `${diff}% short of`} 100%
            </span>
        </div>
    );
};

// ─── Meeting Type Section ─────────────────────────────────────────────────────

const MeetingTypeSection: React.FC<MeetingTypeSectionProps> = ({ config, isLight, onChange }) => {
    const meta = MEETING_TYPE_META[config.meetingType];
    const builtin = SCORECARD_CONFIGS.find(c => c.meetingType === config.meetingType)!;
    const total = totalWeight(config.categories);

    // Category modal state
    const [modalOpen, setModalOpen] = useState(false);
    const [editingCat, setEditingCat] = useState<CustomCategoryConfig | null>(null);
    const [isAddMode, setIsAddMode] = useState(false);

    const openAdd = () => { setEditingCat(null); setIsAddMode(true); setModalOpen(true); };
    const openEdit = (cat: CustomCategoryConfig) => { setEditingCat(cat); setIsAddMode(false); setModalOpen(true); };

    const handleCatSave = (cat: CustomCategoryConfig) => {
        if (isAddMode) {
            onChange({ ...config, categories: [...config.categories, cat] });
        } else {
            onChange({ ...config, categories: config.categories.map(c => c.key === cat.key ? cat : c) });
        }
        setModalOpen(false);
    };

    const handleDelete = (key: string) => {
        if (config.categories.length <= 1) return;
        onChange({ ...config, categories: config.categories.filter(c => c.key !== key) });
    };

    const card = isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle';

    return (
        <>
            <div className={`${card} rounded-xl border overflow-hidden transition-all`}>

                {/* ── Header ── */}
                <div className="p-5 pb-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                            {/* Icon container — lucide icon with themed background */}
                            <div
                                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                                style={{
                                    background: meta.accentBg(isLight),
                                    border: `1px solid ${meta.accentBorder(isLight)}`,
                                }}
                            >
                                <meta.Icon size={18} color={meta.color} />
                            </div>

                            <div>
                                <div className="flex items-center gap-2 mb-0.5">
                                    <h4 className={`text-sm font-bold ${isLight ? 'text-slate-900' : 'text-text-primary'}`}>{meta.label}</h4>
                                    {config.enabled && (
                                        <span
                                            className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                                            style={{ color: meta.color, background: meta.accentBg(isLight), border: `1px solid ${meta.accentBorder(isLight)}` }}
                                        >
                                            CUSTOM
                                        </span>
                                    )}
                                </div>
                                <p className={`text-[11px] leading-snug ${isLight ? 'text-slate-500' : 'text-text-secondary'}`}>{meta.description}</p>
                            </div>
                        </div>

                        {/* Enable toggle */}
                        <div className="flex items-center gap-2 shrink-0">
                            <span className={`text-[10px] font-medium ${config.enabled
                                ? (isLight ? 'text-slate-500' : 'text-text-secondary')
                                : (isLight ? 'text-slate-400' : 'text-text-tertiary')
                                }`}>
                                {config.enabled ? 'Custom rules' : 'Using defaults'}
                            </span>
                            <button
                                onClick={() => onChange({ ...config, enabled: !config.enabled })}
                                className="relative shrink-0 transition-all"
                                style={{
                                    width: 36, height: 20, borderRadius: 10,
                                    background: config.enabled
                                        ? meta.color
                                        : (isLight ? '#e2e8f0' : 'rgba(255,255,255,0.08)'),
                                    border: `1px solid ${config.enabled
                                        ? meta.color + '80'
                                        : (isLight ? '#cbd5e1' : 'rgba(255,255,255,0.12)')}`,
                                    transition: 'background 0.2s ease, border-color 0.2s ease',
                                }}
                            >
                                <div
                                    className="absolute top-[3px] w-[12px] h-[12px] rounded-full transition-all duration-200"
                                    style={{
                                        left: config.enabled ? 20 : 3,
                                        background: '#ffffff',
                                        boxShadow: isLight
                                            ? '0 1px 3px rgba(0,0,0,0.20)'
                                            : '0 1px 3px rgba(0,0,0,0.40)',
                                    }}
                                />
                            </button>
                        </div>
                    </div>
                </div>

                {/* ── Custom categories (when enabled) ── */}
                {config.enabled && (
                    <div className={`border-t px-5 py-4 space-y-3 ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>

                        {/* Weight gauge */}
                        <WeightGauge total={total} accent={meta.color} isLight={isLight} />

                        {/* Category list */}
                        <div className="space-y-2">
                            {config.categories.map(cat => (
                                <CategoryRow
                                    key={cat.key}
                                    category={cat}
                                    accent={meta.color}
                                    totalCats={config.categories.length}
                                    isLight={isLight}
                                    onEdit={() => openEdit(cat)}
                                    onDelete={() => handleDelete(cat.key)}
                                />
                            ))}
                        </div>

                        {/* Add category */}
                        <button
                            onClick={openAdd}
                            className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed text-[11.5px] font-medium transition-all ${isLight
                                ? 'border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-600 hover:bg-slate-50'
                                : 'border-white/[0.07] text-text-tertiary hover:border-white/15 hover:text-text-secondary hover:bg-white/[0.02]'
                                }`}
                        >
                            <Plus size={12} />
                            Add category
                        </button>

                        {/* Reset to defaults link */}
                        <button
                            onClick={() => {
                                onChange({
                                    ...config,
                                    categories: builtin.categories.map(c => ({
                                        key: c.key,
                                        label: c.label,
                                        weight: c.weight,
                                        checkpoints: [...c.checkpoints],
                                        framework: '',
                                    })),
                                });
                            }}
                            className={`flex items-center gap-1.5 text-[10px] transition-colors ${isLight
                                ? 'text-slate-400 hover:text-slate-600'
                                : 'text-text-tertiary hover:text-text-secondary'
                                }`}
                        >
                            <RotateCcw size={9} />
                            Reset this meeting type to defaults
                        </button>
                    </div>
                )}

                {/* ── Disabled state — preview of defaults ── */}
                {!config.enabled && (
                    <div className={`border-t px-5 py-4 ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                        <div className={`flex items-start gap-2 px-3 py-2 rounded-lg mb-3 ${isLight ? 'bg-slate-50 border border-slate-100' : 'bg-white/[0.02] border border-white/[0.05]'}`}>
                            <Sparkles size={11} className={`mt-0.5 shrink-0 ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`} />
                            <p className={`text-[10.5px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-text-secondary'}`}>
                                Using <strong className={isLight ? 'text-slate-800' : 'text-text-primary'}>{builtin.categories.length} built-in categories</strong>.
                                Toggle on to define your own scoring criteria for this call type.
                            </p>
                        </div>

                        {/* Default categories preview — compact chips */}
                        <div className="flex flex-wrap gap-1.5">
                            {builtin.categories.map(cat => (
                                <span
                                    key={cat.key}
                                    className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg border"
                                    style={{
                                        color: meta.color,
                                        background: meta.accentBg(isLight),
                                        borderColor: meta.accentBorder(isLight),
                                    }}
                                >
                                    <span className="tabular-nums font-bold opacity-60">{cat.weight}%</span>
                                    {cat.label}
                                </span>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Category modal */}
            {modalOpen && (
                <CategoryModal
                    category={isAddMode ? null : editingCat}
                    accentColor={meta.color}
                    onSave={handleCatSave}
                    onClose={() => setModalOpen(false)}
                    isLight={isLight}
                />
            )}
        </>
    );
};

// ─── Main Export ──────────────────────────────────────────────────────────────

export const ScoringCriteriaTab: React.FC = () => {
    const isLight = useResolvedTheme() === 'light';
    const [settings, setSettings] = useState<ScoringCriteriaSettings>(buildDefaultSettings);
    const savedSnapshot = useRef<ScoringCriteriaSettings>(settings);
    const [isDirty, setIsDirty] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState('');

    // Load from DB on mount
    useEffect(() => {
        (window as any).electronAPI?.scoringGetCriteria?.()
            .then((res: any) => {
                if (res?.success && res.data) {
                    setSettings(res.data);
                    savedSnapshot.current = res.data;
                }
            })
            .catch(console.warn);
    }, []);

    const handleConfigChange = useCallback((meetingType: MeetingType, updated: CustomScorecardConfig) => {
        setSettings(prev => ({
            ...prev,
            configs: prev.configs.map(c => c.meetingType === meetingType ? updated : c),
        }));
        setIsDirty(true);
        setSaveError('');
    }, []);

    // Validate: all enabled configs must sum to 100%
    const allValid = settings.configs.every(cfg => !cfg.enabled || totalWeight(cfg.categories) === 100);

    const handleSave = async () => {
        if (!allValid) return;
        setIsSaving(true);
        setSaveError('');
        try {
            const res = await window.electronAPI?.scoringSaveCriteria(settings);
            if (res?.success) {
                savedSnapshot.current = settings;
                setIsDirty(false);
            } else {
                setSaveError(res?.error ?? 'Save failed. Please try again.');
            }
        } catch (e: any) {
            setSaveError(e.message ?? 'Save failed.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDiscard = () => {
        setSettings(JSON.parse(JSON.stringify(savedSnapshot.current)));
        setIsDirty(false);
        setSaveError('');
    };

    const handleFullReset = async () => {
        if (!confirm('Reset all meeting score criteria to built-in defaults? This cannot be undone.')) return;
        await (window as any).electronAPI?.scoringResetCriteria?.();
        const fresh = buildDefaultSettings();
        setSettings(fresh);
        savedSnapshot.current = fresh;
        setIsDirty(false);
        setSaveError('');
    };

    const enabledCount = settings.configs.filter(c => c.enabled).length;

    return (
        <div className="space-y-6 animated fadeIn pb-10">

            {/* ── Page header ── */}
            <div className="mb-5">
                <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                        <h3 className={`text-sm font-bold ${isLight ? 'text-slate-900' : 'text-text-primary'}`}>Meeting Score Criteria</h3>
                        {enabledCount > 0 && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                {enabledCount} custom
                            </span>
                        )}
                    </div>

                    {/* Global reset */}
                    <button
                        onClick={handleFullReset}
                        className={`flex items-center gap-1.5 text-[10px] font-medium transition-colors px-2 py-1 rounded-lg border border-transparent hover:border-red-500/20 hover:bg-red-500/10 hover:text-red-400 ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`}
                    >
                        <RotateCcw size={10} />
                        Reset all
                    </button>
                </div>
                <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-text-secondary'}`}>
                    Override how each call type is scored. Enable a type to define your own categories,
                    frameworks, weights, and checkpoints. Disabled types use the built-in rubric.
                </p>
            </div>

            {/* ── Meeting type sections ── */}
            <div className="space-y-4">
                {settings.configs.map(cfg => (
                    <MeetingTypeSection
                        key={cfg.meetingType}
                        config={cfg}
                        isLight={isLight}
                        onChange={updated => handleConfigChange(cfg.meetingType, updated)}
                    />
                ))}
            </div>

            {/* ── Info callout ── */}
            <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-white/[0.02] border-border-subtle'}`}>
                <Info size={13} className={`shrink-0 mt-0.5 ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`} />
                <p className={`text-[11px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-text-secondary'}`}>
                    Custom criteria take effect on the <strong className={isLight ? 'text-slate-800' : 'text-text-primary'}>next meeting</strong> that ends.
                    Already-scored meetings are not affected.
                </p>
            </div>

            {/* ── Error banner ── */}
            {saveError && (
                <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[11px] text-red-400 font-medium animated fadeIn">
                    <AlertCircle size={13} className="shrink-0" />
                    {saveError}
                    <button onClick={() => setSaveError('')} className="ml-auto shrink-0">
                        <X size={12} />
                    </button>
                </div>
            )}

            {/* ── Sticky save bar (mirrors CompanyContextTab pattern exactly) ── */}
            {isDirty && (
                <div className="sticky bottom-0 pt-3 pb-1 animated fadeIn">
                    <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border shadow-lg ${isLight ? 'bg-white border-slate-200' : 'bg-bg-elevated border-border-subtle'}`}>
                        <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-text-secondary'}`}>
                            {allValid
                                ? 'You have unsaved changes'
                                : 'Fix weight totals before saving'}
                        </p>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleDiscard}
                                disabled={isSaving}
                                className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all border disabled:opacity-50 ${isLight
                                    ? 'text-slate-600 hover:text-slate-800 hover:bg-slate-50 border-slate-200'
                                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-input border-border-subtle'
                                    }`}
                            >
                                Discard
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={isSaving || !allValid}
                                className="px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed bg-text-primary text-bg-main hover:opacity-90 shadow"
                            >
                                {isSaving
                                    ? <><RefreshCw size={12} className="animate-spin" /> Saving…</>
                                    : <><BarChart3 size={12} /> Save Scoring Rules</>
                                }
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ScoringCriteriaTab;