/**
 * UserRolesPermissionsTab.tsx
 *
 * Settings tab: "User roles & Permissions"
 * Manage users, assign roles, and control access permissions across GoDojo.
 *
 * Default state: user is on an individual plan, sees the "Create Team" empty state.
 * Clicking "Create Team" opens a modal to collect a Team Name; on submit this calls
 * POST /tenants (tenantsApi.create), then GET /tenants/:id/members (tenantsApi.listMembers)
 * to populate the members table shown afterward.
 *
 * TODO (backend):
 *   - #6/#7 (suspend / update member) aren't wired to the row action menu yet —
 *     tenantsApi stubs those until the backend routes exist.
 *   - "Invite User" button doesn't open an invite modal yet (separate task).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Users, ShieldPlus, Plus, X, Search, ChevronLeft, ChevronRight, MoreVertical, Trash2, RotateCw, UserX, SearchX } from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { tenantsApi } from '../../lib/tenantsApi';
import { ApiError } from '../../lib/apiClient';
import { getFirebaseAuth } from '../../lib/firebase';
import type { Tenant, TenantMember, TenantRole, MemberOrInvitation, InvitationAcceptResult } from '../../types/tenant';

import type { MyPendingInvitation } from '../../types/tenant';
import { InvitationResponseModal } from './InvitationResponseModal';

const MEMBERS_PAGE_SIZE = 8;
const TABLE_GRID_COLS = 'grid-cols-[1fr_1fr_140px_60px]';

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

const avatarColorFor = (key: string) => {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
};

/**
 * A tenant "owner" is whoever created it (tenant.owner_id). Anyone else who
 * can see the tenant (i.e. an accepted invitee) is read-only in this tab:
 * they can view the roster but can't invite, edit, resend, or remove.
 *
 * NOTE: this is a UX affordance only. The backend must independently reject
 * POST /tenants/:id/invitations, PATCH .../members/:id, etc. for non-owners
 * — do not treat this flag as the security boundary.
 */
function useIsTenantOwner(tenant: Tenant | null): boolean {
    const [uid, setUid] = useState<string | null>(() => getFirebaseAuth().currentUser?.uid ?? null);

    useEffect(() => {
        // currentUser can still be null on first mount (auth not yet
        // hydrated); subscribe so we pick it up once it resolves.
        const unsubscribe = getFirebaseAuth().onAuthStateChanged((user) => {
            setUid(user?.uid ?? null);
        });
        return unsubscribe;
    }, []);

    if (!tenant || !uid) return false;
    return tenant.owner_id === uid;
}

// ─── Create Team Modal ──────────────────────────────────────────────────────

interface CreateTeamModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (teamName: string) => Promise<void>;
    isLight: boolean;
}

