import React from 'react';
import { TenantRole } from '@/types';

interface RoleBadgeProps {
    role: TenantRole;
}

// Small pill showing "Admin" (blue) or "Member" (slate) for a member row.
// Purely presentational — no state, so no accompanying hook is needed.
const RoleBadge: React.FC<RoleBadgeProps> = ({ role }) => {
    const isAdmin = role === 'admin';
    return (
        <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold w-fit ${isAdmin
                ? 'bg-blue-500/15 text-blue-400'
                : 'bg-slate-500/15 text-slate-400'
                }`}
        >
            <span className={`w-1.5 h-1.5 rounded-full ${isAdmin ? 'bg-blue-400' : 'bg-slate-400'}`} />
            {isAdmin ? 'Admin' : 'Member'}
        </span>
    );
};

export default RoleBadge;