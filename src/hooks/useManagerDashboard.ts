// State + data-fetching layer for ManagerDashboard: owns the tenant/admin
// check, the dashboard data fetch (stats/trend/objections/rankings), the
// period picker, and the AE / objection modal selection. Kept separate from
// the component so the component only owns rendering — same split as
// useCalendarConnections / useGlobalChat.

import { useCallback, useEffect, useRef, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase";
import { tenantsApi, dashboardApi } from "@/api";
import { ApiError } from "@/lib/apiClient";
import {
    AeEntry,
    AeSummary,
    Tenant,
    RepEntry,
    DashboardActiveMember,
    DashboardPeriod,
    DashboardResponse,
    ObjectionType,
} from "@/types";

// ─── Period options for the date-range pill ─────────────────────────────────
// Backend enum: last_1_day, last_5_days, last_week, last_2_weeks,
// last_30_days, last_quarter, last_year.
export const PERIOD_OPTIONS: { value: DashboardPeriod; label: string }[] = [
    { value: "last_1_day", label: "Last 1 day" },
    { value: "last_5_days", label: "Last 5 days" },
    { value: "last_week", label: "Last week" },
    { value: "last_2_weeks", label: "Last 2 weeks" },
    { value: "last_30_days", label: "Last 30 days" },
    { value: "last_quarter", label: "Last quarter" },
    { value: "last_year", label: "Last year" },
];

/**
 * Same ownership check used in UserRolesPermissionsTab.tsx — the tenant's
 * owner_id is the source of truth for "is this user an admin". This is a UX
 * affordance only; the backend independently rejects non-admins on
 * GET /dashboard.
 */
function useIsTenantOwner(tenant: Tenant | null): boolean {
    const [uid, setUid] = useState<string | null>(() => getFirebaseAuth().currentUser?.uid ?? null);

    useEffect(() => {
        const unsubscribe = getFirebaseAuth().onAuthStateChanged((user) => {
            setUid(user?.uid ?? null);
        });
        return unsubscribe;
    }, []);

    if (!tenant || !uid) return false;
    return tenant.owner_id === uid;
}

interface UseManagerDashboardArgs {
    isOpen: boolean;
}

/**
 * Data flow (mirrors the loading/error pattern used in UserRolesPermissionsTab):
 *   1. GET /tenants/me on open — if [] the user hasn't created a tenant yet
 *      (nothing to show). Otherwise take the first tenant and check
 *      tenant.owner_id === current uid to know if this user is the admin.
 *   2. Only admins call GET /dashboard?tenant_id=...&period=... — this single
 *      endpoint backs every card below except "All AEs".
 */
export function useManagerDashboard({ isOpen }: UseManagerDashboardArgs) {
    // ── AE / objection drill-down selection ──────────────────────────────────
    const [selectedAe, setSelectedAe] = useState<AeSummary | null>(null);
    const [selectedObjection, setSelectedObjection] = useState<ObjectionType | null>(null);

    const openAeFromRep = (rep: RepEntry) =>
        setSelectedAe({ userId: rep.userId, name: rep.name, role: rep.role, calls: 0, score: rep.score });
    const openAeFromRow = (ae: AeEntry) =>
        setSelectedAe({ userId: ae.userId, name: ae.name, role: ae.role, calls: ae.calls, score: ae.score });

    // Clear any in-progress AE/objection drill-down whenever the dashboard
    // closes, so the header "Dashboard" icon reliably lands back on the main
    // dashboard view next time it's opened, instead of resuming on whatever
    // sub-view was showing when it was last closed.
    useEffect(() => {
        if (!isOpen) {
            setSelectedAe(null);
            setSelectedObjection(null);
        }
    }, [isOpen]);

    // ── 1. Tenant + admin check (GET /tenants/me) ───────────────────────────
    const [tenant, setTenant] = useState<Tenant | null>(null);
    const [isLoadingTenant, setIsLoadingTenant] = useState(true);
    const [tenantError, setTenantError] = useState<string | null>(null);
    const isAdmin = useIsTenantOwner(tenant);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        setIsLoadingTenant(true);
        setTenantError(null);
        tenantsApi
            .listMine()
            .then((tenants) => {
                if (cancelled) return;
                // No tenant created yet → nothing to show (handled in render).
                setTenant(tenants[0] ?? null);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setTenantError(err instanceof ApiError ? err.message : "Failed to load your team.");
            })
            .finally(() => {
                if (!cancelled) setIsLoadingTenant(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    // ── 2. Dashboard data (GET /dashboard?tenant_id=...&period=...) ─────────
    const [period, setPeriod] = useState<DashboardPeriod>("last_week");
    const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
    const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);
    const [isRefreshingDashboard, setIsRefreshingDashboard] = useState(false);
    const [dashboardError, setDashboardError] = useState<string | null>(null);
    const [isPeriodMenuOpen, setIsPeriodMenuOpen] = useState(false);

    // In-memory cache, keyed by `${tenantId}:${period}`. Avoids re-hitting
    // GET /dashboard every time the overlay is closed/reopened or the user
    // flips back to a period they've already viewed this session. Cleared
    // implicitly on full app reload — intentionally not persisted.
    const dashboardCacheRef = useRef<Map<string, DashboardResponse>>(new Map());
    // Bumped on every new request; a completed request only applies its
    // result if it's still the most recent one in flight (replaces the old
    // per-effect `cancelled` flag now that fetches are also triggered
    // imperatively by the refresh button, not just by the effect).
    const requestIdRef = useRef(0);

    const fetchDashboard = useCallback(
        (tenantId: string, forPeriod: DashboardPeriod, options: { force?: boolean } = {}) => {
            const cacheKey = `${tenantId}:${forPeriod}`;

            if (!options.force) {
                const cached = dashboardCacheRef.current.get(cacheKey);
                if (cached) {
                    setDashboard(cached);
                    setDashboardError(null);
                    return Promise.resolve();
                }
            }

            const thisRequestId = ++requestIdRef.current;
            if (options.force) setIsRefreshingDashboard(true);
            else setIsLoadingDashboard(true);
            setDashboardError(null);

            return dashboardApi
                .get(tenantId, forPeriod)
                .then((data) => {
                    if (requestIdRef.current !== thisRequestId) return;
                    dashboardCacheRef.current.set(cacheKey, data);
                    setDashboard(data);
                })
                .catch((err: unknown) => {
                    if (requestIdRef.current !== thisRequestId) return;
                    setDashboardError(err instanceof ApiError ? err.message : "Failed to load dashboard data.");
                })
                .finally(() => {
                    if (requestIdRef.current !== thisRequestId) return;
                    if (options.force) setIsRefreshingDashboard(false);
                    else setIsLoadingDashboard(false);
                });
        },
        [],
    );

    useEffect(() => {
        if (!isOpen || !tenant || !isAdmin) return;
        fetchDashboard(tenant.id, period);
    }, [isOpen, tenant, isAdmin, period, fetchDashboard]);

    // Manual "Refresh" button — bypasses and repopulates the cache for the
    // current tenant/period.
    const refreshDashboard = useCallback(() => {
        if (!tenant || !isAdmin) return;
        fetchDashboard(tenant.id, period, { force: true });
    }, [tenant, isAdmin, period, fetchDashboard]);

    // ── Map API shapes → the presentational props components already expect ──
    const activeReps = dashboard?.active_members_count ?? 0;
    const totalCalls = dashboard?.total_calls ?? 0;
    const teamAvgScore = dashboard?.team_avg_score ?? 0;
    const allAes: DashboardActiveMember[] = (dashboard?.active_members ?? []).filter((m) => m.role !== "admin");

    const teamScoreTrend = (dashboard?.trend ?? []).map((t) => ({
        label: t.label,
        score: t.avg_score,
    }));

    const objections: ObjectionType[] = (dashboard?.top_objections ?? []).map((o) => ({
        label: o.category,
        count: o.count,
        latest: o.latest ?? [],
    }));

    const topPerformers: RepEntry[] = (dashboard?.top_performers ?? []).map((p) => ({
        userId: p.user_id,
        name: p.name,
        role: `${p.call_count} call${p.call_count === 1 ? "" : "s"}`,
        score: p.avg_score,
    }));

    const needsCoaching: RepEntry[] = (dashboard?.lowest_performers ?? []).map((p) => ({
        userId: p.user_id,
        name: p.name,
        role: `${p.call_count} call${p.call_count === 1 ? "" : "s"}`,
        score: p.avg_score,
    }));

    const allAeRows: AeEntry[] = allAes.map((m) => ({
        userId: m.user_id,
        name: m.name || m.email || "Unknown",
        role: m.role === "admin" ? "Admin" : "Member",
        calls: m.calls,
        score: m.avg_score,
    }));

    const periodLabel = PERIOD_OPTIONS.find((p) => p.value === period)?.label ?? "Select period";
    const hasTenant = tenant !== null;

    return {
        // tenant / admin
        tenant,
        isLoadingTenant,
        tenantError,
        isAdmin,
        hasTenant,
        // period picker
        period,
        setPeriod,
        periodLabel,
        isPeriodMenuOpen,
        setIsPeriodMenuOpen,
        // dashboard data
        isLoadingDashboard,
        isRefreshingDashboard,
        refreshDashboard,
        dashboardError,
        activeReps,
        totalCalls,
        teamAvgScore,
        teamScoreTrend,
        objections,
        topPerformers,
        needsCoaching,
        allAeRows,
        // selections
        selectedAe,
        setSelectedAe,
        openAeFromRep,
        openAeFromRow,
        selectedObjection,
        setSelectedObjection,
    };
}