import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { subscribeAuthState, signOut as fbSignOut, installSessionGuard } from "../lib/firebase";
import { apiFetch, setInvalidSessionHandler } from "../lib/apiClient";
import { FirebaseAuthState } from "@/types";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";
import { queryClient } from "@/lib/queryClient";

/**
 * Owns every piece of Firebase auth state App.tsx needs:
 *  - the current signed-in/pending-verification/signed-out gate
 *  - the global session guard (catches account disabled/deleted/revoked,
 *    both via Firebase token refresh AND via a terminal 401 from apiClient)
 *  - a best-effort backend readiness probe once signed in
 *
 * Only the launcher/default window (and the overlay, for the session guard)
 * actually runs the Firebase subscription — other windows (settings,
 * model-selector) don't need their own auth listener.
 */
export function useFirebaseAuth(
    isLauncherWindow: boolean,
    isDefault: boolean,
    isOverlayWindow: boolean
): FirebaseAuthState {
    const [authUser, setAuthUser] = useState<User | null>(null);
    const [authChecked, setAuthChecked] = useState(false);
    const [pendingVerificationUser, setPendingVerificationUser] = useState<User | null>(null);
    const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

    // Primary auth-state subscription — decides between SignIn / EmailVerification / app.
    useEffect(() => {
        if (!(isLauncherWindow || isDefault)) {
            setAuthChecked(true);
            return;
        }
        const unsub = subscribeAuthState((user) => {
            if (!user) {
                // Signed out, or session was revoked/account deleted server-side.
                // Clear both gates — returns user to SignIn screen.
                setAuthUser(null);
                setPendingVerificationUser(null);
                setAuthChecked(true);
                posthogAnalytics.resetIdentity(); // clear identity on sign-out
                // The QueryClient is a module-scope singleton, so its cache
                // (meetings, tenants, /auth/me, …) outlives the signed-out user.
                // "Add another account" is just onSignOut() → SignIn → a new
                // user in the SAME renderer with no reload, so without this the
                // next account is served the previous account's cached rows on
                // first paint. The Switch Account path reloads the window and
                // doesn't depend on this; the add-account path does.
                queryClient.clear();
                return;
            }

            if (!user.emailVerified) {
                // Email/password sign-up: user exists but hasn't clicked the link yet.
                // Show the verification screen; keep authUser=null so the app never opens.
                setPendingVerificationUser(user);
                setAuthUser(null);
                setAuthChecked(true);
                return;
            }

            // Verified user — open the app.
            setPendingVerificationUser(null);
            setAuthUser(user);
            setAuthChecked(true);
            posthogAnalytics.identifyUser(user.uid, {   // identify on verified sign-in
                email: user.email,
                name: user.displayName,
            });
        });
        return () => unsub();
    }, [isLauncherWindow, isDefault]);

    // Global session guard — runs continuously while the app is open. Catches
    // account disabled/deleted/revoked anywhere, not just on meeting start.
    // onIdTokenChanged fires every ~hour on token refresh, so a disabled
    // account is caught at the next refresh cycle at the latest — or
    // immediately if the token has already expired.
    useEffect(() => {
        if (!(isLauncherWindow || isDefault || isOverlayWindow)) return;
        const handleInvalidSession = async (errorCode?: string) => {
            const { getAuthErrorMessage } = await import("../lib/firebase");
            const msg = errorCode
                ? getAuthErrorMessage({ code: errorCode })
                : "Your session has expired or the account was disabled. Please sign in again.";
            setSessionExpiredMessage(msg || "Your session has ended. Please sign in again.");
            await fbSignOut().catch(() => { });
        };
        // Firebase token-refresh guard (catches account disabled/deleted/revoked).
        const unsub = installSessionGuard(handleInvalidSession);
        // A terminal HTTP 401 from apiClient (after its one refresh-retry) routes
        // through the SAME handler via React Query's QueryCache/MutationCache
        // onError bridge — see app/queryClient.ts.
        setInvalidSessionHandler((code) => {
            void handleInvalidSession(code);
        });
        return () => {
            unsub();
            setInvalidSessionHandler(null);
        };
    }, [isLauncherWindow, isDefault, isOverlayWindow]);

    // Backend readiness probe: once signed in, confirm the API is reachable
    // and the forwarded token is accepted. /auth/me is RLS-independent (works
    // even before Supabase third-party auth is enabled). Best-effort — a
    // failure here is logged, not fatal.
    useEffect(() => {
        if (!authUser) return;
        apiFetch("/auth/me").catch((e) => console.warn("[api] /auth/me probe failed:", e));
    }, [authUser]);

    // If the main process clears the session (account disabled/deleted), mirror that here.
    useEffect(() => {
        if (!window.electronAPI?.onAuthStateChanged) return;
        const unsub = window.electronAPI.onAuthStateChanged(async (state: { signedIn: boolean }) => {
            if (!state.signedIn) {
                await fbSignOut().catch(() => { });
            }
        });
        return () => unsub?.();
    }, []);

    const completeEmailVerification = (verifiedUser: User) => {
        // subscribeAuthState will re-fire with emailVerified=true and move the
        // user into authUser automatically — but reload() does not trigger
        // onAuthStateChanged, so we must manually transition here: clear the
        // pending gate and set authUser ourselves.
        setPendingVerificationUser(null);
        setAuthUser(verifiedUser);
    };

    return {
        authUser,
        authChecked,
        pendingVerificationUser,
        sessionExpiredMessage,
        setSessionExpiredMessage,
        completeEmailVerification,
        signOut: () => {
            void fbSignOut().catch((e) => console.warn("[App] sign-out failed:", e));
        },
    };
}