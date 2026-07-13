import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Settings, AlignLeft, Camera, Eye, Cpu, MousePointerClick, Layers } from 'lucide-react';
import { ShortcutConfig } from '../../../hooks/useShortcuts';
import { ModelSelector } from '../../ui/ModelSelector';
import { OVERLAY_OPACITY_MIN } from '../../../lib/overlayAppearance';
import { isMac } from '../../../utils/platformUtils';

interface AnimatedToggleProps {
    value: boolean;
    onChange: (v: boolean) => void;
    accentColor?: string;
}

// ── Platform-aware fallback keys for when the IPC keybinds haven't loaded yet ──
const mod = isMac ? '⌘' : 'Ctrl';
const shift = isMac ? '⇧' : 'Shift';
const SETTINGS_FALLBACKS: Partial<ShortcutConfig> = {
    takeScreenshot: [mod, 'H'],
    toggleVisibility: [mod, 'B'],
    selectiveScreenshot: [mod, shift, 'H'],
    toggleMousePassthrough: [mod, shift, 'B'],
};

function buildSettingsFallback(key: keyof typeof SETTINGS_FALLBACKS): string[] {
    return SETTINGS_FALLBACKS[key] ?? [];
}

const AnimatedToggle: React.FC<AnimatedToggleProps> = ({
    value,
    onChange,
    accentColor = '#3b82f6',
}) => (
    <motion.button
        onClick={() => onChange(!value)}
        className="relative shrink-0"
        style={{
            width: 44,
            height: 24,
            borderRadius: 12,
            background: value ? accentColor : 'rgba(255,255,255,0.1)',
            border: value ? `1px solid ${accentColor}60` : '1px solid rgba(255,255,255,0.12)',
            transition: 'background 0.25s ease, border 0.25s ease',
        }}
        whileTap={{ scale: 0.95 }}
    >
        <motion.div
            animate={{ x: value ? 22 : 2 }}
            transition={{ type: 'spring', damping: 22, stiffness: 400 }}
            className="absolute top-[3px] w-[16px] h-[16px] rounded-full"
            style={{
                background: value ? '#fff' : 'rgba(255,255,255,0.4)',
                boxShadow: value ? '0 1px 4px rgba(0,0,0,0.3)' : 'none',
            }}
        />
    </motion.button>
);

interface SettingRowProps {
    icon: React.ReactNode;
    label: string;
    iconColor?: string;
    children: React.ReactNode;
    divider?: boolean;
    emphasis?: boolean;
}

const SettingRow: React.FC<SettingRowProps> = ({
    icon, label, iconColor = 'rgba(255,255,255,0.35)', children, divider, emphasis,
}) => (
    <>
        <div className="flex items-center justify-between px-5 py-4">
            <div className="flex items-center gap-3.5">
                <span style={{ color: iconColor }}>{icon}</span>
                <span
                    className="text-[13px] tracking-widest uppercase font-semibold"
                    style={{ color: emphasis ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)' }}
                >
                    {label}
                </span>
            </div>
            {children}
        </div>
        {divider && <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '0 20px' }} />}
    </>
);

const KeyBadge: React.FC<{ keys: string[] }> = ({ keys }) => (
    <div className="flex items-center gap-1">
        {keys.map((k, i) => (
            <React.Fragment key={i}>
                <span
                    className="text-[11px] font-bold uppercase text-white/50 px-2 py-1 rounded-md"
                    style={{
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        fontFamily: 'monospace',
                        letterSpacing: '0.05em',
                    }}
                >
                    {k}
                </span>
                {i < keys.length - 1 && <span className="text-white/20 text-[10px]">+</span>}
            </React.Fragment>
        ))}
    </div>
);

// ── Opacity slider track/thumb styles injected once ──────────────────────────
const SLIDER_STYLE_ID = 'fsp-slider-style';
if (typeof document !== 'undefined' && !document.getElementById(SLIDER_STYLE_ID)) {
    const s = document.createElement('style');
    s.id = SLIDER_STYLE_ID;
    s.textContent = `
        .fsp-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 9999px; outline: none; cursor: pointer; }
        .fsp-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.5); cursor: pointer; transition: transform 0.1s ease; }
        .fsp-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
        .fsp-slider::-moz-range-thumb { width: 14px; height: 14px; border: none; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.5); cursor: pointer; }
    `;
    document.head.appendChild(s);
}

interface FloatingSettingsPanelProps {
    showTranscript: boolean;
    onToggleTranscript: (v: boolean) => void;
    shortcuts: ShortcutConfig;
    currentModel: string;
    onSelectModel: (m: string) => void;
    dockOpacity: number;
    onDockOpacityChange: (val: number) => void;
}