const CreateTeamModal: React.FC<CreateTeamModalProps> = ({ isOpen, onClose, onCreate, isLight }) => {
    const [teamName, setTeamName] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!isOpen) return null;

    const canCreate = teamName.trim().length > 0 && !isSubmitting;

    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-2 focus:ring-accent-primary/20 focus:border-accent-primary/50';

    const handleCreate = async () => {
        if (!canCreate) return;
        setIsSubmitting(true);
        setError(null);
        try {
            await onCreate(teamName.trim());
            setTeamName('');
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Failed to create team. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleClose = () => {
        setTeamName('');
        setError(null);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={handleClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className={`relative w-full max-w-md rounded-2xl border shadow-2xl ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'}`}
                onClick={e => e.stopPropagation()}
                style={{ boxShadow: isLight ? '0 24px 64px rgba(0,0,0,0.18)' : '0 24px 64px rgba(0,0,0,0.60)' }}
            >
                {/* Header */}
                <div className={`flex items-center justify-between px-5 pt-5 pb-4 border-b ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                    <div className="flex items-center gap-2.5">
                        <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center"
                            style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.30)' }}
                        >
                            <ShieldPlus size={15} className="text-blue-400" />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">Create Team</h3>
                    </div>
                    <button
                        onClick={handleClose}
                        className={`w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary transition-all ${isLight ? 'hover:text-slate-700 hover:bg-slate-100' : 'hover:text-text-primary hover:bg-bg-input'}`}
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* Body */}
                <div className="px-5 py-5 space-y-2">
                    <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 block">
                        Team Name <span className="text-red-400">*</span>
                    </label>
                    <input
                        autoFocus
                        type="text"
                        value={teamName}
                        onChange={e => setTeamName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                        placeholder="e.g. Acme Sales Team"
                        disabled={isSubmitting}
                        className={`w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none transition-all ${inputCls}`}
                    />
                    {error && <p className="text-xs font-medium text-red-400">{error}</p>}
                </div>

                {/* Footer */}
                <div className={`flex items-center justify-end gap-2 px-5 py-4 border-t ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                    <button
                        onClick={handleClose}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${isLight ? 'text-slate-600 hover:bg-slate-100' : 'text-text-secondary hover:bg-bg-item-active/50 hover:text-text-primary'}`}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleCreate}
                        disabled={!canCreate}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2 ${canCreate
                            ? 'bg-blue-600 hover:bg-blue-500 text-white'
                            : 'bg-blue-600/40 text-white/60 cursor-not-allowed'
                            }`}
                    >
                        {isSubmitting ? 'Creating…' : 'Create'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// ─── Row actions menu (context menu for a single member/invitation row) ─────

interface RowActionsMenuProps {
    row: MemberOrInvitation;
    isLight: boolean;
    onResendInvite: () => void;
    onRemove: () => void;
    isOwner: boolean;
}

const RowActionsMenu: React.FC<RowActionsMenuProps> = ({ row, isLight, onResendInvite, onRemove, isOwner }) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const isPendingInvitation = row.type === 'pending_invite';

    // Close on outside click.
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const itemCls = isLight
        ? 'text-slate-700 hover:bg-slate-100'
        : 'text-text-secondary hover:bg-bg-item-active/60 hover:text-text-primary';

    const menuAction = (fn: () => void) => () => {
        setIsOpen(false);
        fn();
    };

    console.log(row)

    if (isOwner && row.type === "team_member" && row.invited_by === null) return null;

    return (
        <div className="relative flex justify-end" ref={containerRef}>
            <button
                onClick={() => setIsOpen((v) => !v)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-item-active/50 transition-colors"
            >
                <MoreVertical size={15} />
            </button>

            {isOpen && (
                <div
                    className={`absolute right-0 top-8 z-[100] w-44 rounded-lg border shadow-xl py-1 ${isLight ? 'bg-white border-slate-200' : 'bg-[#1a1f29] border-border-subtle'}`}
                    style={{ boxShadow: isLight ? '0 12px 32px rgba(0,0,0,0.16)' : '0 12px 32px rgba(0,0,0,0.55)' }}
                >

                    {isPendingInvitation && (
                        <button
                            onClick={menuAction(onResendInvite)}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium transition-colors ${itemCls}`}
                        >
                            <RotateCw size={13} /> Re-send Invite
                        </button>
                    )}

                    <button
                        onClick={menuAction(onRemove)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                        <Trash2 size={13} /> Remove
                    </button>
                </div>
            )}
        </div>
    );
};

// ─── Invite User Modal ───────────────────────────────────────────────────────

interface InviteUserModalProps {
    isOpen: boolean;
    onClose: () => void;
    onInvite: (email: string, role: TenantRole) => Promise<void>;
    isLight: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const InviteUserModal: React.FC<InviteUserModalProps> = ({ isOpen, onClose, onInvite, isLight }) => {
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<TenantRole>('member');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!isOpen) return null;

    const canInvite = EMAIL_RE.test(email.trim()) && !isSubmitting;

    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-2 focus:ring-accent-primary/20 focus:border-accent-primary/50';

    const handleInvite = async () => {
        if (!canInvite) return;
        setIsSubmitting(true);
        setError(null);
        try {
            await onInvite(email.trim(), role);
            setEmail('');
            setRole('member');
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Failed to send invitation. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleClose = () => {
        setEmail('');
        setRole('member');
        setError(null);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={handleClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className={`relative w-full max-w-md rounded-2xl border shadow-2xl ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'}`}
                onClick={e => e.stopPropagation()}
                style={{ boxShadow: isLight ? '0 24px 64px rgba(0,0,0,0.18)' : '0 24px 64px rgba(0,0,0,0.60)' }}
            >
                {/* Header */}
                <div className={`flex items-center justify-between px-5 pt-5 pb-4 border-b ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                    <div className="flex items-center gap-2.5">
                        <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center"
                            style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.30)' }}
                        >
                            <Plus size={15} className="text-blue-400" />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">Invite User</h3>
                    </div>
                    <button
                        onClick={handleClose}
                        className={`w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary transition-all ${isLight ? 'hover:text-slate-700 hover:bg-slate-100' : 'hover:text-text-primary hover:bg-bg-input'}`}
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* Body */}
                <div className="px-5 py-5 space-y-4">

                    <div className="space-y-2">
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 block">
                            Email <span className="text-red-400">*</span>
                        </label>
                        <input
                            autoFocus
                            type="email"
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleInvite(); }}
                            placeholder="teammate@company.com"
                            disabled={isSubmitting}
                            className={`w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none transition-all ${inputCls}`}
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-1 block">
                            Role
                        </label>
                        <select
                            value={role}
                            onChange={e => setRole(e.target.value as TenantRole)}
                            disabled={isSubmitting}
                            className={`w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none transition-all ${inputCls}`}
                        >
                            <option value="member">Member</option>
                        </select>
                    </div>

                    {error && <p className="text-xs font-medium text-red-400">{error}</p>}
                </div>

                {/* Footer */}
                <div className={`flex items-center justify-end gap-2 px-5 py-4 border-t ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                    <button
                        onClick={handleClose}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${isLight ? 'text-slate-600 hover:bg-slate-100' : 'text-text-secondary hover:bg-bg-item-active/50 hover:text-text-primary'}`}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleInvite}
                        disabled={!canInvite}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2 ${canInvite
                            ? 'bg-blue-600 hover:bg-blue-500 text-white'
                            : 'bg-blue-600/40 text-white/60 cursor-not-allowed'
                            }`}
                    >
                        {isSubmitting ? 'Sending…' : 'Send Invite'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// ─── Status badge ───────────────────────────────────────────────────────────

const StatusBadge: React.FC<{ status: TenantMember['status'] | 'invited' }> = ({ status }) => {
    const isActive = status === 'active';
    return (
        <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold w-fit ${isActive
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-amber-500/15 text-amber-400'
                }`}
        >
            <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {isActive ? 'Active' : 'Pending'}
        </span>
    );
};

// ─── Skeleton loader ─────────────────────────────────────────────────────────
// Mirrors the real row's grid/columns exactly so there's no layout shift when
// the actual data swaps in. A staggered opacity pulse (rather than one flat
// blink) reads as "loading" rather than "broken", and it fills a full page
// of rows so the card doesn't visibly shrink/grow between loading -> loaded.

const SkeletonBar: React.FC<{ width: string; isLight: boolean }> = ({ width, isLight }) => (
    <div
        className={`h-3 rounded-full animate-pulse ${isLight ? 'bg-slate-200' : 'bg-white/10'}`}
        style={{ width }}
    />
);

const MemberRowSkeleton: React.FC<{ isLight: boolean; delayMs: number }> = ({ isLight, delayMs }) => (
    <div
        className={`grid ${TABLE_GRID_COLS} gap-4 px-6 py-3.5 items-center border-b border-border-subtle last:border-b-0`}
        style={{ animationDelay: `${delayMs}ms` }}
    >
        <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full animate-pulse ${isLight ? 'bg-slate-200' : 'bg-white/10'}`} />
            <SkeletonBar width="70%" isLight={isLight} />
        </div>
        <SkeletonBar width="85%" isLight={isLight} />
        <div className={`h-5 w-16 rounded-full animate-pulse ${isLight ? 'bg-slate-200' : 'bg-white/10'}`} />
        <div className={`h-6 w-6 rounded-md ml-auto animate-pulse ${isLight ? 'bg-slate-200' : 'bg-white/10'}`} />
    </div>
);

const MembersTableSkeleton: React.FC<{ isLight: boolean; rows?: number }> = ({ isLight, rows = MEMBERS_PAGE_SIZE }) => (
    <div role="status" aria-label="Loading members">
        {Array.from({ length: rows }, (_, i) => (
            <MemberRowSkeleton key={i} isLight={isLight} delayMs={i * 60} />
        ))}
    </div>
);

// ─── Members table (populated after a tenant exists) ────────────────────────

interface MembersTableProps {
    tenant: Tenant;
    isLight: boolean;
    isOwner: boolean;
}

const MembersTable: React.FC<MembersTableProps> = ({ tenant, isLight, isOwner }) => {
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
            setRefreshKey((k) => k + 1);
        } catch (err) {
            setRowError(err instanceof ApiError ? err.message : 'Failed to remove user.');
        }
    };

    const handleInvite = async (email: string, role: TenantRole) => {
        if (!isOwner) return;
        await tenantsApi.inviteMember(tenant.id, email, role);
        setIsInviteOpen(false);
        setPage(1);
        setRefreshKey((k) => k + 1); // pull the new pending invitation into the list
    };

    const totalPages = Math.max(1, Math.ceil(total / MEMBERS_PAGE_SIZE));
    const rangeStart = total === 0 ? 0 : (page - 1) * MEMBERS_PAGE_SIZE + 1;
    const rangeEnd = Math.min(page * MEMBERS_PAGE_SIZE, total);

    const cardCls = isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle';
    const inputCls = isLight
        ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400'
        : 'bg-bg-input border-border-subtle text-text-primary placeholder-text-tertiary focus:ring-2 focus:ring-accent-primary/20 focus:border-accent-primary/50';

    return (
        <div className={`rounded-2xl border overflow-hidden ${cardCls}`}>
            {/* Card header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-border-subtle flex-wrap gap-3">
                <div>
                    <h3 className="text-base font-bold text-text-primary">
                        {tenant.name}
                        {!isLoading && (
                            <span className={`ml-2 inline-flex items-center gap-1.5 rounded-full align-middle text-xs text-text-tertiary font-semibold w-fit `}>
                                <span className={`w-1 h-1 text-text-tertiary bg-text-tertiary rounded-full`} />
                                {total} {total === 1 ? 'user' : 'users'}
                            </span>
                        )}
                    </h3>
                    <p className="text-sm text-text-secondary">Manage your team members and their access.</p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => { setPage(1); setSearch(e.target.value); }}
                            placeholder="Search users..."
                            className={`w-52 rounded-lg border pl-8 pr-8 py-2 text-sm font-medium outline-none transition-all ${inputCls}`}
                        />
                        {search && (
                            <button
                                onClick={() => { setPage(1); setSearch(''); }}
                                aria-label="Clear search"
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-colors"
                            >
                                <X size={13} />
                            </button>
                        )}
                    </div>
                    {isOwner && (
                        <button
                            onClick={() => setIsInviteOpen(true)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                        >
                            <Plus size={15} /> Invite User
                        </button>
                    )}
                </div>
            </div>

            {/* Table */}
            {rowError && (
                <div className="mx-6 mt-3 px-3 py-2 rounded-lg text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20">{rowError}</div>
            )}

            {error ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                    <div className="w-11 h-11 rounded-full bg-red-500/10 flex items-center justify-center">
                        <UserX size={18} className="text-red-400" />
                    </div>
                    <p className="text-sm text-red-400 font-medium">{error}</p>
                    <button
                        onClick={() => setRefreshKey((k) => k + 1)}
                        className="text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors"
                    >
                        Try again
                    </button>
                </div>
            ) : (
                <>
                    <div className={`grid ${TABLE_GRID_COLS} gap-4 px-6 py-3 text-[11px] font-bold text-text-tertiary uppercase tracking-wider border-b border-border-subtle ${isLight ? 'bg-slate-50/60' : 'bg-white/[0.02]'}`}>
                        <span>User</span>
                        <span>Email</span>
                        <span>Status</span>
                        {isOwner && <span className="text-right">Actions</span>}
                    </div>

                    {isLoading ? (
                        <MembersTableSkeleton isLight={isLight} rows={Math.min(MEMBERS_PAGE_SIZE, total || MEMBERS_PAGE_SIZE)} />
                    ) : members.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                            <div className={`w-11 h-11 rounded-full flex items-center justify-center ${isLight ? 'bg-slate-100' : 'bg-white/5'}`}>
                                {search ? <SearchX size={18} className="text-text-tertiary" /> : <Users size={18} className="text-text-tertiary" />}
                            </div>
                            <p className="text-sm text-text-secondary">
                                {search ? `No users match "${search}".` : 'No members yet — invite someone to get started.'}
                            </p>
                            {search && (
                                <button
                                    onClick={() => { setPage(1); setSearch(''); }}
                                    className="text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors"
                                >
                                    Clear search
                                </button>
                            )}
                        </div>
                    ) : (
                        members.map((m, i) => {
                            const displayName = m.type === 'team_member' ? m.user.display_name : "Invited User";
                            const email = m.type === 'team_member' ? m.user.email : m.email;
                            const initial = (displayName || email || '?').slice(0, 1);
                            const avatarColor = avatarColorFor(displayName || email || String(i));
                            return (
                                <div key={m.id} className={`grid ${TABLE_GRID_COLS} gap-4 px-6 py-3.5 items-center border-b border-border-subtle last:border-b-0 transition-colors ${isLight ? 'hover:bg-slate-50' : 'hover:bg-white/[0.03]'}`}>
                                    <div className="flex items-center gap-3">
                                        <div className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-xs font-bold uppercase ${avatarColor.bg} ${avatarColor.text}`}>
                                            {initial}
                                        </div>
                                        <span className="text-sm font-semibold text-text-primary truncate" title={displayName}>{displayName}</span>
                                    </div>
                                    <span className="text-sm text-text-secondary truncate" title={email}>{email}</span>
                                    <StatusBadge status={m.status} />
                                    {isOwner && (
                                        <RowActionsMenu
                                            row={m}
                                            isOwner={isOwner}
                                            isLight={isLight}
                                            onResendInvite={() => handleResendInvite(m)}
                                            onRemove={() => handleRemove(m)}
                                        />
                                    )}

                                </div>
                            );
                        })


                    )}
                </>
            )}

            {/* Footer / pagination */}
            <div className={`flex items-center justify-between px-6 py-4 border-t ${isLight ? 'border-slate-100' : 'border-border-subtle'}`}>
                <span className="text-xs text-text-tertiary">
                    {isLoading ? (
                        <span className={`inline-block h-3 w-32 rounded-full animate-pulse ${isLight ? 'bg-slate-200' : 'bg-white/10'}`} />
                    ) : (
                        `Showing ${rangeStart} to ${rangeEnd} of ${total} users`
                    )}
                </span>
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page <= 1 || isLoading}
                        className="w-7 h-7 rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary disabled:opacity-40 hover:text-text-primary transition-colors"
                    >
                        <ChevronLeft size={14} />
                    </button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                        <button
                            key={n}
                            onClick={() => setPage(n)}
                            disabled={isLoading}
                            className={`w-7 h-7 rounded-lg text-xs font-semibold flex items-center justify-center transition-colors ${n === page
                                ? 'bg-blue-600 text-white'
                                : 'text-text-tertiary hover:text-text-primary border border-border-subtle'
                                } disabled:opacity-40`}
                        >
                            {n}
                        </button>
                    ))}
                    <button
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page >= totalPages || isLoading}
                        className="w-7 h-7 rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary disabled:opacity-40 hover:text-text-primary transition-colors"
                    >
                        <ChevronRight size={14} />
                    </button>
                </div>
            </div>

            {isOwner && (
                <>
                    <InviteUserModal
                        isOpen={isInviteOpen}
                        onClose={() => setIsInviteOpen(false)}
                        onInvite={handleInvite}
                        isLight={isLight}
                    />
                </>
            )}

        </div>
    );
};

// ─── Main Tab ───────────────────────────────────────────────────────────────

interface UserRolesPermissionsTabProps {
    /** Token from an `invite-deep-link` IPC event, if this render was triggered by one. */
    deepLinkInviteToken?: string | null;
    /** Lets the parent clear the token once we've consumed it (avoid re-triggering). */
    onDeepLinkTokenConsumed?: () => void;
}

export const UserRolesPermissionsTab: React.FC<UserRolesPermissionsTabProps> = ({ deepLinkInviteToken = null, onDeepLinkTokenConsumed }) => {
    const isLight = useResolvedTheme() === 'light';
    const [isCreateTeamOpen, setIsCreateTeamOpen] = useState(false);
    const [tenant, setTenant] = useState<Tenant | null>(null);
    const [isLoadingTenant, setIsLoadingTenant] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [pendingInvitation, setPendingInvitation] = useState<MyPendingInvitation | null>(null);
    const [declinedNotice, setDeclinedNotice] = useState(false);
    const isOwner = useIsTenantOwner(tenant);

    // Restore the user's existing tenant (if any) across reloads instead of
    // always starting from the "Create Team" empty state.
    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                // 1. If we arrived via the invite deep link, preview that
                //    specific invitation first — this is the fast path and
                //    doesn't depend on GET /tenants/me at all.
                if (deepLinkInviteToken) {
                    try {
                        const preview = await tenantsApi.previewInvitation(deepLinkInviteToken);
                        if (cancelled) return;
                        setPendingInvitation({
                            token: deepLinkInviteToken,
                            tenant_id: '', // not known until accepted; not needed for the prompt
                            tenant_name: preview.tenant_name,
                            role: preview.role,
                            invited_by_name: preview.invited_by_name,
                            expires_at: preview.expires_at,
                        });
                    } catch (err) {
                        // token invalid/expired — fall through to the normal checks below
                        console.warn('[UserRolesPermissionsTab] previewInvitation failed:', err);
                    }
                }

                // 2. Fallback / normal path: any pending invitation already on
                //    file for this user's email (covers manual tab navigation,
                //    no token in hand).
                if (!cancelled && !deepLinkInviteToken) {
                    const myInvitations = await tenantsApi.listMyInvitations().catch(() => []);
                    if (!cancelled && myInvitations.length > 0) {
                        setPendingInvitation(myInvitations[0]);
                    }
                }

                // 3. Existing tenant membership (owner's own team, or a team
                //    the user already accepted previously).
                const tenants = await tenantsApi.listMine();
                if (cancelled) return;
                setTenant(tenants[0] ?? null);
            } catch (err) {
                if (!cancelled) {
                    setLoadError(err instanceof ApiError ? err.message : 'Failed to load your team.');
                }
            } finally {
                if (!cancelled) setIsLoadingTenant(false);
            }
        }

        load();
        return () => { cancelled = true; };
    }, [deepLinkInviteToken]);

    const hasTeam = tenant != null && typeof tenant.id === 'string';

    const handleCreateTeam = async (teamName: string) => {
        const created = await tenantsApi.create(teamName);
        setTenant(created);
        setIsCreateTeamOpen(false);
    };

    const handleInvitationAccepted = async (_result: InvitationAcceptResult) => {
        setPendingInvitation(null);
        onDeepLinkTokenConsumed?.();

        try {
            const tenants = await tenantsApi.listMine();
            const resolvedTenant = tenants[0] ?? null;
            setTenant(resolvedTenant);
            await window.electronAPI?.setCurrentTenantId?.(resolvedTenant?.id ?? null);
        } catch (err) {
            setLoadError(err instanceof ApiError ? err.message : 'Failed to load your team.');
        }
    };

    const handleInvitationDeclined = () => {
        setPendingInvitation(null);
        setDeclinedNotice(true);
        onDeepLinkTokenConsumed?.();
    };

    return (
        <div className="max-w-3xl">
            {/* Header */}
            <div className="mb-6">
                <h2 className="text-xl font-bold text-text-primary mb-1">Roles &amp; Management</h2>
                <p className="text-sm text-text-secondary">
                    Manage users, assign roles, and control access permissions across GoDojo.
                </p>
            </div>

            {declinedNotice && (
                <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${isLight ? 'bg-slate-50 border-slate-200 text-text-secondary' : 'bg-bg-item-surface border-border-subtle text-text-secondary'}`}>
                    You declined the team invitation.
                </div>
            )}

            {isLoadingTenant ? (
                <div className={`rounded-2xl border px-8 py-16 text-center ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'}`}>
                    <p className="text-sm text-text-secondary">Loading your team…</p>
                </div>
            ) : loadError ? (
                <div className={`rounded-2xl border px-8 py-16 text-center ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'}`}>
                    <p className="text-sm text-red-400">{loadError}</p>
                </div>
            ) : pendingInvitation ? (
                // ── Pending invitation: block the member list until they respond ──
                <div className={`rounded-2xl border flex flex-col items-center justify-center text-center px-8 py-16 ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'}`}>
                    <Users size={38} className="text-blue-400 mb-4" />
                    <h3 className="text-lg font-bold text-text-primary mb-2">You have a pending invitation</h3>
                    <p className="text-sm text-text-secondary max-w-sm">
                        Respond to the invitation below to see this team's members.
                    </p>
                </div>
            ) : !hasTeam ? (
                // ── Empty state: individual plan, prompt to create a team ──
                <div
                    className={`rounded-2xl border flex flex-col items-center justify-center text-center px-8 py-16 ${isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle'
                        }`}
                >
                    <div
                        className="relative w-24 h-24 rounded-full flex items-center justify-center mb-6"
                        style={{ background: isLight ? 'rgba(59,130,246,0.08)' : 'rgba(59,130,246,0.10)' }}
                    >
                        <Users size={38} className="text-blue-400" />
                        <div
                            className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full flex items-center justify-center border-4"
                            style={{
                                background: '#2563eb',
                                borderColor: isLight ? '#ffffff' : '#141820',
                            }}
                        >
                            <Plus size={16} className="text-white" />
                        </div>
                    </div>

                    <h3 className="text-lg font-bold text-text-primary mb-2">Teams</h3>
                    <p className="text-sm text-text-secondary mb-1">
                        You're currently using GoDojo as an individual.
                    </p>
                    <p className="text-sm text-text-secondary mb-6 max-w-sm">
                        Create a team to collaborate with your sales team, share company context, and manage users.
                    </p>

                    <button
                        onClick={() => setIsCreateTeamOpen(true)}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                    >
                        <Plus size={16} /> Create Team
                    </button>
                </div>
            ) : (
                // ── Team exists: real members table (GET /tenants/:id/members) ──
                <MembersTable tenant={tenant} isLight={isLight} isOwner={isOwner} />
            )}

            <CreateTeamModal
                isOpen={isCreateTeamOpen}
                onClose={() => setIsCreateTeamOpen(false)}
                onCreate={handleCreateTeam}
                isLight={isLight}
            />

            {pendingInvitation && (
                <InvitationResponseModal
                    invitation={pendingInvitation}
                    isLight={isLight}
                    onAccepted={handleInvitationAccepted}
                    onDeclined={handleInvitationDeclined}
                    onDismiss={() => setPendingInvitation(null)}
                />
            )}
        </div>
    );
};