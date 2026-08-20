import React from 'react';

interface ToggleSwitchProps {
    checked: boolean;
    onClick: () => void;
    /** Track background + glow shown when checked, e.g. 'bg-emerald-500 shadow-[0_2px_10px_rgba(16,185,129,0.3)]'. */
    activeTrackClass: string;
    isLightTheme: boolean;
    disabled?: boolean;
}

// The small pill switch used by every toggle row in SettingsPopup
// (Undetectable, Fast Response, Transcript, Interview Mode, Profile Mode).
// Only the "on" track color/glow differs between rows — everything else
// (size, knob, spring easing, disabled dimming) is identical, so it's
// centralized here instead of being copy-pasted per row.
const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onClick, activeTrackClass, isLightTheme, disabled }) => {
    const inactiveTrackClass = isLightTheme ? 'bg-black/[0.22]' : 'bg-white/10';
    const knobClass = isLightTheme ? 'bg-white shadow-[0_1px_4px_rgba(0,0,0,0.18)]' : 'bg-black shadow-sm';

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`w-[30px] h-[18px] rounded-full p-[1.5px] transition-all duration-300 ease-spring active:scale-[0.92] ${checked ? activeTrackClass : inactiveTrackClass
                }`}
        >
            <div
                className={`w-[15px] h-[15px] rounded-full transition-transform duration-300 ease-spring ${knobClass} ${checked ? 'translate-x-[12px]' : 'translate-x-0'
                    }`}
            />
        </button>
    );
};

export default ToggleSwitch;