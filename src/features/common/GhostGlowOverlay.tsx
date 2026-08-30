/**
 * GhostGlowOverlay.tsx
 *
 * App-wide "Ghost Mode is ON" indicator for the launcher window. Replaces the
 * old dashed border that framed the launcher content — which, sitting at a
 * higher z-index than the Settings / Dashboard overlays, bled on top of them
 * and drew a hard line across their controls (e.g. the "Quit GoDojo" /
 * "Back to GoDojo" buttons).
 *
 * Instead this paints a soft, slowly breathing glow that hugs the window edges.
 * It's rendered once at the app root, sits above every screen but below the
 * persistent top bar, and is pointer-events-none — so the user always knows the
 * app is hidden from screen capture, without any hard edge crossing the UI.
 *
 * Self-contained: owns its own Ghost Mode subscription + theme, so callers just
 * mount <GhostGlowOverlay /> with no props.
 */

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useUndetectable } from '@/hooks/useUndetectable';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';

export const GhostGlowOverlay: React.FC = () => {
    const isUndetectable = useUndetectable();
    const isLight = useResolvedTheme() === 'light';

    // Steady frame — always on while active so the state reads unmistakably.
    // Light mode is toned down so it doesn't flood the near-white canvas.
    const baseGlow = isLight
        ? [
            // On a near-white canvas pale blue vanishes, so use a defined edge
            // and a more saturated blue-600/700 with higher alpha to stay legible.
            'inset 0 0 0 2px rgba(37,99,235,0.55)',
            'inset 0 0 20px rgba(37,99,235,0.30)',
            'inset 0 0 52px 4px rgba(29,78,216,0.16)',
        ].join(', ')
        : [
            'inset 0 0 0 1.5px rgba(96,165,250,0.50)',
            'inset 0 0 20px rgba(59,130,246,0.32)',
            'inset 0 0 46px 2px rgba(37,99,235,0.20)',
        ].join(', ');

    // Brighter layer that breathes on top of the base for a subtle "alive" feel.
    // Only opacity animates (compositor-friendly), never box-shadow/layout.
    const pulseGlow = isLight
        ? [
            'inset 0 0 30px rgba(37,99,235,0.36)',
            'inset 0 0 76px 10px rgba(79,70,229,0.20)',
        ].join(', ')
        : [
            'inset 0 0 26px rgba(96,165,250,0.42)',
            'inset 0 0 82px 8px rgba(79,70,229,0.22)',
        ].join(', ');

    // Breathing floor: dark mode can swing wide for a dramatic pulse, but on a
    // near-white canvas the trough must stay high enough to still read as "on".
    const pulseRange = isLight ? [0.6, 1, 0.6] : [0.35, 1, 0.35];

    return (
        <AnimatePresence>
            {isUndetectable && (
                <motion.div
                    key="ghost-glow"
                    className="pointer-events-none fixed inset-0 z-[70]"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                    aria-hidden
                >
                    {/* Steady frame */}
                    <div className="absolute inset-0 rounded-[11px]" style={{ boxShadow: baseGlow }} />
                    {/* Breathing accent */}
                    <motion.div
                        className="absolute inset-0 rounded-[11px]"
                        style={{ boxShadow: pulseGlow, willChange: 'opacity' }}
                        animate={{ opacity: pulseRange }}
                        transition={{ duration: 3.8, ease: 'easeInOut', repeat: Infinity }}
                    />
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default GhostGlowOverlay;
