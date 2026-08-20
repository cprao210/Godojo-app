import React from 'react';
import { motion } from 'framer-motion';
import { useNextMeetingCountdown } from '@/hooks';

/** Countdown ring — shows time remaining as an SVG arc */
export function NextMeetingCountdownRing({ startTime, isLight }: { startTime: string; isLight: boolean }) {
    const display = useNextMeetingCountdown(startTime);

    // Arc: full circle = 60 min = 282.6 circumference
    const radius = 52;
    const circ = 2 * Math.PI * radius;
    // Progress fraction based on how far from 60 min window the meeting is
    const maxSecs = 60 * 60; // 60 min window
    const fraction = Math.min(display.total / maxSecs, 1);
    const dashOffset = circ * (1 - fraction);

    const isStartingNow = display.total <= 0;

    return (
        <div className="flex flex-col items-center justify-center shrink-0">
            <div className="relative flex items-center justify-center w-[130px] h-[130px]">
                {/* Track ring */}
                <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 130 130">
                    <circle
                        cx="65" cy="65" r={radius}
                        fill="none"
                        stroke={isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)'}
                        strokeWidth="5"
                    />
                    {/* Progress arc */}
                    <motion.circle
                        cx="65" cy="65" r={radius}
                        fill="none"
                        stroke={isStartingNow ? '#10b981' : '#3b82f6'}
                        strokeWidth="5"
                        strokeLinecap="round"
                        strokeDasharray={circ}
                        initial={{ strokeDashoffset: circ }}
                        animate={{ strokeDashoffset: dashOffset }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                        style={{
                            filter: isStartingNow
                                ? `drop-shadow(0 0 ${isLight ? '3px' : '6px'} rgba(16,185,129,${isLight ? '0.35' : '0.7'}))`
                                : `drop-shadow(0 0 ${isLight ? '3px' : '6px'} rgba(59,130,246,${isLight ? '0.35' : '0.7'}))`,
                        }}
                    />
                </svg>

                {/* Center text */}
                <div className="relative flex flex-col items-center leading-none">
                    {isStartingNow ? (
                        <span className="text-[11px] font-bold text-emerald-400 tracking-wide">NOW</span>
                    ) : (
                        <>
                            <span className={`text-[9px] font-medium mb-0.5 ${isLight ? 'text-slate-400' : 'text-slate-400'}`}>
                                {display.label}
                            </span>
                            <span className={`font-bold tabular-nums leading-none ${display.hrs > 0 ? 'text-[17px]' : 'text-[22px]'} ${isLight ? 'text-slate-800' : 'text-white'}`}>
                                {display.hrs > 0
                                    ? `${String(display.hrs).padStart(2, '0')}:${String(display.mins).padStart(2, '0')}:${String(display.secs).padStart(2, '0')}`
                                    : `${String(display.mins).padStart(2, '0')}:${String(display.secs).padStart(2, '0')}`
                                }
                            </span>
                            <span className={`text-[9px] font-medium mt-0.5 ${isLight ? 'text-slate-400' : 'text-slate-400'}`}>
                                {display.hrs > 0 ? 'hr' : 'min'}
                            </span>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}