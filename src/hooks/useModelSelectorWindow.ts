// State + data layer for ModelSelectorWindow: loads the list of available
// models (cloud providers with stored credentials, custom providers, local
// Ollama models), tracks/persists the currently active model, and keeps
// everything in sync with the Electron main process. Kept separate from the
// component so the component only owns rendering — same split as
// useCalendarConnections / useTopSearchPill / useGlobalChat.

import { useCallback, useEffect, useState } from "react";
import { STANDARD_CLOUD_MODELS, prettifyModelId } from "@/../utils/modelUtils";
import { ModelOption } from "@/types";

const CACHED_MODELS_KEY = "cached-models";
const CACHED_CURRENT_MODEL_KEY = "cached-current-model";

/** Reads the last-known model list from localStorage so the panel can render instantly, before the fresh fetch resolves. */
function readCachedModels(): ModelOption[] {
    try {
        const cached = localStorage.getItem(CACHED_MODELS_KEY);
        return cached ? JSON.parse(cached) : [];
    } catch {
        return [];
    }
}

/**
 * Fetches Ollama's local model list, retrying once via a forced restart if
 * the first attempt comes back empty (the local server may simply be down).
 */
async function fetchOllamaModelsWithRetry(): Promise<string[]> {
    try {
        let models = await window.electronAPI?.getAvailableOllamaModels?.();

        if (!models || models.length === 0) {
            try {
                // @ts-ignore — optional/legacy IPC method, not in every build
                if (window.electronAPI?.forceRestartOllama) {
                    // @ts-ignore
                    await window.electronAPI.forceRestartOllama();
                    // Give the server a moment to come back up before retrying.
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    models = await window.electronAPI?.getAvailableOllamaModels?.();
                }
            } catch (e) {
                console.warn("Retrying Ollama failed", e);
            }
        }

        return models || [];
    } catch {
        // Ollama is optional — swallow errors and report no local models.
        return [];
    }
}

/** Assembles the full model list from cloud, custom, and local (Ollama) sources. */
async function buildAvailableModels(): Promise<ModelOption[]> {
    // Stored credentials tell us which cloud providers are active.
    const creds = await window.electronAPI?.getStoredCredentials?.();
    const customProviders = (await window.electronAPI?.getCustomProviders?.()) || [];
    const ollamaModels = await fetchOllamaModelsWithRetry();

    const models: ModelOption[] = [];

    // Cloud models — standard models per provider + any unique preferred model.
    for (const [provider, cfg] of Object.entries(STANDARD_CLOUD_MODELS)) {
        if (!cfg.hasKeyCheck(creds)) continue;
        cfg.ids.forEach((id, i) => {
            models.push({ id, name: cfg.names[i], type: "cloud", provider });
        });
        const preferredModel = creds?.[cfg.pmKey];
        if (preferredModel && !cfg.ids.includes(preferredModel)) {
            models.push({ id: preferredModel, name: prettifyModelId(preferredModel), type: "cloud", provider });
        }
    }

    // Custom (user-configured) providers.
    customProviders.forEach((p: any) => {
        models.push({ id: p.id, name: p.name, type: "custom" });
    });

    // Local Ollama models.
    ollamaModels.forEach((m: string) => {
        models.push({ id: `ollama-${m}`, name: `${m} (Local)`, type: "ollama" });
    });

    return models;
}

export function useModelSelectorWindow() {
    const [currentModel, setCurrentModel] = useState<string>(
        () => localStorage.getItem(CACHED_CURRENT_MODEL_KEY) || "",
    );
    const [availableModels, setAvailableModels] = useState<ModelOption[]>(readCachedModels);
    // Only show the loading state on first mount when there's nothing cached yet, to avoid flicker on refocus.
    const [isLoading, setIsLoading] = useState<boolean>(() => availableModels.length === 0);

    const loadModels = useCallback(async () => {
        try {
            setIsLoading((prevModelsPresent) => availableModels.length === 0 || prevModelsPresent);

            const models = await buildAvailableModels();
            localStorage.setItem(CACHED_MODELS_KEY, JSON.stringify(models));
            setAvailableModels(models);

            // Sync the currently active model from the main process.
            const config = await window.electronAPI?.getCurrentLlmConfig?.();
            if (config && config.model) {
                setCurrentModel(config.model);
                localStorage.setItem(CACHED_CURRENT_MODEL_KEY, config.model);
            }
        } catch (err) {
            console.error("Failed to load models:", err);
        } finally {
            setIsLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Load on mount, refresh whenever the window regains focus, and stay in
    // sync with model changes triggered elsewhere in the app.
    useEffect(() => {
        loadModels();
        window.addEventListener("focus", loadModels);

        const unsubscribe = window.electronAPI?.onModelChanged?.((modelId: string) => {
            setCurrentModel(modelId);
        });

        return () => {
            unsubscribe?.();
            window.removeEventListener("focus", loadModels);
        };
    }, [loadModels]);

    const selectModel = useCallback((modelId: string) => {
        setCurrentModel(modelId);
        localStorage.setItem(CACHED_CURRENT_MODEL_KEY, modelId);

        window.electronAPI
            ?.setModel(modelId)
            .catch((err: any) => console.error("Failed to set model:", err));
    }, []);

    return {
        currentModel,
        availableModels,
        isLoading,
        selectModel,
    };
}