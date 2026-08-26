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

import React, { useEffect, useState } from 'react';
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
}) => {
    // Inactive panels animate to opacity:0 but stay mounted (so their internal
    // state — countdown timers, chat history, scroll — survives a panel switch).
    // opacity:0 alone keeps the element painted, so its backdrop-filter and
    // contents keep compositing every frame while hidden: wasted work, and a
    // real cost on software-composited machines. Once the fade-out COMPLETES we
    // flip to visibility:hidden so it stops painting entirely; becoming
    // interactive again reveals it immediately (before the fade-in) so nothing
    // pops in blank. Gating on animation completion preserves the cross-fade.
    // visibility:hidden (not display:none) keeps the layout box, so the dock's
    // height measurements are unaffected.
    const [renderHidden, setRenderHidden] = useState(!isInteractive);

    useEffect(() => {
        if (isInteractive) setRenderHidden(false);
    }, [isInteractive]);

    return (
        <motion.div
            initial={initial}
            animate={animate}
            exit={exit}
            transition={transition}
            onAnimationComplete={() => {
                if (!isInteractive) setRenderHidden(true);
            }}
            className="fixed left-[5px]"
            style={{
                position: 'fixed',
                top: panelTopOffset,
                pointerEvents: isInteractive ? 'auto' : 'none',
                visibility: renderHidden ? 'hidden' : 'visible',
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
};