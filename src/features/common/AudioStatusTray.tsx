import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AlertTriangle, CheckCircle2, ExternalLink, Mic, Volume2, Wrench, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useResolvedTheme, useSystemAudioPermission, useAudioStatusTray } from '@/hooks';
import { shapeLevel, DEFAULT_MIC_GAIN, DEFAULT_SYSTEM_GAIN } from '@/features/floating-dock/AudioWaveIndicator';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import type { AudioStatusTrayProps, AudioChannelCardProps, AudioLevelMeterProps } from '@/types';

/** Marks that the first-run prompt has been shown, so it only opens once. */
const FIRST_RUN_KEY = 'godojo_perms_shown_v1';

/** Bars in the collapsed tray meter. */
const COMPACT_BARS = 4;

/** Resting height of a compact bar, so an idle meter still reads as a meter. */
const COMPACT_BAR_FLOOR = 0.28;

// Channel colours deliberately match AudioWaveIndicator's defaults — sky for
// "You", orange for "Client" — so the tray and the meeting dock never disagree
// about which side is which. Light theme drops to the 500 shade: the 400s are
// tuned for a dark panel and wash out against white.
const toneFill = (tone: 'mic' | 'system', isLight: boolean): string =>
    tone === 'mic'
        ? isLight ? 'bg-sky-500' : 'bg-sky-400'
        : isLight ? 'bg-orange-500' : 'bg-orange-400';

const toneText = (tone: 'mic' | 'system', isLight: boolean): string =>
    tone === 'mic'
        ? isLight ? 'text-sky-600' : 'text-sky-400'
        : isLight ? 'text-orange-600' : 'text-orange-400';

const meterTrack = (isLight: boolean): string => (isLight ? 'bg-black/[0.07]' : 'bg-white/10');

/**
 * Level meter for both tray surfaces. Animates via `transform` only — no layout,
 * no paint of a changing box — because it can update ~20 times a second for the
 * length of a meeting on machines that are already busy encoding audio.
 *
 * Marked aria-hidden: a value that changes 20x/s is noise to a screen reader.
 * The textual status badge beside it carries the same meaning.
 */
export const AudioLevelMeter: React.FC<AudioLevelMeterProps> = ({
    level,
    isLive,
    tone,
    isLight,
    compact = false,
    className = '',
}) => {
    const fill = toneFill(tone, isLight);
    const track = meterTrack(isLight);

    if (compact) {
        return (
            <span className={`flex items-stretch gap-[2px] h-3.5 ${className}`} aria-hidden="true">
                {Array.from({ length: COMPACT_BARS }, (_, i) => {
                    // Each bar owns a quarter of the range, so the meter fills
                    // left to right instead of all four pumping in unison.
                    const share = Math.min(Math.max(level * COMPACT_BARS - i, 0), 1);
                    const lit = isLive && share > 0.02;
                    const scale = lit ? COMPACT_BAR_FLOOR + share * (1 - COMPACT_BAR_FLOOR) : COMPACT_BAR_FLOOR;
                    return (
                        <span
                            key={i}
                            className={`w-[3px] rounded-full origin-bottom transition-transform duration-100 ease-out ${lit ? fill : track}`}
                            style={{ transform: `scaleY(${scale})` }}
                        />
                    );
                })}
            </span>
        );
    }

    return (
        <div className={`h-1.5 w-full rounded-full overflow-hidden ${track} ${className}`} aria-hidden="true">
            <div
                className={`h-full w-full rounded-full origin-left transition-transform duration-100 ease-out ${fill}`}
                // A live-but-silent channel keeps a sliver of fill: "connected and
                // quiet" and "not connected" must not look the same.
                style={{ transform: `scaleX(${isLive ? Math.max(level, 0.02) : 0})` }}
            />
        </div>
    );
};

/**
 * One channel of the panel. Replaces the old PermissionRow: same permission
 * affordances, plus the device it resolves to and a live meter, because
 * "allowed" and "actually receiving audio" are different questions and only the
 * second one predicts whether the meeting will transcribe.
 */
