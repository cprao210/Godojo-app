/**
 * AuthChrome.tsx
 *
 * Visual chrome shared by every auth screen (SignIn, EmailVerification):
 * the radial background gradient, the ambient glow behind the card, and the
 * logo. `AuthDecorativeLines` (the glowing curved lines + floating particles)
 * is split out separately since only SignIn uses it.
 */

import React from 'react';
import { motion } from 'framer-motion';
import { IMAGES } from '@/lib/assets';

// ─── Background gradient + ambient glow ──────────────────────────────────────

export const AuthBackground: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <>
        <div
            className="absolute inset-0"
            style={{
                background: isLight
                    ? 'radial-gradient(ellipse at 50% 20%, #ffffff 0%, #eef2fb 45%, #e2e8f5 100%)'
                    : 'radial-gradient(ellipse at 50% 20%, #0f1d3a 0%, #070b18 45%, #03050b 100%)',
            }}
        />
        <div
            className={`pointer-events-none absolute left-1/2 top-1/2 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[120px] ${isLight ? 'bg-blue-300/30' : 'bg-blue-600/20'
                }`}
        />
    </>
);

// ─── Glowing curved lines + floating particles (SignIn only) ────────────────

export const AuthDecorativeLines: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <>
        <svg
            className={`pointer-events-none absolute left-0 top-0 h-full w-[40%] ${isLight ? 'opacity-40' : 'opacity-50'}`}
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
            className={`pointer-events-none absolute right-0 top-0 h-full w-[40%] -scale-x-100 ${isLight ? 'opacity-40' : 'opacity-50'}`}
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
                    className={`absolute rounded-full ${isLight ? 'bg-blue-500' : 'bg-blue-400'}`}
                    style={{
                        left: `${left}%`,
                        top: `${top}%`,
                        width: size,
                        height: size,
                        filter: 'blur(0.5px)',
                        boxShadow: isLight ? '0 0 8px rgba(59,130,246,0.5)' : '0 0 8px rgba(96,165,250,0.8)',
                    }}
                    animate={{ opacity: [0.2, 0.9, 0.2], y: [0, -10, 0] }}
                    transition={{ duration: 4 + (i % 5), repeat: Infinity, delay: i * 0.2, ease: 'easeInOut' }}
                />
            );
        })}
    </>
);

// ─── Logo ─────────────────────────────────────────────────────────────────────

export const AuthLogo: React.FC = () => (
    <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-6 flex items-center justify-center gap-2"
    >
        <img src={IMAGES.godojoLogoV3} alt="GoDojo AI" className="h-10 object-contain" />
    </motion.div>
);

// ─── Outer page shell (draggable area + theme background classes) ──────────

export const AuthPageShell: React.FC<{ isLight: boolean; children: React.ReactNode }> = ({ isLight, children }) => (
    <div
        className={`relative draggable-area w-full overflow-hidden ${isLight ? 'bg-[#f4f6fb] text-slate-900' : 'bg-[#05070d] text-white'
            } font-[Inter,ui-sans-serif,system-ui] antialiased`}
    >
        {children}
    </div>
);