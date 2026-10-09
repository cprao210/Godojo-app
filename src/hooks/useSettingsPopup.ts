// State + IPC layer for SettingsPopup (the small tray/menu-bar popover).
// Owns every toggle's state, the electronAPI listeners that keep them in
// sync with the main process and other windows, the credential/profile
// bootstrap fetches, and the ResizeObserver that reports content size back
// to Electron so it can size the popup window. Kept separate from the
// component so the component only owns rendering — same split as
// useUserRolesPermissionsTab / useMembersTable.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShortcuts, useResolvedTheme, useTranscriptVisibility } from '@/hooks';


export function useSettingsPopup() {
    const { shortcuts } = useShortcuts();
    const isLightTheme = useResolvedTheme() === 'light';

    const [isUndetectable, setIsUndetectable] = useState(false);
    const [useGroqFastText, setUseGroqFastText] = useState(() => {
        return localStorage.getItem('godojo_groq_fast_text') === 'true';
    });
    const [profileMode, setProfileMode] = useState(false);
    const [hasProfile, setHasProfile] = useState(false);
    const [isPremium, setIsPremium] = useState(false);
    const [hasStoredKey, setHasStoredKey] = useState<Record<string, boolean>>({});
    const { showTranscript, toggleTranscript } = useTranscriptVisibility();

    const isFirstRender = useRef(true);
    const contentRef = useRef<HTMLDivElement>(null);

    // ── Load stored API-key presence (not the keys themselves) ──────────────
    const loadCredentials = async () => {
        try {
            // @ts-ignore
            const creds = await window.electronAPI?.getStoredCredentials?.();
            if (creds) {
                setHasStoredKey({
                    gemini: creds.hasGeminiKey,
                    groq: creds.hasGroqKey,
                    openai: creds.hasOpenaiKey,
                    claude: creds.hasClaudeKey,
                });
            }
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    };

    // ── Load initial data and refresh on window focus ───────────────────────
    useEffect(() => {
        loadCredentials();
        const handleFocus = () => loadCredentials();
        window.addEventListener('focus', handleFocus);

        const loadProfile = async () => {
            try {
                // @ts-ignore
                const status = await window.electronAPI?.profileGetStatus?.();
                if (status) {
                    setHasProfile(status.hasProfile);
                    setProfileMode(status.profileMode);
                }
                const premium = await window.electronAPI?.licenseCheckPremium?.();
                setIsPremium(!!premium);
            } catch (e) {
                console.warn('[useSettingsPopup] Failed to load profile/premium status:', e);
            }
        };
        loadProfile();

        return () => window.removeEventListener('focus', handleFocus);
    }, []);

    // ── Fetch initial undetectable state from main process (source of truth) ─
    useEffect(() => {
        if (window.electronAPI?.getUndetectable) {
            window.electronAPI.getUndetectable().then((state: boolean) => {
                setIsUndetectable(state);
            });
        }
    }, []);

    // ── One-way listener: receive state changes from main process, never echo back ─
    useEffect(() => {
        if (window.electronAPI?.onUndetectableChanged) {
            const unsubscribe = window.electronAPI.onUndetectableChanged((newState: boolean) => {
                setIsUndetectable(newState);
                localStorage.setItem('godojo_undetectable', String(newState));
            });
            return () => unsubscribe();
        }
    }, []);

    // ── 2-way sync: Groq Fast Text mode across windows ───────────────────────
    useEffect(() => {
        if (window.electronAPI?.onGroqFastTextChanged) {
            const unsubscribe = window.electronAPI.onGroqFastTextChanged((enabled: boolean) => {
                setUseGroqFastText(enabled);
                localStorage.setItem('godojo_groq_fast_text', String(enabled));
            });
            return () => unsubscribe();
        }
    }, []);

    // ── Push Groq Fast Text mode to the backend whenever it changes ─────────
    useEffect(() => {
        // Skip the initial render to avoid an unnecessary IPC call, but still
        // sync the backend once on mount (even if there's no change) so it
        // agrees with whatever localStorage said at load time.
        if (isFirstRender.current) {
            isFirstRender.current = false;
            try {
                // @ts-ignore
                window.electronAPI?.invoke('set-groq-fast-text-mode', useGroqFastText);
            } catch (e) {
                console.error(e);
            }
            return;
        }

        localStorage.setItem('godojo_groq_fast_text', String(useGroqFastText));
        try {
            // @ts-ignore - electronAPI not typed in this file yet
            window.electronAPI?.invoke('set-groq-fast-text-mode', useGroqFastText);
        } catch (e) {
            console.error(e);
        }
    }, [useGroqFastText]);

    // ── Cross-window transcript toggle sync is handled by useTranscriptVisibility ──

    // ── Auto-resize the Electron popup window to fit the content ────────────
    useLayoutEffect(() => {
        if (!contentRef.current) return;

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const rect = entry.target.getBoundingClientRect();
                try {
                    // @ts-ignore
                    window.electronAPI?.updateContentDimensions({
                        width: Math.ceil(rect.width),
                        height: Math.ceil(rect.height),
                    });
                } catch (e) {
                    console.warn('Failed to update dimensions', e);
                }
            }
        });

        observer.observe(contentRef.current);
        return () => observer.disconnect();
    }, []);

    // ── Toggle handlers ──────────────────────────────────────────────────────
    const toggleUndetectable = () => {
        const newState = !isUndetectable;
        setIsUndetectable(newState);
        localStorage.setItem('godojo_undetectable', String(newState));
        window.electronAPI?.setUndetectable(newState);
    };

    const toggleGroqFastText = () => {
        if (hasStoredKey.groq === false) return; // requires a Groq key first
        setUseGroqFastText((v) => !v);
    };

    const toggleProfileMode = async () => {
        if (!isPremium) return;
        const newState = !profileMode;
        setProfileMode(newState);
        try {
            // @ts-ignore
            await window.electronAPI?.profileSetMode?.(newState);
        } catch (e) {
            console.error(e);
        }
    };

    return {
        // theme + shortcuts
        isLightTheme,
        shortcuts,
        // state
        isUndetectable,
        useGroqFastText,
        profileMode,
        hasProfile,
        isPremium,
        hasStoredKey,
        showTranscript,
        // refs
        contentRef,
        // handlers
        toggleUndetectable,
        toggleGroqFastText,
        toggleTranscript,
        toggleProfileMode,
    };
}