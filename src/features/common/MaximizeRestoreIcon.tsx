/**
 * MaximizeRestoreIcon.tsx — the two-state glyph for the maximize/restore
 * window-control button (a single square when the window can be maximized,
 * an overlapping-squares "restore" glyph when it's already maximized).
 */

import React from 'react';

export const MaximizeRestoreIcon: React.FC<{ isMaximized: boolean }> = ({ isMaximized }) =>
    isMaximized ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5" y="3" width="8" height="8" rx="0.5" />
            <path d="M3 5V11C3 11.5523 3.44772 12 4 12H10" />
        </svg>
    ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3.5" y="3.5" width="9" height="9" rx="0.5" />
        </svg>
    );