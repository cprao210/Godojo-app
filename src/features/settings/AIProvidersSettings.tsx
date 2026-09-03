import React from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { ProviderCard } from './ProviderCard';
import ModelSelect from './ModelSelect';
import OllamaStatusPanel from './OllamaStatusPanel';
import CustomProviderForm from './CustomProviderForm';
import CustomProviderListItem from './CustomProviderListItem';
import TavilySearchCard from './TavilySearchCard';
import { useResolvedTheme } from '@/hooks';
import {
    useAIProvidersSettings,
    PROVIDER_DISPLAY_NAMES,
    PROVIDER_KEY_PLACEHOLDERS,
    PROVIDER_KEY_URLS,
} from '@/hooks/useAIProvidersSettings';
import { AIProvidersSettingsTypes } from '@/types';

// ============================================
// Main Component
// ============================================
// The "AI Providers" settings tab: default model + fast response mode,
// standard cloud providers (Gemini/Groq/OpenAI/Claude), local Ollama models,
// custom cURL-based providers, and the Tavily search API key. All state and
// business logic now live in useAIProvidersSettings (composed from smaller
// per-section hooks); this component only renders.
export const AIProvidersSettings: React.FC<AIProvidersSettingsTypes> = ({
    tavilyApiKey,
    hasStoredTavilyKey,
    tavilyKeySource,
    handleRemoveTavilyKey,
    tavilySaving,
    tavilyError,
    handleAddTavilyKey,
    handleSaveTavilyKey,
}) => {
    const isLight = useResolvedTheme() === "light";
    const { providerIds, standard, custom, ollama, defaultModelSettings, defaultModelOptions } = useAIProvidersSettings();

    return (
        <div className="space-y-5 animated fadeIn pb-10">
            {/* Default Model for Chat */}
            <div className="space-y-5">
                <div>
                    <h3 className="text-sm font-bold text-text-primary mb-1">Default Model for Chat</h3>
                    <p className="text-xs text-text-secondary mb-2">Primary model for new chats. Other configured models act as fallbacks.</p>
                </div>

                <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle flex items-center justify-between">
                    <div>
                        <label className="block text-xs font-medium text-text-primary uppercase tracking-wide mb-0">Active Model</label>
                        <p className="text-[10px] text-text-secondary">Applies to new chats instantly.</p>
                    </div>
                    <ModelSelect
                        value={defaultModelSettings.defaultModel}
                        options={defaultModelOptions}
                        onChange={defaultModelSettings.selectDefaultModel}
                    />
                </div>

                {/* Fast Response Mode */}
                <div
                    className={`bg-bg-item-surface rounded-xl p-5 border border-border-subtle flex items-center justify-between ${!standard.hasStoredKey.groq ? 'opacity-50 grayscale' : ''}`}
                    title={!standard.hasStoredKey.groq ? "Requires Groq API Key to be configured" : ""}
                >
                    <div>
                        <div className="flex items-center gap-2">
                            <label className="block text-xs font-medium text-text-primary uppercase tracking-wide mb-0">Fast Response Mode</label>
                            <span className="bg-orange-500/10 text-orange-500 text-[9px] font-bold px-1.5 py-0.5 rounded border border-orange-500/20">NEW</span>
                        </div>
                        <p className="text-[10px] text-text-secondary mt-0.5">Super fast responses using Groq Llama 3 for text. Multimodal requests still use your Default Model.</p>
                        {!standard.hasStoredKey.groq && (
                            <p className="text-[10px] text-orange-500 mt-0.5 font-medium">Requires a Groq API Key to be configured below.</p>
                        )}
                    </div>
                    <div
                        onClick={defaultModelSettings.toggleFastResponseMode}
                        className={`w-11 h-6 rounded-full relative transition-colors ${!standard.hasStoredKey.groq ? 'cursor-not-allowed bg-bg-toggle-switch' : defaultModelSettings.fastResponseMode ? 'bg-orange-500' : 'bg-bg-toggle-switch border border-border-muted'}`}
                    >
                        <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${defaultModelSettings.fastResponseMode ? 'translate-x-5' : 'translate-x-0'}`} />
                    </div>
                </div>
            </div>

            {/* Cloud Providers */}
            <div className="space-y-5">
                <div>
                    <h3 className="text-sm font-bold text-text-primary mb-1">Cloud Providers</h3>
                    <p className="text-xs text-text-secondary mb-2">Add API keys to unlock cloud AI models.</p>
                </div>

                <div className="space-y-4">
                    {providerIds.map((providerId) => (
                        <ProviderCard
                            key={providerId}
                            providerId={providerId}
                            providerName={PROVIDER_DISPLAY_NAMES[providerId]}
                            apiKey={standard.apiKeys[providerId]}
                            preferredModel={standard.preferredModels[providerId]}
                            hasStoredKey={!!standard.hasStoredKey[providerId]}
                            keySource={standard.keySources[providerId]}
                            onKeyChange={(val) => standard.setApiKeyValue(providerId, val)}
                            onSaveKey={() => standard.handleSaveKey(providerId)}
                            onRemoveKey={() => standard.handleRemoveKey(providerId)}
                            onTestConnection={() => standard.handleTestConnection(providerId)}
                            testStatus={standard.testStatus[providerId] || 'idle'}
                            testError={standard.testError[providerId]}
                            savingStatus={!!standard.savingStatus[providerId]}
                            savedStatus={!!standard.savedStatus[providerId]}
                            keyPlaceholder={PROVIDER_KEY_PLACEHOLDERS[providerId]}
                            keyUrl={PROVIDER_KEY_URLS[providerId]}
                            onPreferredModelChange={(model) => standard.setPreferredModel(providerId, model)}
                        />
                    ))}
                </div>
            </div>

            {/* Local (Ollama) Providers */}
            <div className="space-y-5">
                <div className="flex items-center justify-between mb-2">
                    <div>
                        <h3 className="text-sm font-bold text-text-primary mb-1">Local Models (Ollama)</h3>
                        <p className="text-xs text-text-secondary">Run open-source models locally.</p>
                    </div>
                    <button
                        onClick={ollama.handleRefreshOllama}
                        className="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-input transition-colors"
                        title="Refresh Ollama"
                        disabled={ollama.isRefreshingOllama}
                    >
                        <RefreshCw size={18} className={ollama.isRefreshingOllama ? "animate-spin" : ""} />
                    </button>
                </div>

                <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                    <OllamaStatusPanel status={ollama.ollamaStatus} models={ollama.ollamaModels} onFix={ollama.handleFixOllama} />
                </div>
            </div>

            {/* Custom Providers */}
            <div className="space-y-5">
                <div className="flex items-center justify-between mb-2">
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-sm font-bold text-text-primary">Custom Providers</h3>
                            <span className="px-1.5 py-0 rounded-full text-[7px] font-bold bg-yellow-500/10 text-yellow-500 uppercase tracking-widest border border-yellow-500/20 leading-loose mt-0.5">Experimental</span>
                        </div>
                        <p className="text-xs text-text-secondary">Add your own AI endpoints via cURL.</p>
                    </div>
                    {!custom.isEditingCustom && (
                        <button
                            onClick={custom.handleNewProvider}
                            className="flex items-center gap-2 px-3 py-1.5 bg-bg-input hover:bg-bg-elevated border border-border-subtle rounded-lg text-xs font-medium text-text-primary transition-colors"
                        >
                            <Plus size={14} /> Add Provider
                        </button>
                    )}
                </div>

                {custom.isEditingCustom ? (
                    <CustomProviderForm
                        editingProvider={custom.editingProvider}
                        name={custom.customName}
                        onNameChange={custom.setCustomName}
                        curl={custom.customCurl}
                        onCurlChange={custom.setCustomCurl}
                        responsePath={custom.customResponsePath}
                        onResponsePathChange={custom.setCustomResponsePath}
                        error={custom.curlError}
                        onCancel={() => custom.setIsEditingCustom(false)}
                        onSave={custom.handleSaveCustom}
                    />
                ) : (
                    <div className="space-y-3">
                        {custom.customProviders.length === 0 ? (
                            <div className="text-center py-8 bg-bg-item-surface rounded-xl border border-border-subtle border-dashed">
                                <p className="text-xs text-text-tertiary">No custom providers added yet.</p>
                            </div>
                        ) : (
                            custom.customProviders.map((provider) => (
                                <CustomProviderListItem
                                    key={provider.id}
                                    provider={provider}
                                    onEdit={() => custom.handleEditProvider(provider)}
                                    onDelete={() => custom.handleDeleteCustom(provider.id)}
                                />
                            ))
                        )}
                    </div>
                )}
            </div>

            {/* Google Search API Card */}
            <TavilySearchCard
                apiKey={tavilyApiKey}
                hasStoredKey={hasStoredTavilyKey}
                keySource={tavilyKeySource}
                saving={tavilySaving}
                error={tavilyError}
                isLight={isLight}
                onKeyChange={handleAddTavilyKey}
                onRemove={handleRemoveTavilyKey}
                onSave={handleSaveTavilyKey}
            />
        </div>
    );
};