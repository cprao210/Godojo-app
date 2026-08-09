// State + interaction layer for EditableTextBlock: owns editing state,
// the debounced auto-save, double-Enter detection, and Escape-to-revert
// handling. Kept separate from the component so the component only owns
// rendering — same split as useCalendarConnections / useTopSearchPill /
// useModelSelectorWindow.

import { useCallback, useEffect, useRef, useState } from "react";

const SAVE_DEBOUNCE_MS = 600;
const DOUBLE_ENTER_THRESHOLD_MS = 500;

interface UseEditableTextBlockArgs {
    initialValue: string;
    onSave: (value: string) => void;
    multiline: boolean;
    autoFocus: boolean;
    /** Called on a double-Enter press (only relevant when multiline). */
    onEnter?: () => void;
}

export function useEditableTextBlock({ initialValue, onSave, multiline, autoFocus, onEnter }: UseEditableTextBlockArgs) {
    // Start editing immediately if autoFocus is true (e.g. a freshly-created item).
    const [isEditing, setIsEditing] = useState(autoFocus);
    const [localValue, setLocalValue] = useState(initialValue);

    const contentRef = useRef<HTMLElement>(null);
    const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastEnterTimeRef = useRef<number>(0);

    // Keep the DOM/local value in sync with external changes while not editing.
    useEffect(() => {
        if (!isEditing) {
            setLocalValue(initialValue);
            if (contentRef.current && contentRef.current.innerText !== initialValue) {
                contentRef.current.innerText = initialValue;
            }
        }
    }, [initialValue, isEditing]);

    // Focus the element as soon as editing starts.
    useEffect(() => {
        if (isEditing && contentRef.current) {
            contentRef.current.focus();
        }
    }, [isEditing]);

    const clearPendingSave = useCallback(() => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }
    }, []);

    /** Commits a value to the parent, but only if it actually changed. */
    const commitSave = useCallback(
        (newValue: string) => {
            const trimmed = newValue.trim();
            if (trimmed !== initialValue) {
                onSave(trimmed);
            }
        },
        [initialValue, onSave],
    );

    const handleChange = useCallback(() => {
        if (!contentRef.current) return;
        const newValue = contentRef.current.innerText;
        setLocalValue(newValue);

        // Debounce the save so we don't fire on every keystroke.
        clearPendingSave();
        saveTimeoutRef.current = setTimeout(() => commitSave(newValue), SAVE_DEBOUNCE_MS);
    }, [clearPendingSave, commitSave]);

    const handleBlur = useCallback(() => {
        setIsEditing(false);
        clearPendingSave();
        if (contentRef.current) {
            commitSave(contentRef.current.innerText);
        }
    }, [clearPendingSave, commitSave]);

    const handleClick = useCallback(() => {
        setIsEditing(true);
    }, []);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                // Revert any unsaved edits.
                setIsEditing(false);
                clearPendingSave();
                if (contentRef.current) {
                    contentRef.current.innerText = initialValue;
                }
                setLocalValue(initialValue);
                return;
            }

            if (e.key !== "Enter") return;

            if (!multiline) {
                // Single-line fields treat Enter as "done editing".
                e.preventDefault();
                contentRef.current?.blur();
                return;
            }

            if (!onEnter) return;

            // Multiline fields with an onEnter handler: detect a double-Enter
            // press (two Enters within DOUBLE_ENTER_THRESHOLD_MS) to trigger it,
            // while still allowing a single Enter to insert a normal newline.
            const now = Date.now();
            if (now - lastEnterTimeRef.current < DOUBLE_ENTER_THRESHOLD_MS) {
                e.preventDefault();
                clearPendingSave();
                if (contentRef.current) commitSave(contentRef.current.innerText);
                onEnter();
                lastEnterTimeRef.current = 0;
            } else {
                // First Enter — just record the time and let the default newline happen.
                lastEnterTimeRef.current = now;
            }
        },
        [multiline, onEnter, initialValue, clearPendingSave, commitSave],
    );

    return {
        isEditing,
        localValue,
        contentRef,
        handleChange,
        handleBlur,
        handleClick,
        handleKeyDown,
    };
}