import { ForwardRefExoticComponent, RefAttributes, useEffect, useState } from "react";
import { motion, type Variants } from "framer-motion";
import { User, Phone, Mail, Lock, Eye, EyeOff, Sparkles, LucideProps, LoaderCircle, X } from "lucide-react";
import { signInWithGoogle, signInWithEmail, signUpWithEmailExtended, resetPassword, getAuthErrorMessage } from '../lib/firebase';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import godojoLogo from '../assets/logo-variant-3.svg';

interface SignInProps {
    onSignedIn?: () => void;
    bannerMessage?: string | null;
    onBannerDismiss?: () => void;
}

const fieldVariants: Variants = {
    hidden: { opacity: 0, y: 12 },
    show: (i: number) => ({
        opacity: 1,
        y: 0,
        transition: { delay: 0.15 + i * 0.07, duration: 0.5, ease: "easeOut" as const },
    }),
};

function GoogleIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35.5 24 35.5c-6.4 0-11.5-5.1-11.5-11.5S17.6 12.5 24 12.5c2.9 0 5.6 1.1 7.7 2.9l5.7-5.7C33.9 6.4 29.2 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.3-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 12.5 24 12.5c2.9 0 5.6 1.1 7.7 2.9l5.7-5.7C33.9 6.4 29.2 4.5 24 4.5 16.3 4.5 9.7 8.9 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 43.5c5.1 0 9.7-1.9 13.2-5l-6.1-5c-2 1.4-4.5 2.2-7.1 2.2-5.3 0-9.7-3.1-11.3-7.5l-6.5 5C9.6 39 16.2 43.5 24 43.5z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.1 5C41.8 35.8 43.5 30.3 43.5 24c0-1.2-.1-2.3-.4-3.5z" />
        </svg>
    );
}

type FieldValuesType = {
    icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>;
    type: "text" | "tel" | "email" | "password";
    name: "email" | "password" | "displayName" | "phoneNumber";
    placeholder: string;
}

