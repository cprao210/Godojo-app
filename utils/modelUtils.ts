// utils/modelUtils.ts
//
// Renderer-side model list for the AI Providers settings. No longer a
// hardcoded model table: ids/names are DERIVED from the shared catalog seeds
// (utils/modelCatalogShared.ts — the single source of truth shared with the
// Electron main process). The dropdowns additionally merge the live catalog
// (window.electronAPI.getModelCatalog) and "Auto" entries at render time —
// see ModelSelector.tsx and useAIProvidersSettings.ts.

import { MODEL_CATALOG, displayNameFor, buildAutoId, isAutoId, autoDisplayName, seedIds } from './modelCatalogShared';
import type { CatalogProvider } from './modelCatalogShared';

export type StandardProviderModelEntry = {
    hasKeyCheck: (creds: any) => boolean;
    ids: string[];
    names: string[];
    descs: string[];
    pmKey: 'geminiPreferredModel' | 'openaiPreferredModel' | 'claudePreferredModel' | 'groqPreferredModel';
};

const PM_KEYS: Record<CatalogProvider, StandardProviderModelEntry['pmKey']> = {
    gemini: 'geminiPreferredModel',
    groq: 'groqPreferredModel',
    openai: 'openaiPreferredModel',
    claude: 'claudePreferredModel',
};

const KEY_CHECKS: Record<CatalogProvider, (creds: any) => boolean> = {
    gemini: (creds) => !!creds?.hasGeminiKey,
    groq: (creds) => !!creds?.hasGroqKey,
    openai: (creds) => !!creds?.hasOpenaiKey,
    claude: (creds) => !!creds?.hasClaudeKey,
};

function buildEntry(provider: CatalogProvider): StandardProviderModelEntry {
    const seeds = MODEL_CATALOG[provider].seeds;
    // Primary (capable) first, then the fast tier, then any remaining capable
    // seeds (e.g. Claude Opus). Unique, seed order = preference order.
    const ids: string[] = [];
    for (const id of [seeds.capable[0], seeds.fast[0], ...seeds.capable.slice(1)]) {
        if (id && !ids.includes(id)) ids.push(id);
    }
    const names = ids.map((id) => displayNameFor(id));
    const descs = ids.map((_, i) =>
        i === 0 ? 'High Quality' : i === 1 ? 'Fastest' : 'Most Capable');
    return { hasKeyCheck: KEY_CHECKS[provider], ids, names, descs, pmKey: PM_KEYS[provider] };
}

export const STANDARD_CLOUD_MODELS: Record<string, StandardProviderModelEntry> = {
    gemini: buildEntry('gemini'),
    openai: buildEntry('openai'),
    claude: buildEntry('claude'),
    groq: buildEntry('groq'),
};

/** "Auto (Recommended)" per provider — resolves to the provider's CURRENT
 *  model from the live catalog at call time (LLMHelper.setModel →
 *  ModelCatalog.resolveAuto), so provider deprecations never require the
 *  user (or us) to pick a new model. */
export const AUTO_MODEL_OPTIONS: Record<string, { id: string; name: string; desc: string }> = {
    gemini: { id: buildAutoId('gemini'), name: 'Gemini Auto (Recommended)', desc: 'Always up to date' },
    groq: { id: buildAutoId('groq'), name: 'Groq Auto (Recommended)', desc: 'Always up to date' },
    openai: { id: buildAutoId('openai'), name: 'OpenAI Auto (Recommended)', desc: 'Always up to date' },
    claude: { id: buildAutoId('claude'), name: 'Claude Auto (Recommended)', desc: 'Always up to date' },
};

/** Fallback list when no live catalog is available (= seeds). */
export function fallbackProviderIds(provider: CatalogProvider): string[] {
    return seedIds(provider);
}

export const prettifyModelId = (id: string): string => {
    if (!id) return '';
    if (isAutoId(id)) return autoDisplayName(id) ?? id;
    return displayNameFor(id);
};
