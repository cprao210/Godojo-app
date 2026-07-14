import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UserX, X } from 'lucide-react';

interface InviteAccountMismatchBannerProps {
    invitedEmail: string;
    onDismiss: () => void;
}

/**
 * Shown right after we've force-signed-out a mismatched account for an
 * invite deep link, so the person understands *why* they were logged out
 * instead of it feeling like a random session drop.
 */
export const InviteAccountMismatchBanner: React.FC<InviteAccountMismatchBannerProps> = ({
    invitedEmail,
    onDismiss,
}) => {
    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] w-full max-w-md px-4"
            >
                <div className="rounded-xl border border-amber-500/30 bg-[#1a1408] shadow-xl px-4 py-3 flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0 mt-0.5">
                        <UserX size={16} className="text-amber-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-text-primary">Signed out for this invitation</p>
                        <p className="text-xs text-text-secondary mt-0.5">
                            This invite was sent to <strong className="text-text-primary">{invitedEmail}</strong>.
                            Sign in with that email to accept or reject it.
                        </p>
                    </div>
                    <button
                        onClick={onDismiss}
                        aria-label="Dismiss"
                        className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-colors shrink-0"
                    >
                        <X size={13} />
                    </button>
                </div>
            </motion.div>
        </AnimatePresence>
    );
};