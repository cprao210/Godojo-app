import React from 'react';
import { ChevronLeft, ChevronRight, Plus, Search, SearchX, UserX, Users, X } from 'lucide-react';
import { MembersTableProps } from '@/types';
import { useMembersTable, MEMBERS_PAGE_SIZE, TABLE_GRID_COLS, avatarColorFor } from '@/hooks';
import StatusBadge from './StatusBadge';
import RowActionsMenu from './RowActionsMenu';
import InviteUserModal from './InviteUserModal';

// ─── Skeleton loader ─────────────────────────────────────────────────────────
// Mirrors the real row's grid/columns exactly so there's no layout shift when
// the actual data swaps in. A staggered opacity pulse (rather than one flat
// blink) reads as "loading" rather than "broken", and it fills a full page
// of rows so the card doesn't visibly shrink/grow between loading -> loaded.
// Local to this file since it's only ever used here.

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
// Data fetching, pagination, search, and row actions now live in
// useMembersTable — this component only renders.
const MembersTable: React.FC<MembersTableProps> = ({ tenant, isLight, isOwner }) => {
    const {
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
    } = useMembersTable({ tenant, isOwner });

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
                            onChange={(e) => handleSearchChange(e.target.value)}
                            placeholder="Search users..."
                            className={`w-52 rounded-lg border pl-8 pr-8 py-2 text-sm font-medium outline-none transition-all ${inputCls}`}
                        />
                        {search && (
                            <button
                                onClick={clearSearch}
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
                        onClick={refresh}
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
                                    onClick={clearSearch}
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
                <InviteUserModal
                    isOpen={isInviteOpen}
                    onClose={() => setIsInviteOpen(false)}
                    onInvite={handleInvite}
                    isLight={isLight}
                />
            )}
        </div>
    );
};

export default MembersTable;