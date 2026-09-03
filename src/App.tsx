import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { QueryClientProvider } from "react-query";

// ---------------------------------------------------------------------------
// lib — infra / service wrappers
// ---------------------------------------------------------------------------
import { queryClient } from "@/lib/queryClient";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";

// ---------------------------------------------------------------------------
// hooks — core app logic, extracted out of App.tsx
// ---------------------------------------------------------------------------
import { useWindowRoute, useFirebaseAuth, useTenant, useAutoOpenDashboardForAdmins } from "@/hooks";
import { useTeamInvite, useOverlayOpacity, useAppLifecycleListeners, useMeetingSession } from "@/hooks";

// ---------------------------------------------------------------------------
// features
// ---------------------------------------------------------------------------
import { ManagerDashboard } from "@/features/dashboard";
import { InviteAccountMismatchBanner } from "@/features/tenant";
import { SettingsPopup, SettingsOverlay } from "@/features/settings"; // Keeping for legacy/specific window support if needed
import { StartupSequence } from "@/features/onboarding";
// import UpdateBanner from "../features/updates/UpdateBanner";

// ---------------------------------------------------------------------------
// components — generic UI kit + shared/common
// ---------------------------------------------------------------------------
import { ToastProvider, ToastViewport } from "@/features/ui/toast";
import { ModelSelectorWindow, GodojoInterface, Launcher, ErrorBoundary } from "@/features/common";
import { IncompatibleProviderBanner, AdCampaignToasters, SystemAudioPermissionBanner, GhostGlowOverlay } from "@/features/common";
import { AudioStatusTray } from "@/features/common";
// import { SupportToaster } from "@/features/common";

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------
import { EmailVerification, SignIn } from "@/pages";
import { AuthToastHost } from "@/features/auth/AuthToastHost";

// ---------------------------------------------------------------------------
// premium
// ---------------------------------------------------------------------------
import { PremiumUpgradeModal, useAdCampaigns } from "./premium";
import { UpdateBanner } from "./features/updates";

