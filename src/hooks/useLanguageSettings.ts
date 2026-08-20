// Language settings: the speech-recognition language (grouped by language
// family, e.g. "English" -> en-US/en-GB/en-AU variants) and the separate
// AI response language. Two independent settings that happen to live on the
// same tab, loaded together on mount since both come back from the same
// initial electronAPI round-trip.

import { useEffect, useState } from 'react';

interface LanguageConfig {
    label: string;
    group: string;
    bcp47?: string;
    iso639?: string;
    alternates?: string[];
}

interface AiLanguageOption {
    label: string;
    [key: string]: unknown;
}

export function useLanguageSettings() {
    const [recognitionLanguage, setRecognitionLanguageState] = useState('');
    const [selectedSttGroup, setSelectedSttGroup] = useState('');
    const [availableLanguages, setAvailableLanguages] = useState<Record<string, LanguageConfig>>({});

    const [aiResponseLanguage, setAiResponseLanguageState] = useState('English');
    const [availableAiLanguages, setAvailableAiLanguages] = useState<AiLanguageOption[]>([]);

    // ── Load both language lists + stored preferences on mount ──────────────
    useEffect(() => {
        const loadLanguages = async () => {
            if (window.electronAPI?.getRecognitionLanguages) {
                const langs: Record<string, LanguageConfig> = await window.electronAPI.getRecognitionLanguages();
                setAvailableLanguages(langs);

                const storedStt = await window.electronAPI.getSttLanguage();
                let currentLangKey = storedStt;

                if (!currentLangKey) {
                    // No stored preference — try to match the system locale.
                    const systemLocale = navigator.language;
                    const match = Object.entries(langs).find(([, config]) =>
                        config.bcp47 === systemLocale ||
                        config.iso639 === systemLocale ||
                        config.alternates?.includes(systemLocale),
                    );
                    currentLangKey = match ? match[0] : 'multilingual';
                    window.electronAPI?.setRecognitionLanguage?.(currentLangKey); // persist the auto-detected default
                }

                setRecognitionLanguageState(currentLangKey);
                setSelectedSttGroup(langs[currentLangKey]?.group ?? 'English');
            }

            if (window.electronAPI?.getAiResponseLanguages) {
                const aiLangs: AiLanguageOption[] = await window.electronAPI.getAiResponseLanguages();
                // English first, then alphabetical.
                const sorted = [...aiLangs].sort((a, b) => {
                    if (a.label === 'English') return -1;
                    if (b.label === 'English') return 1;
                    return a.label.localeCompare(b.label);
                });
                setAvailableAiLanguages(sorted);

                const storedAi = await window.electronAPI.getAiResponseLanguage();
                setAiResponseLanguageState(storedAi || 'English');
            }
        };
        loadLanguages();
    }, []);

    // ── Derived: unique language groups (English pinned first) ──────────────
    const languageGroups = Array.from(new Set(Object.values(availableLanguages).map((l) => l.group)))
        .sort((a, b) => {
            if (a === 'English') return -1;
            if (b === 'English') return 1;
            return a.localeCompare(b);
        });

    // ── Derived: dialect/accent variants for the currently selected group ───
    // Shaped to satisfy CustomSelect, which expects MediaDeviceInfo-like objects.
    const currentGroupVariants = Object.entries(availableLanguages)
        .filter(([, lang]) => lang.group === selectedSttGroup)
        .map(([key, lang]) => ({
            deviceId: key,
            label: lang.label,
            kind: 'audioinput' as MediaDeviceKind,
            groupId: '',
            toJSON: () => ({}),
        }));

    const setRecognitionLanguage = async (key: string) => {
        setRecognitionLanguageState(key);
        if (availableLanguages[key]) setSelectedSttGroup(availableLanguages[key].group);
        await window.electronAPI?.setRecognitionLanguage?.(key);
    };

    const setLanguageGroup = (group: string) => {
        setSelectedSttGroup(group);
        // Jump to that group's first variant so a language is always selected.
        const firstVariant = Object.entries(availableLanguages).find(([, lang]) => lang.group === group);
        if (firstVariant) setRecognitionLanguage(firstVariant[0]);
    };

    const setAiResponseLanguage = async (key: string) => {
        if (!key) return;
        const previous = aiResponseLanguage;
        setAiResponseLanguageState(key); // optimistic update

        try {
            const result = await window.electronAPI?.setAiResponseLanguage?.(key);
            if (result && !result.success) {
                setAiResponseLanguageState(previous); // rollback on explicit failure
                console.error('[useLanguageSettings] Failed to set AI response language:', result.error);
            }
        } catch (err) {
            setAiResponseLanguageState(previous); // rollback on exception
            console.error('[useLanguageSettings] Exception setting AI response language:', err);
        }
    };

    return {
        recognitionLanguage,
        selectedSttGroup,
        availableLanguages,
        languageGroups,
        currentGroupVariants,
        setRecognitionLanguage,
        setLanguageGroup,
        aiResponseLanguage,
        availableAiLanguages,
        setAiResponseLanguage,
    };
}