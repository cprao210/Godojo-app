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
import { motion, AnimatePresence } from 'framer-motion';
import { Radio, Brain, Pause, Play, StopCircle, Settings, Ghost } from 'lucide-react';
import { FloatingSettingsPanel, FloatingChatPanel, FloatingIntelligencePanel, DockButton } from '@/features/floating-dock';
import { FloatingPanelWrapper, DockDivider, DockDragHandle, PausedIndicatorDot } from '@/features/floating-dock';
import { useFloatingDock } from '@/hooks';
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

    const { activePanel, togglePanel, isFrozen, dockOpacity, handleDockOpacityChange, dockRef } = floatingDockStates;
    const { panelTopOffset, meetingTypes, setMeetingTypes, analysisData, analysisLoading, analysisError } = floatingDockStates;
    const { runAnalysis, isRefreshRun, chatMessages, setChatMessages, autoRefreshInterval, setAutoRefreshInterval } = floatingDockStates;
    const { intelligencePanelFirstOpenedAt, noAnalysisCaptured, handleInteractionId } = floatingDockStates;

    const panelSpring = { type: 'spring', damping: 28, stiffness: 380, mass: 0.8 } as const;

    const isPanelActive = activePanel === "chat" || activePanel === "intelligence" || activePanel === "settings";

    return (
        <>
            <motion.div
                className={`relative w-[480px] mx-auto h-fit bg-transparent max-w-full rounded-2xl items-center flex flex-col min-h-0 ${overlayPanelClass}`}
                style={{ height: isPanelActive ? '735px' : '130px' }}
            >
                {/* Overlay Panels — all three stay mounted so internal state (countdown
                    timers, chat history, scroll position) is never lost on panel switch.
                    Visibility + pointer-events are toggled via CSS only. */}

                {/* Intelligence panel — always mounted (analysis starts on meeting start) */}
                <FloatingPanelWrapper
                    panelTopOffset={panelTopOffset}
                    showFrozenOverlay={isFrozen && activePanel === 'intelligence'}
                    isInteractive={activePanel === 'intelligence'}
                    animate={{
                        opacity: activePanel === 'intelligence' ? dockOpacity : 0,
                        y: activePanel === 'intelligence' ? 0 : 20,
                        scale: activePanel === 'intelligence' ? 1 : 0.96,
                    }}
                    transition={panelSpring}
                >
                    <FloatingIntelligencePanel
                        isOpen={activePanel === 'intelligence'}
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
                {(chatMessages.length > 0 || activePanel === 'chat') && (
                    <FloatingPanelWrapper
                        panelTopOffset={panelTopOffset}
                        showFrozenOverlay={isFrozen && activePanel === 'chat'}
                        isInteractive={activePanel === 'chat'}
                        initial={{ opacity: 0, y: 20, scale: 0.96 }}
                        animate={{
                            opacity: activePanel === 'chat' ? dockOpacity : 0,
                            y: activePanel === 'chat' ? 0 : 20,
                            scale: activePanel === 'chat' ? 1 : 0.96,
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
                    {activePanel === 'settings' && (
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
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: 'spring', damping: 26, stiffness: 300 }}
                    className="fixed pointer-events-auto"
                    style={{ top: 30 }}
                >
                    {/* The Dock */}
                    <motion.div
                        ref={dockRef}
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
                            isActive={activePanel === 'intelligence'}
                            activeColor="#3b82f6"
                            showActiveDot
                            frozen={isFrozen}
                            onClick={() => togglePanel('intelligence')}
                        />

                        {/* Chat Assistant */}
                        <DockButton
                            icon={<Brain size={22} strokeWidth={1.6} />}
                            tooltip="GoDojo Chat Assistant"
                            isActive={activePanel === 'chat'}
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
                            onClick={() => onEndCall(meetingTypes)}
                        />

                        {/* Settings */}
                        <DockButton
                            icon={<Settings size={22} strokeWidth={1.6} />}
                            tooltip="Settings"
                            isActive={activePanel === 'settings'}
                            activeColor="#64748b"
                            showActiveDot
                            frozen={isFrozen}
                            onClick={() => togglePanel('settings')}
                        />

                        <DockDivider />

                        <DockDragHandle />
                    </motion.div>
                </motion.div>
            </motion.div>
        </>
    );
};

export default FloatingDock;