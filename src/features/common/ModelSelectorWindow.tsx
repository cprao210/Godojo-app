import { useResolvedTheme } from '@/hooks/useResolvedTheme';
import { useModelSelectorWindow } from '@/hooks';
import { Loader2 } from 'lucide-react';
import ModelOptionRow from '@/features/common/ModelOptionRow';

// ============================================
// Main Component
// ============================================
// Floating panel (opened as its own small Electron window) that lists every
// available model — cloud, custom, and local Ollama — and lets the user
// switch the active one. All data loading, caching, and selection logic now
// lives in useModelSelectorWindow; this component only renders.
const ModelSelectorWindow = () => {
    const isLight = useResolvedTheme() === 'light';
    const { currentModel, availableModels, isLoading, selectModel } = useModelSelectorWindow();

    const panelClass = isLight
        ? 'bg-[#F3F4F6]/92 border-black/10 shadow-black/10'
        : 'bg-[#1E1E1E]/80 border-white/10 shadow-black/40';

    return (
        <div className="w-fit h-fit bg-transparent flex flex-col">
            <div className={`w-[140px] h-[200px] backdrop-blur-md border rounded-[16px] overflow-hidden shadow-2xl p-2 flex flex-col animate-scale-in origin-top-left ${panelClass}`}>

                {isLoading ? (
                    <div className={`flex items-center justify-center py-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        <span className="text-xs">Loading models...</span>
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto scrollbar-hide flex flex-col gap-0.5">
                        {availableModels.length === 0 ? (
                            <div className={`px-4 py-3 text-center text-xs ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                                No models connected.<br />Check Settings.
                            </div>
                        ) : (
                            availableModels.map((model) => (
                                <ModelOptionRow
                                    key={model.id}
                                    model={model}
                                    isSelected={currentModel === model.id}
                                    isLight={isLight}
                                    onSelect={() => selectModel(model.id)}
                                />
                            ))
                        )}
                    </div>
                )}

            </div>
        </div>
    );
};

export default ModelSelectorWindow;