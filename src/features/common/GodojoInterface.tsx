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
    const { contentRef, liveTranscriptRef, isMeetingPaused, handlePauseMeeting, requestOverlayResize } = godojoInterfaceState;
    const { isUndetectable, setIsUndetectable, rollingTranscriptUser, rollingTranscriptClient } = godojoInterfaceState;
    const { isClientSpeaking, isUserSpeaking, showTranscript, setShowTranscript } = godojoInterfaceState;
    const { currentModel, setCurrentModel, speakerNames, shortcuts, overlayPanelClass, companyIntel } = godojoInterfaceState;
    const { calendarEventMetadata } = godojoInterfaceState;

    // This component re-renders on every rolling-transcript update (10+/s during
    // a call), so these two handlers must not be inline arrows: a fresh identity
    // each time would invalidate the memo on the dock buttons that receive them.
    // `isUndetectable` in the deps is not churn — it changes only when the user
    // toggles ghost mode, which re-renders that button anyway (isActive flips).
    const handleToggleGhost = React.useCallback(() => {
        const next = !isUndetectable;
        setIsUndetectable(next);
        window.electronAPI?.setUndetectable(next);
    }, [isUndetectable, setIsUndetectable]);

    const handleToggleTranscript = React.useCallback((v: boolean) => {
        setShowTranscript(v);
        localStorage.setItem('natively_interviewer_transcript', String(v));
    }, [setShowTranscript]);

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
                onToggleGhost={handleToggleGhost}
                transcriptRef={liveTranscriptRef}
                rollingTranscriptUser={rollingTranscriptUser}
                rollingTranscriptClient={rollingTranscriptClient}
                isClientSpeaking={isClientSpeaking}
                isUserSpeaking={isUserSpeaking}
                showTranscript={showTranscript}
                onToggleTranscript={handleToggleTranscript}
                currentModel={currentModel}
                onSelectModel={setCurrentModel}
                speakerNames={speakerNames}
                shortcuts={shortcuts}
                overlayPanelClass={overlayPanelClass}
                companyIntel={companyIntel}
                calendarEventMetadata={calendarEventMetadata}
                onRequestOverlayResize={requestOverlayResize}
            />
        </motion.div>
    );
};

export default GodojoInterface;