// State + interaction layer for InvitationResponseModal: owns the
// accept/reject submit state and the tenantsApi calls. Kept separate from
// the component so the component only owns rendering — same split as
// useProviderCard / useUserProfileTab.

import { useCallback, useState } from "react";
import { tenantsApi } from "@/api/tenantsApi";
import { ApiError } from "@/lib/apiClient";
import type { MyPendingInvitation, InvitationAcceptResult } from "@/types";

type SubmitAction = "accept" | "reject" | null;

interface UseInvitationResponseModalArgs {
    invitation: MyPendingInvitation;
    onAccepted: (result: InvitationAcceptResult) => void;
    onDeclined: () => void;
}

export function useInvitationResponseModal({ invitation, onAccepted, onDeclined }: UseInvitationResponseModalArgs) {
    const [isSubmitting, setIsSubmitting] = useState<SubmitAction>(null);
    const [error, setError] = useState<string | null>(null);

    const handleAccept = useCallback(async () => {
        setError(null);
        setIsSubmitting("accept");
        try {
            const result = await tenantsApi.acceptInvitation(invitation.token);
            onAccepted(result);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : "Failed to accept invitation. Please try again.");
            setIsSubmitting(null);
        }
    }, [invitation.token, onAccepted]);

    const handleReject = useCallback(async () => {
        setError(null);
        setIsSubmitting("reject");
        try {
            await tenantsApi.declineInvitation(invitation.token);
            onDeclined();
        } catch (err) {
            setError(err instanceof ApiError ? err.message : "Failed to decline invitation. Please try again.");
            setIsSubmitting(null);
        }
    }, [invitation.token, onDeclined]);

    return {
        isSubmitting,
        error,
        handleAccept,
        handleReject,
    };
}