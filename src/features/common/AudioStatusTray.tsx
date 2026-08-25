import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, Volume2, AlertTriangle, CheckCircle2, X, ExternalLink, Wrench } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useResolvedTheme, useSystemAudioPermission } from '@/hooks';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import type { AudioStatusTrayProps, PermissionRowProps } from '@/types';

/** Marks that the first-run prompt has been shown, so it only opens once. */
const FIRST_RUN_KEY = 'godojo_perms_shown_v1';

export const AudioStatusTray: React.FC<AudioStatusTrayProps> = ({ isVisible, onClose, onAllGranted }) => {
    const {
        permissions,
        allGranted: isAllGranted,
        checked,
        repairing,
        isMac,
        recheck,
        openPane,
        request,
        repair,
    } = useSystemAudioPermission();
    const [expanded, setExpanded] = useState(false);

    const isLight = useResolvedTheme() === 'light';

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

    return (
        <div className={`shrink-0 w-full h-12 border-t border-border-subtle ${isLight ? "bg-bg-secondary" : "bg-gray-600/20"} flex items-center px-4 z-40 relative`}>
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
                    className={`flex items-center gap-3 px-2.5 py-1.5 rounded-lg hover:bg-bg-elevated border border-transparent transition-all`}
                >
                    <Mic size={18} className={permissions.microphone ? "text-text-secondary" : "text-red-500"} />
                    <Volume2 size={18} className={permissions.screenCapture ? "text-text-secondary" : "text-red-500"} />
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
                                    <div className="flex items-center gap-2">
                                        {isAllGranted ? (
                                            <CheckCircle2 size={16} className="text-emerald-500" />
                                        ) : (
                                            <AlertTriangle size={16} className="text-amber-500" />
                                        )}
                                        <span className="text-sm font-semibold text-text-primary">
                                            Audio Permissions
                                        </span>
                                    </div>
                                    <button
                                        onClick={() => {
                                            setExpanded(false);
                                            onClose?.();
                                        }}
                                        className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>

                                {/* Content */}
                                <div className="p-4 space-y-3">
                                    {!isAllGranted && (
                                        <p className="text-xs text-text-secondary mb-3">
                                            GoDojo requires access to your microphone and system audio to analyze meetings.
                                        </p>
                                    )}

                                    {/* Microphone Row */}
                                    <PermissionRow
                                        icon={<Mic size={16} />}
                                        title="Microphone"
                                        isGranted={permissions.microphone}
                                        onRequest={() => handleRequest('microphone')}
                                        onOpenSettings={() => openSettings('microphone')}
                                    />

                                    {/* System Audio Row — gated by Screen Recording on macOS,
                                    which is why it deep-links to a different pane. */}
                                    <PermissionRow
                                        icon={<Volume2 size={16} />}
                                        title="System Audio"
                                        isGranted={permissions.screenCapture}
                                        onRequest={() => handleRequest('screen')}
                                        onOpenSettings={() => openSettings('screen')}
                                    />
                                </div>

                                {/* Footer */}
                                {!isAllGranted && (
                                    <div className="px-4 py-3 border-t border-border-subtle bg-bg-secondary flex items-center justify-between gap-2">
                                        {/*
                                      macOS binds each grant to the binary's code signature. This
                                      build is ad-hoc signed, so an app update changes that
                                      signature and orphans the grant — System Settings still
                                      lists GoDojo AI as allowed while capture returns silence.
                                      Resetting the TCC entries is the only fix a user can apply
                                      themselves, so it has to be reachable from here.
                                    */}
                                        {isMac ? (
                                            <button
                                                onClick={handleRepair}
                                                disabled={repairing}
                                                title="Reset macOS permission entries for GoDojo AI, then quit and reopen to grant them again"
                                                className="px-3 py-2 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
                                            >
                                                <Wrench size={12} /> {repairing ? 'Resetting…' : 'Repair'}
                                            </button>
                                        ) : <span />}
                                        <button
                                            onClick={() => { void recheck(); }}
                                            className="px-4 py-2 rounded-lg text-xs font-medium bg-accent-primary text-white hover:bg-accent-hover transition-colors shadow-sm"
                                        >
                                            Check Again
                                        </button>
                                    </div>
                                )}
                            </motion.div>
                        )}
                    </AnimatePresence>,
                    document.body
                )}
            </div>
        </div>
    );
};

const PermissionRow: React.FC<PermissionRowProps> = ({ icon, title, isGranted, onRequest, onOpenSettings }) => {
    return (
        <div className={`flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-bg-elevated shadow-sm`}>
            <div className="flex items-center gap-3">
                <div className={`p-2 rounded-md ${isGranted ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
                    {icon}
                </div>
                <h3 className="text-sm font-medium text-text-primary">{title}</h3>
            </div>

            {isGranted ? (
                <div className="text-xs font-medium text-emerald-500 flex items-center gap-1.5 bg-emerald-500/10 px-2 py-1 rounded-md">
                    <CheckCircle2 size={14} /> Allowed
                </div>
            ) : (
                <div className="flex items-center gap-2">
                    <button
                        onClick={onOpenSettings}
                        className="text-[11px] font-medium text-text-secondary hover:text-text-primary flex items-center gap-1 transition-colors"
                    >
                        <ExternalLink size={12} /> Settings
                    </button>
                    <button
                        onClick={onRequest}
                        className="px-3 py-1.5 bg-red-500 text-white text-xs font-medium rounded-md hover:bg-red-600 transition-colors shadow-sm"
                    >
                        Allow
                    </button>
                </div>
            )}
        </div>
    );
};
