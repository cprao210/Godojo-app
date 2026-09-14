import React, { useEffect, useState } from 'react';
import UpdateModal from './UpdateModal';
import { useUpdateStatus } from '@/hooks';
import { PENDING_MANUAL_UPDATE_KEY, UpdateInfo } from '@/hooks/useUpdateStatus';
import { ParsedReleaseNotes } from '@/types';

const UpdateBanner: React.FC = () => {
    // Shared update state — the SAME useUpdateStatus instance shape the
    // Settings > Updates tab uses, so the banner and the tab can never drift
    // (previously this component kept its own duplicate state: it knew about
    // the macOS manual-install flow while the tab downloaded via
    // electron-updater, which fails on unsigned mac builds).
    const {
        updateInfo,
        parsedNotes,
        status,
        downloadProgress,
        errorMessage,
        installUpdate,
        startInstall,
    } = useUpdateStatus();

    // Banner-local UI state: whether the modal is on screen, the "just
    // updated" toast, and the dev-only UI mock (the shared hook is
    // event-driven, so a fake update can only exist locally here).
    const [isVisible, setIsVisible] = useState(false);
    const [justUpdatedVersion, setJustUpdatedVersion] = useState<string | null>(null);
    const [devMock, setDevMock] = useState<{ updateInfo: UpdateInfo; parsedNotes: ParsedReleaseNotes } | null>(null);

    // On launch: if the last thing we did was send the user to manually
    // install a version on macOS, and the running app now matches it, the
    // install succeeded — clear the flag and celebrate once.
    useEffect(() => {
        const pending = localStorage.getItem(PENDING_MANUAL_UPDATE_KEY);
        if (!pending) return;

        let toastTimeout: ReturnType<typeof setTimeout> | null = null;
        window.electronAPI.getAppVersion()
            .then((current: string) => {
                const normalize = (v: string) => v.replace(/^v/, '');
                if (normalize(current) === normalize(pending)) {
                    setJustUpdatedVersion(current);
                    toastTimeout = setTimeout(() => setJustUpdatedVersion(null), 5000);
                }
                localStorage.removeItem(PENDING_MANUAL_UPDATE_KEY);
            })
            .catch(() => localStorage.removeItem(PENDING_MANUAL_UPDATE_KEY));

        return () => {
            if (toastTimeout) clearTimeout(toastTimeout);
        };
    }, []);

    useEffect(() => {
        // Listen for update available
        const unsubAvailable = window.electronAPI.onUpdateAvailable(() => {
            setIsVisible(true);
        });

        // Listen for download progress — re-open if the user hid the modal
        // (same behavior as before; the download is user-initiated so showing
        // it again is expected). Status/progress live in the shared hook.
        const unsubProgress = window.electronAPI.onDownloadProgress(() => {
            setIsVisible(true);
        });

        // Listen for update-downloaded event
        const unsubDownloaded = window.electronAPI.onUpdateDownloaded(() => {
            setIsVisible(true);
        });

        // Listen for update errors. Show them even if the modal was dismissed:
        // a failed user-initiated download is invisible otherwise, and the
        // stale error would sit in shared state until the next event resets it.
        const unsubError = window.electronAPI.onUpdateError(() => {
            setIsVisible(true);
        });

        return () => {
            unsubAvailable();
            unsubProgress();
            unsubDownloaded();
            unsubError();
        };
    }, []);

    // Demo/Test mode: Press Cmd/Ctrl+I to trigger backend test-fetch or
    // Cmd/Ctrl+J for UI mock (dev only; metaKey alone is macOS-only).
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!import.meta.env.DEV) return;

            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'i') {
                e.preventDefault();
                console.log("[UpdateBanner] Cmd/Ctrl+I pressed: Triggering Test Release Fetch...");
                window.electronAPI.testReleaseFetch().catch(console.error);
            }

            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'j') {
                e.preventDefault();
                console.log("[UpdateBanner] Cmd/Ctrl+J pressed: Triggering Instruction UI mock...");
                setDevMock({
                    updateInfo: { version: '2.0.8' },
                    parsedNotes: { summary: 'Test Update', fullBody: 'Testing', sections: [{ title: 'Notes', items: ['UI Test'] }] } as ParsedReleaseNotes,
                });
                setIsVisible(true);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const handleDismiss = () => {
        setIsVisible(false);
        // Intentionally does NOT touch shared status: dismissing the banner
        // must not erase what the hook knows (a 'ready' install, an in-flight
        // download, an error for the Settings tab badge). The modal is just a
        // view; the hook re-opens it via the listeners above.
    };

    // Same as dismiss today — kept as a distinct handler so "Remind Me Later"
    // can gain its own snooze/backoff behavior later without touching callers.
    const handleRemindLater = () => {
        handleDismiss();
    };

    // Statuses the modal knows how to render beyond the release-notes view.
    // The banner only opens itself on real events, so 'instructions'/'error'
    // arrive here only while the modal is already up (or via the error
    // listener re-opening it) — never out of nowhere. In dev the UI mock
    // overrides what's displayed.
    const modalStatus = status;
    const modalNotes = (devMock?.parsedNotes ?? parsedNotes) as ParsedReleaseNotes | null;
    const modalInfo = (devMock?.updateInfo ?? updateInfo) as UpdateInfo | null;

    return (
        <>
            {isVisible && (
                <UpdateModal
                    isOpen={isVisible}
                    updateInfo={modalInfo}
                    parsedNotes={modalNotes}
                    onDismiss={handleDismiss}
                    onInstall={startInstall}
                    onInstallUpdate={installUpdate}
                    onRemindLater={handleRemindLater}
                    downloadProgress={downloadProgress}
                    status={modalStatus}
                    errorMessage={errorMessage}
                />
            )}

            {justUpdatedVersion && (
                <div className="fixed bottom-6 right-6 z-[10000] flex items-center gap-2 bg-[#1E1E1E]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl px-4 py-3 shadow-[0_20px_50px_-10px_rgba(0,0,0,0.5)]">
                    <span className="text-[13px] font-medium text-white">
                        You're now on the latest version 🎉
                    </span>
                </div>
            )}
        </>
    );
};

export default UpdateBanner;