// Shared QueryClient (auth-error routing lives in lib/queryClient.ts) —
// imported rather than declared here so every window branch below uses the
// exact same client/cache instance instead of a locally duplicated one.
const App: React.FC = () => {

  // --- Window identity -------------------------------------------------
  const { isSettingsWindow, isLauncherWindow, isOverlayWindow, isModelSelectorWindow, isCropperWindow, isDefault } = useWindowRoute();

  // --- Cross-cutting app logic, lifted into hooks -----------------------

  // Each Electron BrowserWindow loads its own copy of this bundle, so
  // PostHog needs its own init() call per window.
  useEffect(() => {
    posthogAnalytics.initAnalytics();
  }, []);

  // `meeting-completed` is broadcast by the main process to EVERY open window
  // (see electron/MeetingPersistence.ts) but is meant to count each saved
  // meeting exactly once. Since every window runs its own posthog-js instance,
  // tracking it in all of them multiplies the count by the number of live
  // windows. Gate it to the single launcher window so it fires exactly once.
  useEffect(() => {
    if (!isLauncherWindow) return;
    const unsubscribeMeetingCompleted = window.electronAPI?.onMeetingCompleted?.(() => {
      posthogAnalytics.trackMeetingCompleted();
    });
    return () => unsubscribeMeetingCompleted?.();
  }, [isLauncherWindow]);

  const FirebaseAuthStates = useFirebaseAuth(isLauncherWindow, isDefault, isOverlayWindow);
  const { authUser, authChecked, pendingVerificationUser, sessionExpiredMessage } = FirebaseAuthStates;
  const { setSessionExpiredMessage, completeEmailVerification, signOut } = FirebaseAuthStates;
  const { tenantId, tenant, isAdmin } = useTenant(authUser, isLauncherWindow, isDefault);
  const [overlayOpacity] = useOverlayOpacity(isOverlayWindow);

  const AppLifecycleStates = useAppLifecycleListeners();
  const { hasProfile, isPremiumActive, setIsPremiumActive, isProcessingMeeting, setIsProcessingMeeting } = AppLifecycleStates;
  const { lastMeetingEndTime, appStartTime, ollamaPull, incompatibleWarning, dismissIncompatibleWarning, reindexIncompatibleMeetings } = AppLifecycleStates;

  const { handleStartMeeting, handleEndMeeting, showPermissionTray, setShowPermissionTray, proceedWithMeeting } = useMeetingSession(tenantId, setIsProcessingMeeting);

  // --- Local UI state ----------------------------------------------------
  const [showStartup, setShowStartup] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isManagerDashboardOpen, setIsManagerDashboardOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState("general");
  const [showPremiumModal, setShowPremiumModal] = useState(false);
  const [isLauncherMainView, setIsLauncherMainView] = useState(true);

  const closeSettings = () => {
    setIsSettingsOpen(false);
    window.dispatchEvent(new CustomEvent("settings-closed"));
  };

  useAutoOpenDashboardForAdmins(authUser, tenant, isAdmin, setIsManagerDashboardOpen);

  const openInviteSettingsTab = () => {
    setSettingsInitialTab("user-roles-permissions");
    posthogAnalytics.trackMainSettingsOpened("user-roles-permissions");
    setIsSettingsOpen(true);
  };

  const { deepLinkInviteToken, clearDeepLinkInviteToken, inviteMismatchEmail, dismissInviteMismatch } = useTeamInvite(authUser, openInviteSettingsTab);

  const isAppReady = !isSettingsWindow && !isOverlayWindow && !isModelSelectorWindow && !showStartup && !isSettingsOpen && !isManagerDashboardOpen && isLauncherMainView;
  const { activeAd, dismissAd } = useAdCampaigns(isPremiumActive, hasProfile, isAppReady, appStartTime, lastMeetingEndTime, isProcessingMeeting);

  // --- Render --------------------------------------------------------------

  if (isCropperWindow) {
    const Cropper = React.lazy(() => import("./features/common/Cropper"));
    return (
      <React.Suspense fallback={<div className="w-screen h-screen bg-transparent" />}>
        <Cropper />
      </React.Suspense>
    );
  }

  if (isSettingsWindow) {
    return (
      <ErrorBoundary context="SettingsPopup">
        <div className="h-full min-h-0 w-full">
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <SettingsPopup />
              <ToastViewport />
            </ToastProvider>
          </QueryClientProvider>
        </div>
      </ErrorBoundary>
    );
  }

  if (isModelSelectorWindow) {
    return (
      <ErrorBoundary context="ModelSelector">
        <div className="h-full min-h-0 w-full overflow-hidden">
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <ModelSelectorWindow />
              <ToastViewport />
            </ToastProvider>
          </QueryClientProvider>
        </div>
      </ErrorBoundary>
    );
  }

  // --- OVERLAY WINDOW (Meeting Interface) ---
  if (isOverlayWindow) {
    return (
      <ErrorBoundary context="Overlay">
        <div className="w-[430px] relative bg-transparent">
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <div
                style={{
                  ["--overlay-opacity" as "--overlay-opacity"]: String(overlayOpacity),
                  transition: "background-color 75ms ease, border-color 75ms ease, box-shadow 75ms ease",
                } as React.CSSProperties}
              >
                {/* Permission warnings render above the meeting UI. The overlay
                    window is created hidden and only appears once a meeting starts,
                    so this is the first point at which an in-meeting denial can
                    actually be seen. */}
                <SystemAudioPermissionBanner />
                <GodojoInterface onEndMeeting={handleEndMeeting} overlayOpacity={overlayOpacity} />
              </div>
              <ToastViewport />
            </ToastProvider>
          </QueryClientProvider>
        </div>
      </ErrorBoundary>
    );
  }

  // --- LAUNCHER WINDOW (Default) ---
  // Renders if window=launcher OR no param
  return (
    <ErrorBoundary context="Launcher">
      <div className="h-full min-h-0 w-full relative bg-[#000000]">
        <AuthToastHost />
        {/* Auth gate: while we don't know yet, render nothing (avoids SignIn flash).
            Once known, if no user is signed in show the SignIn page instead of the
            launcher. The SignIn component triggers onIdTokenChanged on success, which
            updates `authUser` below and unmounts itself. */}
        {!authChecked ? (
          <div className="h-full w-full" />
        ) : pendingVerificationUser ? (
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <EmailVerification
                user={pendingVerificationUser}
                onVerified={() => completeEmailVerification(pendingVerificationUser)}
              />
              <ToastViewport />
            </ToastProvider>
          </QueryClientProvider>
        ) : !authUser ? (
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <SignIn
                onSignedIn={() => {
                  /* auth state listener will flip the gate */
                }}
                bannerMessage={sessionExpiredMessage}
                onBannerDismiss={() => setSessionExpiredMessage(null)}
              />
              <ToastViewport />
            </ToastProvider>
          </QueryClientProvider>
        ) : (
          <>
            <AnimatePresence>
              {showStartup ? (
                <motion.div
                  key="startup"
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0, scale: 1.1, pointerEvents: "none", transition: { duration: 0.6, ease: "easeInOut" } }}
                >
                  <StartupSequence onComplete={() => setShowStartup(false)} />
                </motion.div>
              ) : (
                <motion.div
                  key="main"
                  className="h-full w-full"
                  initial={{ opacity: 0, scale: 0.98, y: 15 }} // "Linear" style entry: slightly down and scaled down
                  animate={{ opacity: 1, scale: 1, y: 0 }} // Slide up and snap to place
                  transition={{
                    duration: 0.8,
                    ease: [0.19, 1, 0.22, 1], // Expo-out: snappy start, smooth landing
                    delay: 0.1,
                  }}
                >
                  <QueryClientProvider client={queryClient}>
                    <ToastProvider>
                      <div id="launcher-container" className="h-full w-full relative">
                        <Launcher
                          onStartMeeting={(event?: any) => handleStartMeeting(event)}
                          onOpenSettings={(tab = "general") => {
                            setSettingsInitialTab(tab);
                            setIsManagerDashboardOpen(false); // switching to Settings closes Dashboard
                            setIsSettingsOpen(true);
                          }}
                          isManagerDashboardOpen={isManagerDashboardOpen}
                          isSettingsOpen={isSettingsOpen}
                          onCloseSettings={closeSettings}
                          onOpenManagerDashboard={
                            isAdmin
                              ? () => {
                                setIsSettingsOpen(false); // switching to Dashboard closes Settings
                                setIsManagerDashboardOpen(true); // clicking Dashboard again keeps it open
                              }
                              : undefined
                          }
                          onCloseManagerDashboard={() => setIsManagerDashboardOpen(false)}
                          onPageChange={setIsLauncherMainView}
                          ollamaPullStatus={ollamaPull.status}
                          ollamaPullPercent={ollamaPull.percent}
                          ollamaPullMessage={ollamaPull.message}
                          authUser={authUser}
                          onSignOut={signOut}
                        />
                      </div>
                      <SettingsOverlay
                        isOpen={isSettingsOpen}
                        onClose={closeSettings}
                        initialTab={settingsInitialTab}
                        deepLinkInviteToken={deepLinkInviteToken}
                        onDeepLinkTokenConsumed={clearDeepLinkInviteToken}
                        tenantId={tenantId}
                        isAdmin={isAdmin}
                      />
                      <ManagerDashboard isOpen={isManagerDashboardOpen} onClose={() => setIsManagerDashboardOpen(false)} />
                      {/* Ghost Mode indicator — soft edge glow above every screen (Launcher /
                          Settings / Dashboard) whenever the window is hidden from capture. */}
                      <GhostGlowOverlay />
                      {/* Audio status footer — rendered once at the App root (like the
                          header) so it stays visible above every screen (Launcher /
                          Settings / Dashboard), not just while the Launcher is mounted. */}
                      <AudioStatusTray
                        isVisible={showPermissionTray}
                        onClose={() => setShowPermissionTray?.(false)}
                        onAllGranted={proceedWithMeeting}
                      />
                      <ToastViewport />
                    </ToastProvider>
                  </QueryClientProvider>
                </motion.div>
              )}
            </AnimatePresence>

            <IncompatibleProviderBanner
              warning={incompatibleWarning}
              visible={isDefault}
              onDismiss={dismissIncompatibleWarning}
              onReindex={reindexIncompatibleMeetings}
            />

            <UpdateBanner />
            {/* <SupportToaster /> */}

            {inviteMismatchEmail && (
              <InviteAccountMismatchBanner invitedEmail={inviteMismatchEmail} onDismiss={dismissInviteMismatch} />
            )}

            <AdCampaignToasters
              visible={isLauncherMainView && !isSettingsOpen}
              activeAd={activeAd}
              dismissAd={dismissAd}
              onSetupProfile={() => {
                setSettingsInitialTab("profile");
                setIsSettingsOpen(true);
              }}
              onSetupJD={() => {
                setSettingsInitialTab("profile");
                setIsSettingsOpen(true);
              }}
              onUpgrade={() => setShowPremiumModal(true)}
            />

            <PremiumUpgradeModal
              isOpen={showPremiumModal}
              onClose={() => setShowPremiumModal(false)}
              isPremium={isPremiumActive}
              onActivated={() => {
                setIsPremiumActive(true);
                setShowPremiumModal(false);
                // After activation, open settings to Profile Intelligence
                setTimeout(() => {
                  setSettingsInitialTab("profile");
                  setIsSettingsOpen(true);
                }, 300);
              }}
              onDeactivated={() => setIsPremiumActive(false)}
            />
          </>
        )}
      </div>
    </ErrorBoundary>
  );
};

export default App;