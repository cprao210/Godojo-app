// State + interaction layer for ProviderCard: owns the fetched-model list,
// the auto-save-after-5s-idle timer, the "auto-fetch models on mount if a
// key is already stored" behavior, and the model dropdown's open/close +
// outside-click handling. Kept separate from the component so the component
// only owns rendering — same split as useCalendarConnections / useCropper /
// useModelSelectorWindow.

import { useCallback, useEffect, useRef, useState } from "react";
import { FetchedModel, ProviderCardProps } from "@/types";

const AUTO_SAVE_DELAY_MS = 5000;

type UseProviderCardArgs = Pick<
    ProviderCardProps,
    "providerId" | "apiKey" | "preferredModel" | "hasStoredKey" | "onSaveKey" | "onPreferredModelChange" | "savedStatus" | "savingStatus"
>;

export function useProviderCard({
    providerId,
    apiKey,
    preferredModel,
    hasStoredKey,
    onSaveKey,
    onPreferredModelChange,
    savedStatus,
    savingStatus,
}: UseProviderCardArgs) {
    const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
    const [isFetching, setIsFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [selectedModel, setSelectedModel] = useState<string>(preferredModel || "");
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);

    const dropdownRef = useRef<HTMLDivElement>(null);

    // Refs to avoid stale closures inside the auto-save timer.
    const savedRef = useRef(savedStatus);
    const savingRef = useRef(savingStatus);
    savedRef.current = savedStatus;
    savingRef.current = savingStatus;

    // ── Auto-save the API key after 5 seconds of inactivity ───────────────
    useEffect(() => {
        if (!apiKey.trim()) return;
        const timer = setTimeout(() => {
            if (!savedRef.current && !savingRef.current) {
                onSaveKey().catch(console.error);
            }
        }, AUTO_SAVE_DELAY_MS);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiKey]);

    // Keep the selected model in sync with the preferredModel prop.
    useEffect(() => {
        if (preferredModel) setSelectedModel(preferredModel);
    }, [preferredModel]);

    const handleFetchModels = useCallback(async () => {
        setIsFetching(true);
        setFetchError(null);

        try {
            // If a new key was typed but not yet saved, save it first.
            if (apiKey.trim()) {
                await onSaveKey();
            }

            const keyToUse = apiKey.trim() || "";
            // @ts-ignore — electronAPI is injected by the preload script
            const result = await window.electronAPI?.fetchProviderModels(providerId, keyToUse);

            if (result?.success && result.models) {
                setFetchedModels(result.models);

                // Keep the current preferred model if it exists in the fetched list;
                // otherwise auto-select the first model returned.
                if (result.models.length > 0) {
                    const existsInList = result.models.some((m: FetchedModel) => m.id === selectedModel);
                    if (!existsInList) {
                        const firstModel = result.models[0].id;
                        setSelectedModel(firstModel);
                        // @ts-ignore
                        await window.electronAPI?.setProviderPreferredModel(providerId, firstModel);
                        onPreferredModelChange?.(firstModel);
                    }
                }
            } else {
                setFetchError(result?.error || "Failed to fetch models");
            }
        } catch (e: any) {
            setFetchError(e?.message || "Failed to fetch models");
        } finally {
            setIsFetching(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiKey, providerId, onSaveKey, onPreferredModelChange, selectedModel]);

    // ── Auto-fetch models on mount if a key is already stored ─────────────
    useEffect(() => {
        if (hasStoredKey && fetchedModels.length === 0) {
            handleFetchModels();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasStoredKey]);

    // ── Close the model dropdown on outside click ──────────────────────────
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsDropdownOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleSelectModel = useCallback(
        async (modelId: string) => {
            setSelectedModel(modelId);
            setIsDropdownOpen(false);
            try {
                // @ts-ignore
                await window.electronAPI?.setProviderPreferredModel(providerId, modelId);
                onPreferredModelChange?.(modelId);
            } catch (e) {
                console.error("Failed to save preferred model:", e);
            }
        },
        [providerId, onPreferredModelChange],
    );

    const toggleDropdown = useCallback(() => {
        if (fetchedModels.length > 0) setIsDropdownOpen((prev) => !prev);
    }, [fetchedModels.length]);

    const selectedOption = fetchedModels.find((m) => m.id === selectedModel);

    return {
        fetchedModels,
        isFetching,
        fetchError,
        selectedModel,
        selectedOption,
        isDropdownOpen,
        dropdownRef,
        handleFetchModels,
        handleSelectModel,
        toggleDropdown,
    };
}