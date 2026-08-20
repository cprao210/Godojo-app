import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { tenantsApi } from "../api/tenantsApi";
import { signOut as fbSignOut } from "../lib/firebase";
import { TeamInviteState } from "@/types";

/**
 * Handles the `godojo://invite?token=...` deep link flow: the main process
 * relays the token via `onInviteDeepLink`, and this hook resolves it against
 * whoever is currently signed in.
 *
 * If the invite was sent to a different email than the signed-in account,
 * this forces a sign-out instead of showing the Accept/Reject prompt to the
 * wrong person — it re-runs once the right account signs in (or does
 * nothing if no one is signed in yet).
 *
 * On a successful match, it opens Settings to the "user-roles-permissions"
 * tab via the callbacks passed in — that state lives in App.tsx since
 * Settings' initial tab is also driven by the Launcher's own "Open Settings"
 * action.
 */
export function useTeamInvite(
    authUser: User | null,
    openInviteSettingsTab: () => void
): TeamInviteState {
    const [deepLinkInviteToken, setDeepLinkInviteToken] = useState<string | null>(null);
    const [inviteMismatchEmail, setInviteMismatchEmail] = useState<string | null>(null);

    // Stash the token as soon as main relays it. The actual account check +
    // routing to Settings happens in the resolver effect below, since it
    // needs to react to authUser changes too (e.g. after a forced sign-out).
    useEffect(() => {
        if (!window.electronAPI?.onInviteDeepLink) return;
        const unsub = window.electronAPI.onInviteDeepLink(({ token }) => {
            setDeepLinkInviteToken(token);
        });
        return () => unsub?.();
    }, []);

    useEffect(() => {
        const token = deepLinkInviteToken;
        if (!token || !authUser) return;

        let cancelled = false;
        (async () => {
            try {
                const preview = await tenantsApi.previewInvitation(token);
                if (cancelled) return;

                const invitedEmail = preview.email?.toLowerCase();
                const currentEmail = authUser.email?.toLowerCase();

                if (invitedEmail && currentEmail && invitedEmail !== currentEmail) {
                    setInviteMismatchEmail(preview.email);
                    await fbSignOut().catch(() => { });
                    return;
                }

                setInviteMismatchEmail(null);
                openInviteSettingsTab();
            } catch (err) {
                if (cancelled) return;
                console.warn("[useTeamInvite] Failed to preview invitation for account check:", err);
                openInviteSettingsTab();
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [deepLinkInviteToken, authUser]);

    return {
        deepLinkInviteToken,
        clearDeepLinkInviteToken: () => setDeepLinkInviteToken(null),
        inviteMismatchEmail,
        dismissInviteMismatch: () => setInviteMismatchEmail(null),
    };
}