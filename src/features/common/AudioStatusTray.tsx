import React, { useEffect, useState } from 'react';
import { Mic, Volume2, AlertTriangle, CheckCircle2, X, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useResolvedTheme } from '@/hooks';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';

interface PermissionState {
    microphone: boolean;
    systemAudio: boolean;
    screenCapture: boolean;
}

interface AudioStatusTrayProps {
    isVisible?: boolean;
    onClose?: () => void;
    onAllGranted?: () => void;
}

export const AudioStatusTray: React.FC<AudioStatusTrayProps> = ({ isVisible, onClose, onAllGranted }) => {
    const [permissions, setPermissions] = useState<PermissionState>({
        microphone: false,
        systemAudio: false,
        screenCapture: false
    });
    const [expanded, setExpanded] = useState(false);

    const isLight = useResolvedTheme() !== "dark";

    const checkStatus = async (isManualCheck = false) => {
        const status = await window.electronAPI.checkPermissions();
        setPermissions(status);

        if (status.microphone && status.systemAudio && status.screenCapture) {
            // ONLY auto-start the meeting if the user was actively blocked (expanded)
            // and they just manually checked or we were forcefully made visible.
            if (isManualCheck) {
                onAllGranted?.();
                setExpanded(false);
            } else if (expanded && !isManualCheck) {
                // If it was just background polling that caught it, don't auto-start
                // unless they explicitly click "Check Again". But we do close the popup.
                setExpanded(false);
            }
        }
    };

    useEffect(() => {
        checkStatus(false);
        const interval = setInterval(() => checkStatus(false), 5000); // Background polling
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (isVisible) {
            setExpanded(true);
            // We pass true here because if it's forced visible by clicking "Start GoDojo",
            // we want it to auto-proceed if permissions happen to already be granted 
            // (or if they grant them and it polls).
            checkStatus(true);
        }
    }, [isVisible]);

    const handleRequest = async (type: 'microphone' | 'screen') => {
        posthogAnalytics.trackEvent("audio_permission_requested", {
            type: type,
            platform: window.electronAPI?.getPlatform?.() || "unknown"
        });

        const granted = await window.electronAPI.requestPermission(type);

        posthogAnalytics.trackEvent("audio_permission_result", {
            type: type,
            granted: granted,
            platform: window.electronAPI?.getPlatform?.() || "unknown"
        });

        if (granted) checkStatus(true);
    };

    const openSettings = () => {
        posthogAnalytics.trackEvent("audio_permission_settings_opened", {
            platform: window.electronAPI?.getPlatform?.() || "unknown"
        });
        window.electronAPI.openPermissionSettings();
    };

    const isAllGranted = permissions.microphone && permissions.systemAudio && permissions.screenCapture;

    return (
        <div className={`shrink-0 w-full h-12 border-t border-border-subtle ${isLight ? "bg-bg-secondary" : "bg-gray-600/20"} flex items-center px-4 z-40 relative`}>
            <div className="flex items-center gap-4 relative">
                {/* Bottom-left System Tray style icons */}
                <button
                    onClick={async () => {
                        const nextExpanded = !expanded;
                        if (!nextExpanded && onClose) onClose();
                        setExpanded(nextExpanded);

                        const platform = await window.electronAPI?.getPlatform?.() || "unknown";
                        posthogAnalytics.trackEvent("audio_tray_clicked", {
                            action: nextExpanded ? "opened" : "closed",
                            platform: platform,
                            mic_granted: permissions.microphone,
                            screen_granted: permissions.screenCapture
                        });
                    }}
                    className={`flex items-center gap-3 px-2.5 py-1.5 rounded-lg hover:bg-bg-elevated border border-transparent transition-all`}
                >
                    <Mic size={18} className={permissions.microphone ? "text-text-secondary" : "text-red-500"} />
                    <Volume2 size={18} className={permissions.screenCapture ? "text-text-secondary" : "text-red-500"} />
                </button>

                {/* Popup Panel (Windows style, popping UP from the bottom-left) */}
                <AnimatePresence>
                    {(expanded) && (
                        <motion.div
                            initial={{ opacity: 0, y: 10, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 10, scale: 0.95 }}
                            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                            className={`absolute bottom-14 left-0 w-[340px] ${isLight ? "bg-bg-secondary" : "bg-gray-900"} border border-border-subtle rounded-xl shadow-2xl overflow-hidden flex flex-col`}
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
                                    onOpenSettings={openSettings}
                                />

                                {/* System Audio Row */}
                                <PermissionRow
                                    icon={<Volume2 size={16} />}
                                    title="System Audio"
                                    isGranted={permissions.screenCapture}
                                    onRequest={() => handleRequest('screen')}
                                    onOpenSettings={openSettings}
                                />
                            </div>

                            {/* Footer */}
                            {!isAllGranted && (
                                <div className="px-4 py-3 border-t border-border-subtle bg-bg-secondary flex justify-end">
                                    <button
                                        onClick={() => checkStatus(true)}
                                        className="px-4 py-2 rounded-lg text-xs font-medium bg-accent-primary text-white hover:bg-accent-hover transition-colors shadow-sm"
                                    >
                                        Check Again
                                    </button>
                                </div>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};

const PermissionRow = ({ icon, title, isGranted, onRequest, onOpenSettings }: any) => {
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
