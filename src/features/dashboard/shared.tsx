/**
 * shared.tsx
 *
 * Small, framework-free presentational helpers reused across the dashboard
 * feature (ManagerDashboard + AeDetailView): the avatar color/initials
 * pickers and the generic pulse-skeleton block every skeleton is built from.
 */

import React from 'react';

// ─── Avatar color + initials ─────────────────────────────────────────────────

export const AVATAR_PALETTE = [
    { bg: 'bg-blue-500/15', text: 'text-blue-400' },
    { bg: 'bg-violet-500/15', text: 'text-violet-400' },
    { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
    { bg: 'bg-amber-500/15', text: 'text-amber-400' },
    { bg: 'bg-pink-500/15', text: 'text-pink-400' },
    { bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
];

export function avatarColorFor(key: string) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export function initialsFor(name: string) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

// ─── Generic pulse-skeleton block ────────────────────────────────────────────
// Shown in place of "No data" / '—' copy while a request is in flight, so the
// dashboard reads as "still fetching" rather than "there's nothing here".

export const Skeleton: React.FC<{ className?: string; isLight: boolean; style?: React.CSSProperties }> = ({ className = '', isLight, style }) => (
    <div
        className={`animate-pulse rounded-md ${isLight ? 'bg-slate-200' : 'bg-white/10'} ${className}`}
        style={style}
    />
);