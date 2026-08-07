import React from 'react';

interface ProfileFieldProps {
    label: string;
    icon: React.ReactNode;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    type?: string;
    disabled?: boolean;
    isLight: boolean;
}

// Single labeled input used throughout the profile form (name, email, phone,
// role, etc). Extracted from UserProfileTab's inline `field()` render helper
// so it's a real, independently reusable component.
const ProfileField: React.FC<ProfileFieldProps> = ({
    label,
    icon,
    value,
    onChange,
    placeholder,
    type = 'text',
    disabled = false,
    isLight,
}) => {
    return (
        <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                <span className="text-text-tertiary">{icon}</span>
                {label}
                {disabled && (
                    <span className="ml-1 text-[10px] font-normal text-text-tertiary normal-case tracking-normal">(managed by account)</span>
                )}
            </label>
            <input
                type={type}
                value={value ?? ''}
                onChange={(e) => !disabled && onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                className={`w-full px-3 py-2.5 rounded-lg text-sm text-text-primary placeholder-text-tertiary
              border transition-colors focus:outline-none focus:border-accent-primary
              ${disabled
                        ? 'opacity-60 cursor-not-allowed bg-bg-item-surface border-border-subtle'
                        : isLight
                            ? 'bg-white border-slate-200 focus:border-blue-400'
                            : 'bg-bg-input border-border-subtle'
                    }`}
            />
        </div>
    );
};

export default ProfileField;