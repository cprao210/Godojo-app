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
import { isVerboseLogging } from '../verboseLog';

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

/**
 * Same-uid token rotations arriving within this window are coalesced into ONE
 * 'auth-changed'. At launch several sources rotate the token within ~2 s (the
 * silent restore, the SDK's own restored token, the session guard's forced
 * refresh in the launcher and overlay); each used to re-run the full
 * auth-changed chain.
 */
export const ROTATION_COALESCE_MS = 1_500;

export class AuthManager extends EventEmitter {
    private static instance: AuthManager;
    private session: FirebaseSession | null = null;
    /** Pending coalesced emit for same-uid rotations (see ROTATION_COALESCE_MS). */
    private rotationTimer: ReturnType<typeof setTimeout> | null = null;
    private coalescedRotations = 0;

    private constructor() {
        super();
    }

    static getInstance(): AuthManager {
        if (!this.instance) this.instance = new AuthManager();
        return this.instance;
    }

    /**
     * Everything a `setSession` call can actually change downstream. Two calls
     * with the same fingerprint are the same session described twice.
     *
     * expiresAt is omitted deliberately: it is derived from the ID token, so an
     * identical token implies an identical expiry.
     *
     * NUL joins the parts because a display name may contain any printable
     * character, and a separator that can appear inside a field would let two
     * different sessions share a fingerprint.
     */
    private static fingerprint(s: FirebaseSession): string {
        return [
            s.uid,
            s.idToken,
            s.refreshToken,
            s.email ?? '',
            s.displayName ?? '',
            s.photoURL ?? '',
        ].join('\x00');
    }

    /**
     * Called by the renderer (via IPC) whenever Firebase's `onIdTokenChanged`
     * fires — initial sign-in, hourly refresh, or session restore.
     */
    setSession(session: FirebaseSession): void {
        // Every renderer installs its own onIdTokenChanged bridge (see
        // src/main.tsx bootFirebaseAuthBridge), so one hourly token refresh
        // arrives here once per open window — launcher, overlay, settings — each
        // carrying a byte-identical session. That was previously treated as N
        // distinct auth changes, and 'auth-changed' is not a cheap event: each
        // emission re-fetches the backend fallback keys over HTTPS, re-decrypts
        // them, re-syncs the LLM and STT clients, re-upserts the Supabase users
        // row, drains the mirror outbox, and broadcasts to every window. Doing
        // that N times produces exactly one useful result and N-1 duplicates,
        // and it can land mid-call.
        //
        // Suppress the duplicates. Every side effect below is idempotent by
        // value, so running them once instead of N times is not a behaviour
        // change — a genuine token rotation or profile edit has a different
        // fingerprint and still flows through untouched.
        const fingerprint = AuthManager.fingerprint(session);
        if (this.session && AuthManager.fingerprint(this.session) === fingerprint) {
            if (isVerboseLogging()) {
                console.log(`[AuthManager] Duplicate session forward ignored for uid=${session.uid}`);
            }
            return;
        }

        const isFirstSignIn = !this.session || this.session.uid !== session.uid;
        const uidChanged = this.session?.uid !== session.uid;
        const previousUid = this.session?.uid ?? null;

        // Same-uid rotation: the new token is readable immediately (getIdToken
        // is synchronous), but the expensive side effects — identity write and
        // the 'auth-changed' chain — run once per burst, on the trailing edge.
        if (!isFirstSignIn) {
            this.session = session;
            this.coalescedRotations += 1;
            if (this.rotationTimer) clearTimeout(this.rotationTimer);
            this.rotationTimer = setTimeout(() => this.flushRotation(), ROTATION_COALESCE_MS);
            this.rotationTimer.unref?.();
            return;
        }

        // A new identity supersedes any pending rotation of the previous one.
        this.cancelPendingRotation();
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

            // switchUser() closed the old SQLite handle and opened a new one,
            // but every long-lived holder of the OLD handle (mirror outbox, RAG
            // VectorStore + its worker's own connection, knowledge DB) and every
            // per-user main-process cache (tenant id) still points at the
            // previous account. A renderer reload does NOT reset any of that —
            // these are main-process singletons. Listeners re-bind here,
            // synchronously, before 'auth-changed' below lets anything act on
            // the new identity. Also fires on first sign-in (previousUid null),
            // which is where the anon-DB bindings taken at boot get corrected.
            this.emit('user-switched', { previousUid, uid: session.uid });
        }

        this.persistIdentity(session);

        console.log(`[AuthManager] Session established for uid=${session.uid}`);
        this.emit('auth-changed', this.snapshot());
        this.emit('signed-in', this.snapshot());
    }

    /** Trailing edge of a same-uid rotation burst. */
    private flushRotation(): void {
        this.rotationTimer = null;
        const count = this.coalescedRotations;
        this.coalescedRotations = 0;
        if (!this.session) return;
        this.persistIdentity(this.session);
        console.log(`[AuthManager] Session refreshed for uid=${this.session.uid}` +
            (count > 1 ? ` (${count} rotations coalesced)` : ''));
        this.emit('auth-changed', this.snapshot());
    }

    /**
     * Drop a pending rotation emit (sign-out / account switch). Its refresh
     * token is still persisted first — while CredentialsManager points at
     * that user — so the newest token is never lost.
     */
    private cancelPendingRotation(): void {
        if (!this.rotationTimer) return;
        clearTimeout(this.rotationTimer);
        this.rotationTimer = null;
        this.coalescedRotations = 0;
        if (this.session) this.persistIdentity(this.session);
    }

    // Persist refresh token + identity for next-launch restore.
    // ID tokens are NOT persisted — they expire in 1h and are re-minted
    // from the refresh token on every app start.
    private persistIdentity(session: FirebaseSession): void {
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
        this.cancelPendingRotation();
        const previousUid = this.session.uid;
        this.session = null;
        try {
            CredentialsManager.getInstance().switchUser(null);
            DatabaseManager.getInstance().switchUser(null);
        } catch (e) {
            console.warn('[AuthManager] Failed to clear Firebase identity:', e);
        }
        this.emit('user-switched', { previousUid, uid: null });
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
