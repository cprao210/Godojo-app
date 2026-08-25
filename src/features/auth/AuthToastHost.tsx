// AuthToastHost.tsx
//
// Single toast host for auth-flow feedback (Google sign-in, email/password
// sign-in, sign-up, password reset, resend verification). Listens on
// authToastBus and renders success/error messages, one at a time,
// auto-dismissing after a few seconds.
//
// Mounted ONCE at the App root (not inside SignIn/EmailVerification) —
// `fixed` bottom-right positioning is anchored to the OS window's viewport
// on purpose here, which is exactly what a standard bottom-right toast
// wants. This sidesteps the earlier center-under-the-card approach
// entirely: there's no dependency on the sign-in card's box, so there's
// nothing for it to drift out of alignment with on resize/maximize/minimize.
//
// Deliberately not theme-aware (unlike SettingsSaveToast, which threads an
// isLight prop from the settings overlay's own theme hook) — auth screens
// render before/outside that context, and the launcher root is dark by
// default, so a single dark-friendly style is used here.

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { subscribeAuthToast, AuthToastEvent } from '@/lib/authToastBus';

const AUTO_DISMISS_MS = 3200;

export const AuthToastHost: React.FC = () => {
    const [toast, setToast] = useState<AuthToastEvent | null>(null);

    useEffect(() => {
        const unsubscribe = subscribeAuthToast((event) => {
            setToast(event);
        });
        return unsubscribe;
    }, []);

    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), AUTO_DISMISS_MS);
        return () => clearTimeout(timer);
    }, [toast]);

    const isSuccess = toast?.variant === 'success';

    return (
        <AnimatePresence>
            {toast && (
                <motion.div
                    key={toast.id}
                    initial={{ x: 60, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: 40, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                    className="fixed bottom-6 right-6 z-[600] flex items-center gap-2.5 pl-3.5 pr-4 py-2.5 rounded-2xl backdrop-blur-xl saturate-[180%] ring-1 ring-black/10 bg-bg-card/85 border border-border-subtle shadow-[0_30px_70px_-20px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.06)] max-w-[320px]"
                    role="status"
                    aria-live="polite"
                >
                    <div className={[
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                        isSuccess ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400',
                    ].join(' ')}>
                        {isSuccess ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                    </div>
                    <span className="text-[13px] font-medium text-text-primary leading-snug">
                        {toast.message}
                    </span>
                </motion.div>
            )}
        </AnimatePresence>
    );
};