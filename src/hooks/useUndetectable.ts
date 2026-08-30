// Read-only subscription to the launcher window's "undetectable" (Ghost Mode)
// state. Ghost Mode ON == the window is hidden from screen capture/recording
// (content protection on). The app launches in Ghost Mode by default, so this
// initialises to `true` and shows the indicator immediately, then reconciles
// with the main process once it answers and on every later change.
//
// Mirrors the same getUndetectable()/onUndetectableChanged wiring already used
// by useLauncher and useGeneralSettings — each consumer subscribes on its own.

import { useEffect, useState } from 'react';

export function useUndetectable(): boolean {
    const [isUndetectable, setIsUndetectable] = useState(true);

    useEffect(() => {
        let mounted = true;

        window.electronAPI?.getUndetectable?.()
            .then((state) => { if (mounted) setIsUndetectable(state); })
            .catch(() => { });

        const unsubscribe = window.electronAPI?.onUndetectableChanged?.(
            (state: boolean) => setIsUndetectable(state)
        );

        return () => {
            mounted = false;
            unsubscribe?.();
        };
    }, []);

    return isUndetectable;
}
