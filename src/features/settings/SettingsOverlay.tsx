import React from 'react';
import { Mic, Monitor, Keyboard, User, LogOut, ArrowLeft, Calendar, FlaskConical, Info, BarChart2, Users, Building2, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { AboutSection } from '@/features/onboarding';
import { AIProvidersSettings } from '@/features/settings';
import { CompanyContextTab, ScoringCriteriaTab, UserProfileTab, UserRolesPermissionsTab, UpdatesTab } from '@/features/settings';
import { SettingsOverlayProps } from '@/types';
import { useSettingsOverlay, useUpdateStatus } from '@/hooks';
import GeneralTab from './GeneralTab';
import KeybindsTab from './KeybindsTab';
import AudioTab from './AudioTab';
import CalendarTab from './CalendarTab';
import { SettingsSaveToast } from './SettingsSaveToast';

import { useEffect } from 'react';
import { isMac } from '@/../utils/platformUtils';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';

// Sidebar nav item definitions — id must match the `activeTab` values used
// below. Kept as data so the nav list itself stays a simple `.map()`.
const NAV_ITEMS = [
    { id: 'general', label: 'General', icon: Monitor, productionOnly: false },
    { id: 'user-profile', label: 'User Profile', icon: User, productionOnly: false },
    { id: 'ai-providers', label: 'AI Providers', icon: FlaskConical, productionOnly: false },
    { id: 'calendar', label: 'Calendar', icon: Calendar, productionOnly: false },
    { id: 'audio', label: 'Audio', icon: Mic, productionOnly: false },
    { id: 'keybinds', label: 'Keybinds', icon: Keyboard, productionOnly: false },
    { id: 'company-context', label: 'Company Context', icon: Building2, productionOnly: false },
    { id: 'scoring-criteria', label: 'Scoring Criteria', icon: BarChart2, productionOnly: false },
    { id: 'user-roles-permissions', label: 'Roles & Management', icon: Users, productionOnly: false },
    { id: 'updates', label: 'Updates', icon: RefreshCw, productionOnly: true },
    { id: 'about', label: 'About', icon: Info, productionOnly: false },
] as const;

// ─────────────────────────────────────────────────────────────────────────
// SettingsOverlay — the full-screen settings modal.
//
// All state/logic now lives in useSettingsOverlay (which itself composes
// useGeneralSettings, useOverlayOpacitySettings, useAudioDeviceSettings,
// useLanguageSettings, useSttProviderSettings, useTavilySettings,
// useProfileIntelligenceSettings, useCompanyContextSettings, and
// useCalendarIntegrationSettings). This component only owns:
//   - the modal shell (backdrop, panel, sidebar nav, content viewport)
//   - routing `activeTab` to the right tab component
// Tab bodies for General / Keybinds / Audio / Calendar are their own
// components; AI Providers / User Profile / Company Context / Scoring
// Criteria / Roles & Management / About were already separate components
// and are used unchanged.
// ─────────────────────────────────────────────────────────────────────────
const SettingsOverlay: React.FC<SettingsOverlayProps> = ({
    isOpen,
    onClose,
    initialTab = 'general',
    deepLinkInviteToken = null,
    onDeepLinkTokenConsumed,
    tenantId = null,
    isAdmin = false,
}) => {
    const overlay = useSettingsOverlay({ isOpen, onClose, initialTab });
    const { isLight, activeTab, setActiveTab, navigateToCompanyContext, opacity, tavily } = overlay;

    // Team company context is admin-owned: a solo user (no tenantId) always
    // edits their own context. Once on a team, only the admin may write —
    // members see the same (admin's) data read-only. This mirrors the
    // backend's own 403-on-write-for-members rule; it's UI-side enforcement
    // for a clean experience, not the source of truth for permissions.
    const isCompanyContextReadOnly = !!tenantId && !isAdmin;

    // Single owned instance for the whole overlay's lifetime — both the nav
    // badge below and the Updates tab content read from this same object, so
    // switching tabs and back doesn't reset anything.
    const updateStatus = useUpdateStatus();
    const { isUpdateAvailable, status: updateStatusValue, isPackaged } = updateStatus;
    const showUpdateBadge = (isUpdateAvailable || updateStatusValue === 'ready') && activeTab !== 'updates';

    const visibleNavItems = NAV_ITEMS.filter(item => !item.productionOnly || isPackaged);

    // Fires once per genuine open. Reads `activeTab` here (not the raw
    // `initialTab` prop) because useSettingsOverlay can redirect on open —
    // e.g. initialTab="company-context" resolves through
    // navigateToCompanyContext() — so `activeTab` is the only reliable
    // source of which tab the user is actually looking at. This does NOT
    // re-fire on later in-panel tab switches; only the isOpen transition
    // counts as a new "open"
    useEffect(() => {
        if (isOpen) {
            posthogAnalytics.trackPageView('main_settings');
            posthogAnalytics.trackMainSettingsOpened(activeTab);
        }
    }, [isOpen]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    id="settings-backdrop"
                    // top-6 leaves the header visible above; bottom-12 (= the audio
                    // status footer's h-12) does the same for the footer, which now
                    // renders at the App root at z-[200] — above this z-50 overlay.
                    className={`fixed top-6 bottom-12 inset-x-0 z-50 transition-colors duration-150 ${opacity.isPreviewingOpacity ? 'bg-transparent backdrop-blur-none' : isLight ? 'bg-[#F8FAFC]' : 'bg-bg-main'}`}
                >
                    <motion.div
                        id="settings-panel-wrapper"
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 12 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 32, mass: 1 }}
                        className={`w-full h-full overflow-hidden relative ${isLight ? 'bg-white' : 'bg-bg-elevated'}`}
                    >
                        <div
                            id="settings-panel"
                            className="flex w-full h-full"
                            style={{ visibility: opacity.isPreviewingOpacity ? 'hidden' : 'visible' }}
                        >
                            {/* ── Sidebar ── */}
                            <div className={`w-72 shrink-0 flex flex-col border-r ${isLight ? 'bg-white border-slate-200/70' : 'bg-bg-sidebar border-border-subtle'}`}>
                                <div className={isMac ? "p-6 pt-12" : "p-6"}>
                                    <div className="flex items-center justify-between mb-4">
                                        <h2 className="font-semibold text-text-tertiary text-xs uppercase tracking-wider">Settings</h2>
                                    </div>

                                    <nav className="space-y-1">
                                        {visibleNavItems.map(({ id, label, icon: Icon }) => (
                                            <button
                                                key={id}
                                                onClick={() => (id === 'company-context' ? navigateToCompanyContext() : setActiveTab(id))}
                                                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-3 ${activeTab === id ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50'}`}
                                            >
                                                <Icon size={16} className="shrink-0" /> {label}
                                                {id === 'updates' && showUpdateBadge && (
                                                    <span className="ml-auto w-2 h-2 rounded-full bg-blue-400 shrink-0" />
                                                )}
                                            </button>
                                        ))}
                                    </nav>
                                </div>

                                <div className={`mt-auto p-6 border-t ${isLight ? 'border-slate-200/70' : 'border-border-subtle'}`}>
                                    <button
                                        onClick={() => window.electronAPI.quitApp()}
                                        className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-3"
                                    >
                                        <LogOut size={16} /> Quit GoDojo
                                    </button>
                                    <button onClick={onClose} className="group mt-2 w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50 transition-colors flex items-center gap-3">
                                        <ArrowLeft size={16} className="group-hover:text-accent-primary transition-colors" /> Back to GoDojo
                                    </button>
                                </div>
                            </div>

                            {/* ── Content ── */}
                            <div className={`flex-1 overflow-y-auto ${isLight ? 'bg-[#F8FAFC]' : 'bg-bg-main'}`}>
                                <div className="max-w-5xl mx-auto px-10 py-10">
                                    {activeTab === 'general' && <GeneralTab overlay={overlay} />}

                                    {activeTab === 'user-profile' && <UserProfileTab isLight={isLight} />}

                                    {activeTab === 'ai-providers' && (
                                        <AIProvidersSettings
                                            tavilyApiKey={tavily.tavilyApiKey}
                                            hasStoredTavilyKey={tavily.hasStoredTavilyKey}
                                            tavilyKeySource={tavily.tavilyKeySource}
                                            handleRemoveTavilyKey={tavily.removeTavilyKey}
                                            handleAddTavilyKey={(e) => tavily.handleTavilyKeyInput(e.target.value)}
                                            handleSaveTavilyKey={tavily.saveTavilyKey}
                                            tavilySaving={tavily.tavilySaving}
                                            tavilyError={tavily.tavilyError}
                                        />
                                    )}

                                    {activeTab === 'keybinds' && <KeybindsTab overlay={overlay} />}

                                    {activeTab === 'audio' && <AudioTab overlay={overlay} />}

                                    {activeTab === 'calendar' && <CalendarTab overlay={overlay} />}

                                    {activeTab === 'company-context' && (
                                        <CompanyContextTab
                                            companyContext={overlay.companyContext.companyContext}
                                            setCompanyContext={overlay.companyContext.setCompanyContext}
                                            companyLoading={overlay.companyContext.companyLoading}
                                            setCompanyLoading={overlay.companyContext.setCompanyLoading}
                                            companySaving={overlay.companyContext.companySaving}
                                            setCompanySaving={overlay.companyContext.setCompanySaving}
                                            companyError={overlay.companyContext.companyError}
                                            setCompanyError={overlay.companyContext.setCompanyError}
                                            assetUploading={overlay.companyContext.assetUploading}
                                            setAssetUploading={overlay.companyContext.setAssetUploading}
                                            isPremium={overlay.profile.isPremium}
                                            setIsPremiumModalOpen={overlay.profile.setIsPremiumModalOpen}
                                            isLight={isLight}
                                            readOnly={isCompanyContextReadOnly}
                                        />
                                    )}

                                    {activeTab === 'scoring-criteria' && <ScoringCriteriaTab />}

                                    {activeTab === 'user-roles-permissions' && (
                                        <UserRolesPermissionsTab
                                            deepLinkInviteToken={deepLinkInviteToken}
                                            onDeepLinkTokenConsumed={onDeepLinkTokenConsumed}
                                        />
                                    )}

                                    {activeTab === 'updates' && isPackaged && (
                                        <UpdatesTab isLight={isLight} updateStatus={updateStatus} />
                                    )}

                                    {activeTab === 'about' && <AboutSection />}
                                </div>
                            </div>
                        </div>
                    </motion.div>

                    {/* Save/error notification — listens on settingsToastBus, fires from
                        any tab's save handler regardless of which hook it lives in. */}
                    <SettingsSaveToast isLight={isLight} />
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default SettingsOverlay;