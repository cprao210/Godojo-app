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
import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Radio, Brain, Pause, Play, StopCircle, Settings, Ghost } from 'lucide-react';
import { FloatingSettingsPanel, FloatingChatPanel, FloatingIntelligencePanel, DockButton } from '@/features/floating-dock';
import { FloatingPanelWrapper, DockDivider, DockDragHandle, PausedIndicatorDot } from '@/features/floating-dock';
// Imported relatively (not via the barrel above) — the barrel re-exports
// FloatingDock, so pulling DockBrandBar from it would be a circular import.
import { DockBrandBar } from './DockBrandBar';
import { useFloatingDock, usePerformanceMode } from '@/hooks';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import { FloatingDockProps } from '@/types';
import { getDockSurfaceStyle } from './dockSurfaceStyle';

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
    onRequestOverlayResize,
}) => {

    const floatingDockStates = useFloatingDock({ transcriptRef, isMeetingPaused, companyIntel });
    const { isPerformanceMode, preference: performanceModePreference, setPreference: setPerformanceModePreference } = usePerformanceMode();

    useEffect(() => {
        posthogAnalytics.trackPageView('floating_dock');
    }, []);

    const { activePanel, togglePanel, isDockExpanded, collapseDock, expandDock, isFrozen, dockOpacity, handleDockOpacityChange, dockRef, ensureFinalAnalysisBeforeEndCall } = floatingDockStates;
    const { panelTopOffset, meetingTypes, setMeetingTypes, analysisData, analysisLoading, analysisError } = floatingDockStates;
    const { runAnalysis, isRefreshRun, chatMessages, setChatMessages, autoRefreshInterval, setAutoRefreshInterval } = floatingDockStates;
    const { intelligencePanelFirstOpenedAt, noAnalysisCaptured, handleInteractionId } = floatingDockStates;

    const panelSpring = { type: 'spring', damping: 28, stiffness: 380, mass: 0.8 } as const;
    const dockSpring = { type: 'spring', damping: 26, stiffness: 300 } as const;

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
    // IMPORTANT: WindowHelper.setOverlayDimensions anchors the window's
    // BOTTOM-RIGHT corner, so a resize also repositions it (moves it up as
    // it grows). That means the single-shot "resize immediately, before the
    // spring starts" approach below doesn't just avoid clipping — it makes
    // the real OS window instantly teleport to its final size/position, and
    // the framer-motion spring then plays out *inside* an already-full-size
    // window. There's nothing left to visibly "grow" or "pop" — hence no
    // bounce. That per-frame tracking is exactly what gave the dock its
    // smooth grow/collapse feel, so on capable (non-performance-mode)
    // hardware we keep doing it; only weak-GPU machines fall back to the
    // cheaper single-shot jump.
    const outerRef = React.useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (isPerformanceMode) return; // weak GPU: handled by the single-shot path below
        const el = outerRef.current;
        if (!el) return;
        const observer = new ResizeObserver((entries) => {
            const h = entries[0]?.contentRect.height;
            if (h) onRequestOverlayResize?.(Math.ceil(h));
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [isPerformanceMode, onRequestOverlayResize]);

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
            onRequestOverlayResize?.(targetHeight);
        }
        prevTargetHeightRef.current = targetHeight;
    }, [targetHeight, onRequestOverlayResize, isPerformanceMode]);

    // Fires when the outer height spring settles. On weak-GPU machines this
    // is the one point a shrink actually resizes the window (grow already
    // happened above). On capable hardware the live tracker has already
    // brought the window to the right size every frame, so this is a
    // harmless dedupe no-op.
    const handleHeightAnimationComplete = () => {
        if (isPerformanceMode) onRequestOverlayResize?.(targetHeight);
    };

    return (
        <>
            <motion.div
                ref={outerRef}
                className={`relative w-[430px] mx-auto h-fit bg-transparent max-w-full rounded-2xl items-center flex flex-col min-h-0 ${overlayPanelClass}`}
                animate={{ height: targetHeight }}
                transition={dockSpring}
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
                        onRegenerate={() => runAnalysis(true)}
                        autoRefreshInterval={autoRefreshInterval}
                        onAutoRefreshIntervalChange={setAutoRefreshInterval}
                        isRefreshRun={isRefreshRun}
                        panelFirstOpenedAt={intelligencePanelFirstOpenedAt}
                        noAnalysisCaptured={noAnalysisCaptured}
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
                            onInteractionId={handleInteractionId}
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
                        onToggle={isDockExpanded ? collapseDock : expandDock}
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
                                        ...getDockSurfaceStyle({ opacity: dockOpacity, rgb: '18, 22, 34', blurPx: 24, isPerformanceMode }),
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
                                        icon={<Radio size={22} strokeWidth={1.6} />}
                                        tooltip="GoDojo Intelligence"
                                        isActive={effectiveActivePanel === 'intelligence'}
                                        activeColor="#3b82f6"
                                        showActiveDot
                                        frozen={isFrozen}
                                        onClick={() => togglePanel('intelligence')}
                                    />

                                    {/* Chat Assistant */}
                                    <DockButton
                                        icon={<Brain size={22} strokeWidth={1.6} />}
                                        tooltip="GoDojo Chat Assistant"
                                        isActive={effectiveActivePanel === 'chat'}
                                        activeColor="#8b5cf6"
                                        showActiveDot
                                        frozen={isFrozen}
                                        onClick={() => togglePanel('chat')}
                                    />

                                    {/* Ghost Mode */}
                                    <DockButton
                                        icon={<Ghost size={22} strokeWidth={1.6} />}
                                        tooltip={isUndetectable ? 'Ghost Mode ON' : 'Ghost Mode'}
                                        isActive={isUndetectable}
                                        activeColor="#10b981"
                                        showActiveDot
                                        frozen={isFrozen}
                                        onClick={onToggleGhost}
                                    />

                                    <DockDivider />

                                    {/* Pause / Resume */}
                                    <DockButton
                                        icon={isMeetingPaused ? <Play size={22} strokeWidth={1.6} /> : <Pause size={22} strokeWidth={1.6} />}
                                        tooltip={isMeetingPaused ? 'Resume Meeting' : 'Pause Meeting'}
                                        isActive={false}
                                        frozen={isFrozen}
                                        onClick={onPauseResume}
                                    />
                                    {isMeetingPaused && <PausedIndicatorDot />}

                                    {/* End Call */}
                                    <DockButton
                                        icon={<StopCircle size={22} strokeWidth={1.6} />}
                                        tooltip="End Call"
                                        isActive={false}
                                        dangerColor
                                        frozen={isFrozen}
                                        onClick={async () => {
                                            await ensureFinalAnalysisBeforeEndCall();
                                            onEndCall(meetingTypes);
                                        }}
                                    />

                                    {/* Settings */}
                                    <DockButton
                                        icon={<Settings size={22} strokeWidth={1.6} />}
                                        tooltip="Settings"
                                        isActive={effectiveActivePanel === 'settings'}
                                        activeColor="#64748b"
                                        showActiveDot
                                        frozen={isFrozen}
                                        onClick={() => togglePanel('settings')}
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