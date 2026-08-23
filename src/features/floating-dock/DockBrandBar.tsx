/**
 * DockBrandBar.tsx
 *
 * A slim, always-visible brand + collapse bar that floats just ABOVE the
 * floating dock pill (with a gap). It exists so users have an obvious,
 * persistent way to open/close the active panel — previously the only way to
 * dismiss a panel was to click its dock icon again, which wasn't discoverable.
 *
 * Left: GoDojo logo + wordmark. Right: a chevron that reflects/toggles state —
 *   • dock is expanded  → ChevronUp  (△) → click collapses it, hiding the
 *     nav dock AND whichever panel was open (brand bar stays visible)
 *   • dock is collapsed → ChevronDown (▽) → click expands it, showing the
 *     nav dock + the last-active panel (or Intelligence on first expand)
 *
 * This bar is the ONLY thing visible on meeting start — the nav dock and all
 * panels stay hidden until the user first clicks the chevron.
 *
 * Styling mirrors the dock pill (same dark-HUD background + the shared
 * `opacity` from the appearance slider) so the two read as one control stack,
 * identical across light/dark app theme.
 */

import React from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { IMAGES } from '@/lib/assets';

interface DockBrandBarProps {
    /** Whether the nav dock + panel are currently expanded — drives the chevron direction + action. */
    isExpanded: boolean;
    /** Collapse the nav dock + panel, or expand them when collapsed. */
    onToggle: () => void;
    /** Shared dock opacity (from the appearance slider) so the bar matches the pill. */
    opacity: number;
}

export const DockBrandBar: React.FC<DockBrandBarProps> = ({ isExpanded, onToggle, opacity }) => (
    <div
        className="flex items-center justify-between gap-3 px-3 py-1.5 rounded-xl cursor-grab active:cursor-grabbing draggable-area"
        style={{
            minWidth: 160,
            background: `rgba(18, 22, 34, ${opacity})`,
            border: '1px solid rgba(255,255,255,0.09)',
        }}
    >
        {/* Brand — GoDojo logo mark + wordmark */}
        <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0">
                <img src={IMAGES.godojoLogoIcon} alt="GoDojo AI" className="w-4 h-4 object-contain" />
            </div>
            <span className="text-[12px] font-semibold tracking-wide text-white/85">GoDojo AI</span>
        </div>

        {/* Expand / collapse the active panel */}
        <button
            onClick={onToggle}
            title={isExpanded ? 'Collapse' : 'Expand'}
            aria-label={isExpanded ? 'Collapse dock' : 'Expand dock'}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-white/70 transition-colors active:scale-95 no-drag"
        >
            {isExpanded ? <ChevronUp size={16} strokeWidth={2.4} /> : <ChevronDown size={16} strokeWidth={2.4} />}
        </button>
    </div>
);

export default DockBrandBar;
