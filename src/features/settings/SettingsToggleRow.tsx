import React from 'react';
import ToggleSwitch from './ToggleSwitch';

interface SettingsToggleRowProps {
    icon: React.ReactNode;
    label: string;
    checked: boolean;
    onToggle: () => void;
    /** Toggle track color/glow when checked — see ToggleSwitch. */
    activeTrackClass: string;
    /** Label color when checked — usually near-black/near-white for emphasis. */
    activeLabelClass: string;
    isLightTheme: boolean;
    disabled?: boolean;
    /** Tooltip shown when the row is disabled (e.g. "requires a Groq key"). */
    disabledTitle?: string;
    /** True for rows without a hover affordance (most rows are cursor-default; this exists for parity with the original markup). */
    hoverClass: string;
    labelInactiveClass: string;
}

// One row = icon + label + toggle switch. Every toggle in SettingsPopup
// (Undetectable, Fast Response, Transcript, Interview Mode, Profile Mode)
// is this same shell with a different icon and a different "active" color —
// centralizing it here removes ~15 lines of duplicated layout markup per row.
const SettingsToggleRow: React.FC<SettingsToggleRowProps> = ({
    icon,
    label,
    checked,
    onToggle,
    activeTrackClass,
    activeLabelClass,
    isLightTheme,
    disabled,
    disabledTitle,
    hoverClass,
    labelInactiveClass,
}) => (
    <div
        className={`flex items-center justify-between px-3 py-2 rounded-lg transition-colors duration-200 group ${disabled ? 'opacity-50 grayscale cursor-not-allowed' : `${hoverClass} cursor-default`
            }`}
        title={disabled ? disabledTitle : ''}
    >
        <div className="flex items-center gap-3">
            {icon}
            <span className={`text-[12px] font-medium transition-colors ${checked ? activeLabelClass : labelInactiveClass}`}>
                {label}
            </span>
        </div>
        <ToggleSwitch checked={checked} onClick={onToggle} activeTrackClass={activeTrackClass} isLightTheme={isLightTheme} disabled={disabled} />
    </div>
);

export default SettingsToggleRow;