import React from 'react';

interface ShortcutRowProps {
    icon: React.ReactNode;
    label: string;
    /** Key labels to render as badges, e.g. ['⌘', 'B']. */
    keys: string[];
    labelInactiveClass: string;
    hoverClass: string;
    shortcutKeyClass: string;
}

// One row = icon + label + a row of keycap badges showing the shortcut.
// Used by "Show/Hide" and "Screenshot" — both display-only, no toggle state.
const ShortcutRow: React.FC<ShortcutRowProps> = ({ icon, label, keys, labelInactiveClass, hoverClass, shortcutKeyClass }) => (
    <div className={`flex items-center justify-between px-3 py-2 rounded-lg transition-colors duration-200 group interaction-base interaction-press ${hoverClass}`}>
        <div className="flex items-center gap-3">
            {icon}
            <span className={`text-[12px] transition-colors ${labelInactiveClass}`}>{label}</span>
        </div>
        <div className="flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
            {keys.map((key, index) => (
                <div key={index} className={`px-1.5 py-0.5 rounded border text-[10px] font-medium min-w-[20px] text-center ${shortcutKeyClass}`}>
                    {key}
                </div>
            ))}
        </div>
    </div>
);

export default ShortcutRow;