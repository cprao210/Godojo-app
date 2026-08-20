import React from 'react';
import { Crosshair } from 'lucide-react';

interface CropperHudProps {
    hudRef: React.RefObject<HTMLDivElement>;
    position: { x: number; y: number };
    isLightTheme: boolean;
}

// The floating "Select area / ESC to cancel" pill shown while the Cropper is
// waiting for a drag to start. Pulled out of Cropper.tsx so the instructional
// HUD markup lives in one reusable place, separate from the canvas/selection logic.
const CropperHud: React.FC<CropperHudProps> = ({ hudRef, position, isLightTheme }) => {
    return (
        <div
            ref={hudRef}
            className="absolute pointer-events-none animate-fade-in-up"
            style={{
                left: position.x,
                top: position.y
            }}
        >
            <div
                className="flex items-center gap-3 px-4 py-2 rounded-full"
                style={{
                    background: isLightTheme
                        ? 'rgba(255, 255, 255, 0.9)'
                        : 'rgba(28, 28, 32, 0.92)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: isLightTheme
                        ? '1px solid rgba(0, 0, 0, 0.06)'
                        : '1px solid rgba(255, 255, 255, 0.08)',
                    boxShadow: isLightTheme
                        ? '0 4px 24px -4px rgba(0, 0, 0, 0.12)'
                        : '0 4px 24px -4px rgba(0, 0, 0, 0.4)',
                }}
            >
                <div
                    className="flex items-center justify-center w-7 h-7 rounded-lg"
                    style={{ background: 'rgba(59, 130, 246, 0.15)' }}
                >
                    <Crosshair className="w-4 h-4" style={{ color: '#3b82f6' }} />
                </div>

                <span
                    className="text-sm font-medium"
                    style={{
                        color: isLightTheme ? '#000000' : '#ffffff',
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
                    }}
                >
                    Select area
                </span>

                <div
                    className="h-4 w-px mx-1"
                    style={{
                        background: isLightTheme
                            ? 'rgba(0, 0, 0, 0.1)'
                            : 'rgba(255, 255, 255, 0.15)'
                    }}
                />

                <div className="flex items-center gap-1.5">
                    <span
                        className="text-[10px] font-medium uppercase tracking-wider"
                        style={{
                            color: isLightTheme
                                ? 'rgba(0, 0, 0, 0.5)'
                                : 'rgba(255, 255, 255, 0.5)'
                        }}
                    >
                        ESC
                    </span>
                    <span
                        className="text-[10px]"
                        style={{
                            color: isLightTheme
                                ? 'rgba(0, 0, 0, 0.4)'
                                : 'rgba(255, 255, 255, 0.4)'
                        }}
                    >
                        to cancel
                    </span>
                </div>
            </div>
        </div>
    );
};

export default CropperHud;