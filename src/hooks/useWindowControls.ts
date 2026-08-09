// State + IPC layer for WindowControls: tracks the maximized state (synced
// with the OS window via electronAPI) and exposes the minimize/maximize/close
// handlers. Kept separate from the component so the component only owns
// rendering — same split as useSignIn / useFloatingDock.
//
// Also fixes a Rules-of-Hooks issue in the previous version: the component
// called `if (isMac) return null` BEFORE its useState/useEffect calls. That
// happened to be safe in practice only because `isMac` is a module-level
// constant that can never change within a single component instance's
// lifetime — but it still violates the rule (hooks must run unconditionally,
// in the same order, on every render) and trips the exhaustive lint check.
// This hook always runs its hooks; the component does the early-return AFTER
// calling the hook, which is the correct place for a conditional return.

import { useEffect, useState } from "react";

export function useWindowControls() {
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        let active = true;

        // Query initial maximized state (e.g. app reopened while maximized).
        window.electronAPI
            ?.windowIsMaximized()
            .then((maximized: boolean) => {
                if (active) setIsMaximized(maximized);
            })
            .catch(() => { });

        const unsubscribe = window.electronAPI?.onWindowMaximizedChanged((maximized: boolean) => {
            setIsMaximized(maximized);
        });

        return () => {
            active = false;
            unsubscribe?.();
        };
    }, []);

    const handleMinimize = () => window.electronAPI?.windowMinimize();
    const handleMaximize = () => window.electronAPI?.windowMaximize();
    const handleClose = () => window.electronAPI?.windowClose();

    return {
        isMaximized,
        handleMinimize,
        handleMaximize,
        handleClose,
    };
}