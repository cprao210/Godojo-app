// electron/services/AuthManager.ts
//
// Singleton holding the current Firebase identity in the main process.
//
// The Firebase Web SDK lives in the renderer and is the source of truth for
// auth state (sign-in flow, automatic hourly refresh). Whenever its
// `onIdTokenChanged` handler fires, the renderer forwards the new ID token to
// main via the `auth:set-id-token` IPC, which calls `setSession()` here.
//
// AuthManager:
//   1. Caches the ID token + uid in memory for synchronous reads by
//      SupabaseClientManager (passed to supabase-js as an `accessToken`
//      callback).
//   2. Persists the long-lived refresh token via CredentialsManager
//      (safeStorage-encrypted on disk) so the next launch can silently restore
//      a session by asking the renderer to exchange the refresh token for a
//      fresh ID token.
//   3. Emits `auth-changed` events so SupabaseMirrorService can drain its
//      outbox the moment a user signs in.

import { EventEmitter } from 'events';
import { CredentialsManager } from './CredentialsManager';
import { DatabaseManager } from '../db/DatabaseManager';

export interface FirebaseSession {
    uid: string;
    idToken: string;
    refreshToken: string;
    email?: string | null;
    displayName?: string | null;
    photoURL?: string | null;
    /** ms since epoch when the ID token expires (Firebase tokens last 1h). */
    expiresAt: number;
}

export interface AuthSnapshot {
    signedIn: boolean;
    uid: string | null;
    email: string | null;
    displayName: string | null;
    photoURL: string | null;
}

export class AuthManager extends EventEmitter {
    private static instance: AuthManager;
    private session: FirebaseSession | null = null;

    private constructor() {
        super();
    }

    static getInstance(): AuthManager {
        if (!this.instance) this.instance = new AuthManager();
        return this.instance;
    }

    /**
     * Called by the renderer (via IPC) whenever Firebase's `onIdTokenChanged`
     * fires — initial sign-in, hourly refresh, or session restore.
     */
    setSession(session: FirebaseSession): void {
        const isFirstSignIn = !this.session || this.session.uid !== session.uid;
        const uidChanged = this.session?.uid !== session.uid;
        this.session = session;

        // Point the local DB at THIS user's file before anyone reacts to the
        // auth change. On a hourly token refresh (same uid) switchUser() no-ops.
        if (uidChanged) {
            try {
                CredentialsManager.getInstance().switchUser(session.uid);
                DatabaseManager.getInstance().switchUser(session.uid);
            } catch (e) {
                console.error('[AuthManager] Failed to switch DB to user file:', e);
            }
        }

        // Persist refresh token + identity for next-launch restore.
        // ID tokens are NOT persisted — they expire in 1h and are re-minted
        // from the refresh token on every app start.
        try {
            CredentialsManager.getInstance().setFirebaseIdentity({
                refreshToken: session.refreshToken,
                uid: session.uid,
                email: session.email ?? undefined,
                displayName: session.displayName ?? undefined,
                photoURL: session.photoURL ?? undefined,
            });
        } catch (e) {
            console.warn('[AuthManager] Failed to persist Firebase identity:', e);
        }

        console.log(`[AuthManager] Session ${isFirstSignIn ? 'established' : 'refreshed'} for uid=${session.uid}`);
        this.emit('auth-changed', this.snapshot());
        if (isFirstSignIn) this.emit('signed-in', this.snapshot());
    }

    listAccounts() {
        return CredentialsManager.getInstance().listFirebaseAccounts();
    }

    getRefreshTokenForUid(uid: string): string | null {
        return CredentialsManager.getInstance().getRefreshTokenForUid(uid);
    }


    /** Called when the renderer signs the user out. */
    clearSession(): void {
        if (!this.session) return;
        this.session = null;
        try {
            CredentialsManager.getInstance().switchUser(null);
            DatabaseManager.getInstance().switchUser(null);
        } catch (e) {
            console.warn('[AuthManager] Failed to clear Firebase identity:', e);
        }
        console.log('[AuthManager] Session cleared');
        this.emit('auth-changed', this.snapshot());
        this.emit('signed-out');
    }

    /** Synchronous accessor — used by Supabase client's accessToken callback. */
    getIdToken(): string | null {
        if (!this.session) return null;
        // Note: if the token is past its expiry, the renderer's onIdTokenChanged
        // will have already pushed a fresh one (Firebase refreshes ~5 min early).
        // We still return it because Supabase will reject and the next request
        // will pick up the new token.
        return this.session.idToken;
    }

    getUid(): string | null {
        return this.session?.uid ?? null;
    }

    getRefreshToken(): string | null {
        return this.session?.refreshToken ?? null;
    }

    isSignedIn(): boolean {
        return this.session !== null;
    }

    snapshot(): AuthSnapshot {
        if (!this.session) {
            return { signedIn: false, uid: null, email: null, displayName: null, photoURL: null };
        }
        return {
            signedIn: true,
            uid: this.session.uid,
            email: this.session.email ?? null,
            displayName: this.session.displayName ?? null,
            photoURL: this.session.photoURL ?? null,
        };
    }

    /**
     * Return the persisted refresh token (if any) so main.ts can ask the
     * renderer to silently exchange it for a fresh ID token on launch.
     */
    getPersistedIdentity(): {
        refreshToken: string;
        uid: string;
        email?: string;
        displayName?: string;
        photoURL?: string;
    } | null {
        try {
            return CredentialsManager.getInstance().getFirebaseIdentity();
        } catch {
            return null;
        }
    }
}
