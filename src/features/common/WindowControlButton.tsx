/**
 * WindowControlButton.tsx — shared shell for the three title-bar buttons
 * (minimize / maximize / close). They're identical except for the icon,
 * tooltip, click handler, and — for Close — a red hover state instead of
 * the neutral one.
 */

import React from 'react';

interface WindowControlButtonProps {
    icon: React.ReactNode;
    title: string;
    onClick: () => void;
    /** Close uses a red hover treatment; minimize/maximize use the neutral one. */
    variant?: 'default' | 'danger';
}

export const WindowControlButton: React.FC<WindowControlButtonProps> = ({ icon, title, onClick, variant = 'default' }) => (
    <button
        onClick={onClick}
        title={title}
        className={`flex items-center justify-center w-[46px] h-full border-0 bg-transparent text-text-secondary transition-colors duration-100 ${variant === 'danger' ? 'hover:text-white hover:bg-red-500' : 'hover:text-text-primary hover:bg-white/10'
            }`}
    >
        {icon}
    </button>
);