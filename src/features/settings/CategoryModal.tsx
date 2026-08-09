import React from 'react';
import { X, Save, BarChart3, Tag, Weight, Info } from 'lucide-react';
import { CategoryModalProps } from '@/types';
import { useCategoryModal } from '@/hooks/useCategoryModal';
import { FRAMEWORK_SUGGESTIONS } from './ScoringCriteriaConstants';

// Modal for adding or editing a single scoring category (name, framework tag,
// weight slider, checkpoints). All form state now lives in useCategoryModal —
// this component only renders.
const CategoryModal: React.FC<CategoryModalProps> = ({ category, accentColor, onSave, onClose, isLight }) => {
    const {
        label, setLabel,
        framework, setFramework,
        weight, setWeight,
        checkpointText, setCheckpointText,
        showFrameworkSuggestions, setShowFrameworkSuggestions, hideSuggestionsSoon,
        isAddMode,
        checkpoints,
        canSave,
        handleSave,
    } = useCategoryModal({ category, onSave });

    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-2 focus:ring-accent-primary/20 focus:border-accent-primary/50';

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
                                onBlur={hideSuggestionsSoon}
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

export default CategoryModal;