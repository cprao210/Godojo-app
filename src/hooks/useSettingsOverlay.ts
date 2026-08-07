// State + IPC layer for SettingsOverlay (the full-screen settings modal).
// This file is deliberately thin: it owns tab navigation and a couple of
// small dropdown-outside-click effects that don't warrant their own hook,
// and otherwise just composes the domain-specific hooks below so
// SettingsOverlay.tsx only ever imports one hook — same pattern as
// useAIProvidersSettings.
//
//   useGeneralSettings              — Ghost Mode, passthrough, disguise, theme, updates
//   useOverlayOpacitySettings       — the opacity slider + live drag preview
//   useAudioDeviceSettings          — input/output devices, mic test
//   useLanguageSettings             — recognition + AI response language
//   useSttProviderSettings          — STT provider + per-provider keys
//   useTavilySettings               — Tavily key (company research)
//   useProfileIntelligenceSettings  — resume/JD upload, research, negotiation script
//   useCompanyContextSettings       — lifted state for <CompanyContextTab>
//   useCalendarIntegrationSettings  — Google/Zoom calendar connect status
//   useTranscriptVisibility         — shared with useSettingsPopup

import { useEffect, useRef, useState } from 'react';
import { useShortcuts } from './useShortcuts';
import { useResolvedTheme } from './useResolvedTheme';
import { useTranscriptVisibility } from './useTranscriptVisibility';
import { useGeneralSettings } from './useGeneralSettings';
import { useOverlayOpacitySettings } from './useOverlayOpacitySettings';
import { useAudioDeviceSettings } from './useAudioDeviceSettings';
import { useLanguageSettings } from './useLanguageSettings';
import { useSttProviderSettings } from './useSttProviderSettings';
import { useTavilySettings } from './useTavilySettings';
import { useProfileIntelligenceSettings } from './useProfileIntelligenceSettings';
import { useCompanyContextSettings } from './useCompanyContextSettings';
import { useCalendarIntegrationSettings } from './useCalendarIntegrationSettings';

interface UseSettingsOverlayArgs {
    isOpen: boolean;
    onClose: () => void;
    initialTab?: string;
}

export function useSettingsOverlay({ isOpen, onClose, initialTab = 'general' }: UseSettingsOverlayArgs) {
    const isLight = useResolvedTheme() === 'light';
    const { shortcuts, updateShortcut, resetShortcuts } = useShortcuts();

    const [activeTab, setActiveTabState] = useState(initialTab);

    const general = useGeneralSettings({ isOpen });
    const opacity = useOverlayOpacitySettings({ isOpen });
    const audio = useAudioDeviceSettings({ isOpen, activeTab });
    const language = useLanguageSettings();
    const tavily = useTavilySettings();
    const stt = useSttProviderSettings({ isOpen, onTavilyKeyLoaded: tavily.setHasStoredTavilyKeyFromCredentials });
    const profile = useProfileIntelligenceSettings({ isOpen, initialTab });
    const companyContext = useCompanyContextSettings();
    const calendar = useCalendarIntegrationSettings({ isOpen });
    const { showTranscript, toggleTranscript } = useTranscriptVisibility();

    // ── Sync the active tab whenever the overlay (re)opens with a new initialTab ─
    useEffect(() => {
        if (isOpen && initialTab) {
            setActiveTabState(initialTab);
            if (initialTab === 'company-context') companyContext.loadCompanyContext();
        }
        // profile.loadProfile() is already triggered for initialTab === 'profile'
        // inside useProfileIntelligenceSettings itself.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, initialTab]);

    /** Sidebar nav -> Company Context: switches tabs and (re)loads its data, matching the initial-open behavior above. */
    const navigateToCompanyContext = () => {
        setActiveTabState('company-context');
        companyContext.loadCompanyContext();
    };

    const setActiveTab = (tab: string) => setActiveTabState(tab);

    // ── Theme + AI-response-language dropdowns: close on outside click ──────
    const [isThemeDropdownOpen, setIsThemeDropdownOpen] = useState(false);
    const [isAiLangDropdownOpen, setIsAiLangDropdownOpen] = useState(false);
    const themeDropdownRef = useRef<HTMLDivElement>(null);
    const aiLangDropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isThemeDropdownOpen && !isAiLangDropdownOpen) return;
        const handleClickOutside = (event: MouseEvent) => {
            if (themeDropdownRef.current && !themeDropdownRef.current.contains(event.target as Node)) {
                setIsThemeDropdownOpen(false);
            }
            if (aiLangDropdownRef.current && !aiLangDropdownRef.current.contains(event.target as Node)) {
                setIsAiLangDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isThemeDropdownOpen, isAiLangDropdownOpen]);

    return {
        // theme + layout
        isLight,
        shortcuts,
        updateShortcut,
        resetShortcuts,
        activeTab,
        setActiveTab,
        navigateToCompanyContext,
        onClose,

        // dropdown open/close (theme selector, AI response language selector)
        isThemeDropdownOpen,
        setIsThemeDropdownOpen,
        themeDropdownRef,
        isAiLangDropdownOpen,
        setIsAiLangDropdownOpen,
        aiLangDropdownRef,

        // shared with SettingsPopup
        showTranscript,
        toggleTranscript,

        // domain hooks, namespaced so callers can tell where each field comes from
        general,
        opacity,
        audio,
        language,
        stt,
        tavily,
        profile,
        companyContext,
        calendar,
    };
}