import { apiFetch } from "./apiClient";
import type { DashboardPeriod, DashboardResponse } from "../types/dashboard";

export const dashboardApi = {
    get: (tenantId: string, period: DashboardPeriod): Promise<DashboardResponse> =>
        apiFetch<DashboardResponse>(
            `/dashboard?tenant_id=${encodeURIComponent(tenantId)}&period=${encodeURIComponent(period)}`,
        ),
};