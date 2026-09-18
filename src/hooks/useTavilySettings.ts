// Tavily API key management — powers company research (the "Sales Brief"
// panel and the Profile Intelligence company dossier). Kept separate from
// the STT provider keys since it's a different feature area, even though it
// was previously declared alongside them.

import { useState } from 'react';
import { settingsToast } from '@/lib/settingsToastBus';
import type { ApiKeySourceName } from '@/electron';

export function useTavilySettings() {
    const [tavilyApiKey, setTavilyApiKeyInput] = useState('');
    const [hasStoredTavilyKey, setHasStoredTavilyKey] = useState(false);
    const [tavilyKeySource, setTavilyKeySource] = useState<ApiKeySourceName | undefined>(undefined);
    const [tavilySaving, setTavilySaving] = useState(false);
    const [tavilyError, setTavilyError] = useState('');

    /** Bootstraps `hasStoredTavilyKey` + its tier from the shared credentials payload —
     * called from useSttProviderSettings's initial load, since both come from the same
     * `getStoredCredentials()` round-trip and we don't want to fetch it twice. */
    const setHasStoredTavilyKeyFromCredentials = (hasKey: boolean, source?: ApiKeySourceName) => {
        setHasStoredTavilyKey(hasKey);
        setTavilyKeySource(source);
    };

    const handleTavilyKeyInput = (value: string) => {
        setTavilyApiKeyInput(value);
        setTavilyError('');
    };

    const saveTavilyKey = async () => {
        if (!tavilyApiKey.trim()) return;
        setTavilyError('');
        setTavilySaving(true);
        try {
            const result = await window.electronAPI?.setTavilyApiKey?.(tavilyApiKey.trim());
            if (result && !result.success) {
                const message = result.error ?? 'Failed to save API key.';
                setTavilyError(message);
                settingsToast.error(message);
            } else {
                setHasStoredTavilyKey(true);
                setTavilyKeySource('user');
                setTavilyApiKeyInput('');
                settingsToast.success('Saved Successfully');
            }
        } catch (e: any) {
            const message = e?.message ?? 'Unexpected error saving API key.';
            setTavilyError(message);
            settingsToast.error(message);
        } finally {
            setTavilySaving(false);
        }
    };

    const removeTavilyKey = async () => {
        if (!confirm('Are you sure you want to remove the Tavily API Key?')) return;
        try {
            await window.electronAPI?.setTavilyApiKey?.('');
            setTavilyApiKeyInput('');
            setHasStoredTavilyKey(false);
            // A shared default may still cover Tavily once the user's key is gone.
            const creds = await window.electronAPI?.getStoredCredentials?.();
            const source = creds?.keySources?.tavily;
            if (source) {
                setTavilyKeySource(source);
                setHasStoredTavilyKey(source !== 'none');
            }
        } catch (e) {
            console.error('[useTavilySettings] Failed to remove Tavily API key:', e);
        }
    };

    return {
        tavilyApiKey,
        hasStoredTavilyKey,
        tavilyKeySource,
        tavilySaving,
        tavilyError,
        handleTavilyKeyInput,
        saveTavilyKey,
        removeTavilyKey,
        setHasStoredTavilyKeyFromCredentials,
    };
}