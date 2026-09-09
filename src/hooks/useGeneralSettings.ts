// General/system settings tab: the Ghost Mode + Mouse Passthrough toggles at
// the top of the General tab, the "Open at login" / "Verbose logging" rows,
// disguise mode, and theme mode.
// Every setter here mirrors its value back to the main process via
// electronAPI so the change takes effect immediately, and listens for the
// main process pushing the same setting back (e.g. changed from a different
// window) so this tab never drifts out of sync.
//
// Update state deliberately does NOT live here: it has its own single source
// of truth in useUpdateStatus (SettingsOverlay holds the one instance and
// passes it to UpdatesTab). An earlier duplicate listener block in this hook
// fought that hook for the same events and was removed.

import { useCallback, useEffect, useState } from 'react';

export type DisguiseMode = 'terminal' | 'settings' | 'activity' | 'none';
export type ThemeMode = 'system' | 'light' | 'dark';

interface UseGeneralSettingsArgs {
    /** Only fetch/subscribe while the Settings overlay is actually open. */
    isOpen: boolean;
}

export function useGeneralSettings({ isOpen }: UseGeneralSettingsArgs) {
    const [isUndetectable, setIsUndetectable] = useState(false);
    const [isMousePassthrough, setIsMousePassthrough] = useState(false);
    const [disguiseMode, setDisguiseModeState] = useState<DisguiseMode>('none');
    const [openOnLogin, setOpenOnLoginState] = useState(false);
    const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
    const [verboseLogging, setVerboseLoggingState] = useState(false);

    // ── Load current values from the main process whenever the overlay opens ─
    useEffect(() => {
        if (!isOpen) return;
        window.electronAPI?.getUndetectable?.().then(setIsUndetectable).catch(() => { });
        window.electronAPI?.getOverlayMousePassthrough?.().then(setIsMousePassthrough).catch(() => { });
        window.electronAPI?.getDisguise?.().then(setDisguiseModeState).catch(() => { });
        window.electronAPI?.getVerboseLogging?.().then(setVerboseLoggingState).catch(() => { });
        window.electronAPI?.getOpenAtLogin?.().then(setOpenOnLoginState).catch(() => { });
        window.electronAPI?.getThemeMode?.().then(({ mode }) => setThemeModeState(mode)).catch(() => { });
    }, [isOpen]);

    // ── One-way listeners: main process is the source of truth, never echo back ─
    useEffect(() => {
        const unsubscribe = window.electronAPI?.onUndetectableChanged?.((state: boolean) => setIsUndetectable(state));
        return () => unsubscribe?.();
    }, []);

    useEffect(() => {
        const unsubscribe = window.electronAPI?.onDisguiseChanged?.((mode: DisguiseMode) => setDisguiseModeState(mode));
        return () => unsubscribe?.();
    }, []);

    useEffect(() => {
        const unsubscribe = window.electronAPI?.onOverlayMousePassthroughChanged?.((enabled: boolean) => setIsMousePassthrough(enabled));
        return () => unsubscribe?.();
    }, []);

    // ── Toggle handlers ──────────────────────────────────────────────────────
    const toggleUndetectable = useCallback(() => {
        const newState = !isUndetectable;
        setIsUndetectable(newState);
        window.electronAPI?.setUndetectable(newState);
    }, [isUndetectable]);

    const toggleMousePassthrough = useCallback(() => {
        const newState = !isMousePassthrough;
        setIsMousePassthrough(newState);
        window.electronAPI?.setOverlayMousePassthrough(newState);
    }, [isMousePassthrough]);

    const toggleOpenOnLogin = useCallback(() => {
        const newState = !openOnLogin;
        setOpenOnLoginState(newState);
        window.electronAPI?.setOpenAtLogin(newState);
    }, [openOnLogin]);

    const toggleVerboseLogging = useCallback(() => {
        const newState = !verboseLogging;
        setVerboseLoggingState(newState);
        window.electronAPI?.setVerboseLogging?.(newState);
    }, [verboseLogging]);

    const setDisguiseMode = useCallback((mode: DisguiseMode) => {
        // Disguise mode can't be changed while Undetectable is on — the caller
        // (row UI) should already disable the control, this is a hard backstop.
        if (isUndetectable) return;
        setDisguiseModeState(mode);
        window.electronAPI?.setDisguise(mode);
    }, [isUndetectable]);

    const setThemeMode = useCallback(async (mode: ThemeMode) => {
        setThemeModeState(mode);
        await window.electronAPI?.setThemeMode?.(mode);
    }, []);

    const quitApp = useCallback(() => window.electronAPI.quitApp(), []);

    return {
        isUndetectable,
        isMousePassthrough,
        disguiseMode,
        openOnLogin,
        themeMode,
        verboseLogging,
        toggleUndetectable,
        toggleMousePassthrough,
        toggleOpenOnLogin,
        toggleVerboseLogging,
        setDisguiseMode,
        setThemeMode,
        quitApp,
    };
}