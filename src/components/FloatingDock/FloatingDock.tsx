import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Radio, Brain, Hand, EyeOff, Pause, Play, StopCircle, Settings, GripVertical, Ghost } from 'lucide-react';
import { FloatingIntelligencePanel } from './panels/FloatingIntelligencePanel';
import { FloatingChatPanel } from './panels/FloatingChatPanel';
import { FloatingSettingsPanel } from './panels/FloatingSettingsPanel';
import { DockButton } from './DockButton';
import { ShortcutConfig } from '../../hooks/useShortcuts';
import { useLiveAnalysis } from '../../hooks/useLiveAnalysis';

export type ActivePanel = 'intelligence' | 'chat' | 'settings' | null;

interface FloatingDockProps {
    // Meeting state
    isMeetingPaused: boolean;
    onPauseResume: () => void;
    onEndCall: () => void;

    // Feature states
    isUndetectable: boolean;
    onToggleGhost: () => void;

    // Chat panel props
    transcriptRef: React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>;
    rollingTranscript: string;
    isInterviewerSpeaking: boolean;
    showTranscript: boolean;
    onToggleTranscript: (v: boolean) => void;
    currentModel: string;
    onSelectModel: (m: string) => void;
    speakerNames: { user: string; interviewer: string };

    // Settings
    isMousePassthrough: boolean;
    onToggleMousePassthrough: () => void;
    // shortcuts: ShortcutConfig{ screenshot?: string[]; toggleOverlay?: string[] };
    shortcuts: ShortcutConfig;

    meetingTitle?: string;
    appearance?: any;
    overlayPanelClass?: string;
}

// ─── Chat message type (mirrors FloatingChatPanel) ──────────────────────────
interface ChatMessage {
    id: string;
    role: 'user' | 'system' | 'interviewer';
    text: string;
    isStreaming?: boolean;
    intent?: string;
}

