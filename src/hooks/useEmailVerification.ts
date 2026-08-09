// State + polling layer for EmailVerification: sends the initial verification
// email on mount, polls Firebase until the user verifies, drives the resend
// cooldown timer, and owns the "use a different account" sign-out. Kept
// separate from the component so the component only owns rendering — same
// split as useSignIn / useCalendarConnections.

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { sendVerificationEmail, reloadAndCheckVerified, signOut } from "@/lib/firebase";

const POLL_INTERVAL_MS = 4000;
const RESEND_COOLDOWN_S = 60;

interface UseEmailVerificationArgs {
    user: User;
    onVerified: () => void;
}

export function useEmailVerification({ user, onVerified }: UseEmailVerificationArgs) {
    const emailSentRef = useRef(false);

    const [resendCooldown, setResendCooldown] = useState(0);
    const [resendBusy, setResendBusy] = useState(false);
    const [resendInfo, setResendInfo] = useState<string | null>(null);
    const [resendError, setResendError] = useState<string | null>(null);
    const [verified, setVerified] = useState(false);

    // ── Poll Firebase until email is verified ────────────────────────────────
    useEffect(() => {
        const poll = setInterval(async () => {
            try {
                const isVerified = await reloadAndCheckVerified(user);
                if (isVerified) {
                    clearInterval(poll);
                    setVerified(true);
                    // Small delay so the user sees the success state.
                    setTimeout(() => onVerified(), 1200);
                }
            } catch {
                // Swallow network errors — keep polling.
            }
        }, POLL_INTERVAL_MS);
        return () => clearInterval(poll);
    }, [user, onVerified]);

    // ── Cooldown countdown timer ──────────────────────────────────────────────
    useEffect(() => {
        if (resendCooldown <= 0) return;
        const t = setInterval(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
        return () => clearInterval(t);
    }, [resendCooldown]);

    // ── Send verification email once on mount automatically ─────────────────
    useEffect(() => {
        if (emailSentRef.current) return;
        emailSentRef.current = true;
        sendVerificationEmail(user).catch(() => { });
        setResendCooldown(RESEND_COOLDOWN_S);
        // Mount-only: resends after this are user-triggered via handleResend.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleResend = useCallback(async () => {
        if (resendBusy || resendCooldown > 0) return;
        setResendBusy(true);
        setResendInfo(null);
        setResendError(null);
        try {
            await sendVerificationEmail(user);
            setResendInfo("Verification email sent! Check your inbox.");
            setResendCooldown(RESEND_COOLDOWN_S);
        } catch (e: any) {
            setResendError(e?.message ?? "Failed to send email. Please try again.");
        } finally {
            setResendBusy(false);
        }
    }, [user, resendBusy, resendCooldown]);

    const handleSignOut = useCallback(async () => {
        await signOut().catch(() => { });
    }, []);

    return {
        verified,
        resendCooldown,
        resendBusy,
        resendInfo,
        resendError,
        handleResend,
        handleSignOut,
    };
}