const AudioChannelCard: React.FC<AudioChannelCardProps> = ({
    icon,
    title,
    isGranted,
    status,
    level,
    isLive,
    isTesting,
    deviceName,
    deviceMissing,
    errorText,
    tone,
    isLight,
    onRequest,
    onOpenSettings,
}) => {
    // macOS only: 'not-determined' means we have never asked, which is a prompt
    // away — not the dead end a hard denial is. Windows and Linux always report
    // 'granted', so this branch simply never fires there.
    const neverAsked = status === 'not-determined';

    const tile = isGranted
        ? isLive
            ? 'bg-emerald-500/10 text-emerald-500'
            : 'bg-bg-item-surface text-text-secondary'
        : neverAsked
            ? 'bg-amber-500/10 text-amber-500'
            : 'bg-red-500/10 text-red-500';

    const deviceLine = deviceMissing
        ? `Saved device unavailable — using ${deviceName}`
        : deviceName;

    return (
        <div className="rounded-lg border border-border-subtle bg-bg-elevated shadow-sm">
            <div className="flex items-center justify-between gap-2 p-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className={`p-2 rounded-md shrink-0 transition-colors ${tile}`}>{icon}</div>
                    <div className="min-w-0">
                        <h3 className="text-sm font-medium text-text-primary leading-tight">{title}</h3>
                        {deviceLine && (
                            <p className="mt-0.5 text-[11px] text-text-tertiary truncate" title={deviceLine}>
                                {deviceLine}
                            </p>
                        )}
                    </div>
                </div>

                {isGranted ? (
                    <div className="shrink-0">
                        {isLive ? (
                            <span className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-500">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                Capturing
                            </span>
                        ) : isTesting ? (
                            <span className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${isLight ? 'bg-sky-500/10 text-sky-600' : 'bg-sky-500/10 text-sky-400'}`}>
                                <Activity size={12} /> Listening
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5 rounded-md bg-bg-item-surface px-2 py-1 text-xs font-medium text-text-tertiary">
                                <CheckCircle2 size={12} /> Allowed
                            </span>
                        )}
                    </div>
                ) : (
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            onClick={onOpenSettings}
                            className="flex items-center gap-1 text-[11px] font-medium text-text-secondary transition-colors hover:text-text-primary"
                        >
                            <ExternalLink size={12} /> Settings
                        </button>
                        <button
                            onClick={onRequest}
                            className={`rounded-md px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors ${neverAsked ? 'bg-amber-500 hover:bg-amber-600' : 'bg-red-500 hover:bg-red-600'}`}
                        >
                            Allow
                        </button>
                    </div>
                )}
            </div>

            {/* No meter when the channel is blocked — an empty track next to a
                red "Allow" button just reads as a second failure. */}
            {isGranted && (
                <div className="px-3 pb-3">
                    <AudioLevelMeter level={level} isLive={isLive} tone={tone} isLight={isLight} />
                </div>
            )}

            {errorText && (
                <p className={`mx-3 mb-3 rounded-md px-2 py-1.5 text-[11px] leading-snug ${isLight ? 'bg-amber-100 text-amber-800' : 'bg-amber-500/10 text-amber-400'}`}>
                    {errorText}
                </p>
            )}
        </div>
    );
};

export const AudioStatusTray: React.FC<AudioStatusTrayProps> = ({ isVisible, onClose, onAllGranted }) => {
    const {
        permissions,
        allGranted: isAllGranted,
        checked,
        repairing,
        isMac,
        microphoneStatus,
        screenStatus,
        warning,
        dismiss,
        recheck,
        openPane,
        request,
        repair,
    } = useSystemAudioPermission();
    const [expanded, setExpanded] = useState(false);

    const isLight = useResolvedTheme() === 'light';

    // Levels, resolved devices, and the opt-in probe. Scoped to `expanded` so a
    // closed tray polls nothing.
    const { mic, system, meetingLive, testing, testError, systemError, startTest, stopTest } =
        useAudioStatusTray(expanded);

    // Same shaping the dock's wave uses, so a given voice lights both meters to
    // the same place. Already clamped and NaN-safe.
    const micMeter = shapeLevel(mic.level, DEFAULT_MIC_GAIN);
    const systemMeter = shapeLevel(system.level, DEFAULT_SYSTEM_GAIN);

    // The hook already refreshes on mount, on window focus, and on push events
    // from main. A poll is kept ONLY while the panel is open, to catch a grant
    // made without ever focusing this window (e.g. System Settings on a second
    // display). Polling every 5s while merely idle was pure waste.
    useEffect(() => {
        if (!expanded) return;
        const interval = setInterval(() => { void recheck(); }, 5000);
        return () => clearInterval(interval);
    }, [expanded, recheck]);

    // Close once everything is granted. onAllGranted resumes the meeting the
    // user was trying to start, so only fire it when a blocked start opened this.
    useEffect(() => {
        // Only auto-close/auto-start if the panel was forcefully opened by a blocked meeting start
        if (!isVisible) return;

        if (!isAllGranted || !expanded) return;
        setExpanded(false);
        onAllGranted?.();
    }, [isAllGranted, expanded, isVisible, onAllGranted]);

    // A blocked meeting start forces the panel open.
    useEffect(() => {
        if (!isVisible) return;
        setExpanded(true);
        void recheck();
    }, [isVisible, recheck]);

    // First run: open unprompted if something is missing, so a new user grants
    // permissions before their first meeting instead of discovering the problem
    // partway through it.
    useEffect(() => {
        if (!checked) return;
        if (localStorage.getItem(FIRST_RUN_KEY)) return;
        localStorage.setItem(FIRST_RUN_KEY, '1');
        if (!isAllGranted) setExpanded(true);
    }, [checked, isAllGranted]);

    const platformName = () => window.electronAPI?.getPlatform?.() || 'unknown';

    const handleRequest = async (type: 'microphone' | 'screen') => {
        posthogAnalytics.trackEvent("audio_permission_requested", { type, platform: platformName() });
        const granted = await request(type);
        posthogAnalytics.trackEvent("audio_permission_result", { type, granted, platform: platformName() });
    };

    // Deep-link to the pane matching the row. This previously always opened
    // Microphone, so the System Audio row sent users somewhere useless.
    const openSettings = (pane: 'microphone' | 'screen') => {
        posthogAnalytics.trackEvent("audio_permission_settings_opened", { pane, platform: platformName() });
        openPane(pane);
    };

    const handleRepair = async () => {
        posthogAnalytics.trackEvent("audio_permission_repair_clicked", { platform: platformName() });
        await repair();
        await recheck();
    };

    const handleTestToggle = () => {
        posthogAnalytics.trackEvent("audio_tray_test_toggled", {
            action: testing ? 'stopped' : 'started',
            platform: platformName(),
        });
        if (testing) stopTest();
        else startTest();
    };

    const closePanel = () => {
        setExpanded(false);
        onClose?.();
    };

    // Green only when there is nothing to act on: a latched capture failure is
    // still a problem even though every permission is granted.
    const isHealthy = isAllGranted && !warning;

    return (
        // Fixed to the viewport (rather than laid out as a flex child) and given
        // the same z-[200] the header uses, so this stays visible as a footer
        // above every screen (Launcher / Settings / Dashboard) — not just while
        // whichever component happens to mount it is on screen.
        <div className={`fixed bottom-0 left-0 right-0 w-full h-12 border-t border-border-subtle ${isLight ? "bg-bg-secondary" : "bg-gray-900"} flex items-center px-4 z-[200]`}>
            <div className="flex items-center gap-4 relative">
                {/* Bottom-left System Tray style icons */}
                <button
                    onClick={() => {
                        const nextExpanded = !expanded;
                        if (!nextExpanded && onClose) onClose();
                        setExpanded(nextExpanded);

                        posthogAnalytics.trackEvent("audio_tray_clicked", {
                            action: nextExpanded ? "opened" : "closed",
                            platform: platformName(),
                            mic_granted: permissions.microphone,
                            screen_granted: permissions.screenCapture
                        });
                    }}
                    aria-expanded={expanded}
                    title={meetingLive ? 'Audio status — capturing' : 'Audio status'}
                    className={`flex items-center gap-3 px-2.5 py-1.5 rounded-lg hover:bg-bg-elevated border border-transparent transition-all`}
                >
                    {/* Icon + meter per channel: the icon still carries permission
                        state (red = blocked, exactly as before), the meter answers
                        the question permissions cannot — is audio flowing now. */}
                    <span className="flex items-center gap-2">
                        <Mic
                            size={18}
                            className={
                                !permissions.microphone
                                    ? "text-red-500"
                                    : mic.live
                                        ? toneText('mic', isLight)
                                        : "text-text-secondary"
                            }
                        />
                        <AudioLevelMeter compact level={micMeter} isLive={mic.live} tone="mic" isLight={isLight} />
                    </span>

                    <span className={`h-4 w-px ${isLight ? 'bg-black/10' : 'bg-white/10'}`} />

                    <span className="flex items-center gap-2">
                        <Volume2
                            size={18}
                            className={
                                !permissions.screenCapture
                                    ? "text-red-500"
                                    : system.live
                                        ? toneText('system', isLight)
                                        : "text-text-secondary"
                            }
                        />
                        <AudioLevelMeter compact level={systemMeter} isLive={system.live} tone="system" isLight={isLight} />
                    </span>

                    {warning && !meetingLive && (
                        <AlertTriangle size={14} className="text-amber-500" />
                    )}
                    {meetingLive && (
                        <span className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${isLight ? 'bg-emerald-500/10 text-emerald-600' : 'bg-emerald-500/15 text-emerald-400'}`}>
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
                        </span>
                    )}
                </button>

                {/*
                  Popup Panel (Windows style, popping UP from the bottom-left).

                  Portalled to document.body: as a child of the 48px tray bar it
                  inherited that bar's z-40, so every other launcher surface
                  (SettingsOverlay z-50, ManagerDashboard z-50/z-[60],
                  SalesBriefPanel z-[300], GlobalChatOverlay z-[355], and the
                  meeting detail ask bar z-50) painted on top of it. A blocked
                  meeting start force-opens this panel, so it has to win against
                  all of them — hence the portal plus a z above the highest.
                */}
                {createPortal(
                    <AnimatePresence>
                        {(expanded) && (
                            <motion.div
                                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                                className={`fixed bottom-16 left-4 z-[400] w-[340px] ${isLight ? "bg-bg-secondary" : "bg-gray-900"} border border-border-subtle rounded-xl shadow-2xl overflow-hidden flex flex-col`}
                            >
                                {/* Header */}
                                <div className={`flex items-center justify-between px-4 py-3 border-b border-border-subtle ${isLight ? "bg-bg-elevated" : "bg-gray-800"}`}>
                                    <div className="flex items-center gap-2 min-w-0">
                                        {isHealthy ? (
                                            <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
                                        ) : (
                                            <AlertTriangle size={16} className="text-amber-500 shrink-0" />
                                        )}
                                        <span className="text-sm font-semibold text-text-primary truncate">
                                            Audio Status
                                        </span>
                                        {meetingLive && (
                                            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-500">
                                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
                                            </span>
                                        )}
                                    </div>
                                    <button
                                        onClick={closePanel}
                                        aria-label="Close audio status"
                                        className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>

                                {/*
                                  Live capture failures and latched permission
                                  warnings. The hook has always exposed this; the
                                  tray used to drop it, so on Windows and Linux —
                                  where every permission reports granted — a dead
                                  capture had no visible explanation anywhere in
                                  the launcher.
                                */}
                                {warning && (
                                    <div className={`flex items-start gap-2 px-4 py-2.5 border-b border-border-subtle ${isLight ? 'bg-amber-100/70' : 'bg-amber-500/10'}`}>
                                        <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${isLight ? 'text-amber-700' : 'text-amber-400'}`} />
                                        <p className={`flex-1 text-[11px] leading-relaxed ${isLight ? 'text-amber-900' : 'text-amber-200'}`}>
                                            {warning.message}
                                        </p>
                                        <button
                                            onClick={dismiss}
                                            aria-label="Dismiss warning"
                                            className={`shrink-0 rounded p-0.5 transition-colors ${isLight ? 'text-amber-700 hover:bg-amber-200' : 'text-amber-400 hover:bg-amber-500/20'}`}
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                )}

                                {/* Content */}
                                <div className="p-4 space-y-3">
                                    {!isAllGranted && (
                                        <p className="text-xs text-text-secondary mb-3">
                                            GoDojo requires access to your microphone and system audio to analyze meetings.
                                        </p>
                                    )}

                                    {/* Microphone */}
                                    <AudioChannelCard
                                        icon={<Mic size={16} />}
                                        title="Microphone"
                                        isGranted={permissions.microphone}
                                        status={microphoneStatus}
                                        level={micMeter}
                                        isLive={mic.live}
                                        isTesting={testing}
                                        deviceName={mic.deviceName}
                                        deviceMissing={mic.deviceMissing}
                                        errorText={testError}
                                        tone="mic"
                                        isLight={isLight}
                                        onRequest={() => handleRequest('microphone')}
                                        onOpenSettings={() => openSettings('microphone')}
                                    />

                                    {/* System Audio — gated by Screen Recording on macOS,
                                    which is why it deep-links to a different pane. */}
                                    <AudioChannelCard
                                        icon={<Volume2 size={16} />}
                                        title="System Audio"
                                        isGranted={permissions.screenCapture}
                                        status={screenStatus}
                                        level={systemMeter}
                                        isLive={system.live}
                                        // A failed system half must not also claim
                                        // to be listening while its error shows.
                                        isTesting={testing && !systemError}
                                        deviceName={system.deviceName}
                                        deviceMissing={system.deviceMissing}
                                        errorText={systemError}
                                        tone="system"
                                        isLight={isLight}
                                        onRequest={() => handleRequest('screen')}
                                        onOpenSettings={() => openSettings('screen')}
                                    />
                                </div>

                                {/* Footer */}
                                <div className="px-4 py-3 border-t border-border-subtle bg-bg-secondary flex items-center justify-between gap-2">
                                    {/*
                                      macOS binds each grant to the binary's code signature. This
                                      build is ad-hoc signed, so an app update changes that
                                      signature and orphans the grant — System Settings still
                                      lists GoDojo AI as allowed while capture returns silence.
                                      Resetting the TCC entries is the only fix a user can apply
                                      themselves, so it has to be reachable from here.
                                    */}
                                    {isMac && !isAllGranted ? (
                                        <button
                                            onClick={handleRepair}
                                            disabled={repairing}
                                            title="Reset macOS permission entries for GoDojo AI, then quit and reopen to grant them again"
                                            className="px-3 py-2 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
                                        >
                                            <Wrench size={12} /> {repairing ? 'Resetting…' : 'Repair'}
                                        </button>
                                    ) : meetingLive ? (
                                        <span className="text-[11px] text-text-tertiary">
                                            Meters show the live meeting capture.
                                        </span>
                                    ) : <span />}

                                    <div className="flex items-center gap-2 shrink-0">
                                        {/*
                                          The probe is opt-in, and hidden during a meeting.
                                          startAudioTest is a main-process singleton shared with
                                          Settings → Audio, and it opens the microphone: starting
                                          it on panel open would both fight that window and record
                                          the user because they clicked a status icon.
                                        */}
                                        {!meetingLive && permissions.microphone && (
                                            <button
                                                onClick={handleTestToggle}
                                                title={testing ? 'Stop the audio check' : 'Open the mic and system audio briefly to check both meters'}
                                                className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${testing
                                                    ? 'border-transparent bg-red-500/10 text-red-500 hover:bg-red-500/20'
                                                    : 'border-border-muted text-text-secondary hover:text-text-primary hover:bg-bg-elevated'}`}
                                            >
                                                <Activity size={12} /> {testing ? 'Stop test' : 'Test audio'}
                                            </button>
                                        )}
                                        {!isAllGranted && (
                                            <button
                                                onClick={() => { void recheck(); }}
                                                className="px-4 py-2 rounded-lg text-xs font-medium bg-accent-primary text-white hover:brightness-110 transition-all shadow-sm"
                                            >
                                                Check Again
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>,
                    document.body
                )}
            </div>
        </div>
    );
};
