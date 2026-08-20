import React from 'react';
import { Check } from 'lucide-react';
import { ModelOption } from '@/types';

interface ModelOptionRowProps {
    model: ModelOption;
    isSelected: boolean;
    isLight: boolean;
    onSelect: () => void;
}

// Single selectable row in the model list. Pulled out of ModelSelectorWindow
// so the row markup and selected/hover styling live in one reusable place
// instead of inline inside a .map().
const ModelOptionRow: React.FC<ModelOptionRowProps> = ({ model, isSelected, isLight, onSelect }) => {
    return (
        <button
            onClick={onSelect}
            className={`
                w-full text-left px-3 py-2 flex items-center justify-between group transition-colors duration-200 rounded-lg
                ${isSelected
                    ? (isLight ? 'bg-black/[0.07] text-slate-900' : 'bg-white/10 text-white')
                    : (isLight ? 'text-slate-500 hover:bg-black/[0.04] hover:text-slate-800' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200')
                }
            `}
        >
            <span className="text-[12px] font-medium truncate flex-1 min-w-0">{model.name}</span>
            {isSelected && <Check className={`w-3.5 h-3.5 shrink-0 ml-2 ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`} />}
        </button>
    );
};

export default ModelOptionRow;