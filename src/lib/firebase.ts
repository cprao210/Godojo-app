// src/lib/firebase.ts
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
    GoogleAuthProvider,
    signInWithPopup,
    signOut as fbSignOut,
    updateProfile,
    Auth,
    User
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

export async function signInWithGoogle(): Promise<User> {
    const auth = getFirebaseAuth();
    const provider = new GoogleAuthProvider();

    // Always show the account picker so users can switch accounts.
    provider.setCustomParameters({ prompt: 'select_account' });

    // Request profile + email scopes explicitly.
    provider.addScope('profile');
    provider.addScope('email');

    try {
        const result = await signInWithPopup(auth, provider);
        return result.user;
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
        await window.electronAPI?.authSetIdToken?.({
            idToken: data.id_token,
            refreshToken: data.refresh_token,
            uid: data.user_id,
            email: null,
            displayName: null,
            photoURL: null,
            expiresAt: Date.now() + parseInt(data.expires_in, 10) * 1000,
        });
        return true;
    } catch (e) {
        console.warn('[firebase] trySilentRestore error:', e);
        return false;
    }
}
