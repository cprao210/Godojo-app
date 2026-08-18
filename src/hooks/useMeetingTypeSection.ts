// State layer for MeetingTypeSection: the add/edit category modal's
// open/edit-target state, and the category add/save/delete handlers that
// mutate this section's config.

import { useState } from "react";
import { CustomCategoryConfig, CustomScorecardConfig } from "@/types";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";

interface UseMeetingTypeSectionArgs {
    config: CustomScorecardConfig;
    onChange: (updated: CustomScorecardConfig) => void;
}

export function useMeetingTypeSection({ config, onChange }: UseMeetingTypeSectionArgs) {
    const [modalOpen, setModalOpen] = useState(false);
    const [editingCat, setEditingCat] = useState<CustomCategoryConfig | null>(null);
    const [isAddMode, setIsAddMode] = useState(false);

    const openAdd = () => {
        setEditingCat(null);
        setIsAddMode(true);
        setModalOpen(true);
    };

    const openEdit = (cat: CustomCategoryConfig) => {
        setEditingCat(cat);
        setIsAddMode(false);
        setModalOpen(true);
    };

    const closeModal = () => setModalOpen(false);

    const handleCatSave = (cat: CustomCategoryConfig) => {
        if (isAddMode) {
            onChange({ ...config, categories: [...config.categories, cat] });
            if (config.meetingType === 'discovery') posthogAnalytics.trackScoringCriteriaDisco();
            else if (config.meetingType === 'demo') posthogAnalytics.trackScoringCriteriaDemo();
            else if (config.meetingType === 'negotiation') posthogAnalytics.trackScoringCriteriaNego();
        } else {
            onChange({ ...config, categories: config.categories.map((c) => (c.key === cat.key ? cat : c)) });
        }
        setModalOpen(false);
    };

    const handleDelete = (key: string) => {
        if (config.categories.length <= 1) return;
        onChange({ ...config, categories: config.categories.filter((c) => c.key !== key) });
    };

    const resetToDefaults = (builtinCategories: CustomCategoryConfig[]) => {
        onChange({
            ...config,
            categories: builtinCategories.map((c) => ({
                key: c.key,
                label: c.label,
                weight: c.weight,
                checkpoints: [...c.checkpoints],
                framework: "",
            })),
        });
    };

    const toggleEnabled = () => onChange({ ...config, enabled: !config.enabled });

    return {
        modalOpen,
        editingCat,
        isAddMode,
        openAdd,
        openEdit,
        closeModal,
        handleCatSave,
        handleDelete,
        resetToDefaults,
        toggleEnabled,
    };
}