/**
 * SettingsPopup.tsx
 *
 * The small tray/menu-bar popover with quick toggles (Undetectable, Fast
 * Response, Transcript, Interview Mode, Profile Mode) plus static shortcut
 * reference rows and a Donate link.
 *
 * All state, IPC listeners, and the auto-resize ResizeObserver live in
 * useSettingsPopup; this component only owns rendering. Each row is built
 * from the shared SettingsToggleRow / ShortcutRow / ToggleSwitch atoms so
 * adding a new toggle is a few lines, not a copy-pasted block.
 */

import React from 'react';
import { MessageSquare, Link, Camera, Zap, Heart, User } from 'lucide-react';
import { useSettingsPopup } from '@/hooks';
import CustomGhostIcon from './CustomGhostIcon';
import SettingsToggleRow from './SettingsToggleRow';
import ShortcutRow from './ShortcutRow';

const SettingsPopup: React.FC = () => {
    const {
        isLightTheme,
        shortcuts,
        isUndetectable,
        useGroqFastText,
        profileMode,
        hasProfile,
        isPremium,
        hasStoredKey,
        actionButtonMode,
        showTranscript,
        contentRef,
        toggleUndetectable,
        toggleGroqFastText,
        toggleTranscript,
        toggleInterviewMode,
        toggleProfileMode,
        openDonateLink,
    } = useSettingsPopup();

    // ── Theme-dependent chrome classes shared across every row ──────────────
    const popupPanelClass = isLightTheme
        ? 'bg-[#F3F4F6]/92 border-black/10 shadow-black/10'
        : 'bg-[#1E1E1E]/80 border-white/10 shadow-black/40';
    const itemHoverClass = isLightTheme ? 'hover:bg-black/[0.04]' : 'hover:bg-white/5';
    const labelInactiveClass = isLightTheme ? 'text-slate-700 group-hover:text-slate-900' : 'text-slate-400 group-hover:text-slate-200';
    const iconInactiveClass = isLightTheme ? 'text-slate-500 group-hover:text-slate-700' : 'text-slate-500 group-hover:text-slate-300';
    const activeLabelClass = isLightTheme ? 'text-slate-950' : 'text-white';
    const dividerClass = isLightTheme ? 'bg-black/[0.06]' : 'bg-white/[0.04]';
    const shortcutKeyClass = isLightTheme
        ? 'border-black/10 bg-black/[0.04] text-slate-600'
        : 'border-white/10 bg-white/5 text-slate-500';

    return (
        <div className="w-fit h-full bg-transparent flex flex-col">
            <div
                ref={contentRef}
                className={`w-[200px] max-h-[280px] backdrop-blur-md border rounded-[16px] overflow-hidden shadow-2xl p-2 flex flex-col animate-scale-in origin-top-left ${popupPanelClass}`}
            >
                <div className="flex-1 overflow-y-auto flex flex-col min-h-0">

                    {/* Undetectability */}
                    <SettingsToggleRow
                        icon={
                            <CustomGhostIcon
                                className={`w-4 h-4 transition-colors ${isUndetectable ? (isLightTheme ? 'text-slate-900' : 'text-white') : iconInactiveClass}`}
                                fill={isUndetectable ? 'currentColor' : 'none'}
                                stroke={isUndetectable ? 'none' : 'currentColor'}
                                eyeColor={isUndetectable ? (isLightTheme ? 'white' : 'black') : (isLightTheme ? '#334155' : 'white')}
                            />
                        }
                        label={isUndetectable ? 'Undetectable' : 'Detectable'}
                        checked={isUndetectable}
                        onToggle={toggleUndetectable}
                        activeTrackClass={isLightTheme ? 'bg-slate-900 shadow-[0_2px_8px_rgba(15,23,42,0.18)]' : 'bg-white shadow-[0_2px_8px_rgba(255,255,255,0.2)]'}
                        activeLabelClass={activeLabelClass}
                        isLightTheme={isLightTheme}
                        hoverClass={itemHoverClass}
                        labelInactiveClass={labelInactiveClass}
                    />

                    {/* Groq (Fast Text) Toggle — requires a stored Groq key */}
                    <SettingsToggleRow
                        icon={<Zap className={`w-4 h-4 transition-colors ${useGroqFastText ? 'text-orange-500' : iconInactiveClass}`} fill={useGroqFastText ? 'currentColor' : 'none'} />}
                        label="Fast Response"
                        checked={useGroqFastText}
                        onToggle={toggleGroqFastText}
                        activeTrackClass="bg-orange-500 shadow-[0_2px_10px_rgba(249,115,22,0.3)]"
                        activeLabelClass={activeLabelClass}
                        isLightTheme={isLightTheme}
                        disabled={hasStoredKey.groq === false}
                        disabledTitle="Requires Groq API Key to be configured in Settings"
                        hoverClass={itemHoverClass}
                        labelInactiveClass={labelInactiveClass}
                    />

                    {/* Client Transcript Toggle */}
                    <SettingsToggleRow
                        icon={<MessageSquare className={`w-3.5 h-3.5 transition-colors ${showTranscript ? 'text-emerald-400' : iconInactiveClass}`} fill={showTranscript ? 'currentColor' : 'none'} />}
                        label="Transcript"
                        checked={showTranscript}
                        onToggle={toggleTranscript}
                        activeTrackClass="bg-emerald-500 shadow-[0_2px_10px_rgba(16,185,129,0.3)]"
                        activeLabelClass={activeLabelClass}
                        isLightTheme={isLightTheme}
                        hoverClass={itemHoverClass}
                        labelInactiveClass={labelInactiveClass}
                    />

                    {/* Interview Mode (Brainstorm) Toggle */}
                    <SettingsToggleRow
                        icon={
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className={`w-3.5 h-3.5 transition-colors ${actionButtonMode === 'brainstorm' ? 'text-violet-400' : iconInactiveClass}`}
                            >
                                <line x1="6" y1="3" x2="6" y2="15" />
                                <circle cx="18" cy="6" r="3" />
                                <circle cx="6" cy="18" r="3" />
                                <path d="M18 9a9 9 0 0 1-9 9" />
                            </svg>
                        }
                        label="Interview Mode"
                        checked={actionButtonMode === 'brainstorm'}
                        onToggle={toggleInterviewMode}
                        activeTrackClass="bg-violet-500 shadow-[0_2px_10px_rgba(139,92,246,0.3)]"
                        activeLabelClass={activeLabelClass}
                        isLightTheme={isLightTheme}
                        hoverClass={itemHoverClass}
                        labelInactiveClass={labelInactiveClass}
                    />

                    {/* Profile Mode Toggle — Pro-license gated, only shown once a profile exists */}
                    {hasProfile && (
                        <SettingsToggleRow
                            icon={
                                <User
                                    className={`w-3.5 h-3.5 transition-colors ${profileMode && isPremium ? 'text-accent-primary' : iconInactiveClass}`}
                                    fill={profileMode && isPremium ? 'currentColor' : 'none'}
                                />
                            }
                            label="Profile Mode"
                            checked={profileMode && isPremium}
                            onToggle={toggleProfileMode}
                            activeTrackClass="bg-accent-primary shadow-[0_2px_10px_rgba(var(--color-accent-primary),0.3)]"
                            activeLabelClass={activeLabelClass}
                            isLightTheme={isLightTheme}
                            disabled={!isPremium}
                            disabledTitle="Requires Pro license to be active"
                            hoverClass={itemHoverClass}
                            labelInactiveClass={labelInactiveClass}
                        />
                    )}

                    <div className={`h-px my-0.5 mx-2 ${dividerClass}`} />

                    {/* Show/Hide Natively */}
                    <ShortcutRow
                        icon={<MessageSquare className={`w-3.5 h-3.5 transition-colors ${iconInactiveClass}`} />}
                        label="Show/Hide"
                        keys={shortcuts.toggleVisibility || ['⌘', 'B']}
                        labelInactiveClass={labelInactiveClass}
                        hoverClass={itemHoverClass}
                        shortcutKeyClass={shortcutKeyClass}
                    />

                    {/* Screenshot */}
                    <ShortcutRow
                        icon={<Camera className={`w-3.5 h-3.5 transition-colors ${iconInactiveClass}`} />}
                        label="Screenshot"
                        keys={shortcuts.takeScreenshot || ['⌘', 'H']}
                        labelInactiveClass={labelInactiveClass}
                        hoverClass={itemHoverClass}
                        shortcutKeyClass={shortcutKeyClass}
                    />

                    <div className={`h-px my-0.5 mx-2 ${dividerClass}`} />

                    {/* Donate */}
                    <div
                        onClick={openDonateLink}
                        className="flex items-center justify-between px-3 py-2 hover:bg-pink-500/10 rounded-lg transition-colors duration-200 group interaction-base interaction-press"
                    >
                        <div className="flex items-center gap-3">
                            <Heart className="w-3.5 h-3.5 text-pink-400 group-hover:fill-pink-400 transition-all duration-300" />
                            <span className={`text-[12px] transition-colors ${isLightTheme ? 'text-slate-700 group-hover:text-pink-700' : 'text-slate-400 group-hover:text-pink-100'}`}>Donate</span>
                        </div>
                        <div className="opacity-60 group-hover:opacity-100 transition-opacity">
                            <Link className={`w-3 h-3 group-hover:text-pink-400 ${isLightTheme ? 'text-slate-600' : 'text-slate-500'}`} />
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
};

export default SettingsPopup;