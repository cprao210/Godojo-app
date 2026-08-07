// Data + interaction layer for MembersTable: fetches the paginated member/
// invitation list, drives search + pagination, and owns resend/remove/invite
// mutations. Kept separate from the component so the component only owns
// rendering — same split as useUserProfileTab / useScoringCriteriaTab.

import { useEffect, useState } from "react";
import { tenantsApi } from "@/api";
import { ApiError } from "@/lib/apiClient";
import { MemberOrInvitation, Tenant, TenantRole } from "@/types";

export const MEMBERS_PAGE_SIZE = 8;
export const TABLE_GRID_COLS = 'grid-cols-[1fr_1fr_140px_60px]';

// Deterministic avatar color per user so the same person always gets the
// same tint across renders/pages, instead of every avatar being the same blue.
const AVATAR_PALETTE = [
    { bg: 'bg-blue-500/15', text: 'text-blue-400' },
    { bg: 'bg-violet-500/15', text: 'text-violet-400' },
    { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
    { bg: 'bg-amber-500/15', text: 'text-amber-400' },
    { bg: 'bg-pink-500/15', text: 'text-pink-400' },
    { bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
];

export const avatarColorFor = (key: string) => {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
};

interface UseMembersTableParams {
    tenant: Tenant;
    isOwner: boolean;
}

export function useMembersTable({ tenant, isOwner }: UseMembersTableParams) {
    const [members, setMembers] = useState<MemberOrInvitation[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isInviteOpen, setIsInviteOpen] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const [rowError, setRowError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setError(null);
        tenantsApi
            .listMembers(tenant.id, { role: isOwner ? "admin" : "member", page, limit: MEMBERS_PAGE_SIZE, search: search || undefined })
            .then((res) => {
                if (cancelled) return;
                setMembers(res.data);
                setTotal(res.total);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(err instanceof ApiError ? err.message : 'Failed to load members.');
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => { cancelled = true; };
    }, [tenant.id, page, search, refreshKey]);

    const refresh = () => setRefreshKey((k) => k + 1);

    const handleSearchChange = (value: string) => {
        setPage(1);
        setSearch(value);
    };

    const clearSearch = () => {
        setPage(1);
        setSearch('');
    };

    const handleResendInvite = async (row: MemberOrInvitation) => {
        if (!isOwner || row.type !== 'pending_invite') return;
        setRowError(null);
        try {
            await tenantsApi.resendInvitation(row.id, tenant.id);
        } catch (err) {
            setRowError(err instanceof ApiError ? err.message : 'Failed to resend invitation.');
        }
    };

    const handleRemove = async (row: MemberOrInvitation) => {
        if (!isOwner) return;
        setRowError(null);
        try {
            if (row.type === 'pending_invite') {
                await tenantsApi.revokeInvitation(row.id, tenant.id);
            } else {
                await tenantsApi.suspendMember(tenant.id, row.user_id);
            }
            refresh();
        } catch (err) {
            setRowError(err instanceof ApiError ? err.message : 'Failed to remove user.');
        }
    };

    const handleInvite = async (email: string, role: TenantRole) => {
        if (!isOwner) return;
        await tenantsApi.inviteMember(tenant.id, email, role);
        setIsInviteOpen(false);
        setPage(1);
        refresh(); // pull the new pending invitation into the list
    };

    const totalPages = Math.max(1, Math.ceil(total / MEMBERS_PAGE_SIZE));
    const rangeStart = total === 0 ? 0 : (page - 1) * MEMBERS_PAGE_SIZE + 1;
    const rangeEnd = Math.min(page * MEMBERS_PAGE_SIZE, total);

    return {
        members,
        total,
        page,
        setPage,
        search,
        handleSearchChange,
        clearSearch,
        isLoading,
        error,
        isInviteOpen,
        setIsInviteOpen,
        rowError,
        refresh,
        handleResendInvite,
        handleRemove,
        handleInvite,
        totalPages,
        rangeStart,
        rangeEnd,
    };
}