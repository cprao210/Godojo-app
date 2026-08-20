// Firebase Web SDK init + ID-token bridge to the Electron main process.
//
// The renderer owns the Firebase auth lifecycle (sign-in UI, onIdTokenChanged
// refresh ticks ~hourly). Every time a fresh ID token is produced we forward
// it to main via window.electronAPI.authSetIdToken(...). Main caches it in
// AuthManager and supabase-js reads it on every request via its accessToken
// callback. The refresh token is persisted main-side via CredentialsManager
// so we can silently restore the session on next launch.

import { initializeApp, FirebaseApp } from 'firebase/app';
import {
    getAuth,
    onIdTokenChanged,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    sendEmailVerification,
    reload,
    GoogleAuthProvider,
    signInWithPopup,
    signOut as fbSignOut,
    updateProfile,
    deleteUser,
    Auth,
    User,
    getAdditionalUserInfo
} from 'firebase/auth';

// =====================================================================
// CONFIG
// =====================================================================
// The Firebase web config is PUBLIC (it's not a secret — see Firebase docs).
// Replace these values with your project's web app credentials, or expose
// them via Vite env vars (VITE_FIREBASE_*) so they can be swapped per build.
//
// Get the config from: Firebase Console → Project Settings → Your apps → Web
// =====================================================================

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};

let _app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _bridgeInstalled = false;

/** Lazily initialize Firebase. Safe to call repeatedly. */
export function getFirebaseAuth(): Auth {
    if (_auth) return _auth;
    if (!firebaseConfig.apiKey) {
        console.warn('[firebase] No VITE_FIREBASE_API_KEY set — auth will fail until config is provided.');
    }
    _app = initializeApp(firebaseConfig);
    _auth = getAuth(_app);
    installIdTokenBridge(_auth);
    return _auth;
}

// Add after the imports, before getFirebaseAuth()

/**
 * Maps Firebase Auth error codes to user-friendly messages.
 * Raw Firebase messages like "Firebase: Error (auth/wrong-password)." are
 * replaced with plain language that tells the user what to do.
 */
export function getAuthErrorMessage(err: unknown): string {
    const code = (err as any)?.code ?? '';
    const fallback = (err as any)?.message ?? 'Something went wrong. Please try again.';

    switch (code) {
        // Sign-in
        case 'auth/invalid-email':
            return `That doesn't look like a valid email address.`;
        case 'auth/user-not-found':
        case 'auth/invalid-credential':
        case 'auth/wrong-password':
            return 'Incorrect email or password. Please try again.';
        case 'auth/user-disabled':
            return 'This account has been disabled. Please contact support.';
        case 'auth/too-many-requests':
            return 'Too many failed attempts. Please wait a few minutes and try again.';
        case 'auth/network-request-failed':
            return 'Network error. Check your connection and try again.';

        // Sign-up
        case 'auth/email-already-in-use':
            return 'An account with this email already exists. Try signing in instead.';
        case 'auth/weak-password':
            return 'Password must be at least 6 characters.';
        case 'auth/operation-not-allowed':
            return 'This sign-in method is not enabled. Please contact support.';

        // Token / session
        case 'auth/id-token-expired':
        case 'auth/session-cookie-expired':
            return 'Your session has expired. Please sign in again.';
        case 'auth/id-token-revoked':
        case 'auth/session-cookie-revoked':
            return 'Your session was revoked. Please sign in again.';

        // Google popup
        case 'auth/popup-closed-by-user':
        case 'auth/cancelled-popup-request':
            return ''; // Silent — user deliberately closed the popup
        case 'auth/popup-blocked':
            return 'The sign-in window was blocked. Please try again.';

        // Password reset
        case 'auth/expired-action-code':
            return 'This reset link has expired. Please request a new one.';
        case 'auth/invalid-action-code':
            return 'This reset link is invalid or has already been used.';

        default:
            // Strip the raw "Firebase: Error (auth/…)." wrapper if present
            return fallback.replace(/^Firebase:\s*/i, '').replace(/\s*\(auth\/[^)]+\)\.?$/, '').trim()
                || 'Something went wrong. Please try again.';
    }
}