export const SignIn: React.FC<SignInProps> = ({ onSignedIn, bannerMessage, onBannerDismiss }) => {

    const [mode, setMode] = useState<'sign-in' | 'sign-up' | 'reset'>('sign-in');
    const [userData, setUserData] = useState({ email: "", password: "", displayName: "", phoneNumber: "" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);
    const [showPassword, setShowPassword] = useState(false);

    // Set to a User object after email/password sign-up until email is verified
    const [pendingVerificationUser, setPendingVerificationUser] = useState<import('firebase/auth').User | null>(null);

    const isLight = useResolvedTheme() === 'light';

    const [googleBusy, setGoogleBusy] = useState(false);
    const [hasAnimated, setHasAnimated] = useState(false);

    const fields: FieldValuesType[] = mode === 'sign-up' ? [
        { icon: User, type: "text", name: "displayName", placeholder: "Full name" },
        { icon: Phone, type: "tel", name: "phoneNumber", placeholder: "Phone number (optional)" },
        { icon: Mail, type: "email", name: "email", placeholder: "you@example.com" },
    ] : [
        { icon: Mail, type: "email", name: "email", placeholder: "you@example.com" },
    ];

    useEffect(() => {
        setHasAnimated(true);
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {

        e.preventDefault();
        const name = e.target.name;
        const value = e.target.value;
        setUserData({ ...userData, [name]: value });

    }

    const handleGoogle = async () => {

        setError(null);
        setGoogleBusy(true);
        setBusy(true);

        try {
            await signInWithGoogle();
        } catch (e: any) {
            const msg: string = e?.message ?? '';
            if (!msg.toLowerCase().includes('cancelled') && !msg.toLowerCase().includes('closed')) {
                setError(getAuthErrorMessage(e) || 'Google sign-in failed. Please try again.');
            }
        } finally {
            setGoogleBusy(false);
            setBusy(false);
            setUserData({ email: "", password: "", phoneNumber: "", displayName: "" });
        }

    };

    const handleSubmit = async (e: React.FormEvent) => {

        e.preventDefault();
        setError(null);
        setInfo(null);
        setBusy(true);

        try {

            const { email, password, displayName, phoneNumber } = userData;

            if (mode === 'sign-up') {
                await signUpWithEmailExtended({ email, password, displayName, phoneNumber });
                // Do not call onSignedIn. Firebase fires onAuthStateChanged which
                // subscribeAuthState in App.tsx intercepts. If emailVerified=false
                // it shows EmailVerification; if true it opens the app.
            } else if (mode === 'sign-in') {
                await signInWithEmail(email, password);
            } else if (mode === 'reset') {
                await resetPassword(email);
                setInfo('Password reset email sent.');
                setMode('sign-in');
            }

        } catch (err: any) {
            setError(getAuthErrorMessage(err) || 'Authentication failed. Please try again.');
        } finally {
            setBusy(false);
            setUserData({ email: "", password: "", phoneNumber: "", displayName: "" });
        }

    };

    const handleKeyDown = (e: any) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleSubmit(e);
        }
    };

    return (
        <div className={`relative draggable-area w-full overflow-hidden ${isLight ? "bg-[#f4f6fb] text-slate-900" : "bg-[#05070d] text-white"} font-[Inter,ui-sans-serif,system-ui] antialiased`}>
            {/* Radial gradient background */}
            <div className="absolute inset-0"
                style={{
                    background: isLight
                        ? "radial-gradient(ellipse at 50% 20%, #ffffff 0%, #eef2fb 45%, #e2e8f5 100%)"
                        : "radial-gradient(ellipse at 50% 20%, #0f1d3a 0%, #070b18 45%, #03050b 100%)",
                }}
            />

            {/* Glowing curved lines */}
            <svg
                className={`pointer-events-none absolute left-0 top-0 h-full w-[40%] ${isLight ? "opacity-40" : "opacity-50"}`}
                viewBox="0 0 400 800"
                fill="none"
                preserveAspectRatio="none"
            >
                <defs>
                    <linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity="0" />
                        <stop offset="50%" stopColor="#60a5fa" stopOpacity="0.7" />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                    </linearGradient>
                </defs>
                <path d="M-50 100 Q150 250 50 450 T200 800" stroke="url(#lg1)" strokeWidth="1" />
                <path d="M-80 200 Q120 350 20 550 T180 850" stroke="url(#lg1)" strokeWidth="1" />
                <path d="M-20 50 Q200 200 80 400 T250 750" stroke="url(#lg1)" strokeWidth="0.7" />
            </svg>

            <svg
                className={`pointer-events-none absolute right-0 top-0 h-full w-[40%] -scale-x-100 ${isLight ? "opacity-40" : "opacity-50"}`}
                viewBox="0 0 400 800"
                fill="none"
                preserveAspectRatio="none"
            >
                <path d="M-50 100 Q150 250 50 450 T200 800" stroke="url(#lg1)" strokeWidth="1" />
                <path d="M-80 200 Q120 350 20 550 T180 850" stroke="url(#lg1)" strokeWidth="1" />
                <path d="M-20 50 Q200 200 80 400 T250 750" stroke="url(#lg1)" strokeWidth="0.7" />
            </svg>

            {/* Floating particles */}
            {Array.from({ length: 22 }).map((_, i) => {
                const left = (i * 53) % 100;
                const top = (i * 37) % 100;
                const size = 1 + (i % 3);
                return (
                    <motion.span
                        key={i}
                        className={`absolute rounded-full ${isLight ? "bg-blue-500" : "bg-blue-400"}`}
                        style={{
                            left: `${left}%`,
                            top: `${top}%`,
                            width: size,
                            height: size,
                            filter: "blur(0.5px)",
                            boxShadow: isLight
                                ? "0 0 8px rgba(59,130,246,0.5)"
                                : "0 0 8px rgba(96,165,250,0.8)",
                        }}
                        animate={{
                            opacity: [0.2, 0.9, 0.2],
                            y: [0, -10, 0],
                        }}
                        transition={{
                            duration: 4 + (i % 5),
                            repeat: Infinity,
                            delay: i * 0.2,
                            ease: "easeInOut",
                        }}
                    />
                );
            })}

            {/* Ambient glow behind card */}
            <div className={`pointer-events-none absolute left-1/2 top-1/2 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[120px] ${isLight ? "bg-blue-300/30" : "bg-blue-600/20"
                }`} />

            {/* Content */}
            <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-10">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                    className="w-full max-w-[420px]"
                >
                    {/* Logo */}
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5 }}
                        className="mb-6 flex items-center justify-center gap-2"
                    >
                        {/* <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-400 to-blue-600 shadow-[0_0_20px_rgba(59,130,246,0.6)]">
                            <Sparkles size={16} className="text-white" />
                        </div>
                        <span className={`text-xl font-semibold tracking-tight ${isLight ? "text-slate-900" : "text-white"}`}>
                            GoDojo AI
                        </span> */}
                        <img src={godojoLogo} alt="GoDojo AI" className="h-10 object-contain" />
                    </motion.div>

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
                                {fields.map((f, i) => {
                                    const Icon = f.icon;
                                    return (
                                        <motion.div
                                            key={f.placeholder}
                                            custom={i + 2}
                                            variants={fieldVariants}
                                            initial={hasAnimated ? false : "hidden"}
                                            animate="show"
                                            className="group relative"
                                        >
                                            <Icon
                                                size={16}
                                                className={`absolute left-3.5 top-1/2 -translate-y-1/2 transition-colors ${isLight
                                                    ? "text-slate-400 group-focus-within:text-blue-500"
                                                    : "text-slate-500 group-focus-within:text-blue-400"
                                                    }`}
                                            />
                                            <input
                                                type={f.type}
                                                name={f.name}
                                                value={userData[f.name]}
                                                onKeyDown={handleKeyDown}
                                                onChange={handleChange}
                                                placeholder={f.placeholder}
                                                className={`w-full rounded-xl border py-3 pl-10 pr-4 text-sm outline-none transition-all ${isLight
                                                    ? "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:shadow-[0_0_0_3px_rgba(59,130,246,0.15)]"
                                                    : "border-white/10 bg-white/[0.03] text-white placeholder:text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] focus:border-blue-500/50 focus:bg-white/[0.05] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.15),inset_0_1px_0_rgba(255,255,255,0.05)]"
                                                    }`}
                                            />
                                        </motion.div>
                                    );
                                })}

                                {/* Password */}
                                {mode !== "reset" && <motion.div
                                    className="group relative"
                                    custom={5}
                                    variants={fieldVariants}
                                    initial={hasAnimated ? false : "hidden"}
                                    animate="show"
                                >
                                    <Lock
                                        size={16}
                                        className={`absolute left-3.5 top-1/2 -translate-y-1/2 transition-colors ${isLight
                                            ? "text-slate-400 group-focus-within:text-blue-500"
                                            : "text-slate-500 group-focus-within:text-blue-400"
                                            }`}
                                    />
                                    <input
                                        type={showPassword ? "text" : "password"}
                                        name="password"
                                        value={userData.password}
                                        onKeyDown={handleKeyDown}
                                        onChange={handleChange}
                                        placeholder="Password"
                                        className={`w-full rounded-xl border py-3 pl-10 pr-10 text-sm outline-none transition-all ${isLight
                                            ? "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:shadow-[0_0_0_3px_rgba(59,130,246,0.15)]"
                                            : "border-white/10 bg-white/[0.03] text-white placeholder:text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] focus:border-blue-500/50 focus:bg-white/[0.05] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.15),inset_0_1px_0_rgba(255,255,255,0.05)]"
                                            }`}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword((v) => !v)}
                                        className={`absolute right-3 top-1/2 -translate-y-1/2 transition-colors ${isLight ? "text-slate-400 hover:text-slate-700" : "text-slate-500 hover:text-slate-300"
                                            }`}
                                        aria-label="Toggle password visibility"
                                    >
                                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </motion.div>}

                                {mode === "sign-in" && <button onClick={() => setMode("reset")} className="text-xs mb-4 w-full flex justify-end text-blue-500 hover:text-blue-400">
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
                                <button onClick={() => setMode(mode === "sign-up" ? 'sign-in' : "sign-up")} className={`font-medium ${isLight ? "text-blue-600 hover:text-blue-700" : "text-blue-400 hover:text-blue-300"}`}>
                                    {mode === "sign-in" ? "Create one" : "Sign in"}
                                </button>
                            </motion.p>

                        </div>
                    </motion.div>

                    {/* <motion.button
                        initial={{ opacity: 0 }}
                        onClick={() => signOut()}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.9 }}
                        className="mt-3 flex w-full justify-center text-center text-xs tracking-[0.2em] text-slate-600 transition-colors hover:text-slate-400"
                    >
                        SKIP — USE OFFLINE ONLY
                    </motion.button> */}
                </motion.div>
            </div>
        </div>
    );
}

