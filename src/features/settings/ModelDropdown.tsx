import React from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { FetchedModel } from '@/types';

interface ModelDropdownProps {
    dropdownRef: React.RefObject<HTMLDivElement>;
    fetchedModels: FetchedModel[];
    selectedModel: string;
    selectedOption: FetchedModel | undefined;
    preferredModel?: string;
    isOpen: boolean;
    isLight: boolean;
    onToggle: () => void;
    onSelect: (modelId: string) => void;
}

// Inline "current model" dropdown shown inside a ProviderCard's action row.
// Pulled out of ProviderCard.tsx so the trigger button + option list markup
// lives in one reusable place instead of inline JSX.
const ModelDropdown: React.FC<ModelDropdownProps> = ({
    dropdownRef,
    fetchedModels,
    selectedModel,
    selectedOption,
    preferredModel,
    isOpen,
    isLight,
    onToggle,
    onSelect,
}) => {
    const hasOptions = fetchedModels.length > 0;

    return (
        <div className="relative flex-1 max-w-[200px] mx-4" ref={dropdownRef}>
            <button
                onClick={onToggle}
                className={`w-full bg-bg-input border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary flex items-center justify-between transition-colors ${hasOptions ? 'hover:bg-bg-elevated' : 'opacity-80 cursor-default'}`}
                type="button"
            >
                <span className="truncate pr-2">{selectedOption ? selectedOption.label : (preferredModel || 'Select model')}</span>
                <ChevronDown size={14} className={`text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''} ${hasOptions ? '' : 'opacity-50'}`} />
            </button>

            {isOpen && hasOptions && (
                <div className={`absolute top-full left-1/2 -translate-x-1/2 mt-1 w-full min-w-[200px] ${isLight ? 'bg-bg-elevated' : 'bg-gray-900'} border border-border-subtle rounded-lg shadow-xl z-50 max-h-60 overflow-y-auto animated fadeIn`}>
                    <div className="p-1 space-y-0.5">
                        {fetchedModels.map((model) => (
                            <button
                                key={model.id}
                                onClick={() => onSelect(model.id)}
                                className={`w-full text-left px-3 py-2 text-xs rounded-md flex items-center justify-between group transition-colors ${selectedModel === model.id ? 'bg-bg-input hover:bg-bg-elevated text-text-primary' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                type="button"
                            >
                                <span className="truncate">{model.label}</span>
                                {selectedModel === model.id && <Check size={14} className="text-accent-primary shrink-0 ml-2" />}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ModelDropdown;