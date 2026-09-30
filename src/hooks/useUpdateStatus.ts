import { useEffect, useRef, useState, useCallback } from 'react';
import { ParsedReleaseNotes } from '@/types';
import { macDmgDownloadUrl } from '@/../utils/updateFeed';
import { API_BASE } from '@/lib/apiClient';

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error' | 'instructions';

export interface UpdateInfo {
    version: string;
    parsedNotes?: ParsedReleaseNotes | null;
    /** Byte size of this platform's update artifact, from the update feed (latest*.yml)
     *  assets (NSIS exe / DMG / AppImage). The FULL package size — on Windows
     *  the differential (blockmap) download usually transfers much less, and
     *  once downloading, `downloadTotalBytes` carries the ACTUAL bytes. */
    downloadSizeBytes?: number | null;
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
    /** Full package size of the pending update (bytes), or null if the asset
     *  list couldn't be fetched. Display with formatUpdateSize(). */
    downloadSizeBytes: number | null;
    /** ACTUAL bytes this download will transfer (from electron-updater's
     *  progress events). On Windows differential updates this is the delta
     *  size — much smaller than downloadSizeBytes. Null until downloading. */
    downloadTotalBytes: number | null;
    /** Bytes transferred so far in the in-flight download. */
    downloadTransferredBytes: number | null;
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

/** 1234567 → "1.2 MB"; 441_000_000 → "441 MB"; small values → KB. */
export function formatUpdateSize(bytes: number | null | undefined): string | null {
    if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const mb = bytes / (1024 * 1024);
    // One decimal only while it adds information (9.4 MB), plain integer after (441 MB)
    return mb < 100 ? `${mb.toFixed(1).replace(/\.0$/, '')} MB` : `${Math.round(mb)} MB`;
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
    const [instructionsArch, setInstructionsArch] = useState<'arm64' | 'x64' | null>(null);
    const [isPackaged, setIsPackaged] = useState(false);
    const [downloadSizeBytes, setDownloadSizeBytes] = useState<number | null>(null);
    const [downloadTotalBytes, setDownloadTotalBytes] = useState<number | null>(null);
    const [downloadTransferredBytes, setDownloadTransferredBytes] = useState<number | null>(null);

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
                // A check that never resolves (no available/not-available/error
                // follow-up) — previously this silently flipped back to 'idle',
                // which read as "the button spun forever and nothing happened".
                // Surface a friendly error instead; a late-arriving result
                // still recovers (the available/not-available handlers clear
                // the error and set the real state).
                setStatus(prev => (prev === 'checking' ? 'error' : prev));
                setErrorMessage(prev => prev ?? "We couldn't check for the latest version right now. Please try again later.");
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
            setDownloadSizeBytes(info?.downloadSizeBytes ?? null);
            setDownloadTotalBytes(null);
            setDownloadTransferredBytes(null);
            if (info?.parsedNotes) setParsedNotes(info.parsedNotes);
            // A check result must never clobber an in-flight download or an
            // update that's already downloaded and waiting to install.
            setStatus(prev => (prev === 'downloading' || prev === 'ready' || prev === 'instructions' ? prev : 'idle'));
        });

        const unsubNotAvailable = window.electronAPI.onUpdateNotAvailable(() => {
            if (checkingTimeoutRef.current) clearTimeout(checkingTimeoutRef.current);
            setIsUpdateAvailable(false);
            setLastCheckedAt(new Date());
            // A completed check is a clean result — never let a previous
            // failure's error text linger next to an "Up to date" state
            // (this used to leave the Updates tab's error card stuck).
            setErrorMessage(null);
            // Same protection as update-available above: a re-check that comes
            // back "up to date" must not erase an already-downloaded install.
            setStatus(prev => (prev === 'downloading' || prev === 'ready' || prev === 'instructions' ? prev : 'idle'));
        });

        const unsubProgress = window.electronAPI.onDownloadProgress((progressObj: any) => {
            setStatus('downloading');
            setDownloadProgress(progressObj.percent);
            // Actual transfer size — for Windows differential (blockmap)
            // downloads this total IS the delta size, not the full installer.
            if (typeof progressObj?.total === 'number' && progressObj.total > 0) {
                setDownloadTotalBytes(progressObj.total);
            }
            if (typeof progressObj?.transferred === 'number') {
                setDownloadTransferredBytes(progressObj.transferred);
            }
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
        } catch {
            // IPC-level failure only (the main process sanitizes every real
            // update error before broadcast) — never surface a raw transport
            // error to the user.
            setStatus('error');
            setErrorMessage("We couldn't check for the latest version right now. Please try again later.");
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
                    window.electronAPI.openExternal(macDmgDownloadUrl(API_BASE, dmgSuffix));
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
        downloadSizeBytes,
        downloadTotalBytes,
        downloadTransferredBytes,
        checkForUpdates,
        startInstall,
        installUpdate,
    };
}