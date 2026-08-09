// Data + interaction layer for UserRolesPermissionsTab (the "Roles &
// Management" settings tab). Owns tenant resolution (existing team vs.
// pending invitation vs. empty "Create Team" state), the deep-link invite
// preview flow, and the tenant-owner check. Kept separate from the
// component so the component only owns rendering — same split as
// useUserProfileTab / useScoringCriteriaTab.

import { useEffect, useState } from "react";
import { tenantsApi } from "@/api";
import { ApiError } from "@/lib/apiClient";
import { getFirebaseAuth } from "@/lib/firebase";
import { InvitationAcceptResult, MyPendingInvitation, Tenant } from "@/types";

/**
 * A tenant "owner" is whoever created it (tenant.owner_id). Anyone else who
 * can see the tenant (i.e. an accepted invitee) is read-only in this tab:
 * they can view the roster but can't invite, edit, resend, or remove.
 *
 * NOTE: this is a UX affordance only. The backend must independently reject
 * POST /tenants/:id/invitations, PATCH .../members/:id, etc. for non-owners
 * — do not treat this flag as the security boundary.
 */
export function useIsTenantOwner(tenant: Tenant | null): boolean {
    const [uid, setUid] = useState<string | null>(() => getFirebaseAuth().currentUser?.uid ?? null);

    useEffect(() => {
        // currentUser can still be null on first mount (auth not yet
        // hydrated); subscribe so we pick it up once it resolves.
        const unsubscribe = getFirebaseAuth().onAuthStateChanged((user) => {
            setUid(user?.uid ?? null);
        });
        return unsubscribe;
    }, []);

    if (!tenant || !uid) return false;
    return tenant.owner_id === uid;
}

interface UseUserRolesPermissionsTabParams {
    deepLinkInviteToken?: string | null;
    onDeepLinkTokenConsumed?: () => void;
}

export function useUserRolesPermissionsTab({ deepLinkInviteToken = null, onDeepLinkTokenConsumed }: UseUserRolesPermissionsTabParams) {
    const [isCreateTeamOpen, setIsCreateTeamOpen] = useState(false);
    const [tenant, setTenant] = useState<Tenant | null>(null);
    const [isLoadingTenant, setIsLoadingTenant] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [pendingInvitation, setPendingInvitation] = useState<MyPendingInvitation | null>(null);
    const [declinedNotice, setDeclinedNotice] = useState(false);
    const isOwner = useIsTenantOwner(tenant);

    // Restore the user's existing tenant (if any) across reloads instead of
    // always starting from the "Create Team" empty state.
    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                // 1. If we arrived via the invite deep link, preview that
                //    specific invitation first — this is the fast path and
                //    doesn't depend on GET /tenants/me at all.
                if (deepLinkInviteToken) {
                    try {
                        const preview = await tenantsApi.previewInvitation(deepLinkInviteToken);
                        if (cancelled) return;
                        setPendingInvitation({
                            token: deepLinkInviteToken,
                            tenant_id: '', // not known until accepted; not needed for the prompt
                            tenant_name: preview.tenant_name,
                            role: preview.role,
                            invited_by_name: preview.invited_by_name,
                            expires_at: preview.expires_at,
                        });
                    } catch (err) {
                        // token invalid/expired — fall through to the normal checks below
                        console.warn('[useUserRolesPermissionsTab] previewInvitation failed:', err);
                    }
                }

                // 2. Fallback / normal path: any pending invitation already on
                //    file for this user's email (covers manual tab navigation,
                //    no token in hand).
                if (!cancelled && !deepLinkInviteToken) {
                    const myInvitations = await tenantsApi.listMyInvitations().catch(() => []);
                    if (!cancelled && myInvitations.length > 0) {
                        setPendingInvitation(myInvitations[0]);
                    }
                }

                // 3. Existing tenant membership (owner's own team, or a team
                //    the user already accepted previously).
                const tenants = await tenantsApi.listMine();
                if (cancelled) return;
                setTenant(tenants[0] ?? null);
            } catch (err) {
                if (!cancelled) {
                    setLoadError(err instanceof ApiError ? err.message : 'Failed to load your team.');
                }
            } finally {
                if (!cancelled) setIsLoadingTenant(false);
            }
        }

        load();
        return () => { cancelled = true; };
    }, [deepLinkInviteToken]);

    const hasTeam = tenant != null && typeof tenant.id === 'string';

    const handleCreateTeam = async (teamName: string) => {
        const created = await tenantsApi.create(teamName);
        setTenant(created);
        setIsCreateTeamOpen(false);
    };

    const handleInvitationAccepted = async (_result: InvitationAcceptResult) => {
        setPendingInvitation(null);
        onDeepLinkTokenConsumed?.();

        try {
            const tenants = await tenantsApi.listMine();
            const resolvedTenant = tenants[0] ?? null;
            setTenant(resolvedTenant);
            await window.electronAPI?.setCurrentTenantId?.(resolvedTenant?.id ?? null);
        } catch (err) {
            setLoadError(err instanceof ApiError ? err.message : 'Failed to load your team.');
        }
    };

    const handleInvitationDeclined = () => {
        setPendingInvitation(null);
        setDeclinedNotice(true);
        onDeepLinkTokenConsumed?.();
    };

    return {
        isCreateTeamOpen,
        setIsCreateTeamOpen,
        tenant,
        isLoadingTenant,
        loadError,
        pendingInvitation,
        setPendingInvitation,
        declinedNotice,
        isOwner,
        hasTeam,
        handleCreateTeam,
        handleInvitationAccepted,
        handleInvitationDeclined,
    };
}