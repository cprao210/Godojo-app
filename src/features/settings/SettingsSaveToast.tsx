// SettingsSaveToast.tsx
//
// Single toast host for the settings modal. Listens on settingsToastBus and
// renders "Saved Successfully" / error messages, one at a time, auto-
// dismissing after a few seconds. Mounted once in SettingsOverlay so every
// tab's save handler — regardless of which hook it lives in — can trigger
// it by importing settingsToast and calling .success()/.error().

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { subscribeSettingsToast, SettingsToastEvent } from '@/lib/settingsToastBus';

const AUTO_DISMISS_MS = 3200;

interface SettingsSaveToastProps {
    isLight: boolean;
}

export const SettingsSaveToast: React.FC<SettingsSaveToastProps> = ({ isLight }) => {
    const [toast, setToast] = useState<SettingsToastEvent | null>(null);

    useEffect(() => {
        const unsubscribe = subscribeSettingsToast((event) => {
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
                    initial={{ y: 16, opacity: 0, scale: 0.95 }}
                    animate={{ y: 0, opacity: 1, scale: 1 }}
                    exit={{ y: 10, opacity: 0, scale: 0.96 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    className={[
                        'fixed bottom-6 left-1/2 -translate-x-1/2 z-[600]',
                        'flex items-center gap-2.5 pl-3.5 pr-4 py-2.5 rounded-2xl backdrop-blur-xl saturate-[180%] ring-1 ring-black/10',
                        isLight
                            ? 'bg-bg-elevated/95 border border-border-muted shadow-[0_8px_32px_rgba(0,0,0,0.15),inset_0_1px_0_rgba(255,255,255,0.9)]'
                            : 'bg-bg-card/85 border border-border-subtle shadow-[0_30px_70px_-20px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.06)]',
                    ].join(' ')}
                    role="status"
                    aria-live="polite"
                >
                    <div className={[
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                        isSuccess
                            ? isLight ? 'bg-green-100 text-green-600' : 'bg-green-500/15 text-green-400'
                            : isLight ? 'bg-red-100 text-red-600' : 'bg-red-500/15 text-red-400',
                    ].join(' ')}>
                        {isSuccess ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                    </div>
                    <span className="text-[13px] font-medium text-text-primary leading-none max-w-[320px] truncate">
                        {toast.message}
                    </span>
                </motion.div>
            )}
        </AnimatePresence>
    );
};