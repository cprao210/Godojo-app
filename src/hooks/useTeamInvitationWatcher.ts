// useTeamInvitationWatcher.ts
// Background watcher for team invitations addressed to the signed-in user.
//
// The invited person previously only learned about a pending invitation when
// they manually opened Settings → Roles & Permissions — that tab calls
// GET /invitations/me on mount. This hook calls the SAME endpoint from the app
// root so the invite popup can surface wherever the user currently is, within
// one poll tick, without them navigating anywhere.
//
// Cadence follows the established calendar-invitations pattern
// (useCalendarInvitations.ts): immediate check once auth resolves, then a
// slow interval (a team invite is not a message — 30s freshness is plenty
// and cheap: one lightweight GET), refreshed on window focus / visibility so
// returning to GoDojo after an invite lands shows it right away.
//
// Dismissals (close without deciding) are remembered per invitation TOKEN for
// the session so the popup doesn't nag on the next tick; a genuinely NEW
// invitation has a new token and therefore re-surfaces immediately. Accepting
// or declining deletes it from the server's pending list, so it never returns
// either way.

import { useCallback, useEffect, useRef, useState } from "react";
import { tenantsApi } from "@/api";
import type { MyPendingInvitation } from "@/types";

const INVITATION_POLL_MS = 30_000;

interface WatcherUser {
    uid?: string | null;
    email?: string | null;
    displayName?: string | null;
}

export function useTeamInvitationWatcher(authUser: WatcherUser | null) {
    const [invitation, setInvitation] = useState<MyPendingInvitation | null>(null);
    const dismissedTokensRef = useRef<Set<string>>(new Set());
    const inFlightRef = useRef(false);

    // Primitive identity key — the authUser object is recreated on renders;
    // polling should restart only on an actual account change.
    const userKey = authUser ? `${authUser.uid ?? ""}|${authUser.email ?? ""}` : null;

    const check = useCallback(async () => {
        if (!userKey || inFlightRef.current) return;
        inFlightRef.current = true;
        try {
            const list = await tenantsApi.listMyInvitations().catch(() => [] as MyPendingInvitation[]);
            const fresh = (list ?? []).find(inv => inv?.token && !dismissedTokensRef.current.has(inv.token)) ?? null;
            // Preserve object identity when the same invitation is simply
            // re-seen, so consumers don't re-animate the popup every tick.
            setInvitation(prev => (prev && fresh && prev.token === fresh.token ? prev : fresh));
        } finally {
            inFlightRef.current = false;
        }
    }, [userKey]);

    useEffect(() => {
        if (!userKey) {
            setInvitation(null);
            return;
        }
        void check();
        const id = setInterval(() => { void check(); }, INVITATION_POLL_MS);
        const onVisible = () => {
            if (document.visibilityState === "visible") void check();
        };
        const onFocus = () => { void check(); };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onFocus);
        return () => {
            clearInterval(id);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("focus", onFocus);
        };
    }, [userKey, check]);

    /** Silence this invitation for the rest of the session (close without deciding). */
    const dismiss = useCallback((token: string) => {
        dismissedTokensRef.current.add(token);
        setInvitation(null);
    }, []);

    return { invitation, dismiss };
}
