/**
 * InvitationResponseModal.tsx
 *
 * Shown to an invited user when they either:
 *   a) click the "invite" deep link (godojo://invite?token=... or the
 *      https universal link), or
 *   b) have a pending invitation on file (GET /invitations/me) — surfaced
 *      app-wide by TeamInviteNotification, and within the Roles & Management
 *      tab itself.
 *
 * They must Accept or Reject (or explicitly dismiss) before moving on.
 *
 * All submit state and API calls live in useInvitationResponseModal — this
 * component only renders. z-[80] so it sits above every in-app surface
 * (Settings, Dashboard, chat), matching its "any screen" role.
 */

import React from 'react';
import { motion } from 'framer-motion';
import { Users, X, Check, Clock, Loader2 } from 'lucide-react';
import { useInvitationResponseModal } from '@/hooks/useInvitationResponseModal';
import type { InvitationResponseModalProps } from '@/types';

const ROLE_COPY: Record<string, string> = {
    admin: 'Admin access',
    member: 'Team member',
};

const formatExpiry = (iso?: string): string | null => {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export const InvitationResponseModal: React.FC<InvitationResponseModalProps> = ({
    invitation,
    isLight,
    onAccepted,
    onDeclined,
    onDismiss,
}) => {
    const { isSubmitting, error, handleAccept, handleReject } = useInvitationResponseModal({
        invitation,
        onAccepted,
        onDeclined,
    });

    const teamInitial = (invitation.tenant_name?.trim()?.[0] ?? '?').toUpperCase();
    const expiry = formatExpiry(invitation.expires_at);

    return (
        <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onDismiss();
            }}
        >
            <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.22, ease: [0.19, 1, 0.22, 1] }}
                className={`w-full max-w-[420px] rounded-3xl border shadow-2xl overflow-hidden ${isLight
                    ? 'bg-white border-slate-200'
                    : 'bg-[#141820] border-white/10'
                    }`}
            >
                {/* Header band */}
                <div className={`px-6 pt-6 pb-5 ${isLight
                    ? 'bg-gradient-to-b from-blue-50 to-white'
                    : 'bg-gradient-to-b from-blue-500/[0.12] to-transparent'
                    }`}>
                    <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3.5">
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-sm ${isLight
                                ? 'bg-white border-slate-200 text-blue-600'
                                : 'bg-blue-500/15 border-blue-400/20 text-blue-400'
                                }`}>
                                <Users size={22} strokeWidth={2} />
                            </div>
                            <div>
                                <p className={`text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-blue-600' : 'text-blue-400'}`}>
                                    Team Invitation
                                </p>
                                <h3 className="text-[17px] font-bold text-text-primary leading-snug mt-0.5">
                                    Join your team on GoDojo
                                </h3>
                            </div>
                        </div>
                        <button
                            onClick={onDismiss}
                            aria-label="Dismiss"
                            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isLight
                                ? 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                                : 'text-white/40 hover:text-white/80 hover:bg-white/[0.06]'
                                }`}
                        >
                            <X size={15} />
                        </button>
                    </div>
                </div>

                <div className="px-6 pb-6 -mt-1">
                    {/* The team */}
                    <div className={`rounded-2xl border px-4 py-3.5 flex items-center gap-3.5 ${isLight
                        ? 'bg-slate-50 border-slate-200'
                        : 'bg-white/[0.03] border-white/[0.07]'
                        }`}>
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-[15px] font-bold shrink-0 ${isLight
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-blue-500/20 text-blue-300'
                            }`}>
                            {teamInitial}
                        </div>
                        <div className="min-w-0">
                            <p className="text-[15px] font-bold text-text-primary truncate">{invitation.tenant_name}</p>
                            <p className="text-xs text-text-secondary mt-0.5 truncate">
                                Invited by <span className="font-semibold text-text-primary">{invitation.invited_by_name || 'your team'}</span>
                            </p>
                        </div>
                        <span className={`ml-auto shrink-0 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full border ${isLight
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : 'bg-blue-500/10 text-blue-300 border-blue-400/20'
                            }`}>
                            {ROLE_COPY[invitation.role] ?? invitation.role}
                        </span>
                    </div>

                    <p className={`text-[13px] leading-relaxed mt-4 ${isLight ? 'text-slate-600' : 'text-white/60'}`}>
                        You'll get shared access to the team's call intelligence — meetings, coaching
                        insights and scorecards, based on your role.
                    </p>

                    {expiry && (
                        <p className={`flex items-center gap-1.5 text-xs mt-3 ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                            <Clock size={12} />
                            This invitation expires {expiry}
                        </p>
                    )}

                    {error && (
                        <div className={`mt-4 rounded-xl border px-3.5 py-2.5 text-xs ${isLight
                            ? 'bg-red-50 border-red-200 text-red-600'
                            : 'bg-red-500/10 border-red-400/20 text-red-300'
                            }`}>
                            {error}
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-3 mt-5">
                        <button
                            onClick={handleReject}
                            disabled={isSubmitting !== null}
                            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 border ${isLight
                                ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                                : 'border-white/10 text-white/70 hover:bg-white/[0.05] hover:text-white'
                                } ${isSubmitting !== null ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            {isSubmitting === 'reject'
                                ? <><Loader2 size={14} className="animate-spin" /> Declining…</>
                                : <>Not now</>}
                        </button>
                        <button
                            onClick={handleAccept}
                            disabled={isSubmitting !== null}
                            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-600/25 ${isSubmitting !== null
                                ? 'bg-blue-600/50 cursor-not-allowed text-white'
                                : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white'
                                }`}
                        >
                            {isSubmitting === 'accept'
                                ? <><Loader2 size={14} className="animate-spin" /> Joining…</>
                                : <><Check size={15} /> Accept invite</>}
                        </button>
                    </div>
                </div>
            </motion.div>
        </div>
    );
};
