import React, { useEffect, useState } from 'react';
import UpdateModal from './UpdateModal';

// Persisted across restarts: the version we sent the user off to manually
// install on macOS. Compared against app.getVersion() on next launch so we
// can surface an explicit success toast — the one thing macOS doesn't give
// us for free the way quitAndInstall's auto-restart does on Windows/Linux.
const PENDING_UPDATE_KEY = 'godojo_pending_manual_update_version';

const UpdateBanner: React.FC = () => {
    const [updateInfo, setUpdateInfo] = useState<any>(null);
    const [parsedNotes, setParsedNotes] = useState<any>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [status, setStatus] = useState<'idle' | 'downloading' | 'ready' | 'error' | 'instructions'>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [instructionsArch, setInstructionsArch] = useState<'arm64' | 'x64' | null>(null);
    const [justUpdatedVersion, setJustUpdatedVersion] = useState<string | null>(null);

    // On launch: if the last thing we did was send the user to manually
    // install a version on macOS, and the running app now matches it, the
    // install succeeded — clear the flag and celebrate once.
    useEffect(() => {
        const pending = localStorage.getItem(PENDING_UPDATE_KEY);
        if (!pending) return;

        window.electronAPI.getAppVersion()
            .then((current: string) => {
                const normalize = (v: string) => v.replace(/^v/, '');
                if (normalize(current) === normalize(pending)) {
                    setJustUpdatedVersion(current);
                    setTimeout(() => setJustUpdatedVersion(null), 5000);
                }
                localStorage.removeItem(PENDING_UPDATE_KEY);
            })
            .catch(() => localStorage.removeItem(PENDING_UPDATE_KEY));
    }, []);

    useEffect(() => {
        // Listen for update available
        const unsubAvailable = window.electronAPI.onUpdateAvailable((info: any) => {
            console.log('[UpdateBanner] Update available:', info);
            setUpdateInfo(info);
            setErrorMessage(null);
            setStatus('idle'); // Reset from any prior error/state before showing update info
            // If parsed notes are included in the info object (from our backend change)
            if (info.parsedNotes) {
                setParsedNotes(info.parsedNotes);
            }
            setIsVisible(true);
        });

        // Listen for download progress
        const unsubProgress = window.electronAPI.onDownloadProgress((progressObj) => {
            // Ensure modal is visible if download starts
            setIsVisible(true);
            setStatus('downloading');
            setDownloadProgress(progressObj.percent);
        });

        // Listen for update-downloaded event
        const unsubDownloaded = window.electronAPI.onUpdateDownloaded((info) => {
            console.log('[UpdateBanner] Update downloaded:', info);
            setUpdateInfo(info); // Update info again just in case
            if (info.parsedNotes) setParsedNotes(info.parsedNotes);

            setStatus('ready');
            setIsVisible(true);
        });

        // Listen for update errors
        const unsubError = window.electronAPI.onUpdateError((err: string) => {
            console.error('[UpdateBanner] Update error:', err);
            setStatus('error');
            setErrorMessage(err);
        });

        return () => {
            unsubAvailable();
            unsubProgress();
            unsubDownloaded();
            unsubError();
        };
    }, []);

    // Demo/Test mode: Press Cmd+I to trigger backend test-fetch or Cmd+J for UI mock
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!import.meta.env.DEV) return;

            if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i') {
                e.preventDefault();
                console.log("[UpdateBanner] Cmd+I pressed: Triggering Test Release Fetch...");
                window.electronAPI.testReleaseFetch().catch(console.error);
            }

            if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
                e.preventDefault();
                console.log("[UpdateBanner] Cmd+J pressed: Triggering Instruction UI mock...");
                setUpdateInfo({ version: '2.0.8' });
                setParsedNotes({ summary: 'Test Update', fullBody: 'Testing', sections: [{ title: 'Notes', items: ['UI Test'] }] });
                setStatus('idle');
                setIsVisible(true);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const handleInstall = async () => {
        // macOS: manual browser download + install, until Developer ID
        // signing + notarization are set up (electron-updater's Squirrel.Mac
        // requires a real code signature — see package.json mac.identity,
        // currently null, and scripts/ad-hoc-sign.js). Revisit this once
        // that's configured; Windows/Linux are unaffected either way.
        if (window.electronAPI.platform === 'darwin') {
            try {
                const arch = await window.electronAPI.getArch();
                const isArm = arch === 'arm64';
                const dmgSuffix = isArm ? 'arm64' : 'x64';
                setInstructionsArch(dmgSuffix);
                const version = updateInfo?.version ? updateInfo.version.replace('v', '') : '2.0.8';
                // NOTE: matches package.json publish.owner/repo (cprao210/Godojo-app)
                // and the default electron-builder dmg artifactName pattern
                // "${productName}-${version}-${arch}.dmg" for productName "GoDojo.AI".
                const url = `https://github.com/cprao210/Godojo-app/releases/download/v${version}/GoDojo.AI-${version}-${dmgSuffix}.dmg`;
                localStorage.setItem(PENDING_UPDATE_KEY, version);
                window.electronAPI.openExternal(url);
                setStatus('instructions');
            } catch (err) {
                console.error("Failed to get arch", err);
                setStatus('downloading');
                window.electronAPI.downloadUpdate();
            }
        } else {
            setStatus('downloading');
            window.electronAPI.downloadUpdate();
        }
    };

    const handleDismiss = () => {
        setIsVisible(false);
        setStatus('idle'); // Reset error/downloading state so next event starts clean
    };

    // Same as dismiss today — kept as a distinct handler so "Remind Me Later"
    // can gain its own snooze/backoff behavior later without touching callers.
    const handleRemindLater = () => {
        handleDismiss();
    };

    return (
        <>
            {isVisible && (
                <UpdateModal
                    isOpen={isVisible}
                    updateInfo={updateInfo}
                    parsedNotes={parsedNotes}
                    onDismiss={handleDismiss}
                    onInstall={handleInstall}
                    onRemindLater={handleRemindLater}
                    downloadProgress={downloadProgress}
                    status={status}
                    errorMessage={errorMessage}
                    instructionsArch={instructionsArch}
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