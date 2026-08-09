/**
 * DockChrome.tsx
 *
 * Small cosmetic pieces of the dock bar itself (not full panels): the
 * vertical divider used between button groups, and the drag handle at the
 * end of the dock. Split out so FloatingDock's render stays focused on
 * layout/composition rather than these one-off style blocks.
 */

import React from 'react';
import { motion } from 'framer-motion';
import { GripVertical } from 'lucide-react';

/** Thin vertical rule used to visually group dock buttons. */
export const DockDivider: React.FC = () => (
    <div className="w-px h-8 mx-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }} />
);

/** Grip icon at the end of the dock — purely visual affordance for the drag area. */
export const DockDragHandle: React.FC = () => (
    <motion.div
        className="flex items-center justify-center w-10 h-10 rounded-xl transition-colors cursor-grab active:cursor-grabbing"
        whileHover={{ backgroundColor: 'rgba(255,255,255,0.07)' }}
        whileTap={{ scale: 0.95 }}
        title="Drag to move"
        style={{ touchAction: 'none' }}
    >
        <GripVertical size={18} className="text-white/30" strokeWidth={2} />
    </motion.div>
);

/** Small pulsing dot shown on the pause button while the meeting is paused. */
export const PausedIndicatorDot: React.FC = () => (
    <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
);