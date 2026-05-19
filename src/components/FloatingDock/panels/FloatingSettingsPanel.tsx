import React from 'react';
import { motion } from 'framer-motion';
import { Settings, EyeOff, Zap, AlignLeft, Camera, Eye, Cpu, MousePointerClick } from 'lucide-react';
import { ShortcutConfig } from '../../../hooks/useShortcuts';
import { ModelSelector } from '../../ui/ModelSelector';

interface AnimatedToggleProps {
    value: boolean;
    onChange: (v: boolean) => void;
    accentColor?: string;
}

const AnimatedToggle: React.FC<AnimatedToggleProps> = ({
    value,
    onChange,
    accentColor = '#3b82f6',
}) => {
    return (
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
};

interface SettingRowProps {
    icon: React.ReactNode;
    label: string;
    iconColor?: string;
    children: React.ReactNode;
    divider?: boolean;
    emphasis?: boolean;
}

const SettingRow: React.FC<SettingRowProps> = ({
    icon, label, iconColor = 'rgba(255,255,255,0.35)', children, divider, emphasis
}) => (
    <>
        <div className="flex items-center justify-between px-5 py-4">
            <div className="flex items-center gap-3.5">
                <span style={{ color: iconColor }}>{icon}</span>
                <span
                    className={`text-[13px] tracking-widest uppercase font-semibold`}
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

interface FloatingSettingsPanelProps {
    showTranscript: boolean;
    onToggleTranscript: (v: boolean) => void;
    isMousePassthrough: boolean;
    onToggleMousePassthrough: () => void;
    isUndetectable: boolean;
    onToggleGhost: () => void;
    shortcuts: ShortcutConfig;
    // Model selection (moved from chat input)
    currentModel: string;
    onSelectModel: (m: string) => void;
}

export const FloatingSettingsPanel: React.FC<FloatingSettingsPanelProps> = ({
    showTranscript,
    onToggleTranscript,
    isMousePassthrough,
    onToggleMousePassthrough,
    isUndetectable,
    onToggleGhost,
    shortcuts,
    currentModel,
    onSelectModel,
}) => {
    const screenshotKeys = shortcuts.takeScreenshot || ['Ctrl', 'H'];
    const showHideKeys = shortcuts.toggleVisibility || ['Ctrl', 'B'];

    return (
        <div
            className="rounded-2xl overflow-hidden"
            style={{
                width: 420,
                background: 'rgba(14, 18, 30, 0.93)',
                backdropFilter: 'blur(28px) saturate(180%)',
                WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 4px 24px rgba(0,0,0,0.4)',
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
                    icon={<EyeOff size={18} strokeWidth={1.8} />}
                    label="Ghost Mode"
                    iconColor={isUndetectable ? '#10b981' : 'rgba(255,255,255,0.35)'}
                    emphasis={isUndetectable}
                    divider
                >
                    <AnimatedToggle
                        value={isUndetectable}
                        onChange={onToggleGhost}
                        accentColor="#10b981"
                    />
                </SettingRow>

                <SettingRow
                    icon={<MousePointerClick size={18} strokeWidth={1.8} />}
                    label="Click-Through"
                    divider
                >
                    <AnimatedToggle
                        value={isMousePassthrough}
                        onChange={onToggleMousePassthrough}
                    />
                </SettingRow>

                <SettingRow
                    icon={<AlignLeft size={18} strokeWidth={1.8} style={{ color: showTranscript ? '#3b82f6' : undefined }} />}
                    label="Transcript"
                    iconColor={showTranscript ? '#3b82f6' : 'rgba(255,255,255,0.35)'}
                    emphasis={showTranscript}
                    divider
                >
                    <AnimatedToggle
                        value={showTranscript}
                        onChange={onToggleTranscript}
                        accentColor="#3b82f6"
                    />
                </SettingRow>

                {/* Model Selector Row */}
                <div className="px-5 py-4 flex justify-between items-center" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div className="flex items-center gap-3.5 mb-3">
                        <span style={{ color: 'rgba(255,255,255,0.35)' }}>
                            <Cpu size={18} strokeWidth={1.8} />
                        </span>
                        <span className="text-[13px] tracking-widest uppercase font-semibold" style={{ color: 'rgba(255,255,255,0.45)' }}>
                            Chat AI Model
                        </span>
                    </div>
                    <div className="pl-[30px]">
                        <ModelSelector currentModel={currentModel} onSelectModel={onSelectModel} />
                    </div>
                </div>

                <div style={{ height: 1, background: 'rgba(255,255,255,0.04)', margin: '4px 0' }} />

                <SettingRow
                    icon={<Camera size={18} strokeWidth={1.8} />}
                    label="Screenshot"
                    divider
                >
                    <KeyBadge keys={screenshotKeys} />
                </SettingRow>

                <SettingRow
                    icon={<Eye size={18} strokeWidth={1.8} />}
                    label="Show / Hide"
                >
                    <KeyBadge keys={showHideKeys} />
                </SettingRow>
            </div>
        </div>
    );
};