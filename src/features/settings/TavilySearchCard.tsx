import React from 'react';
import { Globe, Trash2, Info } from 'lucide-react';

interface TavilySearchCardProps {
    apiKey: string;
    hasStoredKey: boolean;
    saving: boolean;
    error: string;
    isLight: boolean;
    onKeyChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onRemove: () => void;
    onSave: () => void;
}

// "Tavily Search API" settings card (powers live web search for company
// research). Extracted from AIProvidersSettings since it's an independent,
// self-contained block unrelated to the AI-provider state above it.
const TavilySearchCard: React.FC<TavilySearchCardProps> = ({
    apiKey,
    hasStoredKey,
    saving,
    error,
    isLight,
    onKeyChange,
    onRemove,
    onSave,
}) => {
    return (
        <div className="mt-5">
            <div className="bg-bg-item-surface rounded-xl border border-border-subtle">
                <div className="p-5">
                    <div className="flex items-center gap-4 mb-4">
                        <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-emerald-500 shrink-0">
                            <Globe size={20} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h4 className="text-sm font-bold text-text-primary">Tavily Search API</h4>
                                {hasStoredKey && (
                                    <span className="text-[9px] font-bold text-emerald-500 px-1.5 py-0.5 bg-emerald-500/10 rounded-full border border-emerald-500/20 uppercase tracking-wide">Connected</span>
                                )}
                            </div>
                            <p className="text-[11px] text-text-secondary mt-0.5">
                                Powers live web search for company research.
                            </p>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div>
                            <div className="flex justify-between items-center mb-1.5">
                                <label className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide block">API Key</label>
                                {hasStoredKey && (
                                    <button
                                        onClick={onRemove}
                                        className="text-[10px] flex items-center gap-1 text-red-400 hover:text-red-300 transition-colors bg-red-500/10 hover:bg-red-500/20 px-1.5 py-0.5 rounded"
                                        title="Remove API Key"
                                    >
                                        <Trash2 size={10} strokeWidth={2} /> Remove
                                    </button>
                                )}
                            </div>
                            <input
                                type="password"
                                value={apiKey}
                                onChange={onKeyChange}
                                placeholder={hasStoredKey ? '••••••••••••' : 'Enter Tavily API key (tvly-...)'}
                                className={`w-full ${isLight ? "bg-bg-elevated" : "bg-gray-900"} border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all`}
                            />
                        </div>
                        {error && (
                            <p className="text-[10px] text-red-400 px-1">{error}</p>
                        )}
                        <button
                            onClick={onSave}
                            disabled={saving || !apiKey.trim()}
                            className={`w-full px-4 py-2 rounded-lg text-xs font-medium transition-all ${saving ? 'bg-bg-input text-text-tertiary cursor-wait' : !apiKey.trim() ? 'bg-bg-input text-text-tertiary cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm'}`}
                        >
                            {saving ? 'Saving...' : 'Save API Key'}
                        </button>
                    </div>

                    <div className="mt-3 flex items-start gap-2 px-3 py-2.5 bg-bg-input/50 rounded-lg">
                        <Info size={12} className="text-text-tertiary shrink-0 mt-0.5" />
                        <p className="text-[10px] text-text-tertiary leading-relaxed">
                            If not provided, LLM general knowledge is used for company research, which may be outdated. Get your free API key at <span className="text-emerald-500/80 hover:text-emerald-400 underline underline-offset-2 cursor-pointer" onClick={() => window.electronAPI?.openExternal?.('https://app.tavily.com/home')}>app.tavily.com</span>. Keys start with <code className="text-emerald-500/80">tvly-</code>.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TavilySearchCard;