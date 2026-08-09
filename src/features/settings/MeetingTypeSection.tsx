import React from 'react';
import { Plus, RotateCcw, Sparkles } from 'lucide-react';
import { MeetingTypeSectionProps } from '@/types';
import { SCORECARD_CONFIGS } from '@/lib/utils';
import { useMeetingTypeSection, totalWeight } from '@/hooks';
import { MEETING_TYPE_META } from './ScoringCriteriaConstants';
import WeightGauge from './WeightGauge';
import CategoryRow from './CategoryRow';
import CategoryModal from './CategoryModal';

// One meeting type's scoring card: header + enable toggle, then either the
// editable category list (enabled) or a read-only preview of the built-in
// defaults (disabled). The add/edit modal state now lives in
// useMeetingTypeSection — this component only renders.
const MeetingTypeSection: React.FC<MeetingTypeSectionProps> = ({ config, isLight, onChange }) => {
    const meta = MEETING_TYPE_META[config.meetingType];
    const builtin = SCORECARD_CONFIGS.find(c => c.meetingType === config.meetingType)!;
    const total = totalWeight(config.categories);

    const {
        modalOpen,
        editingCat,
        isAddMode,
        openAdd,
        openEdit,
        closeModal,
        handleCatSave,
        handleDelete,
        resetToDefaults,
        toggleEnabled,
    } = useMeetingTypeSection({ config, onChange });

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
                                onClick={toggleEnabled}
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
                        <WeightGauge total={total} />

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
                            onClick={() => resetToDefaults(builtin.categories as any)}
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
                    onClose={closeModal}
                    isLight={isLight}
                />
            )}
        </>
    );
};

export default MeetingTypeSection;