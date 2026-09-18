// useInviteAcceptedWatcher.ts
//
// Watches the tenant's invitation list for pending → accepted transitions so
// the inviter (tenant owner/admin) learns about new members the moment they
// accept, instead of only when they next open Roles & Permissions.
//
// Why polling: the invitation is accepted by the INVITEE's device straight
// against the FastAPI backend; there is no push channel between backends and
// the admin's app, so the admin client diffs GET /tenants/:id/invitations on
// the same 30s cadence the invitee-side watcher uses. One lightweight list
// read per tick, no new endpoints.
//
// The first successful poll SEEDS the snapshot without notifying — otherwise
// every pre-existing accepted invitation would toast the admin on every app
// launch. Only flips observed between two polls are reported.

import { useCallback, useEffect, useRef } from "react";
import { tenantsApi } from "@/api";
import type { Invitation } from "@/types";

const INVITATIONS_POLL_MS = 30_000;

export interface AcceptedDiff {
    /** Invitations that flipped to (or newly appeared as) accepted. */
    newlyAccepted: Invitation[];
    /** Snapshot to store for the next tick. */
    snapshot: Map<string, string>;
}

/**
 * Pure diff against the previous snapshot (null = first poll → seed only).
 * Exported for unit testing without React/renderer deps.
 */
export function diffAcceptedInvitations(prev: Map<string, string> | null, list: Invitation[]): AcceptedDiff {
    const snapshot = new Map<string, string>();
    const newlyAccepted: Invitation[] = [];
    for (const inv of list ?? []) {
        if (!inv?.id) continue;
        snapshot.set(inv.id, inv.status);
        if (inv.status === 'accepted' && prev !== null && prev.get(inv.id) !== 'accepted') {
            newlyAccepted.push(inv);
        }
    }
    return { newlyAccepted, snapshot };
}

export function useInviteAcceptedWatcher(
    tenantId: string | null,
    enabled: boolean,
    onAccepted: (invitation: Invitation) => void
): void {
    const snapshotRef = useRef<Map<string, string> | null>(null);
    const inFlightRef = useRef(false);
    const onAcceptedRef = useRef(onAccepted);
    onAcceptedRef.current = onAccepted;

    // Switching tenants (or losing one) invalidates the baseline — re-seed.
    useEffect(() => {
        snapshotRef.current = null;
    }, [tenantId]);

    const check = useCallback(async () => {
        if (!tenantId || !enabled || inFlightRef.current) return;
        inFlightRef.current = true;
        try {
            const list = await tenantsApi.listInvitations(tenantId).catch(() => null);
            if (!list) return; // transient error / not permitted — keep baseline
            const { newlyAccepted, snapshot } = diffAcceptedInvitations(snapshotRef.current, list);
            snapshotRef.current = snapshot;
            for (const inv of newlyAccepted) onAcceptedRef.current(inv);
        } finally {
            inFlightRef.current = false;
        }
    }, [tenantId, enabled]);

    useEffect(() => {
        if (!tenantId || !enabled) return;
        void check();
        const id = setInterval(() => { void check(); }, INVITATIONS_POLL_MS);
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
    }, [tenantId, enabled, check]);
}
