import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioCaptureFailure, PermissionStatus } from '@/electron.d';
import type { AudioPermissionState, SystemAudioWarning } from '@/types';

/**
 * Single source of truth for microphone / Screen Recording permission state.
 *
 * Shared by the launcher's AudioStatusTray and the meeting overlay's banner so
 * the two windows cannot disagree. It combines three signals that each cover a
 * case the others miss:
 *
 *   1. A poll of `checkPermissions()` on mount — the baseline.
 *   2. `getSystemAudioPermissionWarning()`, also on mount, which replays a
 *      warning the main process latched BEFORE this component subscribed. The
 *      startup denial check runs ~800ms after window creation, and the overlay
 *      window does not exist until a meeting starts, so without this replay
 *      those warnings would be delivered to nothing.
 *   3. Push events for live failures during a meeting.
 *
 * It also re-checks on window `focus`, which is how the user returning from
 * System Settings clears the warning without needing a restart.
 */
export function useSystemAudioPermission() {
    const [permissions, setPermissions] = useState<AudioPermissionState>({
        microphone: false,
        systemAudio: false,
        screenCapture: false,
    });
    const [screenStatus, setScreenStatus] = useState<PermissionStatus>('not-determined');
    const [microphoneStatus, setMicrophoneStatus] = useState<PermissionStatus>('not-determined');
    const [warning, setWarning] = useState<SystemAudioWarning | null>(null);
    const [repairing, setRepairing] = useState(false);
    const [checked, setChecked] = useState(false);

    // Read in effects that must not re-subscribe when the warning changes.
    const warningRef = useRef<SystemAudioWarning | null>(null);
    warningRef.current = warning;

    const recheck = useCallback(async (): Promise<AudioPermissionState | null> => {
        try {
            const status = await window.electronAPI?.checkPermissions?.();
            if (!status) return null;

            setPermissions({
                microphone: status.microphone,
                systemAudio: status.systemAudio,
                screenCapture: status.screenCapture,
            });
            setScreenStatus(status.screenStatus ?? 'not-determined');
            setMicrophoneStatus(status.microphoneStatus ?? 'not-determined');

            // Clear a stale banner once the grant it complained about exists.
            // The capture itself still needs a restart to pick the grant up, but
            // leaving "permission denied" on screen after the user has granted it
            // is worse than saying nothing.
            if (status.screenCapture && warningRef.current?.kind === 'screen-recording-permission') {
                setWarning(null);
            }
            return {
                microphone: status.microphone,
                systemAudio: status.systemAudio,
                screenCapture: status.screenCapture,
            };
        } catch (err) {
            console.warn('[useSystemAudioPermission] checkPermissions failed:', err);
            return null;
        } finally {
            setChecked(true);
        }
    }, []);

    // Mount: current state, plus any warning latched before we subscribed.
    useEffect(() => {
        void recheck();
        void (async () => {
            try {
                const latched = await window.electronAPI?.getSystemAudioPermissionWarning?.();
                // Don't clobber a live push that arrived while this was in flight.
                if (latched && !warningRef.current) {
                    setWarning({ kind: 'screen-recording-permission', message: latched, channel: 'system' });
                }
            } catch (err) {
                console.warn('[useSystemAudioPermission] warning replay failed:', err);
            }
        })();
    }, [recheck]);

    // Re-check when the user comes back to the app — typically from System
    // Settings, having just changed the very permission we are reporting on.
    useEffect(() => {
        const handleFocus = () => { void recheck(); };
        window.addEventListener('focus', handleFocus);
        return () => window.removeEventListener('focus', handleFocus);
    }, [recheck]);

    useEffect(() => {
        const unsub = window.electronAPI?.onSystemAudioPermissionDenied?.((message: string) => {
            setWarning({ kind: 'screen-recording-permission', message, channel: 'system' });
        });
        return () => unsub?.();
    }, []);

    useEffect(() => {
        const unsub = window.electronAPI?.onAudioCaptureFailed?.((payload: AudioCaptureFailure) => {
            // Only terminal or stuck failures are worth a banner. Transient
            // recovery attempts succeed within ~1.5s and would just flicker.
            if (!payload.terminal && !payload.stuck) return;
            setWarning({
                kind: 'audio-capture-failure',
                message: payload.message,
                channel: payload.channel,
            });
        });
        return () => unsub?.();
    }, []);

    // Main tells us when audio starts flowing again. Needed because a warning
    // raised during a quiet stretch would otherwise sit on screen over a meeting
    // that is transcribing fine, and the focus re-check above cannot help during
    // a live call the user is not clicking away from.
    useEffect(() => {
        const unsub = window.electronAPI?.onSystemAudioRecovered?.(() => {
            setWarning((current) =>
                current?.kind === 'audio-capture-failure' && current.channel === 'system' ? null : current,
            );
        });
        return () => unsub?.();
    }, []);

    const dismiss = useCallback(() => setWarning(null), []);

    const openPane = useCallback((pane: 'microphone' | 'screen') => {
        void window.electronAPI?.openPermissionSettings?.(pane);
    }, []);

    const request = useCallback(async (type: 'microphone' | 'screen') => {
        const granted = await window.electronAPI?.requestPermission?.(type);
        // 'screen' always resolves false (macOS has no ask API for it) — it just
        // opens the pane, so the focus listener above is what actually updates us.
        if (granted) await recheck();
        return !!granted;
    }, [recheck]);

    const repair = useCallback(async () => {
        if (repairing) return null; // guard a double-click from running tccutil twice
        setRepairing(true);
        try {
            const result = await window.electronAPI?.repairTccPermissions?.();
            if (result) {
                // Replace the banner text with the repair outcome — it carries the
                // quit-and-reopen instruction the user now needs.
                setWarning({
                    kind: 'audio-capture-failure',
                    message: result.message,
                    channel: warningRef.current?.channel,
                });
            }
            return result ?? null;
        } catch (err) {
            console.warn('[useSystemAudioPermission] repairTccPermissions failed:', err);
            return null;
        } finally {
            setRepairing(false);
        }
    }, [repairing]);

    const isMac = (window.electronAPI?.getPlatform?.() ?? 'darwin') === 'darwin';
    const allGranted = isMac
        ? permissions.microphone && permissions.screenCapture
        : permissions.microphone;

    return {
        permissions,
        screenStatus,
        microphoneStatus,
        warning,
        repairing,
        checked,
        isMac,
        allGranted,
        recheck,
        dismiss,
        openPane,
        request,
        repair,
    };
}