export const FloatingSettingsPanel: React.FC<FloatingSettingsPanelProps> = ({
    showTranscript,
    onToggleTranscript,
    shortcuts,
    currentModel,
    onSelectModel,
    dockOpacity,
    onDockOpacityChange,
}) => {
    const [localOpacity, setLocalOpacity] = useState(dockOpacity);
    const [isDragging, setIsDragging] = useState(false);

    const screenshotKeys = shortcuts.takeScreenshot?.length ? shortcuts.takeScreenshot : buildSettingsFallback('takeScreenshot');
    const showHideKeys = shortcuts.toggleVisibility?.length ? shortcuts.toggleVisibility : buildSettingsFallback('toggleVisibility');
    const showClickThroughKeys = shortcuts.toggleMousePassthrough?.length ? shortcuts.toggleMousePassthrough : buildSettingsFallback('toggleMousePassthrough');

    React.useEffect(() => {
        setLocalOpacity(dockOpacity);
    }, [dockOpacity]);

    const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = parseFloat(e.target.value);
        setLocalOpacity(val);
        onDockOpacityChange(val);
    };

    // Gradient track: dark left → blue accent right
    const pct = Math.round(((localOpacity - OVERLAY_OPACITY_MIN) / (1 - OVERLAY_OPACITY_MIN)) * 100);
    const trackBg = `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${pct}%, rgba(255,255,255,0.12) ${pct}%, rgba(255,255,255,0.12) 100%)`;

    return (
        <div
            className="rounded-2xl overflow-hidden"
            style={{
                width: 420,
                background: 'rgba(14, 18, 30, 0.93)',
                backdropFilter: 'blur(28px) saturate(180%)',
                WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.08)',
            }}
        >
            {/* Header */}
            <div
                className="flex items-center gap-3.5 px-5 py-4"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
            >
                <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center"
                    style={{ background: 'rgba(100,116,139,0.15)', border: '1px solid rgba(100,116,139,0.25)' }}
                >
                    <Settings size={17} className="text-slate-400" strokeWidth={1.8} />
                </div>
                <span className="text-[13px] font-bold text-white tracking-widest uppercase">Settings</span>
            </div>

            {/* Toggle rows */}
            <div>

                <SettingRow
                    icon={<AlignLeft size={18} strokeWidth={1.8} style={{ color: showTranscript ? '#3b82f6' : undefined }} />}
                    label="Transcript"
                    iconColor={showTranscript ? '#3b82f6' : 'rgba(255,255,255,0.35)'}
                    emphasis={showTranscript}
                    divider
                >
                    <AnimatedToggle value={showTranscript} onChange={onToggleTranscript} accentColor="#3b82f6" />
                </SettingRow>

                {/* Model Selector Row */}
                <div className="px-5 py-4 flex justify-between items-center" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div className="flex items-center gap-3.5 mb-3">
                        <span style={{ color: 'rgba(255,255,255,0.35)' }}>
                            <Cpu size={18} strokeWidth={1.8} />
                        </span>
                        <span className="text-[13px] tracking-widest uppercase font-semibold" style={{ color: 'rgba(255,255,255,0.45)' }}>
                            Active Model
                        </span>
                    </div>
                    <div className="pl-[30px]">
                        <ModelSelector currentModel={currentModel} onSelectModel={onSelectModel} />
                    </div>
                </div>

                {/* ── Dock Opacity Slider ─────────────────────────────────── */}
                <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3.5">
                            <Layers
                                size={18}
                                strokeWidth={1.8}
                                style={{ color: isDragging ? '#3b82f6' : 'rgba(255,255,255,0.35)', transition: 'color 0.2s ease' }}
                            />
                            <span
                                className="text-[13px] tracking-widest uppercase font-semibold"
                                style={{ color: isDragging ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)', transition: 'color 0.2s ease' }}
                            >
                                Interface Opacity
                            </span>
                        </div>
                        {/* Live % badge */}
                        <motion.span
                            key={Math.round(localOpacity * 100)}
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.15 }}
                            className="text-[12px] font-bold tabular-nums"
                            style={{
                                color: isDragging ? '#3b82f6' : 'rgba(255,255,255,0.5)',
                                minWidth: 36,
                                textAlign: 'right',
                                transition: 'color 0.2s ease',
                            }}
                        >
                            {Math.round(localOpacity * 100)}%
                        </motion.span>
                    </div>

                    <input
                        type="range"
                        min={OVERLAY_OPACITY_MIN}
                        max={1.0}
                        step={0.01}
                        value={localOpacity}
                        onChange={handleSliderChange}
                        onPointerDown={() => setIsDragging(true)}
                        onPointerUp={() => setIsDragging(false)}
                        onPointerCancel={() => setIsDragging(false)}
                        className="fsp-slider"
                        style={{ background: trackBg }}
                    />

                </div>

                {/* <SettingRow icon={<Camera size={18} strokeWidth={1.8} />} label="Screenshot" divider>
                    <KeyBadge keys={screenshotKeys} />
                </SettingRow> */}

                <SettingRow icon={<Eye size={18} strokeWidth={1.8} />} label="Show / Hide" divider>
                    <KeyBadge keys={showHideKeys} />
                </SettingRow>

                <SettingRow icon={<MousePointerClick size={18} strokeWidth={1.8} />} label="Click-Through">
                    <KeyBadge keys={showClickThroughKeys} />
                </SettingRow>

            </div>
        </div>
    );
};