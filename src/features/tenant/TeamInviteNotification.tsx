/**
 * TeamInviteNotification.tsx
 *
 * App-root level invitation popup — mounted in App.tsx's authenticated
 * launcher tree (alongside GhostGlowOverlay / AudioStatusTray), so it surfaces
 * over EVERY launcher screen: My Meetings, meeting details, Settings,
 * Dashboard, global chat. It replaces "only visible when you open Roles &
 * Permissions" with a watcher that polls GET /invitations/me (see
 * useTeamInvitationWatcher).
 *
 * Deliberately NOT mounted in the live-call overlay window: interrupting an
 * in-progress sales call with a team prompt is worse than a short delay — the
 * watcher keeps polling while the overlay is up, so the popup is already
 * there the moment the user returns to the launcher.
 *
 * Accept mirrors what the Roles & Permissions tab does after accepting
 * (resolve the new tenant → setCurrentTenantId → full reload so every
 * tenant-scoped surface re-derives cleanly); decline/dismiss just silences
 * this invitation for the session.
 */

import React from "react";
import { InvitationResponseModal } from "@/features/settings";
import { useResolvedTheme, useTeamInvitationWatcher } from "@/hooks";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";
import { markSkipSplashOnNextLoad } from "@/lib/splash";
import type { InvitationAcceptResult } from "@/types";

interface TeamInviteNotificationProps {
    authUser: { uid?: string | null; email?: string | null; displayName?: string | null } | null;
    /** True while an invite DEEP LINK (godojo://invite?token=…) is driving the
     *  flow — the Roles & Permissions tab already shows the response modal for
     *  that token, so the global popup stands down instead of stacking twice. */
    suppressed?: boolean;
    /** True once the signed-in user is the tenant owner (e.g. right after
     *  creating their own team). An admin can't be the target of a pending
     *  invitation, so the watcher stops polling GET /invitations/me. */
    isAdmin?: boolean;
}

export const TeamInviteNotification: React.FC<TeamInviteNotificationProps> = ({ authUser, suppressed = false, isAdmin = false }) => {
    const { invitation, dismiss } = useTeamInvitationWatcher(authUser, isAdmin);
    const isLight = useResolvedTheme() === "light";

    if (!invitation || suppressed) return null;

    const handleAccepted = async (result: InvitationAcceptResult) => {
        posthogAnalytics.trackAcceptInvite();
        try {
            await window.electronAPI?.setCurrentTenantId?.(result.tenant_id ?? null);
        } catch { /* reload below re-resolves tenant state regardless */ }
        // Same full-reload the tab performs after accepting: team membership
        // changes what half the app renders (dashboards, company context,
        // roles), and a reload is the only guaranteed-consistent path.
        //
        // This reload is NOT a hard refresh from the user's point of view —
        // tell the next page load to skip the full startup splash and show
        // the plain <BirdLoader /> ("draw" loader) instead (see lib/splash.ts),
        // matching the same accept flow in Roles & Permissions.
        markSkipSplashOnNextLoad('Joining team…');
        window.location.reload();
    };

    return (
        <InvitationResponseModal
            invitation={invitation}
            isLight={isLight}
            onAccepted={handleAccepted}
            onDeclined={() => dismiss(invitation.token)}
            onDismiss={() => dismiss(invitation.token)}
        />
    );
};