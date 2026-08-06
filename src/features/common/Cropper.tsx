import React from 'react';
import { useCropper } from '@/hooks';
import CropperHud from './CropperHud';

/**
 * Cropper component provides a visual interface for selecting a screen area.
 *
 * DESIGN NOTES:
 * 1. Undetectable UI: Instead of using system cursors (like cursor: crosshair), which
 *    are visible on screen shares, we use 'cursor: default' and draw custom guides
 *    on the Canvas. Since the window is protected, these guides are invisible to viewers.
 * 2. State Reset: The component listens for 'reset-cropper' IPC events because the
 *    window is reused (Windows) and doesn't unmount between captures.
 * 3. Theme-aware: Supports light/dark themes for consistent UX.
 * 4. mouseUp is also handled at window level (via useEffect) so dragging outside the
 *    viewport still completes the selection instead of leaving it stuck.
 *
 * All state, canvas rendering, and IPC wiring now live in useCropper — this
 * component only owns rendering.
 */
const Cropper: React.FC = () => {
    const { startPos, hudPosition, isLightTheme, canvasRef, hudRef, handleMouseDown, handleMouseMove, handleMouseUp } =
        useCropper();

    return (
        <div
            className="w-screen h-screen cursor-default overflow-hidden bg-transparent select-none"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
        >
            <canvas ref={canvasRef} className="block pointer-events-none" />

            {/* Clean HUD — shown only when not actively dragging */}
            {!startPos && hudPosition && (
                <CropperHud hudRef={hudRef} position={hudPosition} isLightTheme={isLightTheme} />
            )}
        </div>
    );
};

export default Cropper;