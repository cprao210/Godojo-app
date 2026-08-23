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
import { useFloatingDock } from '@/hooks';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import { FloatingDockProps } from '@/types';

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
}) => {

    const floatingDockStates = useFloatingDock({ transcriptRef, isMeetingPaused, companyIntel });

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

    return (
        <>
            <motion.div
                className={`relative w-[430px] mx-auto h-fit bg-transparent max-w-full rounded-2xl items-center flex flex-col min-h-0 ${overlayPanelClass}`}
                animate={{
                    height: !isDockExpanded
                        ? 52 // collapsed: only the slim DockBrandBar is showing
                        : isPanelActive
                            ? (effectiveActivePanel === "settings" ? 532 : 680)
                            : 123,
                }}
                transition={dockSpring}
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
                                        background: `rgba(18, 22, 34, ${dockOpacity})`,
                                        backdropFilter: 'blur(24px) saturate(180%)',
                                        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
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