export const FloatingDock: React.FC<FloatingDockProps> = ({
    isMeetingPaused,
    onPauseResume,
    onEndCall,
    isUndetectable,
    onToggleGhost,
    transcriptRef,
    rollingTranscript,
    isInterviewerSpeaking,
    showTranscript,
    onToggleTranscript,
    currentModel,
    onSelectModel,
    speakerNames,
    isMousePassthrough,
    onToggleMousePassthrough,
    shortcuts,
    meetingTitle,
    overlayPanelClass
}) => {
    const [activePanel, setActivePanel] = useState<ActivePanel>(null);
    const [isFrozen, setIsFrozen] = useState(false);
    // const dragControls = useDragControls();
    const constraintsRef = useRef<HTMLDivElement>(null);

    // ── Lifted state: survives panel switches ──────────────────────────────────
    // Analysis state is owned here so FloatingIntelligencePanel never loses it on remount.
    const { analysisData, isLoading: analysisLoading, runAnalysis, resetAnalysis } = useLiveAnalysis(transcriptRef, isMeetingPaused);
    // Track whether the first analysis has been triggered so we don't re-run on every remount.
    const analysisInitiatedRef = useRef(false);

    // Chat messages lifted here so history survives panel switches.
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

    // Reset all state when a new meeting starts (IPC session-reset event)
    useEffect(() => {
        if (!window.electronAPI?.onSessionReset) return;
        const unsubscribe = window.electronAPI.onSessionReset(() => {
            resetAnalysis();              // clears analysisData + error in the hook
            analysisInitiatedRef.current = false;  // allows first-open to trigger fresh analysis
            setChatMessages([]);          // clears chat history
            setActivePanel(null);         // close any open panel
        });
        return () => unsubscribe();
    }, [resetAnalysis]);

    const togglePanel = (panel: ActivePanel) => {
        if (isFrozen && panel !== null) return;
        // When intelligence panel opens for the first time, trigger analysis once.
        if (panel === 'intelligence' && !analysisInitiatedRef.current) {
            analysisInitiatedRef.current = true;
            runAnalysis(true);
        }
        setActivePanel(prev => prev === panel ? null : panel);
    };

    const handleFreezeMode = () => {
        setIsFrozen(prev => !prev);
    };


    return (
        <>

            <motion.div
                ref={constraintsRef}
                className={`relative w-[480px] mx-auto h-fit bg-transparent max-w-full rounded-2xl items-center flex flex-col min-h-0 ${overlayPanelClass}`}
                style={{ height: '640px' }}
            >

                {/* Overlay Panel (above dock) */}
                <AnimatePresence mode="wait">
                    {activePanel && (
                        <motion.div
                            key={activePanel}
                            initial={{ opacity: 0, y: 20, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 12, scale: 0.97 }}
                            transition={{ type: 'spring', damping: 28, stiffness: 380, mass: 0.8 }}
                            className="fixed bottom-[90px] left-[65px]"
                            style={{ position: 'fixed' }}
                        >
                            {/* Freeze overlay — keeps panel visible but blocks all interaction */}
                            {isFrozen && (
                                <div
                                    className="absolute inset-0 rounded-2xl z-50"
                                    style={{
                                        pointerEvents: 'auto',
                                        background: 'rgba(0,0,0,0.10)',
                                        cursor: 'not-allowed',
                                    }}
                                />
                            )}
                            {activePanel === 'intelligence' && (
                                <FloatingIntelligencePanel
                                    transcriptRef={transcriptRef}
                                    meetingTitle={meetingTitle}
                                    isMeetingPaused={isMeetingPaused}
                                    analysisData={analysisData}
                                    showTranscript={showTranscript}
                                    isLoading={analysisLoading}
                                    onRegenerate={() => runAnalysis(true)}
                                    onAutoRefresh={() => runAnalysis(false)}
                                />
                            )}
                            {activePanel === 'chat' && (
                                <FloatingChatPanel
                                    transcriptRef={transcriptRef}
                                    isMeetingPaused={isMeetingPaused}
                                    rollingTranscript={rollingTranscript}
                                    isInterviewerSpeaking={isInterviewerSpeaking}
                                    showTranscript={showTranscript}
                                    currentModel={currentModel}
                                    onSelectModel={onSelectModel}
                                    speakerNames={speakerNames}
                                    messages={chatMessages}
                                    onMessagesChange={setChatMessages}
                                />
                            )}
                            {activePanel === 'settings' && (
                                <FloatingSettingsPanel
                                    showTranscript={showTranscript}
                                    onToggleTranscript={onToggleTranscript}
                                    isMousePassthrough={isMousePassthrough}
                                    onToggleMousePassthrough={onToggleMousePassthrough}
                                    isUndetectable={isUndetectable}
                                    onToggleGhost={onToggleGhost}
                                    shortcuts={shortcuts}
                                    currentModel={currentModel}
                                    onSelectModel={onSelectModel}
                                />
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>

                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: 'spring', damping: 26, stiffness: 300 }}
                    className="fixed pointer-events-auto"
                    style={{ bottom: 10 }}
                >
                    {/* The Dock */}
                    <motion.div
                        className={`flex items-center gap-1 px-3 py-3 rounded-2xl relative select-none draggable-area`}
                        style={{
                            background: 'rgba(18, 22, 34, 0.88)',
                            backdropFilter: 'blur(24px) saturate(180%)',
                            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                            border: '1px solid rgba(255,255,255,0.09)',
                            boxShadow: '0 8px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06)',
                            width: 420,
                        }}
                    >
                        {/* Frozen overlay — blocks clicks on other buttons */}
                        {isFrozen && (
                            <div
                                className="absolute inset-0 rounded-2xl z-10"
                                style={{ pointerEvents: 'auto' }}
                                onClick={(e) => {
                                    // Allow only freeze button click through
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

                        {/* Freeze Mode */}
                        <DockButton
                            icon={<Hand size={22} strokeWidth={1.6} />}
                            tooltip={isFrozen ? 'Unfreeze' : 'Freeze Mode'}
                            isActive={isFrozen}
                            activeColor="#f59e0b"
                            showActiveDot
                            frozen={false}
                            onClick={handleFreezeMode}
                            zIndex={isFrozen ? 20 : undefined}
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

                        {/* Divider */}
                        <div className="w-px h-8 mx-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }} />

                        {/* Pause / Resume */}
                        <DockButton
                            icon={isMeetingPaused ? <Play size={22} strokeWidth={1.6} /> : <Pause size={22} strokeWidth={1.6} />}
                            tooltip={isMeetingPaused ? 'Resume Meeting' : 'Pause Meeting'}
                            isActive={false}
                            frozen={isFrozen}
                            onClick={onPauseResume}
                        />
                        {/* ── NEW: amber dot indicator when paused ── */}
                        {isMeetingPaused && (
                            <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                        )}

                        {/* End Call */}
                        <DockButton
                            icon={<StopCircle size={22} strokeWidth={1.6} />}
                            tooltip="End Call"
                            isActive={false}
                            dangerColor
                            frozen={isFrozen}
                            onClick={onEndCall}
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

                        {/* Divider before drag handle */}
                        <div className="w-px h-8 mx-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }} />

                        {/* Drag Handle */}
                        <motion.div
                            className="flex items-center justify-center w-10 h-10 rounded-xl transition-colors cursor-grab active:cursor-grabbing"
                            whileHover={{ backgroundColor: 'rgba(255,255,255,0.07)' }}
                            whileTap={{ scale: 0.95 }}
                            title="Drag to move"
                            style={{ touchAction: 'none' }}
                        >
                            <GripVertical size={18} className="text-white/30" strokeWidth={2} />
                        </motion.div>
                    </motion.div>
                </motion.div>

            </motion.div>
        </>
    );
};

export default FloatingDock;