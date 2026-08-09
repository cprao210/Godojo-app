// Shown after email/password sign-up until the user's email is verified.
// Polls Firebase every 4 seconds and auto-advances when verified.
//
// All polling/resend/sign-out state lives in useEmailVerification; this
// component only owns rendering, reusing the same background chrome as
// SignIn.

import React from 'react';
import { motion } from 'framer-motion';
import { Mail, RefreshCw, LogOut, CheckCircle } from 'lucide-react';
import { useResolvedTheme, useEmailVerification } from '@/hooks';
import { EmailVerificationProps } from '@/types';
import { AuthBackground, AuthLogo, AuthPageShell } from '@/features/auth';

export const EmailVerification: React.FC<EmailVerificationProps> = ({ user, onVerified }) => {

    const isLight = useResolvedTheme() === 'light';

    const { verified, resendCooldown, resendBusy, resendInfo, resendError, handleResend, handleSignOut } = useEmailVerification({ user, onVerified });

    const textPrimary = isLight ? 'text-slate-900' : 'text-white';
    const textSecondary = isLight ? 'text-slate-500' : 'text-slate-400';
    const cardBg = isLight
        ? 'border-slate-200/80 bg-white/80 shadow-[0_30px_80px_-30px_rgba(30,58,138,0.25)]'
        : 'border-white/10 bg-white/[0.03] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]';

    return (
        <AuthPageShell isLight={isLight}>
            <AuthBackground isLight={isLight} />

            <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-10">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                    className="w-full max-w-[420px]"
                >
                    <AuthLogo />

                    {/* Card */}
                    <div className={`relative rounded-2xl border p-8 backdrop-blur-xl ${cardBg}`}>
                        <div className="flex flex-col items-center text-center">
                            {/* Icon */}
                            <motion.div
                                initial={{ scale: 0.7, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={{ delay: 0.1, type: 'spring', stiffness: 300 }}
                                className={`mb-5 flex h-16 w-16 items-center justify-center rounded-full ${verified
                                    ? 'bg-emerald-500/15'
                                    : isLight
                                        ? 'bg-blue-100'
                                        : 'bg-blue-500/15'
                                    }`}
                            >
                                {verified ? (
                                    <CheckCircle
                                        size={32}
                                        className="text-emerald-500"
                                    />
                                ) : (
                                    <Mail
                                        size={32}
                                        className={isLight ? 'text-blue-500' : 'text-blue-400'}
                                    />
                                )}
                            </motion.div>

                            <h1 className={`text-2xl font-semibold tracking-tight ${textPrimary}`}>
                                {verified ? 'Email verified!' : 'Verify your email'}
                            </h1>

                            <p className={`mt-2 text-sm leading-relaxed ${textSecondary}`}>
                                {verified ? (
                                    'Taking you to the app…'
                                ) : (
                                    <>
                                        We sent a verification link to{' '}
                                        <span className={`font-medium ${isLight ? 'text-slate-700' : 'text-slate-200'}`}>
                                            {user.email}
                                        </span>
                                        .<br />
                                        Click the link in that email to continue.
                                    </>
                                )}
                            </p>

                            {!verified && (
                                <>
                                    {/* Animated waiting indicator */}
                                    <div className="mt-6 flex items-center gap-2">
                                        {[0, 1, 2].map((i) => (
                                            <motion.span
                                                key={i}
                                                className={`h-2 w-2 rounded-full ${isLight ? 'bg-blue-400' : 'bg-blue-500'
                                                    }`}
                                                animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
                                                transition={{
                                                    duration: 1.2,
                                                    repeat: Infinity,
                                                    delay: i * 0.3,
                                                    ease: 'easeInOut',
                                                }}
                                            />
                                        ))}
                                        <span className={`ml-1 text-xs ${textSecondary}`}>
                                            Waiting for verification…
                                        </span>
                                    </div>

                                    {/* Resend button */}
                                    <button
                                        onClick={handleResend}
                                        disabled={resendBusy || resendCooldown > 0}
                                        className={`mt-6 flex items-center gap-2 rounded-xl border px-5 py-2.5 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${isLight
                                            ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                            : 'border-white/10 bg-white/[0.04] text-white hover:bg-white/[0.07]'
                                            }`}
                                    >
                                        <RefreshCw
                                            size={14}
                                            className={resendBusy ? 'animate-spin' : ''}
                                        />
                                        {resendCooldown > 0
                                            ? `Resend in ${resendCooldown}s`
                                            : resendBusy
                                                ? 'Sending…'
                                                : 'Resend email'}
                                    </button>

                                    {resendInfo && (
                                        <p className="mt-3 text-sm text-emerald-400">{resendInfo}</p>
                                    )}
                                    {resendError && (
                                        <p className="mt-3 text-sm text-red-400">{resendError}</p>
                                    )}

                                    {/* Sign out link */}
                                    <button
                                        onClick={handleSignOut}
                                        className={`mt-5 flex items-center gap-1.5 text-xs transition-colors ${isLight
                                            ? 'text-slate-400 hover:text-slate-600'
                                            : 'text-slate-500 hover:text-slate-300'
                                            }`}
                                    >
                                        <LogOut size={12} />
                                        Use a different account
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </motion.div>
            </div>
        </AuthPageShell>
    );
};