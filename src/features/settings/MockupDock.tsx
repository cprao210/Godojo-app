import React from 'react';
import { Camera, Eye, AlignLeft, Layers, Radio, Brain, Ghost, Pause, StopCircle, GripVertical, Settings } from 'lucide-react';
import { OVERLAY_OPACITY_MIN } from '@/lib/overlayAppearance';

// Fake in-meeting settings panel + dock bar, rendered at the live preview
// opacity so the user can see exactly what their chosen transparency will
// look like in a real meeting before committing to it.
export const MockupDock: React.FC<{ opacity: number }> = ({ opacity }) => {
    const pct = Math.round(((opacity - OVERLAY_OPACITY_MIN) / (1 - OVERLAY_OPACITY_MIN)) * 100);
    const trackBg = `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${pct}%, rgba(255,255,255,0.12) ${pct}%, rgba(255,255,255,0.12) 100%)`;

    return (
        <div className="flex flex-col items-center gap-2 pointer-events-none select-none w-full">
            {/* Settings panel */}
            <div className="rounded-2xl overflow-hidden" style={{
                width: 340, opacity,
                background: 'rgba(14,18,30,0.93)',
                backdropFilter: `blur(${Math.round(opacity * 24)}px) saturate(180%)`,
                border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
            }}>
                {/* Header */}
                <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'rgba(100,116,139,0.15)', border: '1px solid rgba(100,116,139,0.25)' }}>
                        <Settings size={13} strokeWidth={1.8} className="text-slate-400" />
                    </div>
                    <span className="text-[11px] font-bold text-white tracking-widest uppercase">Settings</span>
                </div>
                {/* Transcript row */}
                <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div className="flex items-center gap-2.5">
                        <AlignLeft size={14} strokeWidth={1.8} style={{ color: 'rgba(255,255,255,0.35)' }} />
                        <span className="text-[10px] tracking-widest uppercase font-semibold" style={{ color: 'rgba(255,255,255,0.45)' }}>Transcript</span>
                    </div>
                    <div className="w-8 h-4 rounded-full relative" style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.12)' }}>
                        <div className="absolute top-[2px] left-[2px] w-3 h-3 rounded-full" style={{ background: 'rgba(255,255,255,0.4)' }} />
                    </div>
                </div>
                {/* Transparency row — live */}
                <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2.5">
                            <Layers size={14} strokeWidth={1.8} style={{ color: '#3b82f6' }} />
                            <span className="text-[10px] tracking-widest uppercase font-semibold" style={{ color: 'rgba(255,255,255,0.85)' }}>Interface Opacity</span>
                        </div>
                        <span className="text-[10px] font-bold tabular-nums" style={{ color: '#3b82f6' }}>
                            {Math.round(opacity * 100)}%
                        </span>
                    </div>
                    <div className="w-full h-[3px] rounded-full" style={{ background: trackBg }} />
                    <div className="flex justify-between mt-1">
                        <span className="text-[8px]" style={{ color: 'rgba(255,255,255,0.25)' }}>More Stealth</span>
                        <span className="text-[8px]" style={{ color: 'rgba(255,255,255,0.25)' }}>Fully Visible</span>
                    </div>
                </div>
                {/* Shortcut rows */}
                {([
                    { icon: <Camera size={13} strokeWidth={1.8} />, label: 'Screenshot', keys: ['⌘', 'H'] },
                    { icon: <Eye size={13} strokeWidth={1.8} />, label: 'Show / Hide', keys: ['⌘', '⇧', 'B'] },
                ] as const).map(({ icon, label, keys }) => (
                    <div key={label} className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <div className="flex items-center gap-2.5">
                            <span style={{ color: 'rgba(255,255,255,0.35)' }}>{icon}</span>
                            <span className="text-[10px] tracking-widest uppercase font-semibold" style={{ color: 'rgba(255,255,255,0.45)' }}>{label}</span>
                        </div>
                        <div className="flex justify-center items-center gap-1">
                            {keys.map((k, i) => (
                                <React.Fragment key={i}>
                                    <span className="text-[10px] font-bold text-white/40 h-6 w-6 rounded flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', fontFamily: 'monospace' }}>{k}</span>
                                    {i < keys.length - 1 && <span className="text-white/20 text-[8px]">+</span>}
                                </React.Fragment>
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            {/* Dock bar */}
            <div className="flex items-center gap-2 px-2.5 py-2.5 rounded-2xl" style={{
                width: 340, opacity,
                background: `rgba(18,22,34,${opacity})`,
                backdropFilter: `blur(${Math.round(opacity * 20)}px) saturate(180%)`,
                border: '1px solid rgba(255,255,255,0.09)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
            }}>
                {[<Radio size={17} strokeWidth={1.6} />, <Brain size={17} strokeWidth={1.6} />, <Ghost size={17} strokeWidth={1.6} />].map((icon, i) => (
                    <div key={i} className="flex items-center justify-center w-9 h-9 rounded-xl" style={{ color: 'rgba(255,255,255,0.5)' }}>{icon}</div>
                ))}
                <div className="w-px h-6 mx-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }} />
                <div className="flex items-center justify-center w-9 h-9 rounded-xl" style={{ color: 'rgba(255,255,255,0.4)' }}><Pause size={17} strokeWidth={1.6} /></div>
                <div className="flex items-center justify-center w-9 h-9 rounded-xl" style={{ color: 'rgba(239,68,68,0.7)' }}><StopCircle size={17} strokeWidth={1.6} /></div>
                {/* Settings active */}
                <div className="flex items-center justify-center w-9 h-9 rounded-xl relative" style={{ background: 'rgba(100,116,139,0.18)', color: 'rgba(255,255,255,0.9)' }}>
                    <Settings size={17} strokeWidth={1.6} />
                    <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-slate-400" />
                </div>
                <div className="w-px h-6 mx-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }} />
                <div className="flex items-center justify-center w-9 h-9 rounded-xl" style={{ color: 'rgba(255,255,255,0.2)' }}><GripVertical size={15} strokeWidth={2} /></div>
            </div>
        </div>
    );
};

export default MockupDock;