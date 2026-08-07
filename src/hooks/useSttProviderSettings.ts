// STT (speech-to-text) provider settings: which provider is active, each
// provider's API key + "is a key already stored" flag, Azure's region,
// Google's service-account file, client-side diarization, the Groq Whisper
// model choice, and the shared test-connection/save flow all providers use.
//
// One `getStoredCredentials()` call bootstraps every provider's "has a key"
// flag at once (including Tavily's — see `onTavilyKeyLoaded`), so this hook
// takes a callback rather than owning Tavily state itself.

import { useEffect, useRef, useState } from 'react';

export type SttProvider = 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox';
export type SttKeyProvider = Exclude<SttProvider, 'google'>;
export type ConnectionTestStatus = 'idle' | 'testing' | 'success' | 'error';

const PROVIDER_LABELS: Record<SttKeyProvider, string> = {
    groq: 'Groq',
    openai: 'OpenAI STT',
    elevenlabs: 'ElevenLabs',
    azure: 'Azure',
    ibmwatson: 'IBM Watson',
    soniox: 'Soniox',
    deepgram: 'Deepgram',
};

/** "Get an API key" documentation links per provider (Google needs a service-account file instead). */
export const STT_PROVIDER_KEY_URLS: Partial<Record<SttProvider, string>> = {
    groq: 'https://console.groq.com/keys',
    openai: 'https://platform.openai.com/api-keys',
    deepgram: 'https://console.deepgram.com',
    elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
    azure: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeech',
    ibmwatson: 'https://cloud.ibm.com/catalog/services/speech-to-text',
};

interface UseSttProviderSettingsArgs {
    isOpen: boolean;
    /** Lets useTavilySettings pick up its "has a key" flag from the same credentials payload. */
    onTavilyKeyLoaded?: (hasKey: boolean) => void;
}

