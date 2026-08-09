/**
 * AuthFormField.tsx
 *
 * Reusable animated icon-prefixed input used by every field in the SignIn
 * form, plus a PasswordField variant that adds the show/hide toggle.
 */

import React from 'react';
import { motion, type Variants } from 'framer-motion';
import { Eye, EyeOff, Lock, type LucideIcon } from 'lucide-react';

// Shared entrance animation — each field fades/slides in with a staggered
// delay based on its `custom` index.
export const fieldVariants: Variants = {
    hidden: { opacity: 0, y: 12 },
    show: (i: number) => ({
        opacity: 1,
        y: 0,
        transition: { delay: 0.15 + i * 0.07, duration: 0.5, ease: 'easeOut' as const },
    }),
};

const inputCls = (isLight: boolean) =>
    `w-full rounded-xl border py-3 pl-10 pr-4 text-sm outline-none transition-all ${isLight
        ? 'border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:shadow-[0_0_0_3px_rgba(59,130,246,0.15)]'
        : 'border-white/10 bg-white/[0.03] text-white placeholder:text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] focus:border-blue-500/50 focus:bg-white/[0.05] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.15),inset_0_1px_0_rgba(255,255,255,0.05)]'
    }`;

const iconCls = (isLight: boolean) =>
    `absolute left-3.5 top-1/2 -translate-y-1/2 transition-colors ${isLight ? 'text-slate-400 group-focus-within:text-blue-500' : 'text-slate-500 group-focus-within:text-blue-400'
    }`;

interface AuthFormFieldProps {
    icon: LucideIcon;
    type: string;
    name: string;
    value: string;
    placeholder: string;
    isLight: boolean;
    animationIndex: number;
    hasAnimated: boolean;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
}

/** A single icon-prefixed text/email/tel input, animated in on first mount. */
export const AuthFormField: React.FC<AuthFormFieldProps> = ({ icon: Icon, type, name, value, placeholder, isLight, animationIndex, hasAnimated, onChange, onKeyDown }) => (

    <motion.div
        custom={animationIndex}
        variants={fieldVariants}
        initial={hasAnimated ? false : 'hidden'}
        animate="show"
        className="group relative"
    >
        <Icon size={16} className={iconCls(isLight)} />
        <input
            type={type}
            name={name}
            value={value}
            onKeyDown={onKeyDown}
            onChange={onChange}
            placeholder={placeholder}
            className={inputCls(isLight)}
        />
    </motion.div>
);

interface PasswordFieldProps {
    value: string;
    isLight: boolean;
    animationIndex: number;
    hasAnimated: boolean;
    showPassword: boolean;
    onToggleVisibility: () => void;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
}

/** The password input — same shell as AuthFormField, plus a show/hide toggle. */
export const PasswordField: React.FC<PasswordFieldProps> = ({ value, isLight, animationIndex, hasAnimated, showPassword, onToggleVisibility, onChange, onKeyDown }) => (
    <motion.div
        className="group relative"
        custom={animationIndex}
        variants={fieldVariants}
        initial={hasAnimated ? false : 'hidden'}
        animate="show"
    >
        <Lock size={16} className={iconCls(isLight)} />
        <input
            type={showPassword ? 'text' : 'password'}
            name="password"
            value={value}
            onKeyDown={onKeyDown}
            onChange={onChange}
            placeholder="Password"
            className={`${inputCls(isLight)} pr-10`}
        />
        <button
            type="button"
            onClick={onToggleVisibility}
            className={`absolute right-3 top-1/2 -translate-y-1/2 transition-colors ${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-500 hover:text-slate-300'
                }`}
            aria-label="Toggle password visibility"
        >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
    </motion.div>
);