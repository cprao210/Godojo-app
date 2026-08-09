import React from 'react';
import { TenantMember } from '@/types';

interface StatusBadgeProps {
    status: TenantMember['status'] | 'invited';
}

// Small pill showing "Active" (green) or "Pending" (amber) for a member row.
// Purely presentational — no state, so no accompanying hook is needed.
const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
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

export default StatusBadge;