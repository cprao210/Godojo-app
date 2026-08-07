// State + IPC layer for SettingsPopup (the small tray/menu-bar popover).
// Owns every toggle's state, the electronAPI listeners that keep them in
// sync with the main process and other windows, the credential/profile
// bootstrap fetches, and the ResizeObserver that reports content size back
// to Electron so it can size the popup window. Kept separate from the
// component so the component only owns rendering — same split as
// useUserRolesPermissionsTab / useMembersTable.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShortcuts, useResolvedTheme, useTranscriptVisibility } from '@/hooks';

type ActionButtonMode = 'recap' | 'brainstorm';

export function useSettingsPopup() {
    const { shortcuts } = useShortcuts();
    const isLightTheme = useResolvedTheme() === 'light';

    const [isUndetectable, setIsUndetectable] = useState(false);
    const [useGroqFastText, setUseGroqFastText] = useState(() => {
        return localStorage.getItem('natively_groq_fast_text') === 'true';
    });
    const [profileMode, setProfileMode] = useState(false);
    const [hasProfile, setHasProfile] = useState(false);
    const [isPremium, setIsPremium] = useState(false);
    const [hasStoredKey, setHasStoredKey] = useState<Record<string, boolean>>({});
    const [actionButtonMode, setActionButtonModeState] = useState<ActionButtonMode>('recap');
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
                localStorage.setItem('natively_undetectable', String(newState));
            });
            return () => unsubscribe();
        }
    }, []);

    // ── 2-way sync: Groq Fast Text mode across windows ───────────────────────
    useEffect(() => {
        if (window.electronAPI?.onGroqFastTextChanged) {
            const unsubscribe = window.electronAPI.onGroqFastTextChanged((enabled: boolean) => {
                setUseGroqFastText(enabled);
                localStorage.setItem('natively_groq_fast_text', String(enabled));
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

        localStorage.setItem('natively_groq_fast_text', String(useGroqFastText));
        try {
            // @ts-ignore - electronAPI not typed in this file yet
            window.electronAPI?.invoke('set-groq-fast-text-mode', useGroqFastText);
        } catch (e) {
            console.error(e);
        }
    }, [useGroqFastText]);

    // ── Cross-window transcript toggle sync is handled by useTranscriptVisibility ──

    // ── Load action button mode and subscribe to changes from other windows ─
    useEffect(() => {
        // @ts-ignore
        window.electronAPI?.getActionButtonMode?.()?.then((mode: ActionButtonMode) => {
            setActionButtonModeState(mode ?? 'recap');
        }).catch(() => { });
        // @ts-ignore
        if (!window.electronAPI?.onActionButtonModeChanged) return;
        // @ts-ignore
        const unsubscribe = window.electronAPI.onActionButtonModeChanged((mode: ActionButtonMode) => {
            setActionButtonModeState(mode);
        });
        return () => unsubscribe();
    }, []);

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
        localStorage.setItem('natively_undetectable', String(newState));
        window.electronAPI?.setUndetectable(newState);
    };

    const toggleGroqFastText = () => {
        if (hasStoredKey.groq === false) return; // requires a Groq key first
        setUseGroqFastText((v) => !v);
    };

    const toggleInterviewMode = async () => {
        const newMode: ActionButtonMode = actionButtonMode === 'brainstorm' ? 'recap' : 'brainstorm';
        setActionButtonModeState(newMode);
        try {
            // @ts-ignore
            await window.electronAPI?.setActionButtonMode?.(newMode);
        } catch (e) {
            console.error(e);
        }
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

    const openDonateLink = () => {
        // @ts-ignore
        window.electronAPI?.openExternal('https://buymeacoffee.com/evinjohnn');
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
        actionButtonMode,
        showTranscript,
        // refs
        contentRef,
        // handlers
        toggleUndetectable,
        toggleGroqFastText,
        toggleTranscript,
        toggleInterviewMode,
        toggleProfileMode,
        openDonateLink,
    };
}