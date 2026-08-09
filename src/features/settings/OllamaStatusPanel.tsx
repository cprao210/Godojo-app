import React from 'react';
import { AlertCircle, CheckCircle } from 'lucide-react';
import { OllamaStatus } from '@/hooks/useAIProvidersSettings';

interface OllamaStatusPanelProps {
    status: OllamaStatus;
    models: string[];
    onFix: () => void;
}

// The body of the "Local Models (Ollama)" card — renders one of four states:
// checking, auto-fixing, not-found (with a fix button), or detected (with
// the model list). Extracted from AIProvidersSettings so each state's markup
// lives in one place instead of a long inline conditional block.
const OllamaStatusPanel: React.FC<OllamaStatusPanelProps> = ({ status, models, onFix }) => {
    if (status === 'checking') {
        return (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span className="animate-spin">⏳</span> Checking for Ollama...
            </div>
        );
    }

    if (status === 'fixing') {
        return (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span className="animate-spin">🔧</span> Attempting to auto-fix connection...
            </div>
        );
    }

    if (status === 'not-found') {
        return (
            <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle size={14} />
                    <span>Ollama not detected</span>
                </div>
                <div className="flex items-center gap-2">
                    <p className="text-xs text-text-secondary">
                        Ensure Ollama is running (`ollama serve`).
                    </p>
                    <button
                        onClick={onFix}
                        className="text-[10px] text-text-secondary bg-bg-elevated hover:bg-bg-input px-2 py-1 rounded border border-border-subtle"
                    >
                        Auto-Fix Connection
                    </button>
                </div>
            </div>
        );
    }

    // status === 'detected'
    if (models.length === 0) {
        return (
            <div className="text-xs text-text-secondary">
                Ollama is running but no models found. Run `ollama pull llama3` to get started.
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-green-400 mb-3">
                <CheckCircle size={14} />
                <span>Ollama connected</span>
            </div>

            <div className="grid grid-cols-1 gap-2">
                {models.map(model => (
                    <div key={model} className="flex items-center justify-between p-2 bg-bg-input rounded-lg border border-border-subtle">
                        <span className="text-xs text-text-primary font-mono">{model}</span>
                        <span className="text-[10px] text-bg-elevated bg-text-secondary px-1.5 py-0.5 rounded-full font-bold">LOCAL</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default OllamaStatusPanel;