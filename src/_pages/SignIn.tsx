// src/_pages/SignIn.tsx
// Minimal sign-in surface. Renders Google + email/password options.
// The actual session forwarding to main happens automatically via the
// onIdTokenChanged bridge installed by getFirebaseAuth().

import React, { useState } from 'react';
import {
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmailExtended,
    resetPassword,
    signOut,
} from '../lib/firebase';

interface SignInProps {
    onSignedIn?: () => void;
}

export const SignIn: React.FC<SignInProps> = ({ onSignedIn }) => {
    const [mode, setMode] = useState<'sign-in' | 'sign-up' | 'reset'>('sign-in');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);

    const handleGoogle = async () => {
        setError(null);
        setBusy(true);
        try {
            await signInWithGoogle();
            onSignedIn?.();
        } catch (e: any) {
            setError(e?.message ?? 'Google sign-in failed');
        } finally {
            setBusy(false);
        }
    };

    const handleEmail = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setInfo(null);
        setBusy(true);
        try {
            if (mode === 'sign-up') {
                await signUpWithEmailExtended({ email, password, displayName, phoneNumber });
                onSignedIn?.();
            } else if (mode === 'sign-in') {
                await signInWithEmail(email, password);
                onSignedIn?.();
            } else if (mode === 'reset') {
                await resetPassword(email);
                setInfo('Password reset email sent.');
                setMode('sign-in');
            }
        } catch (err: any) {
            setError(err?.message ?? 'Authentication failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-neutral-900 text-neutral-100">
            <div className="w-full max-w-sm rounded-2xl bg-neutral-800/80 p-8 shadow-xl backdrop-blur">
                <h1 className="mb-1 text-2xl font-semibold">
                    {mode === 'sign-up' ? 'Create account' : mode === 'reset' ? 'Reset password' : 'Sign in'}
                </h1>
                <p className="mb-6 text-sm text-neutral-400">
                    Sync your meetings & notes across devices via Supabase.
                </p>

                {mode !== 'reset' && (
                    <button
                        type="button"
                        onClick={handleGoogle}
                        disabled={busy}
                        className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-white py-2.5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-100 disabled:opacity-50"
                    >
                        Continue with Google
                    </button>
                )}

                {mode !== 'reset' && (
                    <div className="my-4 flex items-center gap-2 text-xs text-neutral-500">
                        <div className="h-px flex-1 bg-neutral-700" />
                        OR
                        <div className="h-px flex-1 bg-neutral-700" />
                    </div>
                )}

                <form onSubmit={handleEmail} className="space-y-3">
                    {mode === 'sign-up' && (
                        <>
                            <input
                                type="text"
                                placeholder="Full name"
                                value={displayName}
                                onChange={(e) => setDisplayName(e.target.value)}
                                required
                                autoComplete="name"
                                className="w-full rounded-lg bg-neutral-900/60 px-3 py-2 text-sm outline-none ring-1 ring-neutral-700 focus:ring-neutral-500"
                            />
                            <input
                                type="tel"
                                placeholder="Phone number (optional)"
                                value={phoneNumber}
                                onChange={(e) => setPhoneNumber(e.target.value)}
                                autoComplete="tel"
                                inputMode="tel"
                                pattern="^[+0-9()\\-\\s]{6,}$"
                                className="w-full rounded-lg bg-neutral-900/60 px-3 py-2 text-sm outline-none ring-1 ring-neutral-700 focus:ring-neutral-500"
                            />
                        </>
                    )}
                    <input
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        className="w-full rounded-lg bg-neutral-900/60 px-3 py-2 text-sm outline-none ring-1 ring-neutral-700 focus:ring-neutral-500"
                    />
                    {mode !== 'reset' && (
                        <input
                            type="password"
                            placeholder="Password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            minLength={6}
                            className="w-full rounded-lg bg-neutral-900/60 px-3 py-2 text-sm outline-none ring-1 ring-neutral-700 focus:ring-neutral-500"
                        />
                    )}
                    <button
                        type="submit"
                        disabled={busy}
                        className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
                    >
                        {busy
                            ? '...'
                            : mode === 'sign-up'
                            ? 'Create account'
                            : mode === 'reset'
                            ? 'Send reset email'
                            : 'Sign in'}
                    </button>
                </form>

                {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
                {info && <p className="mt-4 text-sm text-emerald-400">{info}</p>}

                <div className="mt-6 flex flex-col gap-2 text-xs text-neutral-400">
                    {mode === 'sign-in' && (
                        <>
                            <button type="button" onClick={() => setMode('sign-up')} className="text-left hover:text-neutral-200">
                                Don't have an account? Create one
                            </button>
                            <button type="button" onClick={() => setMode('reset')} className="text-left hover:text-neutral-200">
                                Forgot password?
                            </button>
                        </>
                    )}
                    {mode === 'sign-up' && (
                        <button type="button" onClick={() => setMode('sign-in')} className="text-left hover:text-neutral-200">
                            Already have an account? Sign in
                        </button>
                    )}
                    {mode === 'reset' && (
                        <button type="button" onClick={() => setMode('sign-in')} className="text-left hover:text-neutral-200">
                            Back to sign in
                        </button>
                    )}
                </div>

                <button
                    type="button"
                    onClick={() => signOut()}
                    className="mt-6 w-full text-center text-[10px] uppercase tracking-wider text-neutral-600 hover:text-neutral-400"
                >
                    Skip — use offline only
                </button>
            </div>
        </div>
    );
};

export default SignIn;
