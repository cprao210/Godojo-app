// src/api/companiesApi.ts
//
// Typed wrappers over the FastAPI customer-companies routes — the registry
// backing the meeting → company association (post-call picker for quick
// meetings, upload-modal field, MeetingDetails chip). This is the CUSTOMER
// company, not the seller's own company-context singleton.
//
// Scoping: when a tenant header is sent, the tenant's shared registry is
// used; without one the backend falls back to the caller's personal registry
// (same resolution as company_context). The Electron backend also auto-falls
// back to the active membership, so tenantId is threaded but optional.

import { apiFetch } from "@/lib/apiClient";
import { Company } from "@/types";

function toQueryString(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : "";
}

export const companiesApi = {
    // GET /companies?search=&limit= — powers the picker's debounced search.
    list: (search?: string, limit = 20, tenantId?: string | null): Promise<Company[]> =>
        apiFetch<Company[]>(
            `/companies${toQueryString({ search, limit })}`,
            tenantId ? { headers: { "x-tenant-id": tenantId } } : undefined,
        ),

    // POST /companies — create-or-get, idempotent on (scope, normalized_name).
    // Returns the existing row instead of 409 on a name collision, so callers
    // can treat it as "resolve this name to a company".
    create: (name: string, domain?: string, tenantId?: string | null): Promise<Company> =>
        apiFetch<Company>(
            "/companies",
            {
                method: "POST",
                body: JSON.stringify({ name, ...(domain ? { domain } : {}) }),
                ...(tenantId ? { headers: { "x-tenant-id": tenantId } } : {}),
            },
        ),
};
