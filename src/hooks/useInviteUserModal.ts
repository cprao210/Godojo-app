// Form state + submit logic for InviteUserModal. Kept separate from the
// component so the component only owns rendering — same split as
// useCreateTeamModal / useUserProfileTab.

import { useState } from "react";
import { ApiError } from "@/lib/apiClient";
import { TenantRole } from "@/types";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UseInviteUserModalParams {
    onInvite: (email: string, role: TenantRole) => Promise<void>;
    onClose: () => void;
}

export function useInviteUserModal({ onInvite, onClose }: UseInviteUserModalParams) {
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<TenantRole>('member');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canInvite = EMAIL_RE.test(email.trim()) && !isSubmitting;

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

    return {
        email,
        setEmail,
        role,
        setRole,
        isSubmitting,
        error,
        canInvite,
        handleInvite,
        handleClose,
    };
}