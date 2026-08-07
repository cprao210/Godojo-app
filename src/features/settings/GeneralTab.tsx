import React from 'react';
import { Ghost, PointerOff, Power, Terminal, MessageSquare, Palette, Monitor, Sun, Moon, Globe, ChevronDown, Eye, Layout, Settings, Activity } from 'lucide-react';
import { OVERLAY_OPACITY_MIN } from '@/lib/overlayAppearance';
import { useSettingsOverlay } from '@/hooks';
import MockupDock from './MockupDock';

type SettingsOverlayHook = ReturnType<typeof useSettingsOverlay>;

const DISGUISE_OPTIONS = [
    { id: 'none', label: 'None (Default)', icon: <Layout size={14} /> },
    { id: 'terminal', label: 'Terminal', icon: <Terminal size={14} /> },
    { id: 'settings', label: 'System Settings', icon: <Settings size={14} /> },
    { id: 'activity', label: 'Activity Monitor', icon: <Activity size={14} /> },
] as const;

const THEME_OPTIONS = [
    { mode: 'system', label: 'System', icon: <Monitor size={14} /> },
    { mode: 'light', label: 'Light', icon: <Sun size={14} /> },
    { mode: 'dark', label: 'Dark', icon: <Moon size={14} /> },
] as const;

// The "General" tab: Ghost Mode + Mouse Passthrough hero toggles, the
// settings list (open-at-login, verbose logging, transcript, theme, AI
// response language), the interface-opacity slider + live MockupDock
// preview, and the process-disguise picker. All state/handlers come from
// `useSettingsOverlay` — this component only renders.
const GeneralTab: React.FC<{ overlay: SettingsOverlayHook }> = ({ overlay }) => {
    const { isLight, general, opacity, language, showTranscript, toggleTranscript,
        isThemeDropdownOpen, setIsThemeDropdownOpen, themeDropdownRef,
        isAiLangDropdownOpen, setIsAiLangDropdownOpen, aiLangDropdownRef } = overlay;

    const cardCls = isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle';

    return (
        <div className="space-y-6 animated fadeIn">
            <div className="space-y-3.5">
                {/* Ghost Mode (Undetectable) */}
                <div className={`${cardCls} rounded-xl p-5 border flex items-center justify-between transition-all ${general.isUndetectable ? 'shadow-lg shadow-blue-500/10' : ''}`}>
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                            {general.isUndetectable ? (
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-primary">
                                    <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" fill="currentColor" stroke="currentColor" />
                                    <path d="M9 10h.01" stroke="var(--bg-item-surface)" strokeWidth="2.5" />
                                    <path d="M15 10h.01" stroke="var(--bg-item-surface)" strokeWidth="2.5" />
                                </svg>
                            ) : (
                                <Ghost size={18} className="text-text-primary" />
                            )}
                            <h3 className="text-lg font-bold text-text-primary">{general.isUndetectable ? 'Ghost Mode ON' : 'Ghost Mode OFF'}</h3>
                        </div>
                        <p className="text-xs text-text-secondary">
                            GoDojo is currently {general.isUndetectable ? 'undetectable' : 'detectable'} by screen-sharing.
                        </p>
                    </div>
                    <div
                        onClick={general.toggleUndetectable}
                        className={`w-11 h-6 rounded-full relative transition-colors cursor-pointer ${general.isUndetectable ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
                    >
                        <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${general.isUndetectable ? 'translate-x-5' : 'translate-x-0'}`} />
                    </div>
                </div>

                {/* Mouse Passthrough */}
                <div className={`${cardCls} rounded-xl p-5 border flex items-center justify-between transition-all ${general.isMousePassthrough ? 'shadow-lg shadow-sky-500/10' : ''}`}>
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                            <PointerOff size={18} className={general.isMousePassthrough ? 'text-sky-400' : 'text-text-primary'} />
                            <h3 className="text-lg font-bold text-text-primary">Mouse Passthrough</h3>
                        </div>
                        <p className="text-xs text-text-secondary">
                            Overlay stays visible but lets all mouse clicks pass through to the app beneath.
                        </p>
                    </div>
                    <div
                        onClick={general.toggleMousePassthrough}
                        className={`w-11 h-6 rounded-full relative transition-colors cursor-pointer ${general.isMousePassthrough ? 'bg-sky-500' : 'bg-bg-toggle-switch border border-border-muted'}`}
                    >
                        <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${general.isMousePassthrough ? 'translate-x-5' : 'translate-x-0'}`} />
                    </div>
                </div>

                <div>
                    <h3 className="text-lg font-bold text-text-primary mb-1">General settings</h3>
                    <p className="text-xs text-text-secondary mb-2">Customize how GoDojo works for you</p>

                    <div className={`rounded-xl border ${isLight ? 'bg-white border-slate-200/80 divide-y divide-slate-100' : 'bg-transparent border-transparent divide-y divide-border-subtle/20'}`}>
                        <div className="space-y-0">
                            {/* Open at Login */}
                            <div className="flex items-center justify-between px-4 py-3">
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                                        <Power size={20} />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-bold text-text-primary">Open GoDojo when you log in</h3>
                                        <p className="text-xs text-text-secondary mt-0.5">GoDojo will open automatically when you log in to your computer</p>
                                    </div>
                                </div>
                                <div
                                    onClick={general.toggleOpenOnLogin}
                                    className={`w-11 h-6 rounded-full relative transition-colors cursor-pointer ${general.openOnLogin ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
                                >
                                    <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${general.openOnLogin ? 'translate-x-5' : 'translate-x-0'}`} />
                                </div>
                            </div>

                            {/* Verbose debug logging */}
                            <div className="flex items-center justify-between px-4 py-3">
                                <div className="flex items-center gap-4">
                                    <div className={`w-10 h-10 bg-bg-item-surface rounded-lg border flex items-center justify-center transition-colors ${general.verboseLogging ? 'border-amber-500/40 text-amber-400' : 'border-border-subtle text-text-tertiary'}`}>
                                        <Terminal size={20} />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-bold text-text-primary">Verbose debug logging</h3>
                                        <p className="text-xs text-text-secondary mt-0.5">Print detailed audio, STT, and pipeline diagnostics to the terminal</p>
                                    </div>
                                </div>
                                <div
                                    onClick={general.toggleVerboseLogging}
                                    className={`w-11 h-6 rounded-full relative transition-colors cursor-pointer ${general.verboseLogging ? 'bg-amber-500' : 'bg-bg-toggle-switch border border-border-muted'}`}
                                >
                                    <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${general.verboseLogging ? 'translate-x-5' : 'translate-x-0'}`} />
                                </div>
                            </div>

                            {/* Meeting Transcript */}
                            <div className="flex items-center justify-between px-4 py-3">
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                                        <MessageSquare size={20} />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-bold text-text-primary">Meeting Transcript</h3>
                                        <p className="text-xs text-text-secondary mt-0.5">Show real-time transcription of all meeting participants</p>
                                    </div>
                                </div>
                                <div
                                    onClick={toggleTranscript}
                                    className={`w-11 h-6 rounded-full relative transition-colors cursor-pointer ${showTranscript ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
                                >
                                    <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${showTranscript ? 'translate-x-5' : 'translate-x-0'}`} />
                                </div>
                            </div>

                            {/* Theme */}
                            <div className="flex items-center justify-between px-4 py-3">
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                                        <Palette size={20} />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-bold text-text-primary">Theme</h3>
                                        <p className="text-xs text-text-secondary mt-0.5">Customize how GoDojo looks on your device</p>
                                    </div>
                                </div>

                                <div className="relative" ref={themeDropdownRef}>
                                    <button
                                        onClick={() => setIsThemeDropdownOpen(!isThemeDropdownOpen)}
                                        className="bg-bg-component hover:bg-bg-elevated border border-border-subtle text-text-primary px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 min-w-[110px] justify-between"
                                    >
                                        <div className="flex items-center gap-2 overflow-hidden">
                                            <span className="text-text-secondary shrink-0">
                                                {general.themeMode === 'system' && <Monitor size={14} />}
                                                {general.themeMode === 'light' && <Sun size={14} />}
                                                {general.themeMode === 'dark' && <Moon size={14} />}
                                            </span>
                                            <span className="capitalize text-ellipsis overflow-hidden whitespace-nowrap">{general.themeMode}</span>
                                        </div>
                                        <ChevronDown size={12} className={`shrink-0 transition-transform ${isThemeDropdownOpen ? 'rotate-180' : ''}`} />
                                    </button>

                                    {isThemeDropdownOpen && (
                                        <div className="absolute right-0 top-full mt-1 min-w-full w-max bg-bg-elevated border border-border-subtle rounded-lg shadow-xl overflow-hidden z-20 p-1 animated fadeIn select-none">
                                            {THEME_OPTIONS.map((option) => (
                                                <button
                                                    key={option.mode}
                                                    onClick={() => {
                                                        general.setThemeMode(option.mode);
                                                        setIsThemeDropdownOpen(false);
                                                    }}
                                                    className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors ${general.themeMode === option.mode ? 'text-text-primary bg-bg-item-active/50' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                                >
                                                    <span className={general.themeMode === option.mode ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'}>{option.icon}</span>
                                                    <span className="font-medium">{option.label}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* AI Response Language */}
                            <div className="flex items-center justify-between px-4 py-3">
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                                        <Globe size={20} />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-bold text-text-primary">AI Response Language</h3>
                                        <p className="text-xs text-text-secondary mt-0.5">Language for AI suggestions and notes</p>
                                    </div>
                                </div>

                                <div className="relative" ref={aiLangDropdownRef}>
                                    <button
                                        onClick={() => setIsAiLangDropdownOpen(!isAiLangDropdownOpen)}
                                        className="bg-bg-component hover:bg-bg-elevated border border-border-subtle text-text-primary pl-4 pr-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 min-w-[110px] justify-between"
                                    >
                                        <span className="capitalize text-ellipsis overflow-hidden whitespace-nowrap">
                                            {language.aiResponseLanguage}
                                        </span>
                                        <ChevronDown size={12} className={`shrink-0 transition-transform ${isAiLangDropdownOpen ? 'rotate-180' : ''}`} />
                                    </button>

                                    {isAiLangDropdownOpen && (
                                        <div className="absolute right-0 top-full mt-1 min-w-full w-max bg-bg-elevated border border-border-subtle rounded-lg shadow-xl overflow-hidden z-20 p-1 animated fadeIn select-none max-h-60 overflow-y-auto custom-scrollbar">
                                            {language.availableAiLanguages.map((option: any) => (
                                                <button
                                                    key={option.code}
                                                    onClick={() => {
                                                        language.setAiResponseLanguage(option.code);
                                                        setIsAiLangDropdownOpen(false);
                                                    }}
                                                    className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors ${language.aiResponseLanguage === option.code ? 'text-text-primary bg-bg-item-active/50' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                                >
                                                    <span className="font-medium">{option.label}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Interface Opacity (Stealth Mode) */}
                    <div
                        id="opacity-slider-card"
                        style={opacity.isPreviewingOpacity ? { visibility: 'visible', position: 'relative', zIndex: 9999 } : {}}
                        className={`${cardCls} rounded-xl p-5 border mt-4`}
                    >
                        <div className="flex items-center justify-between mb-3">
                            <label className="flex items-center gap-2 text-xs font-medium text-text-secondary uppercase tracking-wide">
                                <Eye size={13} className="text-text-secondary" />
                                Interface Opacity
                            </label>
                            <span className="opacity-percent-label text-xs font-semibold text-text-primary tabular-nums">
                                {Math.round(opacity.overlayOpacity * 100)}%
                            </span>
                        </div>

                        <input
                            type="range"
                            id="main-opacity-slider"
                            min={OVERLAY_OPACITY_MIN}
                            max={1.0}
                            step={0.01}
                            defaultValue={opacity.overlayOpacity}
                            onChange={(e) => opacity.handleOpacityChange(parseFloat(e.target.value))}
                            onPointerUp={opacity.stopPreviewingOpacity}
                            className="w-full h-1.5 rounded-full appearance-none bg-slate-500/10 dark:bg-bg-input accent-accent-primary"
                            style={{ WebkitAppearance: 'none' } as React.CSSProperties}
                        />

                        <div className="flex justify-between mt-1.5">
                            <span className="text-[10px] text-text-tertiary">More Stealth</span>
                            <span className="text-[10px] text-text-tertiary">Fully Visible</span>
                        </div>

                        <div className={`mt-4 rounded-xl p-4 flex items-end justify-center ${isLight ? 'bg-slate-100/80' : 'bg-black/30'}`} style={{ minHeight: 200 }}>
                            <MockupDock opacity={opacity.previewOverlayOpacity} />
                        </div>
                    </div>
                </div>
            </div>

            {/* Process Disguise */}
            <div className={`${cardCls} rounded-xl p-5 border`}>
                <div className="flex flex-col gap-1 mb-3">
                    <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold text-text-primary">Process Disguise</h3>
                    </div>
                    <p className="text-xs text-text-secondary">
                        Disguise GoDojo as another application to prevent detection during screen sharing.
                        <span className="block mt-1 text-text-tertiary">
                            Select a disguise to be automatically applied when Undetectable mode is on.
                        </span>
                    </p>
                </div>

                <div className={`grid grid-cols-2 gap-3 ${general.isUndetectable ? 'opacity-50 pointer-events-none' : ''}`}>
                    {general.isUndetectable && (
                        <p className="col-span-2 text-xs text-yellow-500/80 -mt-1 mb-1">
                            ⚠️ Disable Undetectable mode first to change disguise.
                        </p>
                    )}
                    {DISGUISE_OPTIONS.map((option) => (
                        <button
                            key={option.id}
                            disabled={general.isUndetectable}
                            onClick={() => general.setDisguiseMode(option.id)}
                            className={`p-3 rounded-lg border text-left flex items-center gap-3 transition-all ${general.disguiseMode === option.id
                                ? 'bg-accent-primary border-accent-primary text-white shadow-lg shadow-blue-500/20'
                                : 'bg-bg-input border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-item-surface'
                                } ${general.isUndetectable ? 'cursor-not-allowed' : ''}`}
                        >
                            <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${general.disguiseMode === option.id ? 'bg-white/20 text-white' : 'bg-bg-item-surface text-text-secondary'}`}>
                                {option.icon}
                            </div>
                            <span className="text-xs font-medium">{option.label}</span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default GeneralTab;