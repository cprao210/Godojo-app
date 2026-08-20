import { useEffect, useRef, useState, useCallback } from 'react';
import { ParsedReleaseNotes } from '@/types';

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error' | 'instructions';

export interface UpdateInfo {
    version: string;
    parsedNotes?: ParsedReleaseNotes | null;
    [key: string]: any;
}

export interface UseUpdateStatusResult {
    appVersion: string | null;
    updateInfo: UpdateInfo | null;
    parsedNotes: ParsedReleaseNotes | null;
    isUpdateAvailable: boolean;
    status: UpdateStatus;
    downloadProgress: number;
    errorMessage: string | null;
    lastCheckedAt: Date | null;
    /** True once we've confirmed this is a packaged (production) build.
     *  Updates are a production-only feature, so consumers should treat
     *  `false` (including the initial default before the IPC round-trip
     *  settles) as "don't show/allow this". */
    isPackaged: boolean;
    checkForUpdates: () => Promise<void>;
    downloadUpdate: () => void;
    installUpdate: () => Promise<void>;
}

/**
 * Single source of truth for update state, backed by the electron-updater
 * IPC events wired up in electron/main.ts (setupAutoUpdater). Both the
 * transient UpdateBanner popup and the persistent Settings > Updates tab
 * subscribe to this so they never fall out of sync with each other.
 */
export function useUpdateStatus(): UseUpdateStatusResult {
    const [appVersion, setAppVersion] = useState<string | null>(null);
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [parsedNotes, setParsedNotes] = useState<ParsedReleaseNotes | null>(null);
    const [isUpdateAvailable, setIsUpdateAvailable] = useState(false);
    const [status, setStatus] = useState<UpdateStatus>('idle');
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
    const [isPackaged, setIsPackaged] = useState(false);

    // Guards against setting 'checking' -> stuck forever if a checking-for-update
    // event fires but no available/not-available follow-up ever arrives.
    const checkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        window.electronAPI?.getAppVersion?.()
            .then(setAppVersion)
            .catch(() => setAppVersion(null));
    }, []);

    useEffect(() => {
        window.electronAPI?.isAppPackaged?.()
            .then(setIsPackaged)
            // Fail closed: if we can't confirm this is production, treat it
            // as not-production so the feature stays hidden/disabled.
            .catch(() => setIsPackaged(false));
    }, []);

    useEffect(() => {
        const unsubChecking = window.electronAPI.onUpdateChecking(() => {
            setStatus('checking');
            setErrorMessage(null);
            if (checkingTimeoutRef.current) clearTimeout(checkingTimeoutRef.current);
            checkingTimeoutRef.current = setTimeout(() => {
                setStatus(prev => (prev === 'checking' ? 'idle' : prev));
            }, 20000);
        });

        const unsubAvailable = window.electronAPI.onUpdateAvailable((info: UpdateInfo) => {
            if (checkingTimeoutRef.current) clearTimeout(checkingTimeoutRef.current);
            setUpdateInfo(info);
            setIsUpdateAvailable(true);
            setErrorMessage(null);
            setLastCheckedAt(new Date());
            if (info?.parsedNotes) setParsedNotes(info.parsedNotes);
            setStatus(prev => (prev === 'downloading' || prev === 'ready' ? prev : 'idle'));
        });

        const unsubNotAvailable = window.electronAPI.onUpdateNotAvailable(() => {
            if (checkingTimeoutRef.current) clearTimeout(checkingTimeoutRef.current);
            setIsUpdateAvailable(false);
            setLastCheckedAt(new Date());
            setStatus('idle');
        });

        const unsubProgress = window.electronAPI.onDownloadProgress((progressObj: any) => {
            setStatus('downloading');
            setDownloadProgress(progressObj.percent);
        });

        const unsubDownloaded = window.electronAPI.onUpdateDownloaded((info: UpdateInfo) => {
            setUpdateInfo(info);
            if (info?.parsedNotes) setParsedNotes(info.parsedNotes);
            setStatus('ready');
        });

        const unsubError = window.electronAPI.onUpdateError((err: string) => {
            if (checkingTimeoutRef.current) clearTimeout(checkingTimeoutRef.current);
            setStatus('error');
            setErrorMessage(err);
        });

        return () => {
            unsubChecking();
            unsubAvailable();
            unsubNotAvailable();
            unsubProgress();
            unsubDownloaded();
            unsubError();
            if (checkingTimeoutRef.current) clearTimeout(checkingTimeoutRef.current);
        };
    }, []);

    const checkForUpdates = useCallback(async () => {
        if (!isPackaged) {
            // Updates are production-only; the main-process IPC handler
            // refuses this too, but short-circuit here to avoid a pointless
            // round-trip and an unnecessary "checking..." flash in dev.
            setStatus('error');
            setErrorMessage('Updates are disabled in development builds');
            return;
        }
        setStatus('checking');
        setErrorMessage(null);
        try {
            await window.electronAPI.checkForUpdates();
        } catch (err: any) {
            setStatus('error');
            setErrorMessage(err?.message || 'Update check failed');
        }
    }, [isPackaged]);

    const downloadUpdate = useCallback(() => {
        if (!isPackaged) return;
        setStatus('downloading');
        window.electronAPI.downloadUpdate();
    }, [isPackaged]);

    const installUpdate = useCallback(async () => {
        await window.electronAPI.restartAndInstall();
    }, []);

    return {
        appVersion,
        updateInfo,
        isPackaged,
        parsedNotes,
        isUpdateAvailable,
        status,
        downloadProgress,
        errorMessage,
        lastCheckedAt,
        checkForUpdates,
        downloadUpdate,
        installUpdate,
    };
}