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
 * All state (tenant resolution, pending-invite deep link, owner check) lives in
 * useUserRolesPermissionsTab. This component only owns rendering, composed from
 * CreateTeamModal, MembersTable, and InvitationResponseModal — same split as the
 * rest of the settings tabs (useUserProfileTab / useScoringCriteriaTab).
 *
 * TODO (backend):
 *   - #6/#7 (suspend / update member) aren't wired to the row action menu yet —
 *     tenantsApi stubs those until the backend routes exist.
 */

import React from 'react';
import { Users, Plus } from 'lucide-react';
import { useResolvedTheme, useUserRolesPermissionsTab } from '@/hooks';
import { UserRolesPermissionsTabProps } from '@/types';
import { InvitationResponseModal } from '@/features/settings';
import CreateTeamModal from './CreateTeamModal';
import MembersTable from './MembersTable';

// ─── Main Tab ───────────────────────────────────────────────────────────────
export const UserRolesPermissionsTab: React.FC<UserRolesPermissionsTabProps> = ({ deepLinkInviteToken = null, onDeepLinkTokenConsumed }) => {
    const isLight = useResolvedTheme() === 'light';

    const {
        isCreateTeamOpen,
        setIsCreateTeamOpen,
        tenant,
        isLoadingTenant,
        loadError,
        pendingInvitation,
        setPendingInvitation,
        declinedNotice,
        isOwner,
        handleCreateTeam,
        handleInvitationAccepted,
        handleInvitationDeclined,
    } = useUserRolesPermissionsTab({ deepLinkInviteToken, onDeepLinkTokenConsumed });

    const cardCls = isLight ? 'bg-white border-slate-200' : 'bg-[#141820] border-border-subtle';

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
                <div className={`rounded-2xl border px-8 py-16 text-center ${cardCls}`}>
                    <p className="text-sm text-text-secondary">Loading your team…</p>
                </div>
            ) : loadError ? (
                <div className={`rounded-2xl border px-8 py-16 text-center ${cardCls}`}>
                    <p className="text-sm text-red-400">{loadError}</p>
                </div>
            ) : pendingInvitation ? (
                // ── Pending invitation: block the member list until they respond ──
                <div className={`rounded-2xl border flex flex-col items-center justify-center text-center px-8 py-16 ${cardCls}`}>
                    <Users size={38} className="text-blue-400 mb-4" />
                    <h3 className="text-lg font-bold text-text-primary mb-2">You have a pending invitation</h3>
                    <p className="text-sm text-text-secondary max-w-sm">
                        Respond to the invitation below to see this team's members.
                    </p>
                </div>
            ) : !tenant ? (
                // ── Empty state: individual plan, prompt to create a team ──
                <div className={`rounded-2xl border flex flex-col items-center justify-center text-center px-8 py-16 ${cardCls}`}>
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
                // Branching on `tenant` itself (rather than the derived `hasTeam`
                // boolean) lets TS narrow `Tenant | null` -> `Tenant` here, since
                // MembersTable requires a non-null tenant prop.
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

export default UserRolesPermissionsTab;