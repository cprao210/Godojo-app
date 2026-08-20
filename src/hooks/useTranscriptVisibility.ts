// "Show meeting transcript" toggle. Lives in localStorage (not electronAPI)
// because it's a same-machine, all-windows UI preference — every window
// reads/writes the same key and syncs via the `storage` event. Shared by
// SettingsPopup and SettingsOverlay, which both exposed this exact toggle
// independently before.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'natively_interviewer_transcript';

export function useTranscriptVisibility() {
    const [showTranscript, setShowTranscriptState] = useState(() => {
        // Default to visible if the user has never set a preference.
        return localStorage.getItem(STORAGE_KEY) !== 'false';
    });

    // ── Cross-window sync via the `storage` event ────────────────────────────
    useEffect(() => {
        const handleStorage = () => {
            setShowTranscriptState(localStorage.getItem(STORAGE_KEY) !== 'false');
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    const toggleTranscript = () => {
        const newState = !showTranscript;
        setShowTranscriptState(newState);
        localStorage.setItem(STORAGE_KEY, String(newState));
        // The native `storage` event only fires in *other* windows/tabs, not the
        // one that wrote it — dispatch a matching event here so this window's
        // own listeners (and any same-window consumers of this hook) update too.
        window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: String(newState) }));
    };

    return { showTranscript, toggleTranscript };
}