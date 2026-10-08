import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setFirebaseIdentity = vi.fn();
vi.mock('../services/CredentialsManager', () => ({
    CredentialsManager: { getInstance: () => ({ setFirebaseIdentity, switchUser: vi.fn() }) },
}));
vi.mock('../db/DatabaseManager', () => ({
    DatabaseManager: { getInstance: () => ({ switchUser: vi.fn() }) },
}));
vi.mock('../verboseLog', () => ({ isVerboseLogging: () => false }));

import { AuthManager, ROTATION_COALESCE_MS, type FirebaseSession } from '../services/AuthManager';

const session = (uid: string, token: string): FirebaseSession => ({
    uid, idToken: token, refreshToken: `rt-${uid}`, email: `${uid}@x.test`,
    displayName: null, photoURL: null, expiresAt: Date.now() + 3_600_000,
});

describe('AuthManager same-uid rotation coalescing', () => {
    let auth: AuthManager;
    let authChanged: ReturnType<typeof vi.fn>;
    let signedIn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => { });
        (AuthManager as any).instance = undefined;
        auth = AuthManager.getInstance();
        authChanged = vi.fn();
        signedIn = vi.fn();
        auth.on('auth-changed', authChanged);
        auth.on('signed-in', signedIn);
        setFirebaseIdentity.mockClear();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('first sign-in emits immediately', () => {
        auth.setSession(session('u1', 't1'));
        expect(authChanged).toHaveBeenCalledTimes(1);
        expect(signedIn).toHaveBeenCalledTimes(1);
        expect(setFirebaseIdentity).toHaveBeenCalledTimes(1);
    });

    it('a burst of same-uid rotations produces one trailing auth-changed', () => {
        auth.setSession(session('u1', 't1'));
        auth.setSession(session('u1', 't2'));
        auth.setSession(session('u1', 't3'));
        auth.setSession(session('u1', 't4'));
        expect(authChanged).toHaveBeenCalledTimes(1); // only the sign-in so far
        expect(auth.getIdToken()).toBe('t4'); // newest token readable immediately

        vi.advanceTimersByTime(ROTATION_COALESCE_MS);
        expect(authChanged).toHaveBeenCalledTimes(2);
        expect(signedIn).toHaveBeenCalledTimes(1);
        expect(setFirebaseIdentity).toHaveBeenCalledTimes(2);
    });

    it('identical forwards are still ignored', () => {
        auth.setSession(session('u1', 't1'));
        auth.setSession(session('u1', 't1'));
        vi.advanceTimersByTime(ROTATION_COALESCE_MS * 2);
        expect(authChanged).toHaveBeenCalledTimes(1);
    });

    it('sign-out cancels a pending rotation but keeps its token persisted', () => {
        auth.setSession(session('u1', 't1'));
        auth.setSession(session('u1', 't2'));
        setFirebaseIdentity.mockClear();
        auth.clearSession();
        expect(setFirebaseIdentity).toHaveBeenCalledTimes(1); // pending rotation persisted
        expect(authChanged).toHaveBeenCalledTimes(2); // sign-in + sign-out
        expect(authChanged.mock.calls[1][0].signedIn).toBe(false);
        vi.advanceTimersByTime(ROTATION_COALESCE_MS * 2);
        expect(authChanged).toHaveBeenCalledTimes(2); // no stale trailing emit
    });

    it('switching account emits immediately and drops the old pending rotation', () => {
        auth.setSession(session('u1', 't1'));
        auth.setSession(session('u1', 't2'));
        auth.setSession(session('u2', 'x1'));
        expect(signedIn).toHaveBeenCalledTimes(2);
        expect(authChanged).toHaveBeenCalledTimes(2);
        expect(authChanged.mock.calls[1][0].uid).toBe('u2');
        vi.advanceTimersByTime(ROTATION_COALESCE_MS * 2);
        expect(authChanged).toHaveBeenCalledTimes(2);
    });
});
