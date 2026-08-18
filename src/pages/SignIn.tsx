/**
 * SignIn.tsx
 *
 * Auth screen covering sign-in, sign-up, and password reset in a single
 * card (mode switch, not separate routes). All state and Firebase calls
 * live in useSignIn; this component only owns rendering.
 */

import { useEffect } from "react";
import { LoaderCircle, X } from "lucide-react";
import { motion } from "framer-motion";
import { useResolvedTheme, useSignIn } from '@/hooks';
import { SignInProps } from "@/types";
import { AuthBackground, AuthDecorativeLines, AuthLogo, AuthPageShell } from '@/features/auth';
import { AuthFormField, PasswordField, fieldVariants, GoogleIcon } from '@/features/auth';
import { posthogAnalytics } from "@/lib/analytics/posthog.service";

export const SignIn: React.FC<SignInProps> = ({ bannerMessage, onBannerDismiss }) => {

    const isLight = useResolvedTheme() === 'light';

    // Fires once on mount, independent of which mode (sign-in / sign-up /
    // reset) the user lands on or later switches to — this is one screen
    // for page-view purposes, per the spec ("no matter of login or signup").
    useEffect(() => {
        posthogAnalytics.trackPageView('registration');
    }, []);

    const signInStates = useSignIn();

    const { mode, setMode, toggleSignInSignUp, userData, fields, showPassword } = signInStates;
    const { togglePasswordVisibility, busy, googleBusy, error, info, hasAnimated } = signInStates;
    const { handleChange, handleGoogle, handleSubmit, handleKeyDown } = signInStates;

    return (
        <AuthPageShell isLight={isLight}>
            <AuthBackground isLight={isLight} />
            <AuthDecorativeLines isLight={isLight} />

            {/* Content */}
            <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-10">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                    className="w-full max-w-[420px]"
                >
                    <AuthLogo />

                    {bannerMessage && (
                        <motion.div
                            initial={{ opacity: 0, y: -8 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
                        >
                            <span className="flex-1">{bannerMessage}</span>
                            {onBannerDismiss && (
                                <button onClick={onBannerDismiss} className="mt-0.5 shrink-0 opacity-60 hover:opacity-100">
                                    <X size={14} />
                                </button>
                            )}
                        </motion.div>
                    )}

                    {/* Card */}
                    <motion.div
                        className={`relative rounded-2xl border p-8 backdrop-blur-xl sm:p-6 ${isLight
                            ? "border-slate-200/80 bg-white/80 shadow-[0_30px_80px_-30px_rgba(30,58,138,0.25),0_0_60px_-20px_rgba(59,130,246,0.15)]"
                            : "border-white/10 bg-white/[0.03] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8),0_0_60px_-20px_rgba(59,130,246,0.3)]"
                            }`}
                    >
                        {/* subtle gradient border glow */}
                        <div className={`pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b via-transparent to-transparent ${isLight ? "from-blue-500/5" : "from-blue-500/10"
                            }`} />

                        <div className="relative">

                            <motion.h1
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.1, duration: 0.5 }}
                                className={`text-2xl font-semibold tracking-tight ${isLight ? "text-slate-900" : "text-white"}`}
                            >
                                {mode === 'sign-up' ? 'Create account' : mode === 'reset' ? 'Reset password' : 'Welcome back!'}
                            </motion.h1>

                            <motion.p
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 0.18, duration: 0.5 }}
                                className={`${mode === "reset" ? "mt-1 mb-2" : "mt-1"} text-sm ${isLight ? "text-slate-500" : "text-slate-400"}`}
                            >
                                {mode === "sign-up" ?
                                    "Create your account to get started" :
                                    mode === 'sign-in' ?
                                        "Sign in to your account" : "Create a new password for your account"
                                }
                            </motion.p>

                            {/* Google */}
                            {mode !== "reset" && <motion.button
                                custom={0}
                                variants={fieldVariants}
                                initial={hasAnimated ? false : "hidden"}
                                animate="show"
                                onClick={handleGoogle}
                                disabled={busy}
                                whileHover={{ scale: 1.01 }}
                                whileTap={{ scale: 0.98 }}
                                className={`mt-3 flex w-full items-center justify-center gap-3 rounded-xl border py-3 text-sm font-medium transition-shadow disabled:opacity-60 disabled:cursor-not-allowed ${isLight
                                    ? "border-slate-200 bg-white text-slate-800 hover:shadow-[0_8px_25px_-8px_rgba(59,130,246,0.35)]"
                                    : "border-white/10 bg-white/[0.04] text-white hover:shadow-[0_0_25px_-5px_rgba(96,165,250,0.5)]"
                                    }`}
                            >
                                {googleBusy ? (
                                    <>
                                        {/* Spinner */}
                                        <svg className="animate-spin h-4 w-4 text-neutral-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                                        </svg>
                                        <span className="text-neutral-500">Opening Google sign-in…</span>
                                    </>
                                ) : (
                                    <>
                                        <GoogleIcon />
                                        Continue with Google
                                    </>
                                )}
                            </motion.button>}

                            {/* Divider */}
                            {mode !== "reset" && <motion.div
                                custom={1}
                                variants={fieldVariants}
                                initial={hasAnimated ? false : "hidden"}
                                animate="show"
                                className="my-3 flex items-center gap-3"
                            >
                                <div className={`h-px flex-1 ${isLight ? "bg-slate-200" : "bg-white/10"}`} />
                                <span className={`text-xs tracking-wider ${isLight ? "text-slate-400" : "text-slate-500"}`}>OR</span>
                                <div className={`h-px flex-1 ${isLight ? "bg-slate-200" : "bg-white/10"}`} />
                            </motion.div>}

                            {/* Form */}
                            <form onSubmit={handleSubmit} className="space-y-3">
                                {fields.map((f, i) => (
                                    <AuthFormField
                                        key={f.placeholder}
                                        icon={f.icon}
                                        type={f.type}
                                        name={f.name}
                                        value={userData[f.name]}
                                        placeholder={f.placeholder}
                                        isLight={isLight}
                                        animationIndex={i + 2}
                                        hasAnimated={hasAnimated}
                                        onChange={handleChange}
                                        onKeyDown={handleKeyDown}
                                    />
                                ))}

                                {/* Password */}
                                {mode !== "reset" && (
                                    <PasswordField
                                        value={userData.password}
                                        isLight={isLight}
                                        animationIndex={5}
                                        hasAnimated={hasAnimated}
                                        showPassword={showPassword}
                                        onToggleVisibility={togglePasswordVisibility}
                                        onChange={handleChange}
                                        onKeyDown={handleKeyDown}
                                    />
                                )}

                                {mode === "sign-in" && <button type="button" onClick={() => {
                                    posthogAnalytics.trackForgotPasswordClicked();
                                    setMode("reset");
                                }} className="text-xs mb-4 w-full flex justify-end text-blue-500 hover:text-blue-400">
                                    Forgot password?
                                </button>}

                                {/* Submit */}
                                <motion.button
                                    custom={6}
                                    variants={fieldVariants}
                                    initial="hidden"
                                    animate="show"
                                    disabled={busy}
                                    whileHover={{ scale: 1.01, y: -1 }}
                                    whileTap={{ scale: 0.98 }}
                                    transition={{ type: "spring", stiffness: 400, damping: 17 }}
                                    type="submit"
                                    className={`mt-2 w-full flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 py-3 text-sm font-semibold text-white ${isLight ? "shadow-[0_6px_18px_-6px_rgba(59,130,246,0.35),inset_0_1px_0_rgba(255,255,255,0.18)]" : "shadow-[0_10px_30px_-5px_rgba(59,130,246,0.6),inset_0_1px_0_rgba(255,255,255,0.2)]"} transition-shadow ${isLight ? "hover:shadow-[0_10px_24px_-6px_rgba(59,130,246,0.45),inset_0_1px_0_rgba(255,255,255,0.2)]" : "hover:shadow-[0_15px_40px_-5px_rgba(59,130,246,0.8),inset_0_1px_0_rgba(255,255,255,0.2)]"}`}
                                >
                                    {busy
                                        ? <LoaderCircle className="h-5 w-5 animate-spin" />
                                        : mode === 'sign-up'
                                            ? 'Create account'
                                            : mode === 'reset'
                                                ? 'Send reset email'
                                                : 'Sign in'}
                                </motion.button>
                            </form>

                            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
                            {info && <p className="mt-3 text-sm text-emerald-400">{info}</p>}

                            <motion.p
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 0.7 }}
                                className={`mt-4 text-center text-sm ${isLight ? "text-slate-500" : "text-slate-400"}`}
                            >
                                {mode === "sign-up" ? "Already have an account? " : mode === "reset" ? "Back to " : "Don't have an account? "}
                                <button onClick={toggleSignInSignUp} className={`font-medium ${isLight ? "text-blue-600 hover:text-blue-700" : "text-blue-400 hover:text-blue-300"}`}>
                                    {mode === "sign-in" ? "Create one" : "Sign in"}
                                </button>
                            </motion.p>

                        </div>
                    </motion.div>
                </motion.div>
            </div>
        </AuthPageShell>
    );
}