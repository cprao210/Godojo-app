// Open/close + outside-click logic for RowActionsMenu (the per-row "..."
// menu in the members table). Kept separate from the component so the
// component only owns rendering.

import { useEffect, useRef, useState } from "react";

interface UseRowActionsMenuParams {
    onResendInvite: () => void;
    onRemove: () => void;
}

export function useRowActionsMenu({ onResendInvite, onRemove }: UseRowActionsMenuParams) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close on outside click.
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const toggleOpen = () => setIsOpen((v) => !v);

    // Wraps an action so the menu closes itself before the action runs.
    const menuAction = (fn: () => void) => () => {
        setIsOpen(false);
        fn();
    };

    const handleResendInvite = menuAction(onResendInvite);
    const handleRemove = menuAction(onRemove);

    return {
        isOpen,
        containerRef,
        toggleOpen,
        handleResendInvite,
        handleRemove,
    };
}