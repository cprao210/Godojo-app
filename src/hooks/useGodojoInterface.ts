// State + IPC listener layer for GodojoInterface (the meeting overlay window).
// Owns the runtime state FloatingDock needs: live transcript accumulation
// (per-speaker rolling text + the finals buffer live analysis reads), speaker
// names, calendar metadata, company intel, pause state, settings sync
// (undetectable mode, mouse passthrough, model selection) and auto-resize.
// The component only renders — same split as useGlobalChat /
// useCalendarConnections.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShortcuts } from "@/hooks";
import { OVERLAY_OPACITY_DEFAULT } from "@/lib/overlayAppearance";
import { boundRolling } from "@/lib/rollingTranscript";
import { CalendarEvent, GodojoInterfaceProps, LiveTranscriptEntry } from "@/types";
import { qualityFields } from "@/lib/liveTranscript";

export function useGodojoInterface({ overlayOpacity = OVERLAY_OPACITY_DEFAULT }: GodojoInterfaceProps) {
    // `overlayOpacity` is accepted for interface compatibility (App.tsx still
    // passes it) but isn't consumed here — the opacity-driven rich-UI theming
    // it used to feed has been removed.
    void overlayOpacity;

    const [isExpanded, setIsExpanded] = useState(true);
    const { shortcuts, isShortcutPressed } = useShortcuts();
    const [showTranscript, setShowTranscript] = useState(() => {
        const stored = localStorage.getItem('godojo_show_transcript');
        return stored !== 'false';
    });
    const [isMeetingPaused, setIsMeetingPaused] = useState(false);
    // Finals of the live call. `text` is the display text (English when transcript translation is
    // on); the optional fields carry what live analysis v2 needs: the ORIGINAL recognized text,
    // a stable turn id and the suspect-line flag from the main process (transcriptQuality.ts).
    const liveTranscriptRef = useRef<LiveTranscriptEntry[]>([]);
    // Last diarized far-end speaker index seen on a client FINAL — used to
    // inject a "Speaker n:" marker in the rolling text only when it changes.
    const lastClientSpeakerIndexRef = useRef<number | undefined>(undefined);
    // Add near the other useState declarations at the top of the hook
    const [companyIntel, setCompanyIntel] = useState<Record<string, any> | null>(null);

    // Default speaker labels, used until the main process resolves real names
    // from the calendar invite (e.g. "Nikhil", "Salesforce"). Kept as "You" /
    // "Other Party" so they match the labels used everywhere else the speaker
    // is displayed post-call (Transcript tab, Speaking Balance) — these get
    // persisted as `displayName` on each transcript segment, so a mismatch
    // here previously showed up as "Me"/"Them" in the saved transcript even
    // though the rest of the app said "You"/"Other Party".
    const speakerNamesRef = useRef<{ user: string; client: string }>({ user: 'You', client: 'Other Party' });
    const [speakerNames, setSpeakerNames] = useState<{ user: string; client: string }>({
        user: 'You',
        client: 'Other Party'
    });

    // Calendar event metadata the current meeting was started with — needed
    // to forward to /chat/live (FloatingChatPanel) so the live in-call
    // assistant has the same event context (attendees, organizer, link, etc.)
    // that gets persisted to meetings.calendar_event_metadata once the call
    // ends. Overlay is a separate window/renderer from wherever startMeeting()
    // was originally called, so this can't just be prop-drilled — it has to
    // come back over IPC.
    //
    // IMPORTANT: the overlay window is created once and reused (show/hide)
    // across every meeting — see WindowHelper — so GodojoInterface itself
    // only ever mounts once per app session, not once per meeting. A
    // mount-only fetch (`useEffect(..., [])`) therefore only ever captures
    // whichever meeting happened to be active (or none) the very first time
    // this component mounted, and silently goes stale for every meeting
    // after that — which is exactly why calendar_metadata showed up as `[]`
    // in the network tab despite the DB row having real data by the end of
    // the call. Refetching on 'speaker-names-resolved' fixes this: that
    // event already fires reliably exactly once per meeting start, right
    // after IntelligenceManager.setMeetingMetadata() has run.
    const [calendarEventMetadata, setCalendarEventMetadata] = useState<CalendarEvent[] | undefined>(undefined);

    const refreshCalendarEventMetadata = () => {
        if (!window.electronAPI?.getMeetingMetadata) return;
        window.electronAPI.getMeetingMetadata()
            .then((metadata) => {
                setCalendarEventMetadata(metadata?.calendarEvent ? [metadata.calendarEvent] : undefined);
            })
            .catch(() => { /* non-fatal — live chat just proceeds without calendar context */ });
    };

    useEffect(() => {
        refreshCalendarEventMetadata(); // covers first load / page refresh mid-meeting

        const unsubscribe = window.electronAPI?.onSpeakerNamesResolved?.(() => {
            refreshCalendarEventMetadata();
        });
        return () => unsubscribe?.();
    }, []);

    // Add alongside the other IPC useEffect listeners
    useEffect(() => {
        if (!window.electronAPI?.onCompanyIntelUpdated) return;
        const unsubscribe = window.electronAPI.onCompanyIntelUpdated((intel: Record<string, any> | null) => {
            setCompanyIntel(intel);
        });
        return () => unsubscribe?.();
    }, []);

    useEffect(() => {
        const loadSpeakerNames = async () => {
            if (window.electronAPI?.getDisplayName) {
                const user = await window.electronAPI.getDisplayName('user');
                const client = await window.electronAPI.getDisplayName('client');
                setSpeakerNames({ user, client });
            }
        };

        loadSpeakerNames();

        // Listen for speaker name resolution events
        const unsubscribe = window.electronAPI?.onSpeakerNamesResolved?.((names) => {
            console.log('[useGodojoInterface] Speaker names resolved event:', names); // ✅ Debug log
            setSpeakerNames(names);
        });

        return () => unsubscribe?.();
    }, []);

    useEffect(() => {
        // Fetch initial pause state (handles reload/refresh while paused)
        window.electronAPI?.getMeetingPaused?.().then(setIsMeetingPaused).catch(() => { });

        // Subscribe to live pause state changes pushed from main process
        const unsubscribe = window.electronAPI?.onMeetingPauseStateChanged?.((data) => {
            setIsMeetingPaused(data.isPaused);
        });
        return () => unsubscribe?.();
    }, []);

    // Sync transcript setting
    useEffect(() => {
        const handleStorage = () => {
            const stored = localStorage.getItem('godojo_show_transcript');
            setShowTranscript(stored !== 'false');
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    // Per-speaker rolling transcript state — keeps "You" and "Other Party" text strictly isolated
    const [rollingTranscriptUser, setRollingTranscriptUser] = useState('');   // "You" track
    const [rollingTranscriptClient, setRollingTranscriptClient] = useState(''); // "Other Party" track
    const [isClientSpeaking, setIsClientSpeaking] = useState(false);  // Track if actively speaking
    const [isUserSpeaking, setIsUserSpeaking] = useState(false);      // Track if user is speaking
    // True while the tail of a rolling track is an un-finalized partial.
    // The matching final REPLACES that tail (echo trims must not append after
    // the full echoed partial), and a retract event strips it entirely.
    const hasPendingPartialRef = useRef({ user: false, client: false });
    const isStealthRef = useRef<boolean>(false); // Tracks if the next expansion should be stealthy
    const contentRef = useRef<HTMLDivElement>(null);

    // Settings State with Persistence
    const [isUndetectable, setIsUndetectable] = useState(false);
    const [hideChatHidesWidget, setHideChatHidesWidget] = useState(() => {
        const stored = localStorage.getItem('godojo_hideChatHidesWidget');
        return stored ? stored === 'true' : true;
    });

    // Model Selection State
    const [currentModel, setCurrentModel] = useState<string>('gemini-3-flash-preview');

    // Only `overlayPanelClass` is still consumed (by FloatingDock) — the
    // syntax-highlighter theme / code-block surface classes it used to sit
    // next to were only used by the overlay's disabled rich message UI.
    const overlayPanelClass = 'overlay-text-primary';

    useEffect(() => {
        // Load the persisted default model (not the runtime model)
        // Each new meeting starts with the default from settings
        if (window.electronAPI?.getDefaultModel) {
            window.electronAPI.getDefaultModel()
                .then((result: any) => {
                    if (result && result.model) {
                        setCurrentModel(result.model);
                        // Also set the runtime model to the default
                        window.electronAPI.setModel(result.model).catch(() => { });
                    }
                })
                .catch((err: any) => console.error("Failed to fetch default model:", err));
        }
    }, []);

    // Listen for default model changes from Settings
    useEffect(() => {
        if (!window.electronAPI?.onModelChanged) return;
        const unsubscribe = window.electronAPI.onModelChanged((modelId: string) => {
            setCurrentModel(prev => prev === modelId ? prev : modelId);
        });
        return () => unsubscribe();
    }, []);

    // Global State Sync
    useEffect(() => {
        // Fetch initial state
        if (window.electronAPI?.getUndetectable) {
            window.electronAPI.getUndetectable().then(setIsUndetectable);
        }

        if (window.electronAPI?.onUndetectableChanged) {
            const unsubscribe = window.electronAPI.onUndetectableChanged((state) => {
                setIsUndetectable(state);
            });
            return () => unsubscribe();
        }
    }, []);

    // Persist Settings
    useEffect(() => {
        localStorage.setItem('godojo_undetectable', String(isUndetectable));
        localStorage.setItem('godojo_hideChatHidesWidget', String(hideChatHidesWidget));
    }, [isUndetectable, hideChatHidesWidget]);

    // Mouse Passthrough State
    const [isMousePassthrough, setIsMousePassthrough] = useState(false);
    // Read from the keydown handler without re-binding it on every toggle.
    const isMousePassthroughRef = useRef(isMousePassthrough);
    isMousePassthroughRef.current = isMousePassthrough;
    useEffect(() => {
        window.electronAPI?.getOverlayMousePassthrough?.().then(setIsMousePassthrough).catch(() => { });
        const unsub = window.electronAPI?.onOverlayMousePassthroughChanged?.((v) => setIsMousePassthrough(v));
        return () => unsub?.();
    }, []);

    // ── Window resize pipeline ────────────────────────────────────────────
    //
    // PERFORMANCE-CRITICAL: `updateContentDimensions` ultimately calls
    // BrowserWindow.setContentSize()/setPosition() in the main process — a
    // real, synchronous native OS window resize. It is NOT a cheap
    // GPU-composited operation like a CSS transform.
    //
    // The dock's height is animated with a framer-motion spring across
    // expand/collapse and panel switches (~20-30 frames over ~300-500ms).
    // Naively wiring a ResizeObserver straight to this IPC call means every
    // one of those frames fires a native window resize — fine on a
    // discrete GPU, but a major source of stutter/hangs on integrated-GPU or
    // otherwise mid-range machines, where resizing a real top-level window
    // repeatedly in under half a second is comparatively expensive.
    //
    // Fix: known, discrete size transitions (the dock's expand/collapse
    // states) are resized EXPLICITLY and ONCE per transition via
    // `requestOverlayResize`, called by FloatingDock — immediately when
    // growing (so the window is already big enough before content animates
    // into it, avoiding clipping) and once the animation completes when
    // shrinking (so the window doesn't clip the content mid-shrink). See
    // FloatingDock.tsx.
    //
    // The ResizeObserver below still exists as a generic SAFETY NET for
    // anything not covered by that explicit path (e.g. an unexpected reflow
    // from a font finishing loading), but it's debounced to the trailing
    // edge only — it deliberately does not try to track every intermediate
    // animation frame, so it can never become the same per-frame-resize
    // problem it's guarding against.
    const appliedDimsRef = useRef<{ width: number; height: number } | null>(null);
    const WIDTH_JITTER_TOLERANCE_PX = 2;
    const RESIZE_FALLBACK_DEBOUNCE_MS = 220;

    // Sends dimensions to Electron exactly once per meaningfully-different
    // size. `width` is guarded against sub-pixel jitter: getBoundingClientRect
    // returns floats, and on displays with fractional OS scaling (common on
    // laptop panels, rare on external monitors run at 100%) those floats
    // jitter by a fraction of a px between renders — enough for Math.ceil to
    // flip between e.g. 429 and 430. WindowHelper.setOverlayDimensions uses
    // width to re-anchor the window's right edge, so unfiltered jitter here
    // previously showed up as the dock nudging sideways on every resize.
    const applyContentDimensions = (rawWidth: number, height: number) => {
        const applied = appliedDimsRef.current;
        const width =
            applied && Math.abs(rawWidth - applied.width) <= WIDTH_JITTER_TOLERANCE_PX
                ? applied.width
                : rawWidth;

        if (applied && applied.width === width && applied.height === height) return;

        appliedDimsRef.current = { width, height };
        window.electronAPI?.updateContentDimensions({ width, height });
    };

    // Pending trailing-edge measurement from the fallback ResizeObserver below.
    // Declared above requestOverlayResize so the explicit path can cancel it.
    const fallbackResizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Explicit, single-shot resize for known/discrete size changes (the
    // dock's own expand/collapse + panel-switch states). Bypasses the
    // fallback observer's debounce entirely — callers control timing.
    const requestOverlayResize = (height: number, width?: number) => {
        // An explicit resize OWNS the current transition. Any fallback
        // measurement scheduled before it must be cancelled: it would fire
        // mid-animation with a stale or intermediate height and shrink the
        // window underneath the animating content (visible clip/jump until
        // the next observation corrected it). The observer reschedules after
        // the animation settles, and its settled measurement then dedupes to
        // a no-op in applyContentDimensions.
        if (fallbackResizeTimeoutRef.current) {
            clearTimeout(fallbackResizeTimeoutRef.current);
            fallbackResizeTimeoutRef.current = null;
        }
        const resolvedWidth =
            width ?? appliedDimsRef.current?.width ?? Math.ceil(contentRef.current?.getBoundingClientRect().width ?? 430);
        applyContentDimensions(resolvedWidth, Math.ceil(height));
    };

    useLayoutEffect(() => {
        if (!contentRef.current) return;

        let isFirstObservation = true;

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;

            // Initial mount: size the window right away so there's no
            // flash-of-wrong-size before the first debounce window elapses.
            if (isFirstObservation) {
                isFirstObservation = false;
                const rect = entry.target.getBoundingClientRect();
                applyContentDimensions(Math.ceil(rect.width), Math.ceil(rect.height));
                return;
            }

            // Trailing-edge debounce only — deliberately ignores every
            // intermediate frame during an animation and only measures once
            // things settle, so this fallback path can never itself become a
            // per-frame native-resize source.
            if (fallbackResizeTimeoutRef.current) clearTimeout(fallbackResizeTimeoutRef.current);
            fallbackResizeTimeoutRef.current = setTimeout(() => {
                fallbackResizeTimeoutRef.current = null;
                if (!contentRef.current) return;
                const rect = contentRef.current.getBoundingClientRect();
                applyContentDimensions(Math.ceil(rect.width), Math.ceil(rect.height));
            }, RESIZE_FALLBACK_DEBOUNCE_MS);
        });

        observer.observe(contentRef.current);
        return () => {
            observer.disconnect();
            if (fallbackResizeTimeoutRef.current) clearTimeout(fallbackResizeTimeoutRef.current);
        };
    }, []);

    // Force initial sizing safety check
    useEffect(() => {
        const timer = setTimeout(() => {
            if (contentRef.current) {
                const rect = contentRef.current.getBoundingClientRect();
                applyContentDimensions(Math.ceil(rect.width), Math.ceil(rect.height));
            }
        }, 600);
        return () => clearTimeout(timer);
    }, []);

    // Sync Window Visibility with Expanded State
    useEffect(() => {
        if (isExpanded) {
            window.electronAPI.showWindow(isStealthRef.current);
            isStealthRef.current = false; // Reset back to default
        } else {
            // Slight delay to allow animation to clean up if needed, though immediate is safer for click-through
            // Using setTimeout to ensure the render cycle completes first
            // Increased to 400ms to allow "contract to bottom" exit animation to finish
            setTimeout(() => window.electronAPI.hideWindow(), 400);
        }
    }, [isExpanded]);

    // Keyboard shortcut to toggle expanded state (via Main Process)
    useEffect(() => {
        if (!window.electronAPI?.onToggleExpand) return;
        const unsubscribe = window.electronAPI.onToggleExpand(() => {
            setIsExpanded(prev => !prev);
        });
        return () => unsubscribe();
    }, []);

    // Ensure overlay is expanded when requested by main process (e.g. after switching to overlay mode).
    // IMPORTANT: set isStealthRef before setIsExpanded so that if isExpanded was false, the
    // isExpanded effect fires showWindow(true) instead of showWindow(false). Without this,
    // ensure-expanded on a collapsed overlay would trigger show()+focus(), breaking stealth.
    useEffect(() => {
        if (!window.electronAPI?.onEnsureExpanded) return;
        const unsubscribe = window.electronAPI.onEnsureExpanded(() => {
            isStealthRef.current = true;
            setIsExpanded(true);
        });
        return () => unsubscribe();
    }, []);

    // Session Reset Listener - Clears UI when a NEW meeting starts
    useEffect(() => {
        if (!window.electronAPI?.onSessionReset) return;
        const unsubscribe = window.electronAPI.onSessionReset(() => {
            console.log('[useGodojoInterface] Resetting session state...');
            setCompanyIntel(null)

            // CRITICAL FIX: Clear the live transcript ref when meeting resets
            liveTranscriptRef.current = [];

            // Also reset rolling transcripts (both speakers)
            setRollingTranscriptUser('');
            setRollingTranscriptClient('');

            // Re-fetch resolved names from main process instead of resetting to generic labels.
            // The main process keeps resolved names in SessionTracker across session resets.
            window.electronAPI?.getSpeakerNames?.().then((names) => {
                if (names) {
                    speakerNamesRef.current = names;
                    setSpeakerNames(names);
                } else {
                    speakerNamesRef.current = { user: 'You', client: 'Other Party' };
                    setSpeakerNames({ user: 'You', client: 'Other Party' });
                }
            }).catch(() => {
                speakerNamesRef.current = { user: 'You', client: 'Other Party' };
                setSpeakerNames({ user: 'You', client: 'Other Party' });
            });
        });
        return () => unsubscribe();
    }, []);


    // Live transcripts from the native audio pipeline
    useEffect(() => {
        const cleanups: (() => void)[] = [];

        // Real-time Transcripts
        cleanups.push(window.electronAPI.onNativeAudioTranscript((transcript) => {
            // (No per-event console.log: this fires 10+/s for the whole call, and
            // logging every payload object kept DevTools/console busy for nothing.)

            // Retraction: the main process dropped an echo final whose partial
            // was already displayed — remove that pending partial everywhere.
            if (transcript.retract) {
                const side = transcript.speaker === 'client' ? 'client' : 'user';
                if (side === 'client') {
                    setIsClientSpeaking(false);
                } else {
                    setIsUserSpeaking(false);
                }
                if (hasPendingPartialRef.current[side]) {
                    hasPendingPartialRef.current[side] = false;
                    const setRolling = side === 'client' ? setRollingTranscriptClient : setRollingTranscriptUser;
                    setRolling(prev => {
                        // Strip the pending-partial tail (and its separator) —
                        // the next segment re-adds its own separator.
                        const lastSeparator = prev.lastIndexOf('  ·  ');
                        return lastSeparator >= 0 ? prev.substring(0, lastSeparator) : '';
                    });
                }
                return;
            }

            // Route both user and client transcripts to the rolling bar.
            // Skip any unknown speaker types for safety.
            if (transcript.speaker !== 'user' && transcript.speaker !== 'client') {
                return;
            }

            const isClient = transcript.speaker === 'client';

            // Track per-speaker speaking state for animated indicators
            if (isClient) {
                setIsClientSpeaking(!transcript.final);
            } else {
                setIsUserSpeaking(!transcript.final);
            }

            const setRollingForSpeaker = isClient ? setRollingTranscriptClient : setRollingTranscriptUser;

            if (transcript.final) {
                // Use displayName from payload (resolved in main process) for accurate attribution.
                // Fall back to speakerNamesRef for older payloads without displayName.
                const resolvedDisplayName = (transcript as any).displayName
                    || (isClient ? speakerNamesRef.current.client : speakerNamesRef.current.user)
                    || undefined;

                // Diarization: mark far-end speaker changes inline in the rolling
                // text ("Speaker 2: ..."). Only when the index actually changes —
                // 1:1 calls (or diarize off) never show a marker.
                let speakerMarker = '';
                if (isClient && transcript.speakerIndex !== undefined) {
                    if (
                        lastClientSpeakerIndexRef.current !== undefined &&
                        lastClientSpeakerIndexRef.current !== transcript.speakerIndex
                    ) {
                        speakerMarker = `Speaker ${transcript.speakerIndex + 1}: `;
                    }
                    lastClientSpeakerIndexRef.current = transcript.speakerIndex;
                }

                // Finalized text for this speaker's rolling transcript. When a
                // partial is pending, the final REPLACES the pending tail —
                // critical for echo TRIM verdicts, where appending would leave
                // the fully-echoed partial visible ahead of the trimmed final.
                // Without a pending partial, append (guarding against duplicate
                // finals, e.g. both is_final and speech_final from Deepgram).
                const sideKey = isClient ? 'client' : 'user';
                const hadPendingPartial = hasPendingPartialRef.current[sideKey];
                hasPendingPartialRef.current[sideKey] = false;
                setRollingForSpeaker(prev => {
                    const lastSeparator = prev.lastIndexOf('  ·  ');
                    if (hadPendingPartial) {
                        const accumulated = lastSeparator >= 0 ? prev.substring(0, lastSeparator + 5) : '';
                        return boundRolling(accumulated + speakerMarker + transcript.text);
                    }
                    const lastSegment = lastSeparator >= 0 ? prev.substring(lastSeparator + 5) : prev;
                    if (lastSegment.trim() === transcript.text.trim()) return prev; // skip exact duplicate
                    const separator = prev ? '  ·  ' : '';
                    return boundRolling(prev + separator + speakerMarker + transcript.text);
                });

                // Guard liveTranscriptRef against exact-text duplicates from rapid final events
                const lastLive = liveTranscriptRef.current[liveTranscriptRef.current.length - 1];
                if (!lastLive || lastLive.speaker !== transcript.speaker || lastLive.text !== transcript.text) {
                    liveTranscriptRef.current.push({
                        speaker: transcript.speaker,
                        displayName: resolvedDisplayName,
                        text: transcript.text,
                        timestamp: Date.now(),
                        speakerIndex: transcript.speakerIndex,
                        ...qualityFields(transcript),
                    });
                }

                // Clear speaking indicator after a pause
                if (isClient) {
                    setTimeout(() => setIsClientSpeaking(false), 3000);
                } else {
                    setTimeout(() => setIsUserSpeaking(false), 2000);
                }
            } else {
                // Partial (interim) transcript — update only this speaker's track.
                // Previous finalized text from the same speaker is preserved;
                // the other speaker's track is never touched. A growing partial
                // replaces the pending tail; a fresh one opens a new segment.
                const sideKey = isClient ? 'client' : 'user';
                const hadPendingPartial = hasPendingPartialRef.current[sideKey];
                hasPendingPartialRef.current[sideKey] = true;
                setRollingForSpeaker(prev => {
                    if (hadPendingPartial) {
                        const lastSeparator = prev.lastIndexOf('  ·  ');
                        const accumulated = lastSeparator >= 0 ? prev.substring(0, lastSeparator + 5) : '';
                        return boundRolling(accumulated + transcript.text);
                    }
                    const separator = prev ? '  ·  ' : '';
                    return boundRolling(prev + separator + transcript.text);
                });
            }
        }));

        return () => cleanups.forEach(fn => fn());
    }, [isExpanded]);

    const handlePauseMeeting = async () => {
        try {
            if (isMeetingPaused) {
                await window.electronAPI?.resumeMeeting?.();
            } else {
                await window.electronAPI?.pauseMeeting?.();
            }
            // State is updated via onMeetingPauseStateChanged listener — no local setState needed here.
            // This avoids double-state-setting and race conditions.
        } catch (err) {
            console.error('[useGodojoInterface] Failed to toggle meeting pause:', err);
        }
    };

    // Local (focused-window) handling of the remaining overlay shortcuts.
    // The global registrations in KeybindManager cover the unfocused case.
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isShortcutPressed(e, 'toggleVisibility')) {
                e.preventDefault();
                window.electronAPI.toggleWindow();
            } else if (isShortcutPressed(e, 'toggleMousePassthrough')) {
                e.preventDefault();
                const newState = !isMousePassthroughRef.current;
                setIsMousePassthrough(newState);
                window.electronAPI?.setOverlayMousePassthrough?.(newState);
            } else if (isShortcutPressed(e, 'moveWindowUp') || isShortcutPressed(e, 'moveWindowDown')) {
                // Prevent default scrolling when moving window
                e.preventDefault();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isShortcutPressed]);

    // ── Values GodojoInterface.tsx needs to render <FloatingDock/> ──────────
    return {
        // refs
        contentRef,
        liveTranscriptRef,
        // explicit, single-shot overlay window resize (see "Window resize
        // pipeline" above) — pass down to FloatingDock so it can size the
        // native window once per state transition instead of every
        // animation frame
        requestOverlayResize,
        // meeting / session state
        isMeetingPaused,
        handlePauseMeeting,
        // ghost / undetectable mode
        isUndetectable,
        setIsUndetectable,
        // rolling transcript (per-speaker)
        rollingTranscriptUser,
        rollingTranscriptClient,
        isClientSpeaking,
        isUserSpeaking,
        showTranscript,
        setShowTranscript,
        // model selection
        currentModel,
        setCurrentModel,
        // speaker display names
        speakerNames,
        calendarEventMetadata,
        // keyboard shortcuts (for the dock's shortcut hints)
        shortcuts,
        // theming
        overlayPanelClass,
        // pre-call company intelligence
        companyIntel,
    };
}