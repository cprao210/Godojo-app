import React from 'react';
import { Mic, Monitor, Keyboard, User, LogOut, ArrowLeft, Calendar, FlaskConical, Info, BarChart2, Users, Building2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { AboutSection } from '@/features/onboarding';
import { AIProvidersSettings } from '@/features/settings';
import { CompanyContextTab, ScoringCriteriaTab, UserProfileTab, UserRolesPermissionsTab } from '@/features/settings';
import { SettingsOverlayProps } from '@/types';
import { useSettingsOverlay } from '@/hooks';
import GeneralTab from './GeneralTab';
import KeybindsTab from './KeybindsTab';
import AudioTab from './AudioTab';
import CalendarTab from './CalendarTab';

// Sidebar nav item definitions — id must match the `activeTab` values used
// below. Kept as data so the nav list itself stays a simple `.map()`.
const NAV_ITEMS = [
    { id: 'general', label: 'General', icon: Monitor },
    { id: 'user-profile', label: 'User Profile', icon: User },
    { id: 'ai-providers', label: 'AI Providers', icon: FlaskConical },
    { id: 'calendar', label: 'Calendar', icon: Calendar },
    { id: 'audio', label: 'Audio', icon: Mic },
    { id: 'keybinds', label: 'Keybinds', icon: Keyboard },
    { id: 'company-context', label: 'Company Context', icon: Building2 },
    { id: 'scoring-criteria', label: 'Scoring Criteria', icon: BarChart2 },
    { id: 'user-roles-permissions', label: 'Roles & Management', icon: Users },
    { id: 'about', label: 'About', icon: Info },
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
}) => {
    const overlay = useSettingsOverlay({ isOpen, onClose, initialTab });
    const { isLight, activeTab, setActiveTab, navigateToCompanyContext, opacity, tavily } = overlay;

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    id="settings-backdrop"
                    className={`fixed top-6 inset-0 z-50 transition-colors duration-150 ${opacity.isPreviewingOpacity ? 'bg-transparent backdrop-blur-none' : isLight ? 'bg-[#F8FAFC]' : 'bg-bg-main'}`}
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
                                <div className="p-6">
                                    <div className="flex items-center justify-between mb-4">
                                        <h2 className="font-semibold text-text-tertiary text-xs uppercase tracking-wider">Settings</h2>
                                    </div>

                                    <nav className="space-y-1">
                                        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
                                            <button
                                                key={id}
                                                onClick={() => (id === 'company-context' ? navigateToCompanyContext() : setActiveTab(id))}
                                                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-3 ${activeTab === id ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50'}`}
                                            >
                                                <Icon size={16} className="shrink-0" /> {label}
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
                                        />
                                    )}

                                    {activeTab === 'scoring-criteria' && <ScoringCriteriaTab />}

                                    {activeTab === 'user-roles-permissions' && (
                                        <UserRolesPermissionsTab
                                            deepLinkInviteToken={deepLinkInviteToken}
                                            onDeepLinkTokenConsumed={onDeepLinkTokenConsumed}
                                        />
                                    )}

                                    {activeTab === 'about' && <AboutSection />}
                                </div>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default SettingsOverlay;