export function useSttProviderSettings({ isOpen, onTavilyKeyLoaded }: UseSttProviderSettingsArgs) {
    const [sttProvider, setSttProviderState] = useState<SttProvider>('google');
    const [diarizeClientEnabled, setDiarizeClientEnabled] = useState(false);
    const [groqSttModel, setGroqSttModelState] = useState('whisper-large-v3-turbo');

    const [sttGroqKey, setSttGroqKey] = useState('');
    const [sttOpenaiKey, setSttOpenaiKey] = useState('');
    const [sttDeepgramKey, setSttDeepgramKey] = useState('');
    const [sttElevenLabsKey, setSttElevenLabsKey] = useState('');
    const [sttAzureKey, setSttAzureKey] = useState('');
    const [sttAzureRegion, setSttAzureRegion] = useState('eastus');
    const [sttIbmKey, setSttIbmKey] = useState('');
    const [sttSonioxKey, setSttSonioxKey] = useState('');

    const [hasStoredSttGroqKey, setHasStoredSttGroqKey] = useState(false);
    const [hasStoredSttOpenaiKey, setHasStoredSttOpenaiKey] = useState(false);
    const [hasStoredDeepgramKey, setHasStoredDeepgramKey] = useState(false);
    const [hasStoredElevenLabsKey, setHasStoredElevenLabsKey] = useState(false);
    const [hasStoredAzureKey, setHasStoredAzureKey] = useState(false);
    const [hasStoredIbmWatsonKey, setHasStoredIbmWatsonKey] = useState(false);
    const [hasStoredSonioxKey, setHasStoredSonioxKey] = useState(false);

    const [googleServiceAccountPath, setGoogleServiceAccountPath] = useState<string | null>(null);

    const [sttTestStatus, setSttTestStatus] = useState<ConnectionTestStatus>('idle');
    const [sttTestError, setSttTestError] = useState('');
    const [sttSaving, setSttSaving] = useState(false);
    const [sttSaved, setSttSaved] = useState(false);

    const [isSttDropdownOpen, setIsSttDropdownOpen] = useState(false);
    const sttDropdownRef = useRef<HTMLDivElement>(null);

    // ── Close the provider dropdown on outside click ─────────────────────────
    useEffect(() => {
        if (!isSttDropdownOpen) return;
        const handleClickOutside = (event: MouseEvent) => {
            if (sttDropdownRef.current && !sttDropdownRef.current.contains(event.target as Node)) {
                setIsSttDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isSttDropdownOpen]);

    // ── Load everything from stored credentials whenever the overlay opens ──
    useEffect(() => {
        if (!isOpen) return;
        const loadSttSettings = async () => {
            try {
                const creds = await window.electronAPI?.getStoredCredentials?.();
                if (creds) {
                    setSttProviderState(creds.sttProvider || 'google');
                    if (creds.groqSttModel) setGroqSttModelState(creds.groqSttModel);
                    setGoogleServiceAccountPath(creds.googleServiceAccountPath);
                    setHasStoredSttGroqKey(creds.hasSttGroqKey);
                    setHasStoredSttOpenaiKey(creds.hasSttOpenaiKey);
                    setHasStoredDeepgramKey(creds.hasDeepgramKey);
                    setHasStoredElevenLabsKey(creds.hasElevenLabsKey);
                    setHasStoredAzureKey(creds.hasAzureKey);
                    if (creds.azureRegion) setSttAzureRegion(creds.azureRegion);
                    setHasStoredIbmWatsonKey(creds.hasIbmWatsonKey);
                    setHasStoredSonioxKey(creds.hasSonioxKey || false);
                    onTavilyKeyLoaded?.(creds.hasTavilyKey || false);
                }
                const diarize = await window.electronAPI?.getDiarizeClientEnabled?.();
                setDiarizeClientEnabled(!!diarize);
            } catch (e) {
                console.error('[useSttProviderSettings] Failed to load STT settings:', e);
            }
        };
        loadSttSettings();
        // Deliberately excludes onTavilyKeyLoaded — callers typically pass a
        // fresh inline function each render, and it doesn't affect *what* to load.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const toggleDiarization = async () => {
        const next = !diarizeClientEnabled;
        setDiarizeClientEnabled(next); // optimistic
        try {
            const res = await window.electronAPI?.setDiarizeClientEnabled?.(next);
            if (res && res.success === false) setDiarizeClientEnabled(!next);
        } catch (e) {
            console.error('[useSttProviderSettings] Failed to set diarization:', e);
            setDiarizeClientEnabled(!next);
        }
    };

    const selectSttProvider = async (provider: SttProvider) => {
        setSttProviderState(provider);
        setIsSttDropdownOpen(false);
        setSttTestStatus('idle');
        setSttTestError('');
        try {
            await window.electronAPI?.setSttProvider?.(provider);
        } catch (e) {
            console.error('[useSttProviderSettings] Failed to set STT provider:', e);
        }
    };

    const setGroqSttModel = async (modelId: string) => {
        setGroqSttModelState(modelId);
        try {
            await window.electronAPI?.setGroqSttModel?.(modelId);
        } catch (e) {
            console.error('[useSttProviderSettings] Failed to set Groq model:', e);
        }
    };

    const selectGoogleServiceAccount = async () => {
        const result = await window.electronAPI?.selectServiceAccount?.();
        if (result?.success && result.path) setGoogleServiceAccountPath(result.path);
    };

    const saveAzureRegion = async () => {
        if (!sttAzureRegion.trim()) return;
        await window.electronAPI?.setAzureRegion?.(sttAzureRegion.trim());
        setSttSaved(true);
        setTimeout(() => setSttSaved(false), 2000);
    };

    const KEY_SETTERS: Record<SttKeyProvider, { setKey: (v: string) => Promise<any> | undefined; setHasKey: (v: boolean) => void; setLocal: (v: string) => void }> = {
        groq: { setKey: (v) => window.electronAPI?.setGroqSttApiKey?.(v), setHasKey: setHasStoredSttGroqKey, setLocal: setSttGroqKey },
        openai: { setKey: (v) => window.electronAPI?.setOpenAiSttApiKey?.(v), setHasKey: setHasStoredSttOpenaiKey, setLocal: setSttOpenaiKey },
        elevenlabs: { setKey: (v) => window.electronAPI?.setElevenLabsApiKey?.(v), setHasKey: setHasStoredElevenLabsKey, setLocal: setSttElevenLabsKey },
        azure: { setKey: (v) => window.electronAPI?.setAzureApiKey?.(v), setHasKey: setHasStoredAzureKey, setLocal: setSttAzureKey },
        ibmwatson: { setKey: (v) => window.electronAPI?.setIbmWatsonApiKey?.(v), setHasKey: setHasStoredIbmWatsonKey, setLocal: setSttIbmKey },
        soniox: { setKey: (v) => window.electronAPI?.setSonioxApiKey?.(v), setHasKey: setHasStoredSonioxKey, setLocal: setSttSonioxKey },
        deepgram: { setKey: (v) => window.electronAPI?.setDeepgramApiKey?.(v), setHasKey: setHasStoredDeepgramKey, setLocal: setSttDeepgramKey },
    };

    /** Tests the key against the provider before saving — a key is never persisted unless the test passes. */
    const submitSttKey = async (provider: SttKeyProvider, key: string) => {
        if (!key.trim()) return;

        setSttSaving(true);
        setSttTestStatus('testing');
        setSttTestError('');

        try {
            const testResult = await window.electronAPI?.testSttConnection?.(
                provider,
                key.trim(),
                provider === 'azure' ? sttAzureRegion : undefined,
            );

            if (!testResult?.success) {
                setSttTestStatus('error');
                setSttTestError(testResult?.error || 'Validation failed. Key not saved.');
                return; // stop — do not save an unverified key
            }

            setSttTestStatus('success');
            setTimeout(() => setSttTestStatus('idle'), 3000);

            await KEY_SETTERS[provider].setKey(key.trim());
            KEY_SETTERS[provider].setHasKey(true);

            setSttSaved(true);
            setTimeout(() => setSttSaved(false), 2000);
        } catch (e: any) {
            console.error(`[useSttProviderSettings] Failed to save ${provider} STT key:`, e);
            setSttTestStatus('error');
            setSttTestError(e.message || 'Validation failed');
        } finally {
            setSttSaving(false);
        }
    };

    const removeSttKey = async (provider: SttKeyProvider) => {
        const label = provider === 'ibmwatson' ? 'IBM Watson' : provider.charAt(0).toUpperCase() + provider.slice(1);
        if (!confirm(`Are you sure you want to remove the ${label} API key?`)) return;

        try {
            await KEY_SETTERS[provider].setKey('');
            KEY_SETTERS[provider].setLocal('');
            KEY_SETTERS[provider].setHasKey(false);
        } catch (e) {
            console.error(`[useSttProviderSettings] Failed to remove ${provider} STT key:`, e);
        }
    };

    const KEY_VALUES: Record<SttKeyProvider, string> = {
        groq: sttGroqKey, openai: sttOpenaiKey, deepgram: sttDeepgramKey,
        elevenlabs: sttElevenLabsKey, azure: sttAzureKey, ibmwatson: sttIbmKey,
        soniox: sttSonioxKey,
    };

    /** Re-tests whatever key is currently typed for the active provider (without saving). */
    const testCurrentProviderConnection = async () => {
        if (sttProvider === 'google') return;
        const keyToTest = KEY_VALUES[sttProvider as SttKeyProvider] || '';
        if (!keyToTest.trim()) {
            setSttTestStatus('error');
            setSttTestError('Please enter an API key first');
            return;
        }

        setSttTestStatus('testing');
        setSttTestError('');
        try {
            const result = await window.electronAPI?.testSttConnection?.(
                sttProvider,
                keyToTest.trim(),
                sttProvider === 'azure' ? sttAzureRegion : undefined,
            );
            if (result?.success) {
                setSttTestStatus('success');
                setTimeout(() => setSttTestStatus('idle'), 3000);
            } else {
                setSttTestStatus('error');
                setSttTestError(result?.error || 'Connection failed');
            }
        } catch (e: any) {
            setSttTestStatus('error');
            setSttTestError(e.message || 'Test failed');
        }
    };

    const openProviderKeyDocs = () => {
        const url = STT_PROVIDER_KEY_URLS[sttProvider];
        if (url) window.electronAPI?.openExternal(url);
    };

    return {
        sttProvider,
        diarizeClientEnabled,
        groqSttModel,
        googleServiceAccountPath,
        sttTestStatus,
        sttTestError,
        sttSaving,
        sttSaved,
        isSttDropdownOpen,
        setIsSttDropdownOpen,
        sttDropdownRef,
        // per-provider local (unsaved) key input + "already stored" flag
        keyInputs: { groq: sttGroqKey, openai: sttOpenaiKey, deepgram: sttDeepgramKey, elevenlabs: sttElevenLabsKey, azure: sttAzureKey, ibmwatson: sttIbmKey, soniox: sttSonioxKey },
        setKeyInput: (provider: SttKeyProvider, value: string) => KEY_SETTERS[provider].setLocal(value),
        hasStoredKey: { groq: hasStoredSttGroqKey, openai: hasStoredSttOpenaiKey, deepgram: hasStoredDeepgramKey, elevenlabs: hasStoredElevenLabsKey, azure: hasStoredAzureKey, ibmwatson: hasStoredIbmWatsonKey, soniox: hasStoredSonioxKey },
        sttAzureRegion,
        setSttAzureRegion,
        providerLabel: (provider: SttKeyProvider) => PROVIDER_LABELS[provider],
        toggleDiarization,
        selectSttProvider,
        setGroqSttModel,
        selectGoogleServiceAccount,
        saveAzureRegion,
        submitSttKey,
        removeSttKey,
        testCurrentProviderConnection,
        openProviderKeyDocs,
    };
}