import { apiFetch } from "@/lib/apiClient";
import { DashboardPeriod, DashboardResponse } from "@/types";

export const dashboardApi = {
    get: (tenantId: string, period: DashboardPeriod): Promise<DashboardResponse> =>
        apiFetch<DashboardResponse>(
            `/dashboard?tenant_id=${encodeURIComponent(tenantId)}&period=${encodeURIComponent(period)}`,
        ),
};