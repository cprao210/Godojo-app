// State + persistence layer for ScoringCriteriaTab. Kept separate from the
// component so the component only owns rendering — same split as
// useProviderCard / useAIProvidersSettings / useUserProfileTab.

import { useCallback, useEffect, useRef, useState } from "react";
import { MeetingType, ScoringCriteriaSettings, CustomScorecardConfig } from "@/types";
import { SCORECARD_CONFIGS } from "@/lib/utils";
import { settingsToast } from "@/lib/settingsToastBus";

const MEETING_TYPES: MeetingType[] = ["discovery", "demo", "negotiation"];

/** Sums a category list's weights (used for both per-section and page-level validation). */
export function totalWeight(cats: { weight: number }[]): number {
    return cats.reduce((s, c) => s + (Number(c.weight) || 0), 0);
}

/** Builds the "custom config, disabled, seeded from the built-in rubric" starting point for a meeting type. */
export function defaultCustomConfig(meetingType: MeetingType): CustomScorecardConfig {
    const builtin = SCORECARD_CONFIGS.find((c) => c.meetingType === meetingType)!;
    return {
        meetingType,
        enabled: false,
        categories: builtin.categories.map((cat) => ({
            key: cat.key,
            label: cat.label,
            weight: cat.weight,
            checkpoints: [...cat.checkpoints],
            framework: "",
        })),
    };
}

/** Builds the full default settings object (one disabled config per meeting type). */
export function buildDefaultSettings(): ScoringCriteriaSettings {
    return { configs: MEETING_TYPES.map(defaultCustomConfig) };
}

export function useScoringCriteriaTab() {
    const [settings, setSettings] = useState<ScoringCriteriaSettings>(buildDefaultSettings);
    const savedSnapshot = useRef<ScoringCriteriaSettings>(settings);
    const [isDirty, setIsDirty] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState("");

    // Load persisted criteria from the DB on mount.
    useEffect(() => {
        (window as any).electronAPI?.scoringGetCriteria?.()
            .then((res: any) => {
                if (res?.success && res.data) {
                    setSettings(res.data);
                    savedSnapshot.current = res.data;
                }
            })
            .catch(console.warn);
    }, []);

    const handleConfigChange = useCallback((meetingType: MeetingType, updated: CustomScorecardConfig) => {
        setSettings((prev) => ({
            ...prev,
            configs: prev.configs.map((c) => (c.meetingType === meetingType ? updated : c)),
        }));
        setIsDirty(true);
        setSaveError("");
    }, []);

    // Every enabled config's category weights must sum to exactly 100%.
    const allValid = settings.configs.every((cfg) => !cfg.enabled || totalWeight(cfg.categories) === 100);

    const handleSave = useCallback(async () => {
        if (!allValid) return;
        setIsSaving(true);
        setSaveError("");
        try {
            const res = await window.electronAPI?.scoringSaveCriteria(settings);
            if (res?.success) {
                savedSnapshot.current = settings;
                setIsDirty(false);
                settingsToast.success('Saved Successfully');
            } else {
                const message = res?.error ?? "Save failed. Please try again.";
                setSaveError(message);
                settingsToast.error(message);
            }
        } catch (e: any) {
            const message = e.message ?? "Save failed.";
            setSaveError(message);
            settingsToast.error(message);
        } finally {
            setIsSaving(false);
        }
    }, [allValid, settings]);

    const handleDiscard = useCallback(() => {
        // Deep-clone so further edits don't mutate the saved snapshot.
        setSettings(JSON.parse(JSON.stringify(savedSnapshot.current)));
        setIsDirty(false);
        setSaveError("");
    }, []);

    const handleFullReset = useCallback(async () => {
        if (!confirm("Reset all meeting score criteria to built-in defaults? This cannot be undone.")) return;
        await (window as any).electronAPI?.scoringResetCriteria?.();
        const fresh = buildDefaultSettings();
        setSettings(fresh);
        savedSnapshot.current = fresh;
        setIsDirty(false);
        setSaveError("");
    }, []);

    const enabledCount = settings.configs.filter((c) => c.enabled).length;

    return {
        settings,
        isDirty,
        isSaving,
        saveError,
        setSaveError,
        allValid,
        enabledCount,
        handleConfigChange,
        handleSave,
        handleDiscard,
        handleFullReset,
    };
}