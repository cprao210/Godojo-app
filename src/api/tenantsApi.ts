// src/lib/tenantsApi.ts
//
// Typed wrappers over the FastAPI tenants routes (multi-tenant admin/member
// management + invitations). Same shape as meetingsApi: apiFetch attaches the
// Firebase Bearer token and handles the {"error":{...}} envelope, so callers
// here just build the path/query/body.
//
// NOTE: #6 (suspend member) and #7 (update member) are not implemented on the
// backend yet — stubbed below with a TODO so callers can wire up once the
// routes exist.

import { apiFetch } from "@/lib/apiClient";
import { Invitation, InvitationAcceptResult, InvitationDeclineResult, InvitationPreview, InvitationStatus } from "@/types";
import { MemberDetail, MemberSuspended, MyPendingInvitation, Tenant, TenantMember, TenantMembersPage, TenantMembersQuery, TenantRole } from "@/types";

function toQueryString(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : "";
}

export const tenantsApi = {
    // 1. POST /tenants — create a tenant; caller becomes admin.
    create: (name: string): Promise<Tenant> =>
        apiFetch<Tenant>("/tenants", {
            method: "POST",
            body: JSON.stringify({ name }),
        }),

    // 2. GET /tenants/me — tenant(s) the current user belongs to.
    listMine: (): Promise<Tenant[]> => apiFetch<Tenant[]>("/tenants/me"),

    // 3. GET /tenants/:tenant_id/members
    listMembers: (tenantId: string, query: TenantMembersQuery = {}): Promise<TenantMembersPage> =>
        apiFetch<TenantMembersPage>(
            `/tenants/${tenantId}/members${toQueryString({
                search: query.search,
                role: query.role,
                page: query.page,
                limit: query.limit,
            })}`,
            { headers: { "x-tenant-id": tenantId } },
        ),

    // 4. POST /tenants/:tenant_id/invitations
    inviteMember: (tenantId: string, email: string, role: TenantRole): Promise<Invitation> =>
        apiFetch<Invitation>(`/tenants/${tenantId}/invitations`, {
            method: "POST",
            body: JSON.stringify({ email, role }),
        }),

    // 5. GET /tenants/:tenant_id/invitations?status_filter=...
    listInvitations: (tenantId: string, statusFilter?: InvitationStatus): Promise<Invitation[]> =>
        apiFetch<Invitation[]>(
            `/tenants/${tenantId}/invitations${toQueryString({ status_filter: statusFilter })}`,
        ),

    // 5b. GET /tenants/:tenant_id/members/:user_id — single-member drill-down
    // (radar scores, strengths, recent calls) backing AeDetailView.
    getMember: (tenantId: string, userId: string): Promise<MemberDetail> =>
        apiFetch<MemberDetail>(
            `/tenants/${tenantId}/members/${userId}`,
            { headers: { "x-tenant-id": tenantId } },
        ),

    // 6. PATCH /tenants/:tenant_id/members/:user_id/suspend
    suspendMember: (tenantId: string, userId: string): Promise<MemberSuspended> =>
        apiFetch<MemberSuspended>(
            `/tenants/${tenantId}/members/${userId}/suspend`,
        ),

    // 7. PATCH /tenants/:tenant_id/members/:user_id
    // TODO: backend route not created yet — wire up once available (role change?).
    updateMember: (tenantId: string, userId: string, updates: Record<string, unknown>): Promise<TenantMember> =>
        apiFetch<TenantMember>(`/tenants/${tenantId}/members/${userId}`, {
            method: "PATCH",
            headers: { "x-tenant-id": tenantId },
            body: JSON.stringify(updates),
        }),

    // 8. POST /tenants/:invitation_id/resend?tenant_id=...
    resendInvitation: (invitationId: string, tenantId: string): Promise<Invitation> =>
        apiFetch<Invitation>(
            `/tenants/${invitationId}/resend${toQueryString({ tenant_id: tenantId })}`,
            { method: "POST" },
        ),

    // 9. PATCH /tenants/:invitation_id/revoke?tenant_id=...
    revokeInvitation: (invitationId: string, tenantId: string): Promise<Invitation> =>
        apiFetch<Invitation>(
            `/tenants/${invitationId}/revoke${toQueryString({ tenant_id: tenantId })}`,
            { method: "PATCH" },
        ),

    // 10. GET /invitations/accept?token=... — preview only, no auth required.
    // NOTE: token is a query param here, not a path segment — the backend
    // mounts both preview (GET) and accept (POST) on the same /accept path.
    previewInvitation: (token: string): Promise<InvitationPreview> =>
        apiFetch<InvitationPreview>(`/invitations/accept${toQueryString({ token })}`),

    // 11. POST /invitations/accept?token=...
    acceptInvitation: (token: string): Promise<InvitationAcceptResult> =>
        apiFetch<InvitationAcceptResult>(`/invitations/accept${toQueryString({ token })}`, {
            method: "POST",
        }),

    // 12. POST /invitations/decline?token=...
    declineInvitation: (token: string): Promise<InvitationDeclineResult> =>
        apiFetch<InvitationDeclineResult>(`/invitations/decline${toQueryString({ token })}`, {
            method: "POST",
        }),

    // 13. GET /invitations/me — pending invitations addressed to the current
    // logged-in user's email, across any tenant. Used as the fallback path
    // when the user opens Roles & Management manually (no deep-link token).
    listMyInvitations: (): Promise<MyPendingInvitation[]> =>
        apiFetch<MyPendingInvitation[]>("/invitations/me"),
};