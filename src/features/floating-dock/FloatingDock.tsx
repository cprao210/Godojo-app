/**
 * FloatingDock.tsx
 *
 * The always-on-top dock shown during a live meeting: buttons for the
 * Intelligence / Chat / Settings panels, Ghost mode, pause/resume, and end
 * call. All state (panel switching, freeze mode, opacity, the lifted
 * analysis session, chat history, and the auto-refresh countdown) lives in
 * useFloatingDock — this component only owns layout and rendering.
 */

import React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Radio, Brain, Pause, Play, StopCircle, Settings, Ghost, Loader2 } from 'lucide-react';
import { FloatingSettingsPanel, FloatingChatPanel, FloatingIntelligencePanel, DockButton } from '@/features/floating-dock';
import { FloatingPanelWrapper, DockDivider, DockDragHandle, PausedIndicatorDot } from '@/features/floating-dock';
// Imported relatively (not via the barrel above) — the barrel re-exports
// FloatingDock, so pulling DockBrandBar from it would be a circular import.
import { DockBrandBar } from './DockBrandBar';
import { useFloatingDock, usePerformanceMode } from '@/hooks';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import { FloatingDockProps } from '@/types';
import { getDockSurfaceStyle } from './dockSurfaceStyle';

// Hoisted so DockButton's memo comparison actually holds. Inline `<Radio …/>`
// allocates a fresh element on every dock render, which alone would defeat the
// memo on all six buttons.
const ICON_RADIO = <Radio size={22} strokeWidth={1.6} />;
const ICON_BRAIN = <Brain size={22} strokeWidth={1.6} />;
const ICON_GHOST = <Ghost size={22} strokeWidth={1.6} />;
const ICON_PLAY = <Play size={22} strokeWidth={1.6} />;
const ICON_PAUSE = <Pause size={22} strokeWidth={1.6} />;
const ICON_STOP = <StopCircle size={22} strokeWidth={1.6} />;
const ICON_ENDING = <Loader2 size={22} strokeWidth={1.6} className="animate-spin" />;
const ICON_SETTINGS = <Settings size={22} strokeWidth={1.6} />;

