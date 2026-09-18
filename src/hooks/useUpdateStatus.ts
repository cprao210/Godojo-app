import { useEffect, useRef, useState, useCallback } from 'react';
import { ParsedReleaseNotes } from '@/types';
import { macDmgDownloadUrl } from '@/../utils/updateFeed';

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
    /** Arch of the pending macOS manual download ('arm64' | 'x64') — used to
     *  render the expected DMG filename in the manual-install instructions. */
    instructionsArch: 'arm64' | 'x64' | null;
    /** True once we've confirmed this is a packaged (production) build.
     *  Updates are a production-only feature, so consumers should treat
     *  `false` (including the initial default before the IPC round-trip
     *  settles) as "don't show/allow this". */
    isPackaged: boolean;
    checkForUpdates: () => Promise<void>;
    /** Starts the install for an available update. On macOS this opens the
     *  DMG in the browser and flips status to 'instructions' (unsigned app —
     *  electron-updater can't self-restart); on Windows/Linux it downloads
     *  via electron-updater and 'ready' arrives through onUpdateDownloaded. */
    startInstall: () => void;
    /** Quits and installs a downloaded update. Refuses (with an error message)
     *  while a meeting is active or in dev builds. */
    installUpdate: () => Promise<void>;
}

// Persisted across restarts: the version we sent the user off to manually
// install on macOS. UpdateBanner compares it against app.getVersion() on next
// launch to surface an explicit success toast — the one thing macOS doesn't
// give us for free the way quitAndInstall's auto-restart does on Windows/Linux.
export const PENDING_MANUAL_UPDATE_KEY = 'godojo_pending_manual_update_version';

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
    const [instructionsArch, setInstructionsArch] = useState<'arm64' | 'x64' | null>(null);
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
            // A newly announced update starts a fresh lifecycle — never carry
            // the previous download's progress into it.
            setDownloadProgress(0);
            if (info?.parsedNotes) setParsedNotes(info.parsedNotes);
            // A check result must never clobber an in-flight download or an
            // update that's already downloaded and waiting to install.
            setStatus(prev => (prev === 'downloading' || prev === 'ready' || prev === 'instructions' ? prev : 'idle'));
        });

        const unsubNotAvailable = window.electronAPI.onUpdateNotAvailable(() => {
            if (checkingTimeoutRef.current) clearTimeout(checkingTimeoutRef.current);
            setIsUpdateAvailable(false);
            setLastCheckedAt(new Date());
            // Same protection as update-available above: a re-check that comes
            // back "up to date" must not erase an already-downloaded install.
            setStatus(prev => (prev === 'downloading' || prev === 'ready' || prev === 'instructions' ? prev : 'idle'));
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
            // An in-flight download that failed is over — drop back so a retry
            // can start cleanly. Ready installs are untouched: an unrelated
            // later error must not unready an already-downloaded update.
            setStatus(prev => (prev === 'ready' || prev === 'instructions' ? prev : 'error'));
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

    const startInstall = useCallback(() => {
        if (!isPackaged) return;
        setErrorMessage(null);
        setDownloadProgress(0);
        // macOS: manual browser download + install, until Developer ID
        // signing + notarization are set up (electron-updater's Squirrel.Mac
        // requires a real code signature — see package.json mac.identity,
        // currently null, and scripts/ad-hoc-sign.js). Windows/Linux are
        // unaffected either way.
        if (window.electronAPI.platform === 'darwin') {
            window.electronAPI.getArch()
                .then((arch) => {
                    const dmgSuffix: 'arm64' | 'x64' = arch === 'arm64' ? 'arm64' : 'x64';
                    const version = updateInfo?.version;
                    if (!version) throw new Error('No update version known');
                    setInstructionsArch(dmgSuffix);
                    localStorage.setItem(PENDING_MANUAL_UPDATE_KEY, version.replace(/^v/, ''));
                    window.electronAPI.openExternal(macDmgDownloadUrl(version, dmgSuffix));
                    setStatus('instructions');
                })
                .catch((err) => {
                    // Can't determine arch/version — fall back to the
                    // electron-updater download; if the build can't use it the
                    // resulting update-error surfaces normally.
                    console.error('[useUpdateStatus] macOS manual install setup failed:', err);
                    setStatus('downloading');
                    window.electronAPI.downloadUpdate();
                });
        } else {
            setStatus('downloading');
            window.electronAPI.downloadUpdate();
        }
    }, [isPackaged, updateInfo]);

    const installUpdate = useCallback(async () => {
        if (!isPackaged) {
            setStatus('error');
            setErrorMessage('Updates are disabled in development builds');
            return;
        }
        // Never kill a live call to apply an update — the quit tears down the
        // audio pipeline and ends the meeting with no summary. Mirror of the
        // main-process guard in AppState.quitAndInstallUpdate (which protects
        // every caller, including UpdateModal's direct restartAndInstall).
        try {
            if (await window.electronAPI.getMeetingActive()) {
                setStatus('error');
                setErrorMessage('End the current meeting before restarting to install the update.');
                return;
            }
        } catch { /* can't tell — let the main-process guard decide */ }
        try {
            await window.electronAPI.restartAndInstall();
        } catch (err: any) {
            // The main process broadcasts update-error for its own guard
            // rejections, but a hard IPC failure should surface too.
            setStatus('error');
            setErrorMessage(err?.message || 'Could not restart to install the update.');
        }
    }, [isPackaged]);

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
        instructionsArch,
        checkForUpdates,
        startInstall,
        installUpdate,
    };
}
