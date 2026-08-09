// General/system settings tab: the Ghost Mode + Mouse Passthrough toggles at
// the top of the General tab, the "Open at login" / "Verbose logging" rows,
// disguise mode, theme mode, and the app auto-update check/download flow.
// Every setter here mirrors its value back to the main process via
// electronAPI so the change takes effect immediately, and listens for the
// main process pushing the same setting back (e.g. changed from a different
// window) so this tab never drifts out of sync.

import { useCallback, useEffect, useState } from 'react';
import { analytics } from '@/lib/analytics/analytics.service';

export type DisguiseMode = 'terminal' | 'settings' | 'activity' | 'none';
export type ThemeMode = 'system' | 'light' | 'dark';
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'uptodate' | 'error';

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
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');

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

    // ── Auto-update lifecycle ────────────────────────────────────────────────
    useEffect(() => {
        if (!isOpen) return;
        const unsubs = [
            window.electronAPI.onUpdateChecking(() => setUpdateStatus('checking')),
            // Don't auto-close Settings here — let the user see the button
            // change to "Update Available" and choose to download.
            window.electronAPI.onUpdateAvailable(() => setUpdateStatus('available')),
            window.electronAPI.onUpdateNotAvailable(() => {
                setUpdateStatus('uptodate');
                setTimeout(() => setUpdateStatus('idle'), 3000);
            }),
            window.electronAPI.onUpdateError((err: unknown) => {
                console.error('[useGeneralSettings] Update error:', err);
                setUpdateStatus('error');
                setTimeout(() => setUpdateStatus('idle'), 3000);
            }),
        ];
        return () => unsubs.forEach((unsub) => unsub());
    }, [isOpen]);

    const checkForUpdates = useCallback(async () => {
        if (updateStatus === 'checking') return;
        setUpdateStatus('checking');
        try {
            await window.electronAPI.checkForUpdates();
        } catch (error) {
            console.error('[useGeneralSettings] Failed to check for updates:', error);
            setUpdateStatus('error');
            setTimeout(() => setUpdateStatus('idle'), 3000);
        }
    }, [updateStatus]);

    /** Starts downloading the already-detected update, or triggers a check if none is pending yet. */
    const downloadOrCheckForUpdate = useCallback(async (onDownloadStarted?: () => void) => {
        if (updateStatus === 'available') {
            try {
                await window.electronAPI.downloadUpdate();
                onDownloadStarted?.(); // caller typically closes Settings to show the download banner
            } catch (err) {
                console.error('[useGeneralSettings] Failed to start download:', err);
            }
        } else {
            checkForUpdates();
        }
    }, [updateStatus, checkForUpdates]);

    // ── Toggle handlers ──────────────────────────────────────────────────────
    const toggleUndetectable = useCallback(() => {
        const newState = !isUndetectable;
        setIsUndetectable(newState);
        window.electronAPI?.setUndetectable(newState);
        analytics.trackModeSelected(newState ? 'undetectable' : 'overlay');
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
        analytics.trackModeSelected(`disguise_${mode}`);
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
        updateStatus,
        toggleUndetectable,
        toggleMousePassthrough,
        toggleOpenOnLogin,
        toggleVerboseLogging,
        setDisguiseMode,
        setThemeMode,
        checkForUpdates,
        downloadOrCheckForUpdate,
        quitApp,
    };
}