import React, { useState } from 'react';
import { Ghost, PointerOff, Power, Terminal, MessageSquare, Palette, Monitor, Sun, Moon, Globe, ChevronDown, Eye, Layout, Settings, Activity, RotateCcw, Skull } from 'lucide-react';
import { OVERLAY_OPACITY_MIN } from '@/lib/overlayAppearance';
import { useSettingsOverlay } from '@/hooks';
import { getFirebaseAuth } from '@/lib/firebase';
import { encryptDangerousKey } from '@/lib/dangerousKey';
import { API_BASE } from '@/lib/apiClient';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
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

    // "Reset app data" — confirmation itself happens via a native dialog in
    // the main process (see electron/ipcHandlers.ts: 'reset-app-data'), so
    // this is just a loading/error state while that's in flight. On success
    // the app relaunches itself, so there's no "done" state to render here.
    const [isResetting, setIsResetting] = useState(false);
    const [resetError, setResetError] = useState<string | null>(null);

    const handleResetAppData = async () => {
        posthogAnalytics.trackResetAppDataClicked();
        setResetError(null);
        setIsResetting(true);
        try {
            const result = await window.electronAPI.resetAppData();
            if (!result.success && !result.cancelled) {
                setResetError(result.error || 'Reset failed. Please try again.');
            }
            // On success the main process calls app.relaunch()/app.exit()
            // itself — nothing further to do here.
        } catch (e: any) {
            setResetError(e?.message || 'Reset failed. Please try again.');
        } finally {
            setIsResetting(false);
        }
    };

    // DEV-ONLY: "Delete My Account" — self-service full wipe of the signed-in
    // user's data (Supabase rows across every user-scoped table, then the
    // Firebase Auth user, then local app data). See ipcHandlers.ts
    // 'dev:delete-current-user-account' for why this can only ever target
    // the currently signed-in user, never an arbitrary account.
    const [isDeletingAccount, setIsDeletingAccount] = useState(false);
    const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);

    const handleDeleteCurrentUserAccount = async () => {
        setDeleteAccountError(null);
        const { confirmed } = await window.electronAPI.confirmDeleteAccount();
        if (!confirmed) return;
        setIsDeletingAccount(true);
        try {
            const uid = getFirebaseAuth().currentUser?.uid;
            if (!uid) {
                setDeleteAccountError('No signed-in user found locally — cannot determine which account to delete.');
                return;
            }

            // Token-free by design: this hits the backend directly with a
            // DANGEROUS_KEY proof instead of a Firebase ID token. See
            // src/lib/dangerousKey.ts and the backend's
            // app/core/dangerous_key.py for the shared-secret scheme.
            const encrypted_key = await encryptDangerousKey();
            const res = await fetch(`${API_BASE}/auth/dangerous/delete-user`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uid, encrypted_key }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                // Backend's error envelope is {"error":{"code","message"}} —
                // for a bad/missing key this is literally "Key required to
                // do this operation" (see dangerous_key.py's _GENERIC_DENIAL).
                setDeleteAccountError(body?.error?.message || `Delete failed (${res.status}).`);
                return;
            }
            if (body?.failed_tables?.length) {
                console.warn('[settings] account deletion: some Supabase tables failed to clear:', body.failed_tables);
            }

            // Server-side rows + the Firebase Auth user are gone at this
            // point — now clear this device: natively.db, cached session,
            // credentials.enc. This relaunches the app on success, so
            // there's no further state to set here.
            const wipeResult = await window.electronAPI.wipeLocalAccountData();
            if (!wipeResult.success) {
                setDeleteAccountError(
                    wipeResult.error || 'Account deleted, but clearing local data failed. Please use "Reset App Data" below.'
                );
            }

        } catch (e: any) {
            setDeleteAccountError(e?.message || 'Account deletion failed. Please try again.');
        } finally {
            setIsDeletingAccount(false);
        }
    };

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

            {/* Danger Zone */}
            <div className={`rounded-xl p-5 border border-red-500/30 ${isLight ? 'bg-red-50/60' : 'bg-red-950/20'}`}>
                <div className="flex items-center justify-between gap-4">
                    <div className="flex flex-col gap-1">
                        <h3 className="text-sm font-bold text-red-500">Reset App Data</h3>
                        <p className="text-xs text-text-secondary max-w-md">
                            Permanently deletes your local credentials, settings, and offline data on this
                            device, and signs you out. This can't be undone. The app restarts automatically.
                        </p>
                        {resetError && (
                            <p className="text-xs text-red-500 mt-1">{resetError}</p>
                        )}
                    </div>
                    <button
                        onClick={handleResetAppData}
                        disabled={isResetting}
                        className="shrink-0 flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium border border-red-500/40 text-red-500 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                        <RotateCcw size={13} className={isResetting ? 'animate-spin' : ''} />
                        {isResetting ? 'Resetting…' : 'Reset App Data'}
                    </button>
                </div>
            </div>

            {/* DEV-ONLY Danger Zone: full account deletion (Supabase + Firebase Auth) */}
            {import.meta.env.DEV && (
                <div className={`rounded-xl p-5 border border-red-500/30 ${isLight ? 'bg-red-50/60' : 'bg-red-950/20'}`}>
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                                <h3 className="text-sm font-bold text-red-500">Delete My Account (Dev Only)</h3>
                                <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-500/20 text-red-500">Dev</span>
                            </div>
                            <p className="text-xs text-text-secondary max-w-md">
                                Permanently deletes THIS signed-in user from every Supabase table (regardless of foreign
                                key constraints) and from Firebase Authentication, then wipes local data. Authorized by
                                DANGEROUS_KEY, not your session token — requires VITE_DANGEROUS_KEY to match the
                                backend's DANGEROUS_KEY. This can't be undone.
                            </p>
                            {deleteAccountError && (
                                <p className="text-xs text-red-500 mt-1">{deleteAccountError}</p>
                            )}
                        </div>
                        <button
                            onClick={handleDeleteCurrentUserAccount}
                            disabled={isDeletingAccount}
                            className="shrink-0 flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium border border-red-500/40 text-red-500 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                        >
                            <Skull size={13} className={isDeletingAccount ? 'animate-pulse' : ''} />
                            {isDeletingAccount ? 'Deleting…' : 'Delete My Account'}
                        </button>
                    </div>
                </div>
            )}

        </div>
    );
};

export default GeneralTab;