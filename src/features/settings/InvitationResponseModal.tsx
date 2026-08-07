/**
 * InvitationResponseModal.tsx
 *
 * Shown to an invited user when they either:
 *   a) click the "invite" deep link (godojo://invite?token=... or the
 *      https universal link), or
 *   b) open Settings → Roles & Management manually while they have a
 *      pending invitation on file (GET /invitations/me).
 *
 * They must Accept or Reject before seeing the team's member list.
 *
 * All submit state and API calls now live in useInvitationResponseModal —
 * this component only renders.
 */

import React from 'react';
import { Users, X, Check } from 'lucide-react';
import { useInvitationResponseModal } from '@/hooks/useInvitationResponseModal';
import type { InvitationResponseModalProps } from '@/types';

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

    return (
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onDismiss();
            }}
        >
            <div
                className={`w-full max-w-md rounded-2xl border shadow-xl p-6 ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'
                    }`}
            >
                <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div
                            className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
                            style={{ background: isLight ? 'rgba(59,130,246,0.08)' : 'rgba(59,130,246,0.10)' }}
                        >
                            <Users size={20} className="text-blue-400" />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-text-primary">Team Invitation</h3>
                            <p className="text-xs text-text-secondary mt-0.5">
                                You've been invited to join a team
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onDismiss}
                        aria-label="Dismiss"
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-item-active/60 transition-colors"
                    >
                        <X size={15} />
                    </button>
                </div>

                <div className={`rounded-xl border px-4 py-3 mb-4 ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-bg-item-surface border-border-subtle'}`}>
                    <p className="text-sm text-text-primary font-semibold mb-1">{invitation.tenant_name}</p>
                    <p className="text-xs text-text-secondary">
                        Invited by {invitation.invited_by_name} &middot; Role:{' '}
                        <span className="capitalize font-medium text-text-primary">{invitation.role}</span>
                    </p>
                </div>

                {error && (
                    <p className="text-xs text-red-400 mb-3">{error}</p>
                )}

                <div className="flex items-center gap-3">
                    <button
                        onClick={handleReject}
                        disabled={isSubmitting !== null}
                        className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${isSubmitting !== null
                            ? 'opacity-50 cursor-not-allowed'
                            : 'text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50'
                            } border ${isLight ? 'border-slate-200' : 'border-border-subtle'}`}
                    >
                        <X size={15} />
                        {isSubmitting === 'reject' ? 'Rejecting…' : 'Reject'}
                    </button>
                    <button
                        onClick={handleAccept}
                        disabled={isSubmitting !== null}
                        className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${isSubmitting !== null
                            ? 'bg-blue-600/50 cursor-not-allowed text-white'
                            : 'bg-blue-600 hover:bg-blue-500 text-white'
                            }`}
                    >
                        <Check size={15} />
                        {isSubmitting === 'accept' ? 'Accepting…' : 'Accept'}
                    </button>
                </div>
            </div>
        </div>
    );
};