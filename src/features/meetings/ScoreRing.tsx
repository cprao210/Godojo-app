import React from 'react';
import { motion } from 'framer-motion';
import type { RingProps } from '@/types';

// ─── Mini circular ring (compact, 48px) ──────────────────────────────────────
export const ScoreRing: React.FC<RingProps> = ({ score, color, size = 48, strokeWidth = 3.5 }) => {
    const r = (size - strokeWidth * 2) / 2;
    const circ = 2 * Math.PI * r;
    const cx = size / 2;
    return (
        <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
                <circle cx={cx} cy={cx} r={r} fill="none" stroke={`${color}1e`} strokeWidth={strokeWidth} />
                <motion.circle
                    cx={cx} cy={cx} r={r} fill="none"
                    stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
                    strokeDasharray={circ}
                    initial={{ strokeDashoffset: circ }}
                    animate={{ strokeDashoffset: circ - (score / 100) * circ }}
                    transition={{ duration: 0.8, ease: [0.33, 1, 0.68, 1] }}
                    style={{ filter: `drop-shadow(0 0 3px ${color}88)` }}
                />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
                <span className="font-bold tabular-nums" style={{ fontSize: size * 0.27, color, lineHeight: 1 }}>{score}</span>
            </div>
        </div>
    );
};

export default ScoreRing;