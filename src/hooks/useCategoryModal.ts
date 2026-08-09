// State layer for CategoryModal: form fields, framework-suggestion visibility,
// derived checkpoint list, and save validation.

import { useState } from "react";
import { CustomCategoryConfig } from "@/types";

interface UseCategoryModalArgs {
    category: CustomCategoryConfig | null;
    onSave: (category: CustomCategoryConfig) => void;
}

export function useCategoryModal({ category, onSave }: UseCategoryModalArgs) {
    const [label, setLabel] = useState(category?.label ?? "");
    const [framework, setFramework] = useState(category?.framework ?? "");
    const [weight, setWeight] = useState(category?.weight ?? 20);
    const [checkpointText, setCheckpointText] = useState((category?.checkpoints ?? []).join("\n"));
    const [showFrameworkSuggestions, setShowFrameworkSuggestions] = useState(false);

    const isAddMode = !category;
    const checkpoints = checkpointText.split("\n").map((l) => l.trim()).filter(Boolean);
    const canSave = label.trim().length > 0 && weight >= 1 && weight <= 100;

    const handleSave = () => {
        if (!canSave) return;
        onSave({
            key: category?.key ?? `cat_${Date.now()}`,
            label: label.trim(),
            framework: framework.trim(),
            weight,
            checkpoints,
        });
    };

    // Delay hiding the suggestion chips so a click on a chip registers before the input's blur fires.
    const hideSuggestionsSoon = () => setTimeout(() => setShowFrameworkSuggestions(false), 150);

    return {
        label,
        setLabel,
        framework,
        setFramework,
        weight,
        setWeight,
        checkpointText,
        setCheckpointText,
        showFrameworkSuggestions,
        setShowFrameworkSuggestions,
        hideSuggestionsSoon,
        isAddMode,
        checkpoints,
        canSave,
        handleSave,
    };
}