/**
 * Subscribe to ID-token refreshes and forward each new token to main.
 * Idempotent — only one listener is ever attached.
 */
function installIdTokenBridge(auth: Auth): void {
    if (_bridgeInstalled) return;
    _bridgeInstalled = true;

    onIdTokenChanged(auth, async (user) => {
        try {
            if (!user) {
                await window.electronAPI?.authClear?.();
                return;
            }
            const result = await user.getIdTokenResult(/* forceRefresh */ false);
            const session = {
                idToken: result.token,
                refreshToken: user.refreshToken,
                uid: user.uid,
                email: user.email,
                displayName: user.displayName,
                photoURL: user.photoURL,
                expiresAt: new Date(result.expirationTime).getTime(),
            };
            await window.electronAPI?.authSetIdToken?.(session);
        } catch (e) {
            console.error('[firebase] onIdTokenChanged forwarding failed:', e);
        }
    });
}

// =====================================================================
// Public sign-in helpers (used by SignIn.tsx)
// =====================================================================

export async function signInWithGoogle(): Promise<{ user: User; isNewUser: boolean }> {
    const auth = getFirebaseAuth();
    const provider = new GoogleAuthProvider();

    // Always show the account picker so users can switch accounts.
    provider.setCustomParameters({ prompt: 'select_account' });

    // Request profile + email scopes explicitly.
    provider.addScope('profile');
    provider.addScope('email');

    try {
        const result = await signInWithPopup(auth, provider);
        // getAdditionalUserInfo tells us whether this popup created a brand
        // new Firebase account or signed into an existing one — used to
        // split 'user_registered' vs 'user_signed_in' analytics for Google,
        // the same distinction the email/password flow gets for free from
        // having separate sign-up/sign-in call sites.
        const isNewUser = getAdditionalUserInfo(result)?.isNewUser ?? false;
        return { user: result.user, isNewUser };
    } catch (err: any) {
        // User closed the popup — not a real error.
        if (err?.code === 'auth/popup-closed-by-user') {
            throw new Error('Sign-in cancelled — the window was closed.');
        }
        // Popup was blocked by Electron (setWindowOpenHandler didn't allow it).
        if (err?.code === 'auth/popup-blocked') {
            throw new Error('Sign-in popup was blocked. Please try again.');
        }
        throw err;
    }
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
    const auth = getFirebaseAuth();
    const result = await signInWithEmailAndPassword(auth, email, password);
    return result.user;
}

export async function signUpWithEmail(email: string, password: string): Promise<User> {
    const auth = getFirebaseAuth();
    const result = await createUserWithEmailAndPassword(auth, email, password);
    return result.user;
}

/**
 * Extended sign-up that also captures a display name and (optionally) a phone
 * number. Firebase email/password auth does not natively store phone numbers
 * (that's a separate phone-auth flow), so we:
 *   1. Set `displayName` on the Firebase user via updateProfile — this flows
 *      through onIdTokenChanged → AuthManager.snapshot() → the `users` table
 *      mirror automatically.
 *   2. Stash phone number locally keyed by uid so it survives reloads. When
 *      a user_profile editor lands it can promote this into Supabase.
 */
export async function signUpWithEmailExtended(args: {
    email: string;
    password: string;
    displayName?: string;
    phoneNumber?: string;
}): Promise<User> {
    const auth = getFirebaseAuth();
    const result = await createUserWithEmailAndPassword(auth, args.email, args.password);
    const user = result.user;

    const displayName = (args.displayName ?? '').trim();
    const phoneNumber = (args.phoneNumber ?? '').trim();

    try {
        if (displayName) {
            await updateProfile(user, { displayName });
            // Force a token refresh so AuthManager picks up the new display name
            // on its next forwarding cycle.
            await user.getIdToken(/* forceRefresh */ true);
        }
    } catch (e) {
        console.warn('[firebase] updateProfile failed (non-fatal):', e);
    }

    try {
        if (phoneNumber) {
            localStorage.setItem(`natively_signup_phone_${user.uid}`, phoneNumber);
        }
    } catch (_) {
        // localStorage unavailable — fine, this is best-effort metadata.
    }

    return user;
}

