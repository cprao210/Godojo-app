import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Radio, Brain, Hand, Pause, Play, StopCircle, Settings, GripVertical, Ghost } from 'lucide-react';
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
    rollingTranscriptUser: string;
    rollingTranscriptClient: string;
    isClientSpeaking: boolean;
    isUserSpeaking: boolean;
    showTranscript: boolean;
    onToggleTranscript: (v: boolean) => void;
    currentModel: string;
    onSelectModel: (m: string) => void;
    speakerNames: { user: string; client: string };

    // Settings
    shortcuts: ShortcutConfig;

    overlayPanelClass?: string;

    // Company intelligence from pre-call sales brief
    companyIntel?: Record<string, any> | null;

}

// ─── Chat message type (mirrors FloatingChatPanel) ──────────────────────────
interface ChatMessage {
    id: string;
    role: 'user' | 'system' | 'client';
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
    const [activePanel, setActivePanel] = useState<ActivePanel>(null);
    const [isFrozen, setIsFrozen] = useState(false);
    // Dock + panel transparency — persisted to localStorage
    const OPACITY_KEY = 'gd_dock_opacity';
    const clampOpacity = (v: number) => Math.min(1, Math.max(0.35, v));

    const [dockOpacity, setDockOpacity] = useState<number>(() => {
        const stored = localStorage.getItem(OPACITY_KEY);
        const parsed = stored ? parseFloat(stored) : NaN;
        return Number.isFinite(parsed) ? clampOpacity(parsed) : 0.88;
    });

    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === OPACITY_KEY && e.newValue) {
                const parsed = parseFloat(e.newValue);
                if (Number.isFinite(parsed)) setDockOpacity(clampOpacity(parsed));
            }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const handleDockOpacityChange = (val: number) => {
        const clamped = clampOpacity(val);
        setDockOpacity(clamped);
        localStorage.setItem(OPACITY_KEY, String(clamped));
        window.dispatchEvent(new StorageEvent('storage', { key: OPACITY_KEY, newValue: String(clamped) }));
        window.electronAPI?.setOverlayOpacity?.(clamped);
    };
    // const dragControls = useDragControls();
    const constraintsRef = useRef<HTMLDivElement>(null);

    // ── Lifted state: survives panel switches ──────────────────────────────────
    // Analysis state is owned here so FloatingIntelligencePanel never loses it on remount.
    const { analysisData, isLoading: analysisLoading, error: analysisError, runAnalysis, resetAnalysis, isRefreshRun } = useLiveAnalysis(transcriptRef, isMeetingPaused, companyIntel);

    // Stable ref to runAnalysis — prevents the timer useEffect from re-running
    // (and resetting the countdown) whenever runAnalysis identity changes.
    const runAnalysisRef = useRef(runAnalysis);
    useEffect(() => { runAnalysisRef.current = runAnalysis; }, [runAnalysis]);

    // Track whether the first analysis has been triggered so we don't re-run on every remount.
    const analysisInitiatedRef = useRef(false);

    // ── Trigger first analysis immediately on meeting start (dock mount) ──────
    // Analysis no longer waits for the intelligence panel to be opened.
    // This runs once on mount. The analysisInitiatedRef guard prevents a second
    // run if the component remounts within the same session.
    useEffect(() => {
        if (analysisInitiatedRef.current) return;
        analysisInitiatedRef.current = true;
        runAnalysisRef.current(true);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Chat messages lifted here so history survives panel switches.
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

    // Auto-refresh interval owned here (not in the panel) so the timer survives
    // panel close/open cycles and responds correctly to isMeetingPaused changes.
    const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(2);
    const autoRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Timestamp of when the meeting started (FloatingDock mount) — used to
    // synchronise the countdown display with the actual auto-refresh timer.
    const [intelligencePanelFirstOpenedAt, setIntelligencePanelFirstOpenedAt] = useState<number | null>(null);

    // Manage the auto-refresh timer in FloatingDock so it lives independent of
    // FloatingIntelligencePanel mount/unmount cycles.
    // Re-runs whenever: interval changes, meeting is paused/resumed.
    // When paused — timer is cleared and NOT restarted until resumed.
    // When interval changes mid-countdown — timer resets from NOW, and
    // intelligencePanelFirstOpenedAt is updated so the countdown display realigns.
    useEffect(() => {
        if (autoRefreshTimerRef.current) {
            clearInterval(autoRefreshTimerRef.current);
            autoRefreshTimerRef.current = null;
        }
        // Don't run timer while paused or when auto-refresh is off
        if (autoRefreshInterval === null || isMeetingPaused) return;

        // Align the countdown origin to NOW so the countdown display
        // always matches how long until the next real refresh fires.
        setIntelligencePanelFirstOpenedAt(Date.now());

        autoRefreshTimerRef.current = setInterval(() => {
            runAnalysisRef.current(false);
            // Reset countdown origin after each fire so the next cycle is accurate
            setIntelligencePanelFirstOpenedAt(Date.now());
        }, autoRefreshInterval * 60 * 1000);

        return () => {
            if (autoRefreshTimerRef.current) {
                clearInterval(autoRefreshTimerRef.current);
                autoRefreshTimerRef.current = null;
            }
        };
    }, [autoRefreshInterval, isMeetingPaused]);

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
                style={{ height: '735px' }}
            >

                {/* Overlay Panels — all three stay mounted so internal state (countdown
                    timers, chat history, scroll position) is never lost on panel switch.
                    Visibility + pointer-events are toggled via CSS only. */}

                {/* Intelligence panel — always mounted (analysis starts on meeting start) */}

                <motion.div
                    animate={{
                        opacity: activePanel === 'intelligence' ? dockOpacity : 0,
                        y: activePanel === 'intelligence' ? 0 : 20,
                        scale: activePanel === 'intelligence' ? 1 : 0.96,
                    }}
                    transition={{ type: 'spring', damping: 28, stiffness: 380, mass: 0.8 }}
                    className="fixed bottom-[76px] left-[65px]"
                    style={{
                        position: 'fixed',
                        pointerEvents: activePanel === 'intelligence' ? 'auto' : 'none',
                    }}
                >
                    {isFrozen && activePanel === 'intelligence' && (
                        <div
                            className="absolute inset-0 rounded-2xl z-50"
                            style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.10)', cursor: 'not-allowed' }}
                        />
                    )}
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
                    />
                </motion.div>

                {/* Chat panel — always mounted once first opened */}
                {chatMessages.length > 0 || activePanel === 'chat' ? (
                    <motion.div
                        animate={{
                            opacity: activePanel === 'chat' ? dockOpacity : 0,
                            y: activePanel === 'chat' ? 0 : 20,
                            scale: activePanel === 'chat' ? 1 : 0.96,
                        }}
                        transition={{ type: 'spring', damping: 28, stiffness: 380, mass: 0.8 }}
                        className="fixed bottom-[76px] left-[65px]"
                        style={{
                            position: 'fixed',
                            pointerEvents: activePanel === 'chat' ? 'auto' : 'none',
                        }}
                    >
                        {isFrozen && activePanel === 'chat' && (
                            <div
                                className="absolute inset-0 rounded-2xl z-50"
                                style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.10)', cursor: 'not-allowed' }}
                            />
                        )}
                        <FloatingChatPanel
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
                    </motion.div>
                ) : null}

                {/* Settings panel — lightweight, can unmount freely (no timer state) */}
                <AnimatePresence>
                    {activePanel === 'settings' && (
                        <motion.div
                            initial={{ opacity: 0, y: 20, scale: 0.96 }}
                            animate={{ opacity: dockOpacity, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 12, scale: 0.97 }}
                            transition={{ type: 'spring', damping: 28, stiffness: 380, mass: 0.8 }}
                            className="fixed top-[110px] left-[65px]"
                            style={{ position: 'fixed' }}
                        >
                            {isFrozen && (
                                <div
                                    className="absolute inset-0 rounded-2xl z-50"
                                    style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.10)', cursor: 'not-allowed' }}
                                />
                            )}
                            <FloatingSettingsPanel
                                showTranscript={showTranscript}
                                onToggleTranscript={onToggleTranscript}
                                shortcuts={shortcuts}
                                currentModel={currentModel}
                                onSelectModel={onSelectModel}
                                dockOpacity={dockOpacity}
                                onDockOpacityChange={handleDockOpacityChange}
                            />
                        </motion.div>
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
                        className={`flex items-center gap-2.5 px-3 py-3 rounded-2xl relative select-none draggable-area`}
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
                        {/* <DockButton
                            icon={<Hand size={22} strokeWidth={1.6} />}
                            tooltip={isFrozen ? 'Unfreeze' : 'Freeze Mode'}
                            isActive={isFrozen}
                            activeColor="#f59e0b"
                            showActiveDot
                            frozen={false}
                            onClick={handleFreezeMode}
                            zIndex={isFrozen ? 20 : undefined}
                        /> */}

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