// State + business logic for AIProvidersSettings. Split into small,
// single-purpose sections below (standard providers, custom providers,
// Ollama, default model) and combined into one hook so the component only
// owns rendering — same split as useProviderCard / useCropper /
// useModelSelectorWindow.

import { useCallback, useEffect, useMemo, useState } from "react";
import { STANDARD_CLOUD_MODELS, prettifyModelId } from "@/../utils/modelUtils";
import { validateCurl } from "@/lib/curl-validator";
import { AIProviderCustomProvider } from "@/types";

export type StandardProviderId = "gemini" | "groq" | "openai" | "claude";
export type OllamaStatus = "checking" | "detected" | "not-found" | "fixing";
export type ConnectionTestStatus = "idle" | "testing" | "success" | "error";

const STANDARD_PROVIDER_IDS: StandardProviderId[] = ["gemini", "groq", "openai", "claude"];

/** Maps each standard provider to its electronAPI "set key" call, so handlers below don't need repeated if/else chains. */
const PROVIDER_SET_KEY: Record<StandardProviderId, (key: string) => Promise<any>> = {
    // @ts-ignore — electronAPI is injected by the preload script
    gemini: (key) => window.electronAPI.setGeminiApiKey(key),
    // @ts-ignore
    groq: (key) => window.electronAPI.setGroqApiKey(key),
    // @ts-ignore
    openai: (key) => window.electronAPI.setOpenaiApiKey(key),
    // @ts-ignore
    claude: (key) => window.electronAPI.setClaudeApiKey(key),
};

/** "Get an API key" links shown in each ProviderCard. */
export const PROVIDER_KEY_URLS: Record<StandardProviderId, string> = {
    gemini: "https://aistudio.google.com/app/apikey",
    groq: "https://console.groq.com/keys",
    openai: "https://platform.openai.com/api-keys",
    claude: "https://console.anthropic.com/settings/keys",
};

export const PROVIDER_KEY_PLACEHOLDERS: Record<StandardProviderId, string> = {
    gemini: "AIzaSy...",
    groq: "gsk_...",
    openai: "sk-...",
    claude: "sk-ant-...",
};

export const PROVIDER_DISPLAY_NAMES: Record<StandardProviderId, string> = {
    gemini: "Gemini",
    groq: "Groq",
    openai: "OpenAI",
    claude: "Claude",
};

