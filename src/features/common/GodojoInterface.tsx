import React from 'react';
import { motion } from 'framer-motion';
import { FloatingDock } from '@/features/floating-dock';
import { useGodojoInterface } from '@/hooks';
import { GodojoInterfaceProps } from '@/types';

// ============================================
// Main Component
// ============================================
// The meeting overlay window. All state, IPC listeners, keyboard shortcuts,
// and auto-resize logic live in useGodojoInterface — this component is
// rendering-only, wiring that state into <FloatingDock/>, which owns the
// actual overlay UI (pause/end controls, transcript, chat panel, settings).
const GodojoInterface: React.FC<GodojoInterfaceProps> = ({ onEndMeeting, overlayOpacity }) => {

    const godojoInterfaceState = useGodojoInterface({ onEndMeeting, overlayOpacity });
    const { contentRef, liveTranscriptRef, isMeetingPaused, handlePauseMeeting } = godojoInterfaceState;
    const { isUndetectable, setIsUndetectable, rollingTranscriptUser, rollingTranscriptClient } = godojoInterfaceState;
    const { isClientSpeaking, isUserSpeaking, showTranscript, setShowTranscript } = godojoInterfaceState;
    const { currentModel, setCurrentModel, speakerNames, shortcuts, overlayPanelClass, companyIntel } = godojoInterfaceState;

    return (
        <motion.div
            ref={contentRef}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            className="flex flex-col items-center w-full mx-auto h-full min-h-0 bg-transparent p-0 rounded-[24px] font-sans gap-2 overlay-text-primary"
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
            <FloatingDock
                isMeetingPaused={isMeetingPaused}
                onPauseResume={handlePauseMeeting}
                onEndCall={onEndMeeting ?? (() => { })}
                isUndetectable={isUndetectable}
                onToggleGhost={() => {
                    const next = !isUndetectable;
                    setIsUndetectable(next);
                    window.electronAPI?.setUndetectable(next);
                }}
                transcriptRef={liveTranscriptRef}
                rollingTranscriptUser={rollingTranscriptUser}
                rollingTranscriptClient={rollingTranscriptClient}
                isClientSpeaking={isClientSpeaking}
                isUserSpeaking={isUserSpeaking}
                showTranscript={showTranscript}
                onToggleTranscript={(v) => {
                    setShowTranscript(v);
                    localStorage.setItem('natively_interviewer_transcript', String(v));
                }}
                currentModel={currentModel}
                onSelectModel={setCurrentModel}
                speakerNames={speakerNames}
                shortcuts={shortcuts}
                overlayPanelClass={overlayPanelClass}
                companyIntel={companyIntel}
            />
        </motion.div>
    );
};

export default GodojoInterface;