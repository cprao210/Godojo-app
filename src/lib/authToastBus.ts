// Minimal pub/sub bus for auth-flow feedback — Google sign-in, email/password
// sign-in, sign-up, password reset, resend verification. Same shape as
// settingsToastBus.ts, but mounted at the App root (not inside the Settings
// modal) since auth happens on SignIn/EmailVerification, well outside
// Settings' component tree.

export type AuthToastVariant = 'success' | 'error';

export interface AuthToastEvent {
    id: number;
    variant: AuthToastVariant;
    message: string;
}

type Listener = (event: AuthToastEvent) => void;

let listeners: Listener[] = [];
let counter = 0;

export function subscribeAuthToast(fn: Listener): () => void {
    listeners.push(fn);
    return () => {
        listeners = listeners.filter((l) => l !== fn);
    };
}

function emit(variant: AuthToastVariant, message: string) {
    counter += 1;
    const event: AuthToastEvent = { id: counter, variant, message };
    listeners.forEach((fn) => fn(event));
}

export const authToast = {
    success: (message: string) => emit('success', message),
    error: (message: string) => emit('error', message),
};