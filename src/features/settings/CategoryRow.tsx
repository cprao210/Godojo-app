import React from 'react';
import { GripVertical, MoreVertical, Edit2, Trash2 } from 'lucide-react';
import { ScoringCategoryRowProps } from '@/types';
import { useCategoryRow } from '@/hooks/useCategoryRow';

// One row in a meeting type's category list: weight badge, name/framework/
// checkpoint-count, weight bar, and an edit/delete meatball menu. The menu's
// open/close state now lives in useCategoryRow — this component only renders.
const CategoryRow: React.FC<ScoringCategoryRowProps> = ({ category, accent, totalCats, isLight, onEdit, onDelete }) => {
    const { menuOpen, menuRef, toggleMenu, closeMenu } = useCategoryRow();

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
                    onClick={toggleMenu}
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
                            onClick={() => { closeMenu(); onEdit(); }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium transition-colors ${isLight
                                ? 'text-slate-700 hover:bg-slate-50'
                                : 'text-text-primary hover:bg-bg-input'
                                }`}
                        >
                            <Edit2 size={12} className={isLight ? 'text-slate-400' : 'text-text-tertiary'} /> Edit
                        </button>
                        <button
                            onClick={() => { closeMenu(); onDelete(); }}
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

export default CategoryRow;