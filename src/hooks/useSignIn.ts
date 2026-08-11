// State + handlers layer for SignIn: owns the sign-in/sign-up/reset mode
// switch, the form field values, busy/error/info state, and every auth call
// (Google, email/password, password reset). Kept separate from the component
// so the component only owns rendering — same split as useCalendarConnections
// / useGlobalChat / useManagerDashboard.

import { useEffect, useState } from "react";
import { User, Phone, Mail, Lock } from "lucide-react";
import type { User as FirebaseUser } from "firebase/auth";
import {
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmailExtended,
    resetPassword,
    getAuthErrorMessage,
} from "@/lib/firebase";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";
import { FieldValuesType } from "@/types";

export type AuthMode = "sign-in" | "sign-up" | "reset";

const EMPTY_USER_DATA = { email: "", password: "", displayName: "", phoneNumber: "" };

/** Field list shown above the password input — differs by mode. */
function fieldsForMode(mode: AuthMode): FieldValuesType[] {
    if (mode === "sign-up") {
        return [
            { icon: User, type: "text", name: "displayName", placeholder: "Full name" },
            { icon: Mail, type: "email", name: "email", placeholder: "you@example.com" },
            { icon: Phone, type: "tel", name: "phoneNumber", placeholder: "Phone number (optional)" },
        ];
    }
    return [{ icon: Mail, type: "email", name: "email", placeholder: "you@example.com" }];
}

export function useSignIn() {
    const [mode, setMode] = useState<AuthMode>("sign-in");
    const [userData, setUserData] = useState(EMPTY_USER_DATA);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);
    const [showPassword, setShowPassword] = useState(false);
    const [googleBusy, setGoogleBusy] = useState(false);
    const [hasAnimated, setHasAnimated] = useState(false);

    // Set to a User object after email/password sign-up until email is
    // verified. App.tsx's onIdTokenChanged listener is the source of truth
    // for routing to EmailVerification; this is kept for parity with the
    // original component shape in case a consumer wants it later.
    const [pendingVerificationUser, setPendingVerificationUser] = useState<FirebaseUser | null>(null);

    const fields = fieldsForMode(mode);

    // Skip the field entrance animation on every re-render after first mount.
    useEffect(() => {
        setHasAnimated(true);
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        const { name, value } = e.target;
        setUserData((prev) => ({ ...prev, [name]: value }));
    };

    const handleGoogle = async () => {
        setError(null);
        setGoogleBusy(true);
        setBusy(true);
        try {
            const { isNewUser } = await signInWithGoogle();
            if (isNewUser) {
                posthogAnalytics.trackUserRegistered('google');
            } else {
                posthogAnalytics.trackUserSignedIn('google');
            }
        } catch (e: any) {
            const msg: string = e?.message ?? "";
            // User-cancelled popups aren't real errors — don't surface them.
            if (!msg.toLowerCase().includes("cancelled") && !msg.toLowerCase().includes("closed")) {
                setError(getAuthErrorMessage(e) || "Google sign-in failed. Please try again.");
            }
        } finally {
            setGoogleBusy(false);
            setBusy(false);
            setUserData(EMPTY_USER_DATA);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setInfo(null);
        setBusy(true);

        try {
            const { email, password, displayName, phoneNumber } = userData;

            if (mode === "sign-up") {
                await signUpWithEmailExtended({ email, password, displayName, phoneNumber });
                posthogAnalytics.trackUserRegistered('email');
                // Do not call onSignedIn. Firebase fires onAuthStateChanged which
                // subscribeAuthState in App.tsx intercepts. If emailVerified=false
                // it shows EmailVerification; if true it opens the app.
            } else if (mode === "sign-in") {
                await signInWithEmail(email, password);
                posthogAnalytics.trackUserSignedIn('email');
            } else if (mode === "reset") {
                await resetPassword(email);
                setInfo("Password reset email sent.");
                setMode("sign-in");
            }
        } catch (err: any) {
            setError(getAuthErrorMessage(err) || "Authentication failed. Please try again.");
        } finally {
            setBusy(false);
            setUserData(EMPTY_USER_DATA);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleSubmit(e as unknown as React.FormEvent);
        }
    };

    const togglePasswordVisibility = () => setShowPassword((v) => !v);

    /** Flips between sign-in ⇄ sign-up (used by the footer link). */
    const toggleSignInSignUp = () => setMode((m) => (m === "sign-up" ? "sign-in" : "sign-up"));

    return {
        // mode
        mode,
        setMode,
        toggleSignInSignUp,
        // form state
        userData,
        fields,
        showPassword,
        togglePasswordVisibility,
        // status
        busy,
        googleBusy,
        error,
        info,
        hasAnimated,
        pendingVerificationUser,
        setPendingVerificationUser,
        // handlers
        handleChange,
        handleGoogle,
        handleSubmit,
        handleKeyDown,
    };
}