// ============================================================
// Standard (cloud) providers: keys, save/remove/test, statuses
// ============================================================
function useStandardProviders() {
    const [apiKeys, setApiKeys] = useState<Record<StandardProviderId, string>>({
        gemini: "",
        groq: "",
        openai: "",
        claude: "",
    });
    const [savedStatus, setSavedStatus] = useState<Record<string, boolean>>({});
    const [savingStatus, setSavingStatus] = useState<Record<string, boolean>>({});
    const [hasStoredKey, setHasStoredKey] = useState<Record<string, boolean>>({});
    const [testStatus, setTestStatus] = useState<Record<string, ConnectionTestStatus>>({});
    const [testError, setTestError] = useState<Record<string, string>>({});
    const [preferredModels, setPreferredModels] = useState<Record<string, string>>({});

    const setApiKeyValue = useCallback((provider: StandardProviderId, value: string) => {
        setApiKeys((prev) => ({ ...prev, [provider]: value }));
    }, []);

    const setPreferredModel = useCallback((provider: string, model: string) => {
        setPreferredModels((prev) => ({ ...prev, [provider]: model }));
    }, []);

    /** Loads stored credentials + preferred models from the main process (called once on mount). */
    const loadStandardProviders = useCallback(async () => {
        // @ts-ignore
        const creds = await window.electronAPI?.getStoredCredentials?.();
        if (!creds) return;

        setHasStoredKey({
            gemini: creds.hasGeminiKey,
            groq: creds.hasGroqKey,
            openai: creds.hasOpenaiKey,
            claude: creds.hasClaudeKey,
        });

        const pm: Record<string, string> = {};
        if (creds.geminiPreferredModel) pm.gemini = creds.geminiPreferredModel;
        if (creds.groqPreferredModel) pm.groq = creds.groqPreferredModel;
        if (creds.openaiPreferredModel) pm.openai = creds.openaiPreferredModel;
        if (creds.claudePreferredModel) pm.claude = creds.claudePreferredModel;
        setPreferredModels(pm);
    }, []);

    const handleSaveKey = useCallback(async (provider: StandardProviderId) => {
        const key = apiKeys[provider];
        if (!key.trim()) return;

        setSavingStatus((prev) => ({ ...prev, [provider]: true }));
        try {
            const result = await PROVIDER_SET_KEY[provider](key);
            if (result && result.success) {
                setSavedStatus((prev) => ({ ...prev, [provider]: true }));
                setHasStoredKey((prev) => ({ ...prev, [provider]: true }));
                setApiKeyValue(provider, "");
                setTimeout(() => setSavedStatus((prev) => ({ ...prev, [provider]: false })), 2000);
            }
        } catch (e) {
            console.error(`Failed to save ${provider} key:`, e);
        } finally {
            setSavingStatus((prev) => ({ ...prev, [provider]: false }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiKeys, setApiKeyValue]);

    const handleRemoveKey = useCallback(async (provider: StandardProviderId) => {
        if (!confirm(`Are you sure you want to remove the ${provider} API key?`)) return;
        try {
            const result = await PROVIDER_SET_KEY[provider]("");
            if (result && result.success) {
                setHasStoredKey((prev) => ({ ...prev, [provider]: false }));
                setApiKeyValue(provider, "");
            }
        } catch (e) {
            console.error(`Failed to remove ${provider} key:`, e);
        }
    }, [setApiKeyValue]);

    const handleTestConnection = useCallback(async (provider: StandardProviderId) => {
        const key = apiKeys[provider];
        // Allow testing if a key is typed OR one is already stored.
        if (!key.trim() && !hasStoredKey[provider]) return;

        setTestStatus((prev) => ({ ...prev, [provider]: "testing" }));
        setTestError((prev) => ({ ...prev, [provider]: "" }));

        try {
            // @ts-ignore
            const result = await window.electronAPI.testLlmConnection(provider, key);
            if (result.success) {
                setTestStatus((prev) => ({ ...prev, [provider]: "success" }));
                setTimeout(() => setTestStatus((prev) => ({ ...prev, [provider]: "idle" })), 3000);
            } else {
                setTestStatus((prev) => ({ ...prev, [provider]: "error" }));
                setTestError((prev) => ({ ...prev, [provider]: result.error || "Connection failed" }));
            }
        } catch (e: any) {
            setTestStatus((prev) => ({ ...prev, [provider]: "error" }));
            setTestError((prev) => ({ ...prev, [provider]: e.message || "Connection failed" }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiKeys, hasStoredKey]);

    const openKeyUrl = useCallback((provider: StandardProviderId) => {
        // @ts-ignore
        window.electronAPI?.openExternal(PROVIDER_KEY_URLS[provider]);
    }, []);

    return {
        apiKeys,
        setApiKeyValue,
        savedStatus,
        savingStatus,
        hasStoredKey,
        testStatus,
        testError,
        preferredModels,
        setPreferredModel,
        loadStandardProviders,
        handleSaveKey,
        handleRemoveKey,
        handleTestConnection,
        openKeyUrl,
    };
}

// ============================================================
// Custom (cURL-configured) providers: list + add/edit form
// ============================================================
function useCustomProviders() {
    const [customProviders, setCustomProviders] = useState<AIProviderCustomProvider[]>([]);
    const [isEditingCustom, setIsEditingCustom] = useState(false);
    const [editingProvider, setEditingProvider] = useState<AIProviderCustomProvider | null>(null);
    const [customName, setCustomName] = useState("");
    const [customCurl, setCustomCurl] = useState("");
    const [customResponsePath, setCustomResponsePath] = useState("");
    const [curlError, setCurlError] = useState<string | null>(null);

    const loadCustomProviders = useCallback(async () => {
        // @ts-ignore
        const custom = await window.electronAPI?.getCustomProviders();
        if (custom) setCustomProviders(custom);
    }, []);

    const handleEditProvider = useCallback((provider: AIProviderCustomProvider) => {
        setEditingProvider(provider);
        setCustomName(provider.name);
        setCustomCurl(provider.curlCommand);
        setCustomResponsePath(provider.responsePath || "");
        setIsEditingCustom(true);
        setCurlError(null);
    }, []);

    const handleNewProvider = useCallback(() => {
        setEditingProvider(null);
        setCustomName("");
        setCustomCurl("");
        setCustomResponsePath("");
        setIsEditingCustom(true);
        setCurlError(null);
    }, []);

    const handleSaveCustom = useCallback(async () => {
        setCurlError(null);
        if (!customName.trim()) {
            setCurlError("Provider Name is required.");
            return;
        }

        const validation = validateCurl(customCurl);
        if (!validation.isValid) {
            setCurlError(validation.message || "Invalid cURL command.");
            return;
        }

        const newProvider: AIProviderCustomProvider = {
            id: editingProvider ? editingProvider.id : crypto.randomUUID(),
            name: customName,
            curlCommand: customCurl,
            responsePath: customResponsePath,
        };

        try {
            // @ts-ignore
            const result = await window.electronAPI.saveCustomProvider(newProvider);
            if (result.success) {
                await loadCustomProviders();
                setIsEditingCustom(false);
            } else {
                setCurlError(result.error ?? null);
            }
        } catch (e: any) {
            setCurlError(e.message);
        }
    }, [customName, customCurl, customResponsePath, editingProvider, loadCustomProviders]);

    const handleDeleteCustom = useCallback(async (id: string) => {
        if (!confirm("Are you sure you want to delete this provider?")) return;
        try {
            // @ts-ignore
            const result = await window.electronAPI.deleteCustomProvider(id);
            if (result.success) await loadCustomProviders();
        } catch (e) {
            console.error("Failed to delete provider:", e);
        }
    }, [loadCustomProviders]);

    return {
        customProviders,
        isEditingCustom,
        setIsEditingCustom,
        editingProvider,
        customName,
        setCustomName,
        customCurl,
        setCustomCurl,
        customResponsePath,
        setCustomResponsePath,
        curlError,
        loadCustomProviders,
        handleEditProvider,
        handleNewProvider,
        handleSaveCustom,
        handleDeleteCustom,
    };
}

// ============================================================
// Local (Ollama) models: detection, smart-start, auto-fix
// ============================================================
function useOllamaProviders() {
    const [ollamaModels, setOllamaModels] = useState<string[]>([]);
    const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>("checking");
    const [ollamaRestarted, setOllamaRestarted] = useState(false);
    const [isRefreshingOllama, setIsRefreshingOllama] = useState(false);

    // checkOllama reads/writes ollamaStatus, so it's kept as a ref-free callback
    // that always re-derives from the latest render — matches original behavior.
    const checkOllama = useCallback(async (_isInitial = true) => {
        try {
            // @ts-ignore
            const models = await window.electronAPI?.getAvailableOllamaModels?.();
            if (models && models.length > 0) {
                setOllamaModels(models);
                setOllamaStatus("detected");
            } else {
                setOllamaStatus((prev) => (prev !== "detected" ? "not-found" : prev));
            }
        } catch (e) {
            setOllamaStatus((prev) => (prev !== "detected" ? "not-found" : prev));
        }
    }, []);

    const ensureOllamaStartup = useCallback(async () => {
        setOllamaStatus("checking");
        try {
            // @ts-ignore
            const result = await window.electronAPI?.invoke?.("ensure-ollama-running");
            if (result && result.success) {
                checkOllama(true);
            } else {
                setOllamaStatus("not-found");
            }
        } catch (e) {
            console.warn("Ollama ensure startup failed:", e);
            setOllamaStatus("not-found");
        }
    }, [checkOllama]);

    const handleFixOllama = useCallback(async () => {
        setOllamaStatus("fixing");
        try {
            // @ts-ignore
            const result = await window.electronAPI?.invoke?.("force-restart-ollama");
            if (result && result.success) {
                setOllamaRestarted(true);
                setTimeout(() => checkOllama(false), 2000);
            } else {
                setOllamaStatus("not-found");
            }
        } catch (e) {
            console.error("Fix failed", e);
            setOllamaStatus("not-found");
        }
    }, [checkOllama]);

    const handleRefreshOllama = useCallback(async () => {
        setIsRefreshingOllama(true);
        await checkOllama(false);
        // Small delay so the spin animation is visible even on a fast check.
        setTimeout(() => setIsRefreshingOllama(false), 500);
    }, [checkOllama]);

    // Immediate smart-start on mount, then poll every 3s for maintenance.
    useEffect(() => {
        ensureOllamaStartup();
        const interval = setInterval(() => checkOllama(false), 3000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {
        ollamaModels,
        ollamaStatus,
        ollamaRestarted,
        isRefreshingOllama,
        handleFixOllama,
        handleRefreshOllama,
    };
}

// ============================================================
// Default model + Fast Response Mode
// ============================================================
function useDefaultModelSettings(hasGroqKey: boolean) {
    const [defaultModel, setDefaultModel] = useState<string>("gemini-3.1-flash-lite-preview");
    const [fastResponseMode, setFastResponseMode] = useState(false);

    const loadDefaultModelSettings = useCallback(async () => {
        // @ts-ignore
        const fastMode = await window.electronAPI?.getGroqFastTextMode();
        if (fastMode) setFastResponseMode(fastMode.enabled);

        // @ts-ignore
        const result = await window.electronAPI?.getDefaultModel();
        if (result && result.model) setDefaultModel(result.model);

        // Two-way sync: another window may toggle fast mode.
        if (window.electronAPI?.onGroqFastTextChanged) {
            // @ts-ignore
            return window.electronAPI.onGroqFastTextChanged((enabled: boolean) => {
                setFastResponseMode(enabled);
                localStorage.setItem("natively_groq_fast_text", String(enabled));
            });
        }
    }, []);

    const selectDefaultModel = useCallback((modelId: string) => {
        setDefaultModel(modelId);
        // @ts-ignore — persists as default + updates runtime + broadcasts to other windows
        window.electronAPI?.setDefaultModel(modelId).catch(console.error);
    }, []);

    const toggleFastResponseMode = useCallback(async () => {
        if (!hasGroqKey) {
            alert("Please configure a Groq API Key first to enable Fast Response Mode.");
            return;
        }
        const newState = !fastResponseMode;
        setFastResponseMode(newState);
        localStorage.setItem("natively_groq_fast_text", String(newState));
        // @ts-ignore
        await window.electronAPI?.setGroqFastTextMode(newState);
    }, [fastResponseMode, hasGroqKey]);

    // Force fast mode off if the Groq key is ever removed while it's enabled.
    useEffect(() => {
        if (!hasGroqKey && fastResponseMode) {
            setFastResponseMode(false);
            localStorage.setItem("natively_groq_fast_text", "false");
            // @ts-ignore
            window.electronAPI?.setGroqFastTextMode(false);
        }
    }, [hasGroqKey, fastResponseMode]);

    return {
        defaultModel,
        fastResponseMode,
        loadDefaultModelSettings,
        selectDefaultModel,
        toggleFastResponseMode,
    };
}

// ============================================================
// Combined hook
// ============================================================
export function useAIProvidersSettings() {
    const standard = useStandardProviders();
    const custom = useCustomProviders();
    const ollama = useOllamaProviders();
    const defaultModelSettings = useDefaultModelSettings(!!standard.hasStoredKey.groq);

    // Load everything that needs to happen once on mount.
    useEffect(() => {
        let unsubscribeFastText: (() => void) | undefined;

        (async () => {
            try {
                await standard.loadStandardProviders();
                await custom.loadCustomProviders();
                unsubscribeFastText = await defaultModelSettings.loadDefaultModelSettings();
            } catch (e) {
                console.error("Failed to load settings:", e);
            }
        })();

        return () => unsubscribeFastText?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Builds the full list of selectable models for the "Default Model" picker:
    // standard cloud models (only for providers with a stored key) + any unique
    // preferred model + custom providers + local Ollama models, always
    // including the current default even if it's since become unavailable.
    const defaultModelOptions = useMemo(() => {
        const opts: { id: string; name: string }[] = [];

        for (const [prov, cfg] of Object.entries(STANDARD_CLOUD_MODELS)) {
            if (!standard.hasStoredKey[prov]) continue;
            cfg.ids.forEach((id, i) => opts.push({ id, name: cfg.names[i] }));
            const pm = standard.preferredModels[prov];
            if (pm && !cfg.ids.includes(pm)) {
                opts.push({ id: pm, name: prettifyModelId(pm) });
            }
        }

        custom.customProviders.forEach((p) => opts.push({ id: p.id, name: p.name }));
        ollama.ollamaModels.forEach((m) => opts.push({ id: `ollama-${m}`, name: `${m} (Local)` }));

        if (defaultModelSettings.defaultModel && !opts.find((o) => o.id === defaultModelSettings.defaultModel)) {
            opts.unshift({ id: defaultModelSettings.defaultModel, name: prettifyModelId(defaultModelSettings.defaultModel) });
        }

        return opts;
    }, [standard.hasStoredKey, standard.preferredModels, custom.customProviders, ollama.ollamaModels, defaultModelSettings.defaultModel]);

    return {
        providerIds: STANDARD_PROVIDER_IDS,
        standard,
        custom,
        ollama,
        defaultModelSettings,
        defaultModelOptions,
    };
}