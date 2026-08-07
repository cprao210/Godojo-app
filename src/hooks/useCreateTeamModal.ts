// Form state + submit logic for CreateTeamModal. Kept separate from the
// component so the component only owns rendering — same split as
// useInviteUserModal / useUserProfileTab.

import { useState } from "react";
import { ApiError } from "@/lib/apiClient";

interface UseCreateTeamModalParams {
    onCreate: (teamName: string) => Promise<void>;
    onClose: () => void;
}

export function useCreateTeamModal({ onCreate, onClose }: UseCreateTeamModalParams) {
    const [teamName, setTeamName] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canCreate = teamName.trim().length > 0 && !isSubmitting;

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

    return {
        teamName,
        setTeamName,
        isSubmitting,
        error,
        canCreate,
        handleCreate,
        handleClose,
    };
}