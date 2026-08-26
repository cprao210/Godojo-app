import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { DockButtonProps } from '@/types';

export const DockButton: React.FC<DockButtonProps> = ({ icon, tooltip, isActive, activeColor = '#3b82f6', dangerColor = false, showActiveDot = false, frozen = false, onClick, zIndex, isPerformanceMode = false }) => {

    const [showTooltip, setShowTooltip] = useState(false);
    const tooltipTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleMouseEnter = () => {
        tooltipTimerRef.current = setTimeout(() => setShowTooltip(true), 150);
    };

    const handleMouseLeave = () => {
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        setShowTooltip(false);
    };

    // Clear any pending tooltip timer if the component unmounts mid-hover,
    // preventing a setState call on an unmounted component.
    useEffect(() => {
        return () => {
            if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        };
    }, []);

    const iconColor = dangerColor
        ? '#ef4444'
        : isActive
            ? activeColor
            : 'rgba(255,255,255,0.65)';

    const bgColor = isActive
        ? dangerColor
            ? 'rgba(239,68,68,0.12)'
            : `${activeColor}18`
        : 'transparent';

    return (
        <div
            className="relative flex items-center justify-center"
            style={{ zIndex }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            {/* Tooltip */}
            <AnimatePresence>
                {showTooltip && (
                    <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 2 }}
                        transition={{ duration: 0.14, ease: 'easeOut' }}
                        // className="absolute bottom-[calc(100%+10px)] -translate-x-1/2 pointer-events-none z-50 whitespace-nowrap"
                        className="absolute top-5 left-[calc(100%-10px)] -translate-x-1/2 pointer-events-none z-50 whitespace-nowrap"
                    >
                        <div
                            className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold tracking-wide text-white"
                            style={{
                                background: 'rgba(10,14,26,0.95)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                                backdropFilter: isPerformanceMode ? 'none' : 'blur(12px)',
                            }}
                        >
                            {tooltip}
                        </div>
                        {/* Tooltip caret */}
                        <div
                            className="absolute top-full left-1/2 -translate-x-1/2"
                            style={{
                                width: 0,
                                height: 0,
                                borderLeft: '5px solid transparent',
                                borderRight: '5px solid transparent',
                                borderTop: '5px solid rgba(10,14,26,0.95)',
                            }}
                        />
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Button */}
            <motion.button
                onClick={frozen ? undefined : onClick}
                whileHover={frozen ? {} : { scale: 1.08 }}
                whileTap={frozen ? {} : { scale: 0.93 }}
                transition={{ type: 'spring', damping: 20, stiffness: 400 }}
                className="relative flex items-center justify-center w-11 h-11 rounded-xl transition-colors duration-150"
                style={{
                    color: iconColor,
                    background: bgColor,
                    cursor: frozen ? 'not-allowed' : 'pointer',
                    opacity: frozen ? 0.4 : 1,
                }}
            >
                {/* Glow ring when active */}
                {isActive && !dangerColor && (
                    <motion.div
                        layoutId={`glow-${tooltip}`}
                        className="absolute inset-0 rounded-xl"
                        style={{
                            boxShadow: `0 0 16px ${activeColor}30, inset 0 0 8px ${activeColor}15`,
                            border: `1px solid ${activeColor}30`,
                        }}
                    />
                )}

                {icon}

                {/* Active dot indicator */}
                {showActiveDot && isActive && (
                    <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        exit={{ scale: 0 }}
                        className="absolute bottom-[1px] -translate-x-1/2"
                    >
                        <span
                            className="block w-1.5 h-1.5 rounded-full"
                            style={{
                                background: activeColor,
                                boxShadow: `0 0 6px ${activeColor}, 0 0 12px ${activeColor}80`,
                            }}
                        />
                    </motion.div>
                )}
            </motion.button>
        </div>
    );
};