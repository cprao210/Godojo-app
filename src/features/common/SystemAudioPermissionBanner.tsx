import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, ExternalLink, Wrench, X } from 'lucide-react';
import { useSystemAudioPermission } from '@/hooks';
import type { SystemAudioPermissionBannerProps } from '@/types';

/**
 * In-meeting warning that interviewer audio is not being captured.
 *
 * The meeting overlay is the one surface where this matters most and previously
 * had nothing: a denied Screen Recording grant produced a silently mic-only
 * meeting, and the only hint was a transient system message in the chat log.
 *
 * Deliberately non-blocking. A mic-only meeting is still worth having, so this
 * informs and offers a fix rather than interrupting the call.
 */
export const SystemAudioPermissionBanner: React.FC<SystemAudioPermissionBannerProps> = ({ className }) => {
    const { warning, repairing, isMac, dismiss, openPane, repair } = useSystemAudioPermission();

    if (!warning) return null;

    const isPermissionDenial = warning.kind === 'screen-recording-permission';

    // Which pane to offer depends on the failing channel, not on the platform:
    // a mic zero-fill and a screen-recording denial need different panes, and
    // sending someone to the wrong one costs them the whole search.
    const wantsMicPane = warning.kind === 'audio-capture-failure' && warning.channel === 'mic';
    const pane: 'microphone' | 'screen' = wantsMicPane ? 'microphone' : 'screen';

    const title = isPermissionDenial ? 'Screen Recording permission denied' : 'Audio capture issue';

    return (
        <AnimatePresence  >
            <motion.div
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                className={`w-full px-3 pt-2 no-drag ${className ?? ''}`}
          
            >
                <div className="rounded-xl border border-amber-500/30 bg-[#1a1408] shadow-xl px-3.5 py-3 flex items-start gap-3 relative group/warning"
                      style={{ zIndex: 12 }} 
                >
                    <div className="w-8 h-8 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0 mt-0.5">
                        <AlertTriangle size={16} className="text-amber-400" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-text-primary">{title}</p>
                        <p className="text-xs text-text-secondary mt-0.5 leading-snug">
                            {warning.message}
                        </p>

                        <div className="flex items-center gap-2 mt-2.5">
                            {isMac && (
                                <button
                                    onClick={() => openPane(pane)}
                                    title={wantsMicPane
                                        ? 'Open macOS Microphone privacy settings'
                                        : 'Open macOS Screen Recording privacy settings'}
                                    className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 text-[11px] font-semibold transition-all active:scale-95 border border-amber-500/20 flex items-center gap-1.5"
                                >
                                    <ExternalLink size={12} />
                                    {wantsMicPane ? 'Open Mic Settings' : 'Open Screen Settings'}
                                </button>
                            )}

                            {/*
                              macOS ties a grant to the binary's code signature, and this build
                              is ad-hoc signed — so an update changes the signature and orphans
                              the grant while System Settings still shows the app as allowed.
                              Resetting the TCC entries is the only self-service fix.
                            */}
                            {isMac && (
                                <button
                                    onClick={() => { void repair(); }}
                                    disabled={repairing}
                                    title="Reset macOS permission entries for GoDojo AI (you will grant them again after relaunch)"
                                    className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400/90 text-[11px] font-medium transition-all active:scale-95 border border-amber-500/15 flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    <Wrench size={12} />
                                    {repairing ? 'Resetting…' : 'Repair Permissions'}
                                </button>
                            )}
                        </div>
                    </div>

                    <button
                        onClick={dismiss}
                        aria-label="Dismiss"
                        className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-colors shrink-0 absolute top-1.5 right-1.5 opacity-0 group-hover/warning:opacity-100"
                    >
                        <X size={13} />
                    </button>
                </div>
            </motion.div>
        </AnimatePresence>
    );
};