export const FloatingDock: React.FC<FloatingDockProps> = ({
    isMeetingPaused,
    onPauseResume,
    onEndCall,
    isUndetectable,
    onToggleGhost,
    transcriptRef,
    rollingTranscriptUser,
    rollingTranscriptClient,
    isClientSpeaking,
    isUserSpeaking,
    showTranscript,
    onToggleTranscript,
    currentModel,
    onSelectModel,
    speakerNames,
    shortcuts,
    overlayPanelClass,
    companyIntel,
    calendarEventMetadata,
    onRequestOverlayResize,
}) => {

    const floatingDockStates = useFloatingDock({ transcriptRef, isMeetingPaused, companyIntel });
    const { isPerformanceMode, preference: performanceModePreference, setPreference: setPerformanceModePreference } = usePerformanceMode();
    // Live wave-indicator levels are NOT read here. They used to arrive as
    // component state (useLiveAudioLevels), which put a ~20Hz-per-channel feed at
    // the root of this tree and reconciled the whole overlay — both panels, six
    // dock buttons, LiveAnalysisContent — to move eight bars in one leaf. The
    // indicator now reads lib/audioLevelFeed directly inside its own rAF loop,
    // so the same numbers reach the meter with zero renders above it. Nothing
    // else here needs the levels.

    // True while the awaited end-of-call analysis is running. Local to the
    // button: nothing else in the dock changes behaviour because of it.
    const [isEndingCall, setIsEndingCall] = useState(false);

    useEffect(() => {
        posthogAnalytics.trackPageView('floating_dock');
    }, []);

    const { activePanel, togglePanel, isDockExpanded, collapseDock, expandDock, isFrozen, dockOpacity, handleDockOpacityChange, dockRef, ensureFinalAnalysisBeforeEndCall } = floatingDockStates;
    const { panelTopOffset, meetingTypes, setMeetingTypes, analysisData, analysisLoading, analysisError } = floatingDockStates;
    const { runAnalysis, isRefreshRun, chatMessages, setChatMessages, autoRefreshInterval, setAutoRefreshInterval } = floatingDockStates;
    const { intelligencePanelFirstOpenedAt, noAnalysisCaptured, isCountdownActive, handleInteractionId } = floatingDockStates;

    // In Performance Mode we swap these springs for short tweens: fewer animated
    // frames (no spring settling/overshoot) = less layout/paint per panel switch
    // and height change, which matters most on software-composited machines.
    // Memoized because they are passed as `transition` to memoized children — a
    // fresh object per render would invalidate every one of them.
    const panelSpring = useMemo(() => isPerformanceMode
        ? ({ type: 'tween', duration: 0.14, ease: 'easeOut' } as const)
        : ({ type: 'spring', damping: 28, stiffness: 380, mass: 0.8 } as const), [isPerformanceMode]);
    const dockSpring = useMemo(() => isPerformanceMode
        ? ({ type: 'tween', duration: 0.14, ease: 'easeOut' } as const)
        : ({ type: 'spring', damping: 26, stiffness: 300 } as const), [isPerformanceMode]);
    // The outer container's height drives the native OS-window resize every
    // animation frame (see the ResizeObserver below). panelSpring/dockSpring are
    // slightly underdamped so the panels/nav feel lively, but the SAME overshoot
    // on the window height makes the real OS window spring PAST its final size
    // and snap back — the "spring/jump" the dock showed on expand/collapse.
    // dockHeightSpring is a no-overshoot spring (bounce:0) so the window grows
    // and shrinks smoothly and settles exactly once, at the same pace.
    const dockHeightSpring = useMemo(() => isPerformanceMode
        ? ({ type: 'tween', duration: 0.16, ease: 'easeOut' } as const)
        : ({ type: 'spring', duration: 0.34, bounce: 0 } as const), [isPerformanceMode]);

    // Same reasoning: the dock pill's surface style is spread into an inline
    // style object, and rebuilding it per render (it parses/builds gradient and
    // backdrop-filter strings) is pure waste while opacity and mode are fixed.
    const dockSurfaceStyle = useMemo(
        () => getDockSurfaceStyle({ opacity: dockOpacity, rgb: '18, 22, 34', blurPx: 24, isPerformanceMode }),
        [dockOpacity, isPerformanceMode]
    );

    // ── Stable handlers for the memoized children ───────────────────────
    // useFloatingDock re-creates its functions on every render, so a useCallback
    // that closed over them directly would change identity every render and
    // defeat the memo on all six dock buttons. This box holds the current
    // closures; the handlers below read through it, so their identity never
    // changes while the call always lands on the newest closure — exactly what
    // an inline arrow does today, minus the re-render. Written during render (not
    // in an effect) so a click can never see a value from the previous commit.
    const latest = React.useRef({
        togglePanel, collapseDock, expandDock, runAnalysis, ensureFinalAnalysisBeforeEndCall,
        onEndCall, meetingTypes, isDockExpanded, isEndingCall, handleInteractionId,
        onRequestOverlayResize, onPauseResume,
    });
    latest.current = {
        togglePanel, collapseDock, expandDock, runAnalysis, ensureFinalAnalysisBeforeEndCall,
        onEndCall, meetingTypes, isDockExpanded, isEndingCall, handleInteractionId,
        onRequestOverlayResize, onPauseResume,
    };

    const openIntelligencePanel = useCallback(() => latest.current.togglePanel('intelligence'), []);
    const openChatPanel = useCallback(() => latest.current.togglePanel('chat'), []);
    const openSettingsPanel = useCallback(() => latest.current.togglePanel('settings'), []);
    const handleRegenerate = useCallback(() => { latest.current.runAnalysis(true); }, []);
    const toggleDock = useCallback(() => {
        if (latest.current.isDockExpanded) latest.current.collapseDock();
        else latest.current.expandDock();
    }, []);
    const handleEndCallClick = useCallback(async () => {
        // ensureFinalAnalysisBeforeEndCall no longer blocks on the final LLM
        // analysis itself — it only awaits the quick "mark analysis in-flight"
        // IPC round-trip, then returns. The actual wait now happens inside
        // main's endMeeting() (AppState.waitForLiveAnalysisToSettle), which
        // this click handler never has to know about. isEndingCall now only
        // guards the brief moment this await takes, so a double-click can't
        // fire the in-flight IPC call twice.
        if (latest.current.isEndingCall) return;
        setIsEndingCall(true);
        try {
            await latest.current.ensureFinalAnalysisBeforeEndCall();
        } finally {
            setIsEndingCall(false);
        }
        latest.current.onEndCall(latest.current.meetingTypes);
    }, []);
    const handleChatInteractionId = useCallback((interactionId: number) => {
        latest.current.handleInteractionId(interactionId);
    }, []);
    // useGodojoInterface re-creates handlePauseMeeting every render too, and that
    // hook renders on every transcript update — so without this the Pause button
    // would be the one dock button whose memo never held.
    const handlePauseResume = useCallback(() => {
        latest.current.onPauseResume();
    }, []);
    // Also stable: `onRequestOverlayResize` arrives from useGodojoInterface as a
    // fresh function every render, and it is in the deps of the ResizeObserver
    // effect below — so every dock render was disconnecting and re-observing the
    // outer box, and each `observe()` fires an immediate callback (a forced
    // layout). Reading it through the ref pins the effect to isPerformanceMode.
    const requestOverlayResize = useCallback((height: number) => {
        latest.current.onRequestOverlayResize?.(height);
    }, []);

    // The nav dock + panels are only ever visible while the dock is expanded —
    // collapsing hides both, regardless of which panel was previously active.
    // `activePanel` itself is left untouched by collapse so it can be
    // restored the next time the dock expands.
    const effectiveActivePanel = isDockExpanded ? activePanel : null;
    const isPanelActive = effectiveActivePanel === "chat" || effectiveActivePanel === "intelligence" || effectiveActivePanel === "settings";

    // The dock only ever has a small, known set of heights — computed here
    // (rather than left implicit inside the `animate` prop below) so the
    // resize-orchestration effect further down can react to it directly.
    const targetHeight = !isDockExpanded
        ? 52 // collapsed: only the slim DockBrandBar is showing
        : isPanelActive
            ? (effectiveActivePanel === "settings" ? 653 : 680)
            : 123;

    // ── Native overlay-window resize orchestration ──────────────────────
    // See the "Window resize pipeline" note in useGodojoInterface.ts for the
    // full rationale. Summary: resizing the real OS window on every
    // animation frame (the naive ResizeObserver approach) causes visible
    // stutter/hangs on mid-range/integrated-GPU machines, because a native
    // window resize is comparatively expensive — nothing like a GPU-composited
    // CSS transform.
    //
    // IMPORTANT: WindowHelper.setOverlayDimensions anchors the window's TOP
    // edge, so the window grows DOWNWARD and its top-pinned brand bar stays
    // put on screen (matching this component's top-down layout — brand bar on
    // top, panels rendered below it). On capable hardware the ResizeObserver
    // tracks the animated height every frame, so the real OS window grows and
    // shrinks in lockstep with the spring — which is what gives the dock its
    // smooth feel. The height spring is deliberately non-overshooting
    // (dockHeightSpring, bounce:0): because the window tracks the height
    // per-frame, any overshoot would make the real window spring past its
    // final size and snap back. Weak-GPU machines skip the per-frame tracking
    // and fall back to the cheaper single-shot jump below.
    const outerRef = React.useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (isPerformanceMode) return; // weak GPU: handled by the single-shot path below
        const el = outerRef.current;
        if (!el) return;
        const observer = new ResizeObserver((entries) => {
            const h = entries[0]?.contentRect.height;
            if (h) requestOverlayResize(Math.ceil(h));
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [isPerformanceMode, requestOverlayResize]);

    // Single-shot resize for weak-GPU machines only (Performance Mode on):
    //   - Growing: resize to the target height IMMEDIATELY, before/alongside
    //     the spring starting, so the window is already large enough and the
    //     growing content is never clipped by window bounds that haven't
    //     caught up yet.
    //   - Shrinking: do NOT resize immediately — the window needs to stay at
    //     its current (larger) size for the full duration of the shrink
    //     animation, or the collapsing content would be clipped mid-animation.
    //     The resize is deferred to `onAnimationComplete` below instead.
    // On capable hardware this is a no-op — the live ResizeObserver above
    // already keeps the window in sync every frame, so firing this too would
    // just fight it.
    const prevTargetHeightRef = React.useRef(targetHeight);
    useEffect(() => {
        if (!isPerformanceMode) {
            prevTargetHeightRef.current = targetHeight;
            return;
        }
        if (targetHeight > prevTargetHeightRef.current) {
            requestOverlayResize(targetHeight);
        }
        prevTargetHeightRef.current = targetHeight;
    }, [targetHeight, requestOverlayResize, isPerformanceMode]);

    // Fires when the outer height spring settles. On weak-GPU machines this
    // is the one point a shrink actually resizes the window (grow already
    // happened above). On capable hardware the live tracker has already
    // brought the window to the right size every frame, so this is a
    // harmless dedupe no-op.
    const handleHeightAnimationComplete = useCallback(() => {
        if (isPerformanceMode) requestOverlayResize(targetHeight);
    }, [isPerformanceMode, requestOverlayResize, targetHeight]);

    return (
        <>
            <motion.div
                ref={outerRef}
                className={`relative w-[430px] mx-auto h-fit bg-transparent max-w-full rounded-2xl items-center flex flex-col min-h-0 ${overlayPanelClass}`}
                animate={{ height: targetHeight }}
                transition={dockHeightSpring}
                onAnimationComplete={handleHeightAnimationComplete}
            >
                {/* Overlay Panels — all three stay mounted so internal state (countdown
                    timers, chat history, scroll position) is never lost on panel switch.
                    Visibility + pointer-events are toggled via CSS only. */}

                {/* Intelligence panel — always mounted (analysis starts on meeting start) */}
                <FloatingPanelWrapper
                    panelTopOffset={panelTopOffset}
                    showFrozenOverlay={isFrozen && effectiveActivePanel === 'intelligence'}
                    isInteractive={effectiveActivePanel === 'intelligence'}
                    animate={{
                        opacity: effectiveActivePanel === 'intelligence' ? dockOpacity : 0,
                        y: effectiveActivePanel === 'intelligence' ? 0 : 20,
                        scale: effectiveActivePanel === 'intelligence' ? 1 : 0.96,
                    }}
                    transition={panelSpring}
                >
                    <FloatingIntelligencePanel
                        isOpen={effectiveActivePanel === 'intelligence'}
                        isMeetingPaused={isMeetingPaused}
                        analysisData={analysisData}
                        analysisError={analysisError}
                        rollingTranscriptUser={rollingTranscriptUser}
                        rollingTranscriptClient={rollingTranscriptClient}
                        isClientSpeaking={isClientSpeaking}
                        isUserSpeaking={isUserSpeaking}
                        speakerNames={speakerNames}
                        showTranscript={showTranscript}
                        isLoading={analysisLoading}
                        onRegenerate={handleRegenerate}
                        autoRefreshInterval={autoRefreshInterval}
                        onAutoRefreshIntervalChange={setAutoRefreshInterval}
                        isRefreshRun={isRefreshRun}
                        panelFirstOpenedAt={intelligencePanelFirstOpenedAt}
                        noAnalysisCaptured={noAnalysisCaptured}
                        isCountdownActive={isCountdownActive}
                        meetingTypes={meetingTypes}
                        onMeetingTypesChange={setMeetingTypes}
                        isPerformanceMode={isPerformanceMode}
                    />
                </FloatingPanelWrapper>

                {/* Chat panel — mounts on first open, then stays mounted so history survives */}
                {(chatMessages.length > 0 || effectiveActivePanel === 'chat') && (
                    <FloatingPanelWrapper
                        panelTopOffset={panelTopOffset}
                        showFrozenOverlay={isFrozen && effectiveActivePanel === 'chat'}
                        isInteractive={effectiveActivePanel === 'chat'}
                        initial={{ opacity: 0, y: 20, scale: 0.96 }}
                        animate={{
                            opacity: effectiveActivePanel === 'chat' ? dockOpacity : 0,
                            y: effectiveActivePanel === 'chat' ? 0 : 20,
                            scale: effectiveActivePanel === 'chat' ? 1 : 0.96,
                        }}
                        transition={panelSpring}
                    >
                        <FloatingChatPanel
                            onInteractionId={handleChatInteractionId}
                            transcriptRef={transcriptRef}
                            isMeetingPaused={isMeetingPaused}
                            rollingTranscriptUser={rollingTranscriptUser}
                            rollingTranscriptClient={rollingTranscriptClient}
                            isClientSpeaking={isClientSpeaking}
                            isUserSpeaking={isUserSpeaking}
                            showTranscript={showTranscript}
                            currentModel={currentModel}
                            onSelectModel={onSelectModel}
                            speakerNames={speakerNames}
                            messages={chatMessages}
                            onMessagesChange={setChatMessages}
                            isPerformanceMode={isPerformanceMode}
                            calendarEventMetadata={calendarEventMetadata}
                        />
                    </FloatingPanelWrapper>
                )}

                {/* Settings panel — lightweight, can unmount freely (no timer state) */}
                <AnimatePresence>
                    {effectiveActivePanel === 'settings' && (
                        <FloatingPanelWrapper
                            panelTopOffset={panelTopOffset}
                            showFrozenOverlay={isFrozen}
                            initial={{ opacity: 0, y: 20, scale: 0.96 }}
                            animate={{ opacity: dockOpacity, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 12, scale: 0.97 }}
                            transition={panelSpring}
                        >
                            <FloatingSettingsPanel
                                showTranscript={showTranscript}
                                onToggleTranscript={onToggleTranscript}
                                shortcuts={shortcuts}
                                currentModel={currentModel}
                                onSelectModel={onSelectModel}
                                dockOpacity={dockOpacity}
                                onDockOpacityChange={handleDockOpacityChange}
                                isPerformanceMode={isPerformanceMode}
                                performanceModePreference={performanceModePreference}
                                onPerformanceModePreferenceChange={setPerformanceModePreference}
                            />
                        </FloatingPanelWrapper>
                    )}
                </AnimatePresence>

                <motion.div
                    ref={dockRef}
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0, x: '-50%' }}
                    transition={{ type: 'spring', damping: 26, stiffness: 300 }}
                    className="fixed pointer-events-auto flex flex-col items-center gap-0"
                    style={{ top: 6, left: '50%', width: 420 }}
                >
                    {/* Slim brand + expand/collapse bar, floating above the dock (with a
                        gap). Always visible — even when the nav dock + panel are hidden.
                        Its chevron expands (▽ → shows nav dock + last/default panel) or
                        collapses (△ → hides nav dock + panel, brand bar stays). dockRef
                        wraps bar + gap + pill, so the measured dockHeight — and thus
                        panelTopOffset — includes it. */}
                    <DockBrandBar
                        isExpanded={isDockExpanded}
                        opacity={dockOpacity}
                        onToggle={toggleDock}
                        isPerformanceMode={isPerformanceMode}
                    />

                    {/* The Dock — nav buttons only mount while expanded, so collapsing
                        smoothly shrinks/fades them away instead of just hiding a panel. */}
                    <AnimatePresence initial={false}>
                        {isDockExpanded && (
                            <motion.div
                                key="dock-nav"
                                initial={{ opacity: 0, height: 0, scale: 0.97 }}
                                animate={{ opacity: 1, height: 'auto', scale: 1 }}
                                exit={{ opacity: 0, height: 0, scale: 0.97 }}
                                transition={dockSpring}
                                style={{ overflow: 'hidden', width: 420 }}
                            >
                                <div
                                    className="flex items-center gap-2.5 px-3 py-3 rounded-2xl relative select-none draggable-area"
                                    style={{
                                        ...dockSurfaceStyle,
                                        border: '1px solid rgba(255,255,255,0.09)',
                                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                                        width: 420,
                                    }}
                                >
                                    {/* Frozen overlay — blocks clicks on other buttons */}
                                    {isFrozen && (
                                        <div
                                            className="absolute inset-0 rounded-2xl z-10"
                                            style={{ pointerEvents: 'auto' }}
                                            onClick={(e) => {
                                                // Allow only the freeze button's own click through.
                                                e.stopPropagation();
                                            }}
                                        />
                                    )}

                                    {/* Call Intelligence */}
                                    <DockButton
                                        icon={ICON_RADIO}
                                        tooltip="GoDojo Intelligence"
                                        isActive={effectiveActivePanel === 'intelligence'}
                                        activeColor="#3b82f6"
                                        showActiveDot
                                        frozen={isFrozen}
                                        isPerformanceMode={isPerformanceMode}
                                        onClick={openIntelligencePanel}
                                    />

                                    {/* Chat Assistant */}
                                    <DockButton
                                        icon={ICON_BRAIN}
                                        tooltip="GoDojo Chat Assistant"
                                        isActive={effectiveActivePanel === 'chat'}
                                        activeColor="#8b5cf6"
                                        showActiveDot
                                        frozen={isFrozen}
                                        isPerformanceMode={isPerformanceMode}
                                        onClick={openChatPanel}
                                    />

                                    {/* Ghost Mode */}
                                    <DockButton
                                        icon={ICON_GHOST}
                                        tooltip={isUndetectable ? 'Ghost Mode ON' : 'Ghost Mode'}
                                        isActive={isUndetectable}
                                        activeColor="#10b981"
                                        showActiveDot
                                        frozen={isFrozen}
                                        isPerformanceMode={isPerformanceMode}
                                        onClick={onToggleGhost}
                                    />

                                    <DockDivider />

                                    {/* Pause / Resume */}
                                    <DockButton
                                        icon={isMeetingPaused ? ICON_PLAY : ICON_PAUSE}
                                        tooltip={isMeetingPaused ? 'Resume Meeting' : 'Pause Meeting'}
                                        isActive={false}
                                        frozen={isFrozen}
                                        isPerformanceMode={isPerformanceMode}
                                        onClick={handlePauseResume}
                                    />
                                    {isMeetingPaused && <PausedIndicatorDot />}

                                    {/* End Call */}
                                    <DockButton
                                        icon={isEndingCall ? ICON_ENDING : ICON_STOP}
                                        tooltip={isEndingCall ? 'Wrapping up the call…' : 'End Call'}
                                        isActive={false}
                                        dangerColor
                                        frozen={isFrozen}
                                        isPerformanceMode={isPerformanceMode}
                                        onClick={handleEndCallClick}
                                    />

                                    {/* Settings */}
                                    <DockButton
                                        icon={ICON_SETTINGS}
                                        tooltip="Settings"
                                        isActive={effectiveActivePanel === 'settings'}
                                        activeColor="#64748b"
                                        showActiveDot
                                        frozen={isFrozen}
                                        isPerformanceMode={isPerformanceMode}
                                        onClick={openSettingsPanel}
                                    />

                                    <DockDivider />

                                    <DockDragHandle />
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </motion.div>
            </motion.div>
        </>
    );
};

export default FloatingDock;