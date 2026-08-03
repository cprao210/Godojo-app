import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { tenantsApi } from "../api/tenantsApi";
import { Tenant, TenantState } from "@/types";

/**
 * Resolves the signed-in user's tenant and keeps every window in sync.
 *
 * Only the launcher/default window actually calls `tenantsApi.listMine()`
 * (it's the one Firebase auth subscribes in `useFirebaseAuth`). Once
 * resolved, it's published to the main process via `setCurrentTenantId` so
 * every window — including the overlay, which owns the "End Meeting"
 * button in a completely separate renderer process — can pick it up
 * through the `tenant:state-changed` broadcast.
 */
export function useTenant(authUser: User | null, isLauncherWindow: boolean, isDefault: boolean): TenantState {
    const [tenantId, setTenantId] = useState<string | null>(null);
    const [tenant, setTenant] = useState<Tenant | null>(null);

    // Resolve the tenant (launcher/default window only).
    useEffect(() => {
        // Guard: tenantsApi.listMine() attaches the Firebase ID token, so calling
        // it before auth resolves (or when signed out) either 401s or races the
        // token being set. Previously this ran once on mount with no dependency
        // on auth state, so on a cold launch it could fire before authUser was
        // set, fail silently, and never retry — leaving tenantId permanently
        // null for the whole session, which is why meetings saved with an
        // empty tenant_id.
        if (!(isLauncherWindow || isDefault)) return;
        if (!authUser) return;

        const getTenantId = async () => {
            const tenants = await tenantsApi.listMine();
            console.log("[useTenant] tenantsApi.listMine() resolved:", tenants);
            const resolvedTenant = tenants[0] ?? null;
            const resolved = resolvedTenant?.id ?? null;
            setTenant(resolvedTenant);
            // Publish to the main process so every window (esp. the overlay,
            // which owns the End Meeting button) picks it up via tenant:state-changed.
            window.electronAPI.setCurrentTenantId(resolved).catch((err) =>
                console.error("[useTenant] Failed to publish tenantId to main process:", err)
            );
        };

        getTenantId().catch((err) => console.error("[useTenant] Failed to fetch tenant ID:", err));
    }, [authUser, isLauncherWindow, isDefault]);

    // Every window (including the overlay) subscribes to the broadcast tenantId,
    // and also asks for whatever value main already has cached, in case this
    // window mounted after the launcher already resolved it.
    useEffect(() => {
        window.electronAPI
            .getCurrentTenantId()
            .then((id) => {
                if (id) setTenantId(id);
            })
            .catch((err) => console.error("[useTenant] Failed to read cached tenantId:", err));

        const unsub = window.electronAPI.onTenantStateChanged((id) => {
            console.log("[useTenant] tenant:state-changed received:", id ?? "(null)");
            setTenantId(id);
        });
        return () => unsub();
    }, []);

    // "admin" == the tenant owner (same rule ManagerDashboard/UserRolesPermissionsTab
    // use). Members (non-owners), and anyone with no resolved tenant yet, are false.
    const isAdmin = !!(tenant && authUser && tenant.owner_id === authUser.uid);

    return { tenantId, tenant, isAdmin };
}

/**
 * Auto-opens the Manager Dashboard once per sign-in for admins, and closes
 * it on sign-out. Kept separate from `useTenant` since it drives UI state
 * (`isManagerDashboardOpen`) that lives in App.tsx, not tenant data itself.
 */
export function useAutoOpenDashboardForAdmins(
    authUser: User | null,
    tenant: Tenant | null,
    isAdmin: boolean,
    setIsManagerDashboardOpen: (open: boolean) => void
): void {
    const hasAutoOpenedRef = useRef(false);

    useEffect(() => {
        if (!authUser) {
            // Signed out (or switched accounts) — allow the next admin login to
            // auto-open the dashboard again.
            hasAutoOpenedRef.current = false;
            setIsManagerDashboardOpen(false);
            return;
        }
        if (!tenant || hasAutoOpenedRef.current) return;
        setIsManagerDashboardOpen(isAdmin);
        hasAutoOpenedRef.current = true;
    }, [authUser, tenant, isAdmin]);
}