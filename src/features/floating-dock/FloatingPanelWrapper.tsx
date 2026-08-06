/**
 * FloatingPanelWrapper.tsx
 *
 * All three dock panels (Intelligence, Chat, Settings) render inside an
 * identically-positioned `fixed` box that sits `panelTopOffset` above the
 * dock, plus an optional "frozen mode" overlay that blocks interaction. This
 * component is that shared shell — each panel only supplies its own
 * animate/initial/exit motion values (they differ slightly: Intelligence is
 * always mounted and cross-fades, Chat mounts on first open, Settings
 * mounts/unmounts with AnimatePresence).
 */

import React from 'react';
import { motion, type TargetAndTransition, type Transition, type VariantLabels } from 'framer-motion';

interface FloatingPanelWrapperProps {
    /** Distance (px) from the top of the viewport — dockHeight + gap, from useFloatingDock. */
    panelTopOffset: number;
    /** Whether freeze mode's click-blocking overlay should render for this panel. */
    showFrozenOverlay: boolean;
    initial?: boolean | TargetAndTransition | VariantLabels;
    animate: TargetAndTransition | VariantLabels;
    exit?: TargetAndTransition | VariantLabels;
    transition?: Transition;
    /** Whether this panel is currently the interactive one (controls pointer-events). */
    isInteractive?: boolean;
    children: React.ReactNode;
}

export const FloatingPanelWrapper: React.FC<FloatingPanelWrapperProps> = ({
    panelTopOffset,
    showFrozenOverlay,
    initial,
    animate,
    exit,
    transition,
    isInteractive = true,
    children,
}) => (
    <motion.div
        initial={initial}
        animate={animate}
        exit={exit}
        transition={transition}
        className="fixed left-[65px]"
        style={{
            position: 'fixed',
            top: panelTopOffset,
            pointerEvents: isInteractive ? 'auto' : 'none',
        }}
    >
        {showFrozenOverlay && (
            <div
                className="absolute inset-0 rounded-2xl z-50"
                style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.10)', cursor: 'not-allowed' }}
            />
        )}
        {children}
    </motion.div>
);