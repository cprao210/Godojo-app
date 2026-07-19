// src/types/tenant.ts
//
// Canonical shapes for the tenants/members/invitations HTTP routes
// (src/lib/tenantsApi.ts). Mirrors the backend response bodies as-is —
// snake_case is kept (not camelCased) since these are thin 1:1 wrappers,
// same convention as meetingsApi's raw mutation responses.

export type TenantRole = "admin" | "member";

export type MemberStatus = "active" | "suspended";

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired" | "declined";

export interface Tenant {
    id: string;
    name: string;
    slug: string;
    owner_id: string;
    settings: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface TenantMember {
    type: "team_member";
    id: string;
    tenant_id: string;
    user_id: string;
    role: TenantRole;
    status: MemberStatus;
    invited_by: string;
    joined_at: string;
    joined_via: string;
    // The member's own account info.
    user: {
        email: string;
        display_name: string;
    };
    // Info about whoever sent the invite that created this membership.
    invited_by_user: {
        email: string;
        display_name: string;
    } | null;
}

// A still-pending invitation, merged into the /members list by the backend.
export interface PendingInvitationRow {
    type: "pending_invite";
    id: string;
    email: string;
    role: TenantRole;
    status: "invited";
    invited_at: string;
}

export type MemberOrInvitation = TenantMember | PendingInvitationRow;

export interface TenantMembersPage {
    data: MemberOrInvitation[];
    page: number;
    limit: number;
    total: number;
}

export interface TenantMembersQuery {
    search?: string;
    role?: TenantRole;
    page?: number;
    limit?: number;
}

export interface Invitation {
    id: string;
    tenant_id: string;
    email: string;
    role: TenantRole;
    token: string;
    status: InvitationStatus;
    invited_by?: string;
    expires_at: string;
    created_at: string;
    updated_at?: string;
}

export interface InvitationPreview {
    id: string;
    email: string;
    role: TenantRole;
    tenant_name: string;
    invited_by_name: string;
    expires_at: string;
}

export interface InvitationAcceptResult {
    invitation_status: "accepted";
    tenant_id: string;
    member_status: "active";
    tenant: Tenant & { role: TenantRole };
}

export interface InvitationDeclineResult {
    status: "declined";
}

// GET /invitations/me — invitations addressed to the current user's email,
// across any tenant, still awaiting their response. Distinct from
// InvitationPreview (which is looked up by token, before the user is
// necessarily known/authenticated as the invitee).
export interface MyPendingInvitation {
    token: string;
    tenant_id: string;
    tenant_name: string;
    role: TenantRole;
    invited_by_name: string;
    expires_at: string;
}

export interface MemberDetailRadarScores {
    MEDDICC: number; BANT: number; Objections: number;
    Discovery: number; Closing: number; Signals: number;
}
export interface MemberDetailRecentCall {
    meeting_id: string; title: string; start_time: number; score: number; highlight: string;
}
export interface MemberDetailStrength { title: string; description: string; frequency: string; }
export interface MemberDetail {
    user_id: string; name: string; image: string | null; role: TenantRole;
    calls_total: number; avg_score: number; radar_scores: MemberDetailRadarScores;
    weakest_area: string | null; recent_calls: MemberDetailRecentCall[]; strengths: MemberDetailStrength[];
}

export interface MemberSuspended {
    id: string;
    tenant_id: string;
    user_id: string;
    role: "member";
    status: "suspended";
    invited_by: string;
    joined_at: string;
    user_email: string | null;
    user_display_name: string | null;
}