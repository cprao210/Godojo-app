// Tavily API key management — powers company research (the "Sales Brief"
// panel and the Profile Intelligence company dossier). Kept separate from
// the STT provider keys since it's a different feature area, even though it
// was previously declared alongside them.

import { useState } from 'react';
import { settingsToast } from '@/lib/settingsToastBus';

export function useTavilySettings() {
    const [tavilyApiKey, setTavilyApiKeyInput] = useState('');
    const [hasStoredTavilyKey, setHasStoredTavilyKey] = useState(false);
    const [tavilySaving, setTavilySaving] = useState(false);
    const [tavilyError, setTavilyError] = useState('');

    /** Bootstraps `hasStoredTavilyKey` from the shared credentials payload — called
     * from useSttProviderSettings's initial load, since both come from the same
     * `getStoredCredentials()` round-trip and we don't want to fetch it twice. */
    const setHasStoredTavilyKeyFromCredentials = (hasKey: boolean) => setHasStoredTavilyKey(hasKey);

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
        } catch (e) {
            console.error('[useTavilySettings] Failed to remove Tavily API key:', e);
        }
    };

    return {
        tavilyApiKey,
        hasStoredTavilyKey,
        tavilySaving,
        tavilyError,
        handleTavilyKeyInput,
        saveTavilyKey,
        removeTavilyKey,
        setHasStoredTavilyKeyFromCredentials,
    };
}