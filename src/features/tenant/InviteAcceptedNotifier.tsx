/**
 * InviteAcceptedNotifier.tsx
 *
 * Fires when someone accepts a team invitation the admin/owner sent:
 *   1. In-app toast — themed, bottom-right, same host pattern as
 *      AuthToastHost, visible on whatever launcher screen the admin is on.
 *   2. Native cross-screen toast — the SAME showNotificationOnActiveDisplay
 *      pipeline behind meeting pause/resume and "Summary Ready", so the
 *      admin also learns about the join while the app is hidden or they're
 *      inside another application.
 *
 * Gated to tenant owners/admins — everyone else gets a 403 from the
 * invitations endpoint anyway; skipping them avoids a pointless poll per
 * tick. Mount once at the App launcher root (see App.tsx).
 */

import React, { useCallback, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { UserPlus } from 'lucide-react';
import { useInviteAcceptedWatcher, useIsTenantOwner, useResolvedTheme } from '@/hooks';
import type { Invitation, Tenant } from '@/types';

const AUTO_DISMISS_MS = 5000;

interface InviteAcceptedNotifierProps {
    tenant: Tenant | null;
    /** True when the signed-in user's role in the tenant is admin. */
    isAdmin: boolean;
}

export const InviteAcceptedNotifier: React.FC<InviteAcceptedNotifierProps> = ({ tenant, isAdmin }) => {
    const isLight = useResolvedTheme() === 'light';
    const isOwner = useIsTenantOwner(tenant);
    const [toast, setToast] = useState<{ id: string; message: string } | null>(null);

    const handleAccepted = useCallback((invitation: Invitation) => {
        const message = `${invitation.email} accepted your team invitation and joined ${tenant?.name ?? 'your team'}.`;
        // Background notification — display-aware native toast, works even
        // while the app is hidden (AppState.showAppNotification via IPC).
        window.electronAPI?.showAppNotification?.('Invitation Accepted', message).catch(() => { });
        // In-app toast (latest wins, like AuthToastHost).
        setToast({ id: `${invitation.id}-${Date.now()}`, message });
    }, [tenant?.name]);

    useInviteAcceptedWatcher(tenant?.id ?? null, isAdmin || isOwner, handleAccepted);

    // Auto-dismiss the in-app toast.
    React.useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), AUTO_DISMISS_MS);
        return () => clearTimeout(timer);
    }, [toast]);

    return (
        <AnimatePresence>
            {toast && (
                <motion.div
                    key={toast.id}
                    initial={{ x: 60, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: 40, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                    className={`fixed bottom-6 right-6 z-[610] flex items-center gap-2.5 pl-3.5 pr-4 py-2.5 rounded-2xl backdrop-blur-xl saturate-[180%] max-w-[340px] shadow-[0_30px_70px_-20px_rgba(0,0,0,0.6)] ${isLight
                        ? 'bg-white/90 border border-slate-200'
                        : 'bg-bg-card/85 border border-border-subtle ring-1 ring-black/10'
                        }`}
                    role="status"
                    aria-live="polite"
                >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                        <UserPlus size={14} />
                    </div>
                    <div className="min-w-0">
                        <p className={`text-[11px] font-bold uppercase tracking-wide ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`}>
                            Invitation accepted
                        </p>
                        <span className="text-[13px] font-medium text-text-primary leading-snug block truncate">
                            {toast.message}
                        </span>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
