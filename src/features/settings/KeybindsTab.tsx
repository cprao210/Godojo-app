import React from 'react';
import { Eye, PointerOff, MessageSquare, Sparkles, RotateCcw, Camera, Crop, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Zap, RefreshCw, Mic } from 'lucide-react';
import { KeyRecorder } from '@/features/ui';
import { useSettingsOverlay } from '@/hooks';

type SettingsOverlayHook = ReturnType<typeof useSettingsOverlay>;

const GENERAL_SHORTCUTS = [
    { id: 'toggleVisibility', label: 'Toggle Visibility', icon: <Eye size={14} /> },
    { id: 'toggleMousePassthrough', label: 'Toggle Mouse Passthrough', icon: <PointerOff size={14} /> },
    { id: 'processScreenshots', label: 'Process Screenshots', icon: <MessageSquare size={14} /> },
    { id: 'captureAndProcess', label: 'Capture Screen & Ask AI', icon: <Sparkles size={14} /> },
    { id: 'resetCancel', label: 'Reset / Cancel', icon: <RotateCcw size={14} /> },
    { id: 'takeScreenshot', label: 'Take Screenshot', icon: <Camera size={14} /> },
    { id: 'selectiveScreenshot', label: 'Selective Screenshot', icon: <Crop size={14} /> },
] as const;

const CHAT_SHORTCUTS = [
    { id: 'whatToAnswer', label: 'What to Answer', icon: <Sparkles size={14} /> },
    { id: 'clarify', label: 'Clarify', icon: <MessageSquare size={14} /> },
    { id: 'followUp', label: 'Follow Up', icon: <MessageSquare size={14} /> },
    { id: 'dynamicAction4', label: 'Recap / Brainstorm', icon: <RefreshCw size={14} /> },
    { id: 'answer', label: 'Answer / Record', icon: <Mic size={14} /> },
    { id: 'codeHint', label: 'Get Code Hint', icon: <Zap size={14} /> },
    { id: 'brainstorm', label: 'Brainstorm Approaches', icon: <Zap size={14} /> },
    { id: 'scrollUp', label: 'Scroll Up', icon: <ArrowUp size={14} /> },
    { id: 'scrollDown', label: 'Scroll Down', icon: <ArrowDown size={14} /> },
] as const;

const WINDOW_SHORTCUTS = [
    { id: 'moveWindowUp', label: 'Move Window Up', icon: <ArrowUp size={14} /> },
    { id: 'moveWindowDown', label: 'Move Window Down', icon: <ArrowDown size={14} /> },
    { id: 'moveWindowLeft', label: 'Move Window Left', icon: <ArrowLeft size={14} /> },
    { id: 'moveWindowRight', label: 'Move Window Right', icon: <ArrowRight size={14} /> },
] as const;

/** One shortcut row: icon + label on the left, the editable key combo on the right. */
const ShortcutRow: React.FC<{
    icon: React.ReactNode;
    label: string;
    currentKeys: string[];
    onSave: (keys: string[]) => void;
}> = ({ icon, label, currentKeys, onSave }) => (
    <div className="flex items-center justify-between py-1.5 group">
        <div className="flex items-center gap-3">
            <span className="text-text-tertiary group-hover:text-text-primary transition-colors w-5 flex justify-center">{icon}</span>
            <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">{label}</span>
        </div>
        <KeyRecorder currentKeys={currentKeys} onSave={onSave} />
    </div>
);

// Keyboard shortcuts tab, grouped into General / Chat / Window categories.
// Backed entirely by `useShortcuts` (via the composing overlay hook) — no
// local state of its own.
const KeybindsTab: React.FC<{ overlay: SettingsOverlayHook }> = ({ overlay }) => {
    const { shortcuts, updateShortcut, resetShortcuts } = overlay;

    return (
        <div className="space-y-5 animated fadeIn select-text pb-4">
            <div className="flex items-start justify-between">
                <div>
                    <h3 className="text-lg font-bold text-text-primary mb-1">Keyboard shortcuts</h3>
                    <p className="text-xs text-text-secondary">GoDojo works with these easy to remember commands.</p>
                </div>
                <button
                    onClick={resetShortcuts}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-full border border-border-subtle bg-bg-subtle/30 hover:bg-bg-subtle hover:border-green-500/30 transition-all duration-200 text-xs font-medium text-text-secondary hover:text-green-500 active:scale-95 mt-1"
                >
                    <RotateCcw size={13} strokeWidth={2.5} />
                    Restore Default
                </button>
            </div>

            <div className="grid gap-6">
                <div>
                    <h4 className="text-sm font-bold text-text-primary mb-3">General</h4>
                    <div className="space-y-1">
                        {GENERAL_SHORTCUTS.map((item) => (
                            <ShortcutRow
                                key={item.id}
                                icon={item.icon}
                                label={item.label}
                                currentKeys={shortcuts[item.id as keyof typeof shortcuts]}
                                onSave={(keys) => updateShortcut(item.id as any, keys)}
                            />
                        ))}
                    </div>
                </div>

                <div>
                    <div className="mb-3">
                        <h4 className="text-sm font-bold text-text-primary">Chat</h4>
                    </div>
                    <div className="space-y-1">
                        {CHAT_SHORTCUTS.map((item) => (
                            <ShortcutRow
                                key={item.id}
                                icon={item.icon}
                                label={item.label}
                                currentKeys={shortcuts[item.id as keyof typeof shortcuts]}
                                onSave={(keys) => updateShortcut(item.id as any, keys)}
                            />
                        ))}
                    </div>
                </div>

                <div>
                    <h4 className="text-sm font-bold text-text-primary mb-3">Window</h4>
                    <div className="space-y-1">
                        {WINDOW_SHORTCUTS.map((item) => (
                            <ShortcutRow
                                key={item.id}
                                icon={item.icon}
                                label={item.label}
                                currentKeys={shortcuts[item.id as keyof typeof shortcuts]}
                                onSave={(keys) => updateShortcut(item.id as any, keys)}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default KeybindsTab;