export async function resetPassword(email: string): Promise<void> {
    const auth = getFirebaseAuth();
    await sendPasswordResetEmail(auth, email);
}

export async function signOut(): Promise<void> {
    const auth = getFirebaseAuth();
    await fbSignOut(auth);
}

export async function getCurrentUser(): Promise<User | null> {
    const auth = getFirebaseAuth();
    return auth.currentUser;
}

export function subscribeAuthState(callback: (user: User | null) => void): () => void {
    const auth = getFirebaseAuth();
    return onAuthStateChanged(auth, callback);
}

/**
 * Silent restore on app launch: if main has a persisted refresh token from a
 * previous session, exchange it for a fresh ID token via Firebase's secure
 * token endpoint and sign the user in.
 *
 * This avoids a sign-in prompt on every launch.
 */
export async function trySilentRestore(): Promise<boolean> {
    try {
        const persisted = await window.electronAPI?.authGetPersistedRefreshToken?.();
        if (!persisted?.refreshToken) return false;
        if (!firebaseConfig.apiKey) {
            console.warn('[firebase] trySilentRestore: no apiKey — cannot exchange refresh token.');
            return false;
        }

        // Exchange refresh token for a fresh ID token via Firebase's public REST endpoint.
        // https://firebase.google.com/docs/reference/rest/auth#section-refresh-token
        const resp = await fetch(
            `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: persisted.refreshToken,
                }),
            }
        );
        if (!resp.ok) {
            console.warn('[firebase] silent refresh failed:', resp.status, await resp.text());
            return false;
        }
        const data: { id_token: string; refresh_token: string; user_id: string; expires_in: string } =
            await resp.json();

        // Use the fresh ID token to bring the Web SDK into a signed-in state.
        // Firebase doesn't expose a "sign in with id+refresh token" path directly,
        // so we rely on the SDK picking up the existing user via auth/emulator
        // mechanisms — easiest fallback: just push the token to main ourselves
        // and let the renderer treat the user as signed-in for UI purposes.

        const auth = getFirebaseAuth();

        // Wait briefly for Firebase SDK to pick up the restored session
        const currentUser = auth.currentUser;

        await window.electronAPI?.authSetIdToken?.({
            idToken: data.id_token,
            refreshToken: data.refresh_token,
            uid: data.user_id,
            email: currentUser?.email ?? null,
            displayName: currentUser?.displayName ?? null,
            photoURL: currentUser?.photoURL ?? null,
            expiresAt: Date.now() + parseInt(data.expires_in, 10) * 1000,
        });
        return true;
    } catch (e) {
        console.warn('[firebase] trySilentRestore error:', e);
        return false;
    }
}

/**
 * Send (or re-send) an email verification to the current user.
 */
export async function sendVerificationEmail(user: User): Promise<void> {
    await sendEmailVerification(user);
}

/**
 * Reload the Firebase user record from the server and return the latest
 * `emailVerified` status.
 */
export async function reloadAndCheckVerified(user: User): Promise<boolean> {
    await reload(user);
    return user.emailVerified;
}

/**
 * Attempts to force-refresh the ID token with an exponential backoff retry policy.
 * Only retries on network-related errors (e.g., waking from sleep with no Wi-Fi yet).
 * Fatal errors (auth/user-disabled, auth/user-token-expired) throw immediately.
 */
async function getIdTokenWithRetry(user: User, maxRetries = 3): Promise<string> {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await user.getIdToken(true);
        } catch (e: any) {
            const code = e?.code || '';
            // Only retry on network issues or timeouts
            if (code === 'auth/network-request-failed' || code === 'auth/internal-error' || code === 'auth/timeout') {
                attempt++;
                if (attempt >= maxRetries) throw e;
                const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000); // 2s, 4s, 8s...
                console.warn(`[firebase] Token refresh failed due to network (${code}). Retrying in ${delayMs}ms (Attempt ${attempt}/${maxRetries})...`);
                await new Promise(r => setTimeout(r, delayMs));
            } else {
                // Fatal error (user disabled, token revoked, etc) - do not retry
                throw e;
            }
        }
    }
    throw new Error('Max retries exceeded');
}

/**
 * Force-refreshes the current user's ID token against Firebase servers.
 * Returns false if the account has been deleted, disabled, or session revoked.
 * This is the only reliable way to detect a server-side deletion since the
 * local Firebase cache still holds a stale user object.
 */
export async function verifySessionIsActive(): Promise<boolean> {
    const auth = getFirebaseAuth();
    const user = auth.currentUser;
    if (!user) return false;
    try {
        await getIdTokenWithRetry(user);
        return true;
    } catch (e: any) {
        const code = e?.code || '';
        // If it's *still* just a network failure after all retries, don't permanently
        // assume the account is deleted. Let them proceed with the cached token rather 
        // than hard-blocking the meeting start just because of bad hotel Wi-Fi.
        if (code === 'auth/network-request-failed') {
            console.warn('[firebase] verifySessionIsActive: Network is down, skipping hard session invalidation.');
            return true; 
        }
        
        console.warn('[firebase] verifySessionIsActive failed (fatal):', e?.code ?? e);
        return false;
    }
}

/**
 * Installs a global session guard using onIdTokenChanged.
 * it attempts a force-refresh on every token cycle and signs out 
 * only when Firebase explicitly rejects it
 * (account disabled, deleted, or session revoked).
 *
 * Call this once from App.tsx for the launcher window only.
 * Returns an unsubscribe function.
 */
export function installSessionGuard(onInvalidSession: (errorCode?: string) => void): () => void {
    const auth = getFirebaseAuth();
    const unsub = onIdTokenChanged(auth, async (user) => {
        if (!user) return; // null during init or after sign-out — not an error
        try {
            await getIdTokenWithRetry(user);
        } catch (e: any) {
            const code = e?.code || '';
            // Do NOT log the user out just because their Wi-Fi dropped during a background refresh
            if (code === 'auth/network-request-failed' || code === 'auth/internal-error') {
                console.warn('[firebase] Session guard: network down during refresh, ignoring.');
                return;
            }

            // Firebase throws here when the account is disabled, deleted, or
            // the session is revoked. Treat any fatal token refresh failure as
            // an invalid session and force the user back to sign-in.
            console.warn('[firebase] Session guard: token refresh failed fatally, signing out.', code ?? e);
            onInvalidSession(code);
        }
    });
    return unsub;
}

/**
 * Performs a server-side token verification, signs out locally if the
 * account is disabled/deleted, and returns whether the session is valid.
 * Use this as a gate before every LLM IPC call.
 */

/**
 * DEV-ONLY. Permanently deletes the currently signed-in Firebase Auth user.
 * Self-service only — the Firebase client SDK has no way to delete anyone
 * but the live `auth.currentUser`, which is intentional: deleting an
 * arbitrary uid requires the Firebase Admin SDK (a service-account key),
 * which this app deliberately never ships (see the same rule for Supabase's
 * service-role key in electron/db/SupabaseClient.ts).
 *
 * Firebase requires a "recently signed in" session for this — if the ID
 * token is more than a few minutes old it throws `auth/requires-recent-login`,
 * in which case the caller should ask the user to sign out/in and retry.
 */
export async function deleteCurrentFirebaseUser(): Promise<void> {
    const auth = getFirebaseAuth();
    const user = auth.currentUser;
    if (!user) {
        throw new Error('No signed-in Firebase user to delete.');
    }
    await deleteUser(user);
}

export async function guardSession(): Promise<{ valid: boolean; message?: string }> {
    const auth = getFirebaseAuth();
    const user = auth.currentUser;
    if (!user) return { valid: false, message: 'You are not signed in.' };
    try {
        await getIdTokenWithRetry(user);
        return { valid: true };
    } catch (e: any) {
        const code = e?.code || '';
        // Same here: do not nuke the user's session if it's just a network timeout
        if (code === 'auth/network-request-failed') {
            console.warn('[firebase] guardSession: Network is down, passing optimistically.');
            return { valid: true };
        }

        console.warn('[firebase] guardSession: token refresh failed, signing out.', code ?? e);
        await fbSignOut(auth).catch(() => { });
        return { valid: false, message: getAuthErrorMessage(e) || 'Session expired. Please sign in again.' };
    }
}