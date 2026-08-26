// State + IPC listener layer for GodojoInterface (the meeting overlay window).
// Owns every piece of runtime state the overlay needs: connection/session
// status, live transcript accumulation, intelligence-command results,
// settings sync (undetectable mode, mouse passthrough, model selection),
// keyboard shortcuts, and auto-resize. The component only renders — same
// split as useGlobalChat / useCalendarConnections.
//
// NOTE ON SCOPE: the overlay's rich chat/message-list UI (quick actions,
// markdown-rendered answers, code blocks, manual voice input bar) is
// currently disabled — GodojoInterface.tsx renders only <FloatingDock/>,
// which owns its own UI. All of that IPC listener wiring below (messages,
// streaming intelligence responses, manual answer flow, etc.) is kept
// exactly as-is because it still runs and still matters (state sync,
// analytics, session lifecycle) even though nothing currently reads
// `messages` for display. If/when the rich UI is reintroduced, its render
// logic can resume consuming the `messages` state this hook already
// maintains.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShortcuts } from "@/hooks";
import { OVERLAY_OPACITY_DEFAULT } from "@/lib/overlayAppearance";
import { CalendarEvent, GodojoInterfaceMessage, GodojoInterfaceProps } from "@/types";

export function useGodojoInterface({ overlayOpacity = OVERLAY_OPACITY_DEFAULT }: GodojoInterfaceProps) {
    // `overlayOpacity` is accepted for interface compatibility (App.tsx still
    // passes it) but isn't consumed here — it only ever fed the overlay's
    // rich-UI theming (`getOverlayAppearance`), which is currently disabled.
    void overlayOpacity;

    const [isExpanded, setIsExpanded] = useState(true);
    const [inputValue, setInputValue] = useState('');
    const { shortcuts, isShortcutPressed } = useShortcuts();
    const [messages, setMessages] = useState<GodojoInterfaceMessage[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [conversationContext, setConversationContext] = useState<string>('');
    const [isManualRecording, setIsManualRecording] = useState(false);
    const isRecordingRef = useRef(false);  // Ref to track recording state (avoids stale closure)
    const [manualTranscript, setManualTranscript] = useState('');
    const manualTranscriptRef = useRef<string>('');
    const [showTranscript, setShowTranscript] = useState(() => {
        const stored = localStorage.getItem('natively_interviewer_transcript');
        return stored !== 'false';
    });
    const [isMeetingPaused, setIsMeetingPaused] = useState(false);
    const liveTranscriptRef = useRef<Array<{ speaker: string; displayName?: string; text: string; timestamp: number; speakerIndex?: number }>>([]);
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

    // Analytics State
    const requestStartTimeRef = useRef<number | null>(null);

    // Sync transcript setting
    useEffect(() => {
        const handleStorage = () => {
            const stored = localStorage.getItem('natively_interviewer_transcript');
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

    // Legacy combined props kept for any callers that still expect them;
    // derived from per-speaker state so they stay in sync automatically.
    const rollingTranscript = rollingTranscriptClient; // kept for commented-out legacy code
    const rollingTranscriptSpeaker: 'client' | 'user' = 'client'; // unused after refactor
    const [voiceInput, setVoiceInput] = useState('');  // Accumulated user voice input
    const voiceInputRef = useRef<string>('');  // Ref for capturing in async handlers
    const isStealthRef = useRef<boolean>(false); // Tracks if the next expansion should be stealthy
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    // Latent Context State (Screenshots attached but not sent)
    const [attachedContext, setAttachedContext] = useState<Array<{ path: string, preview: string }>>([]);

    // Settings State with Persistence
    const [isUndetectable, setIsUndetectable] = useState(false);
    const [hideChatHidesWidget, setHideChatHidesWidget] = useState(() => {
        const stored = localStorage.getItem('natively_hideChatHidesWidget');
        return stored ? stored === 'true' : true;
    });

    // Model Selection State
    const [currentModel, setCurrentModel] = useState<string>('gemini-3-flash-preview');

    // Dynamic Action Button Mode (Recap vs Brainstorm)
    const [actionButtonMode, setActionButtonMode] = useState<'recap' | 'brainstorm'>('recap');

    useEffect(() => {
        // Load persisted mode
        window.electronAPI?.getActionButtonMode?.()?.then((mode: 'recap' | 'brainstorm') => {
            if (mode) setActionButtonMode(mode);
        }).catch(() => { });

        // Listen for live changes from SettingsPopup / IPC
        const unsubscribe = window.electronAPI?.onActionButtonModeChanged?.((mode: 'recap' | 'brainstorm') => {
            setActionButtonMode(mode);
        });
        return () => { unsubscribe?.(); };
    }, []);

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

    const handleModelSelect = (modelId: string) => {
        setCurrentModel(modelId);
        // Session-only: update runtime but don't persist as default
        window.electronAPI.setModel(modelId)
            .catch((err: any) => console.error("Failed to set model:", err));
    };

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
        localStorage.setItem('natively_undetectable', String(isUndetectable));
        localStorage.setItem('natively_hideChatHidesWidget', String(hideChatHidesWidget));
    }, [isUndetectable, hideChatHidesWidget]);

    // Mouse Passthrough State
    const [isMousePassthrough, setIsMousePassthrough] = useState(false);
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

    // Explicit, single-shot resize for known/discrete size changes (the
    // dock's own expand/collapse + panel-switch states). Bypasses the
    // fallback observer's debounce entirely — callers control timing.
    const requestOverlayResize = (height: number, width?: number) => {
        const resolvedWidth =
            width ?? appliedDimsRef.current?.width ?? Math.ceil(contentRef.current?.getBoundingClientRect().width ?? 430);
        applyContentDimensions(resolvedWidth, Math.ceil(height));
    };

    const fallbackResizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Force resize when attachedContext changes (screenshots added/removed).
    // A discrete, non-animated size change — safe to apply immediately.
    useEffect(() => {
        if (!contentRef.current) return;
        requestAnimationFrame(() => {
            if (!contentRef.current) return;
            const rect = contentRef.current.getBoundingClientRect();
            applyContentDimensions(Math.ceil(rect.width), Math.ceil(rect.height));
        });
    }, [attachedContext]);

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

    // Auto-scroll
    useEffect(() => {
        if (isExpanded) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, isExpanded, isProcessing]);

    // Build conversation context from messages
    useEffect(() => {
        const context = messages
            .filter(m => m.role !== 'user' || !m.hasScreenshot)
            .map(m => `${m.role === 'client' ? 'Client' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
            .slice(-20)
            .join('\n');
        setConversationContext(context);
    }, [messages]);

    // Listen for settings window visibility changes
    useEffect(() => {
        if (!window.electronAPI?.onSettingsVisibilityChange) return;
        const unsubscribe = window.electronAPI.onSettingsVisibilityChange((isVisible) => {
            setIsSettingsOpen(isVisible);
        });
        return () => unsubscribe();
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
            setMessages([]);
            setInputValue('');
            setAttachedContext([]);
            setManualTranscript('');
            setVoiceInput('');
            setIsProcessing(false);
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


    const handleScreenshotAttach = (data: { path: string; preview: string }) => {
        setIsExpanded(true);
        setAttachedContext(prev => {
            // Prevent duplicates and cap at 5
            if (prev.some(s => s.path === data.path)) return prev;
            const updated = [...prev, data];
            return updated.slice(-5); // Keep last 5
        });
    };

    // Connect to Native Audio Backend
    useEffect(() => {
        const cleanups: (() => void)[] = [];

        // Connection Status
        window.electronAPI.getNativeAudioStatus().then((status) => {
            setIsConnected(status.connected);
        }).catch(() => setIsConnected(false));

        cleanups.push(window.electronAPI.onNativeAudioConnected(() => {
            setIsConnected(true);
        }));
        cleanups.push(window.electronAPI.onNativeAudioDisconnected(() => {
            setIsConnected(false);
        }));

        // Audio warnings from the main process (loopback input device, SCK
        // permission problems, ...) — informational only, never blocking.
        cleanups.push(window.electronAPI.onMeetingAudioWarning((message) => {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Audio warning: ${message}`
            }]);
        }));

        // Real-time Transcripts
        cleanups.push(window.electronAPI.onNativeAudioTranscript((transcript) => {
            // When Answer button is active, capture USER transcripts for voice input
            // Use ref to avoid stale closure issue
            console.log(transcript, '[Transcript Event]');

            // Retraction: the main process dropped an echo final whose partial
            // was already displayed — remove that pending partial everywhere.
            if (transcript.retract) {
                const side = transcript.speaker === 'client' ? 'client' : 'user';
                if (side === 'client') {
                    setIsClientSpeaking(false);
                } else {
                    setIsUserSpeaking(false);
                    if (isRecordingRef.current) {
                        setManualTranscript('');
                        manualTranscriptRef.current = '';
                    }
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

            if (isRecordingRef.current && transcript.speaker === 'user') {
                if (transcript.final) {
                    // Accumulate final transcripts
                    setVoiceInput(prev => {
                        const updated = prev + (prev ? ' ' : '') + transcript.text;
                        voiceInputRef.current = updated;
                        return updated;
                    });
                    setManualTranscript('');  // Clear partial preview
                    manualTranscriptRef.current = '';

                    // Still push to liveTranscriptRef so the full transcript
                    // is available for live analysis and post-meeting use.
                    const resolvedDisplayName = (transcript as any).displayName
                        || speakerNamesRef.current.user
                        || undefined;
                    const lastLive = liveTranscriptRef.current[liveTranscriptRef.current.length - 1];
                    if (!lastLive || lastLive.speaker !== transcript.speaker || lastLive.text !== transcript.text) {
                        liveTranscriptRef.current.push({
                            speaker: transcript.speaker,
                            displayName: resolvedDisplayName,
                            text: transcript.text,
                            timestamp: Date.now(),
                        });
                    }
                } else {
                    // Show live partial transcript
                    setManualTranscript(transcript.text);
                    manualTranscriptRef.current = transcript.text;
                }

                return;  // Don't add to messages while recording
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
                        return accumulated + speakerMarker + transcript.text;
                    }
                    const lastSegment = lastSeparator >= 0 ? prev.substring(lastSeparator + 5) : prev;
                    if (lastSegment.trim() === transcript.text.trim()) return prev; // skip exact duplicate
                    const separator = prev ? '  ·  ' : '';
                    return prev + separator + speakerMarker + transcript.text;
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
                        return accumulated + transcript.text;
                    }
                    const separator = prev ? '  ·  ' : '';
                    return prev + separator + transcript.text;
                });
            }
        }));

        // AI Suggestions from native audio (legacy)
        cleanups.push(window.electronAPI.onSuggestionProcessingStart(() => {
            setIsProcessing(true);
            setIsExpanded(true);
        }));

        cleanups.push(window.electronAPI.onSuggestionGenerated((data) => {
            setIsProcessing(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: data.suggestion
            }]);
        }));

        cleanups.push(window.electronAPI.onSuggestionError((err) => {
            setIsProcessing(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err.error}`
            }]);
        }));



        cleanups.push(window.electronAPI.onIntelligenceSuggestedAnswerToken((data) => {
            // Progressive update for 'what_to_answer' mode
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];

                // If we already have a streaming message for this intent, append
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'what_to_answer') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }

                // Otherwise, start a new one (First token)
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'what_to_answer',
                    isStreaming: true
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceSuggestedAnswer((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];

                // If we were streaming, finalize it
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'what_to_answer') {
                    // Start new array to avoid mutation
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.answer, // Ensure final consistency
                        isStreaming: false
                    };
                    return updated;
                }

                // If we missed the stream (or not streaming), append fresh
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.answer,  // Plain text, no markdown - ready to speak
                    intent: 'what_to_answer'
                }];
            });
        }));

        // STREAMING: Refinement
        cleanups.push(window.electronAPI.onIntelligenceRefinedAnswerToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === data.intent) {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }
                // New stream start (e.g. user clicked Shorten)
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: data.intent,
                    isStreaming: true
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceRefinedAnswer((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === data.intent) {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.answer,
                        isStreaming: false
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.answer,
                    intent: data.intent
                }];
            });
        }));

        // STREAMING: Recap
        cleanups.push(window.electronAPI.onIntelligenceRecapToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'recap') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'recap',
                    isStreaming: true
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceRecap((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'recap') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.summary,
                        isStreaming: false
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.summary,
                    intent: 'recap'
                }];
            });
        }));

        // STREAMING: Follow-Up Questions (Rendered as message? Or specific UI?)
        // Currently interface typically renders follow-up Qs as a message or button update.
        // Let's assume message for now based on existing 'follow_up_questions_update' handling
        // But wait, existing handle just sets state?
        // Let's check how 'follow_up_questions_update' was handled.
        // It was handled separate locally in this component maybe?
        // Ah, I need to see the existing listener for 'onIntelligenceFollowUpQuestionsUpdate'

        // Let's implemented token streaming for it anyway, likely it updates a message bubble 
        // OR it might update a specialized "Suggested Questions" area.
        // Assuming it's a message for consistency with "Copilot" approach.

        cleanups.push(window.electronAPI.onIntelligenceFollowUpQuestionsToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'follow_up_questions') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'follow_up_questions',
                    isStreaming: true
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceFollowUpQuestionsUpdate((data) => {
            // This event name is slightly different ('update' vs 'answer')
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'follow_up_questions') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.questions,
                        isStreaming: false
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.questions,
                    intent: 'follow_up_questions'
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceManualResult((data) => {
            setIsProcessing(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `🎯 **Answer:**\n\n${data.answer}`
            }]);
        }));

        cleanups.push(window.electronAPI.onIntelligenceError((data) => {
            setIsProcessing(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `❌ Error (${data.mode}): ${data.error}`
            }]);
        }));
        // Screenshot taken - attach to chat input instead of auto-analyzing
        cleanups.push(window.electronAPI.onScreenshotTaken(handleScreenshotAttach));

        // Selective Screenshot (Latent Context)
        if (window.electronAPI.onScreenshotAttached) {
            cleanups.push(window.electronAPI.onScreenshotAttached(handleScreenshotAttach));
        }


        return () => cleanups.forEach(fn => fn());
    }, [isExpanded]);

    // Stable mount-only effect for clarify streaming listeners.
    // These MUST NOT be inside the [isExpanded] effect — if the user
    // expands/collapses the panel while a clarify stream is in-flight,
    // the [isExpanded] effect would tear down and re-register listeners,
    // orphaning the final 'clarify' event and leaving isProcessing=true forever.
    useEffect(() => {
        const cleanupToken = window.electronAPI.onIntelligenceClarifyToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'clarify') {
                    const updated = [...prev];
                    updated[prev.length - 1] = { ...lastMsg, text: lastMsg.text + data.token };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system' as const,
                    text: data.token,
                    intent: 'clarify',
                    isStreaming: true
                }];
            });
        });

        const cleanupFinal = window.electronAPI.onIntelligenceClarify((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'clarify') {
                    const updated = [...prev];
                    updated[prev.length - 1] = { ...lastMsg, text: data.clarification, isStreaming: false };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system' as const,
                    text: data.clarification,
                    intent: 'clarify'
                }];
            });
        });

        return () => {
            cleanupToken();
            cleanupFinal();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // intentionally empty — these listeners must survive isExpanded changes

    // Quick Actions - Updated to use new Intelligence APIs

    const handleCopy = (text: string) => {
        navigator.clipboard.writeText(text);
        // Optional: Trigger a small toast or state change for visual feedback
    };

    const handleWhatToSay = async () => {
        setIsExpanded(true);
        setIsProcessing(true);

        // Capture and clear attached image context
        const currentAttachments = attachedContext;
        if (currentAttachments.length > 0) {
            setAttachedContext([]);
            // Show the attached image in chat
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'user',
                text: 'What should I say about this?',
                hasScreenshot: true,
                screenshotPreview: currentAttachments[0].preview
            }]);
        }

        try {
            // Pass imagePath if attached
            await window.electronAPI.generateWhatToSay(undefined, currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined);
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleWhatAmIMissing = async () => {
        setIsExpanded(true);
        setIsProcessing(true);

        try {
            await window.electronAPI.generateWhatAmIMissing();
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDiscovery = async () => {
        setIsExpanded(true);
        setIsProcessing(true);

        try {
            await window.electronAPI.generateDiscovery();
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleObjectionHandler = async () => {
        setIsExpanded(true);
        setIsProcessing(true);

        try {
            await window.electronAPI.generateObjectionHandler();
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleFollowUp = async (intent: string = 'rephrase') => {
        setIsExpanded(true);
        setIsProcessing(true);

        try {
            await window.electronAPI.generateFollowUp(intent);
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleRecap = async () => {
        setIsExpanded(true);
        setIsProcessing(true);

        try {
            await window.electronAPI.generateRecap();
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleFollowUpQuestions = async () => {
        setIsExpanded(true);
        setIsProcessing(true);

        try {
            await window.electronAPI.generateFollowUpQuestions();
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleClarify = async () => {
        setIsExpanded(true);
        setIsProcessing(true);

        try {
            await window.electronAPI.generateClarify();
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleCodeHint = async () => {
        setIsExpanded(true);
        setIsProcessing(true);

        const currentAttachments = attachedContext;
        if (currentAttachments.length > 0) {
            setAttachedContext([]);
            // Show the attached image in chat
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'user',
                text: 'Give me a code hint for this',
                hasScreenshot: true,
                screenshotPreview: currentAttachments[0].preview
            }]);
        }

        try {
            await window.electronAPI.generateCodeHint(currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined);
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleBrainstorm = async () => {
        setIsExpanded(true);
        setIsProcessing(true);

        const currentAttachments = attachedContext;
        if (currentAttachments.length > 0) {
            setAttachedContext([]);
            // Show the attached image in chat
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'user',
                text: 'Brainstorm with this context',
                hasScreenshot: true,
                screenshotPreview: currentAttachments[0].preview
            }]);
        }

        try {
            await window.electronAPI.generateBrainstorm(currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined);
        } catch (err) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };


    // Setup Streaming Listeners
    useEffect(() => {
        const cleanups: (() => void)[] = [];

        // Stream Token
        cleanups.push(window.electronAPI.onGeminiStreamToken((token) => {
            // Guard: if this token is the negotiation coaching JSON sentinel, accumulate it
            // silently. The JSON is always emitted as a single complete `yield JSON.stringify(...)`
            // call, so one parse attempt is sufficient. The onGeminiStreamDone handler will
            // detect the accumulated JSON and render the proper card UI — we just prevent the
            // raw JSON characters from ever appearing in the chat bubble.
            try {
                const parsed = JSON.parse(token);
                if (parsed?.__negotiationCoaching) {
                    // Store the raw JSON text (Done handler needs it) but don't show it.
                    setMessages(prev => {
                        const lastMsg = prev[prev.length - 1];
                        if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                            const updated = [...prev];
                            updated[prev.length - 1] = { ...lastMsg, text: token };
                            return updated;
                        }
                        return prev;
                    });
                    return; // Skip the normal append below
                }
            } catch {
                // Not JSON — normal text token, fall through to the standard append.
            }

            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + token,
                        // re-check code status on every token? Expensive but needed for progressive highlighting
                        isCode: (lastMsg.text + token).includes('```') || (lastMsg.text + token).includes('def ') || (lastMsg.text + token).includes('function ')
                    };
                    return updated;
                }
                return prev;
            });
        }));

        // Stream Done
        cleanups.push(window.electronAPI.onGeminiStreamDone(() => {
            setIsProcessing(false);
            requestStartTimeRef.current = null;

            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                    // Detect negotiation coaching response
                    try {
                        const parsed = JSON.parse(lastMsg.text);
                        if (parsed?.__negotiationCoaching) {
                            const coaching = parsed.__negotiationCoaching;
                            return [...prev.slice(0, -1), {
                                ...lastMsg,
                                isStreaming: false,
                                isNegotiationCoaching: true,
                                negotiationCoachingData: coaching,
                                text: '',
                            }];
                        }
                    } catch { }
                    // Normal completion
                    return [...prev.slice(0, -1), { ...lastMsg, isStreaming: false }];
                }
                return prev;
            });
        }));

        // Token stream
        cleanups.push(window.electronAPI.onWhatAmIMissingToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'what_am_i_missing') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'what_am_i_missing',
                    isStreaming: true
                }];
            });
        }));

        // Final event
        cleanups.push(window.electronAPI.onWhatAmIMissing((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'what_am_i_missing') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.answer,
                        isStreaming: false
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.answer,
                    intent: 'what_am_i_missing'
                }];
            });
        }));

        // Discovery token stream
        cleanups.push(window.electronAPI.onDiscoveryToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'discovery') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'discovery',
                    isStreaming: true
                }];
            });
        }));

        // Discovery final
        cleanups.push(window.electronAPI.onDiscovery((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'discovery') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.answer,
                        isStreaming: false
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.answer,
                    intent: 'discovery'
                }];
            });
        }));

        // Objection Handler token stream
        cleanups.push(window.electronAPI.onObjectionHandlerToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'objection_handler') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'objection_handler',
                    isStreaming: true
                }];
            });
        }));

        // Objection Handler final
        cleanups.push(window.electronAPI.onObjectionHandler((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'objection_handler') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.answer,
                        isStreaming: false
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.answer,
                    intent: 'objection_handler'
                }];
            });
        }));

        // Stream Error
        cleanups.push(window.electronAPI.onGeminiStreamError((error) => {
            setIsProcessing(false);
            requestStartTimeRef.current = null; // Clear timer on error
            setMessages(prev => {
                // Append error to the current message or add new one?
                // Let's add a new error block if the previous one confusing,
                // or just update status.
                // Ideally we want to show the partial response AND the error.
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming) {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        isStreaming: false,
                        text: lastMsg.text + `\n\n[Error: ${error}]`
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: `❌ Error: ${error}`
                }];
            });
        }));

        // Update the onRAGStreamChunk handler as well
        if (window.electronAPI.onRAGStreamChunk) {
            cleanups.push(window.electronAPI.onRAGStreamChunk((data: { chunk: string; meetingId?: string; global?: boolean }) => {
                // Check if this chunk is the start of a Live Analysis response
                if (data.chunk.includes('"bant"') || data.chunk.includes('"meddic"') || data.chunk.includes('"objections"')) {
                    // Don't add analysis to messages - just ignore it silently
                    console.log('[useGodojoInterface] Ignoring Live Analysis chunk in chat');
                    return;
                }

                // Check if this chunk is from a meeting RAG query (has meetingId or global)
                // These are valid chat responses
                if (!data.meetingId && !data.global) {
                    // Not a chat response - ignore
                    return;
                }

                // Same guard for negotiation coaching
                try {
                    const parsed = JSON.parse(data.chunk);
                    if (parsed?.__negotiationCoaching) {
                        setMessages(prev => {
                            const lastMsg = prev[prev.length - 1];
                            if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                                const updated = [...prev];
                                updated[prev.length - 1] = { ...lastMsg, text: data.chunk };
                                return updated;
                            }
                            return prev;
                        });
                        return;
                    }
                } catch {
                    // Normal text chunk — fall through.
                }

                // Only process non-analysis chunks
                setMessages(prev => {
                    const lastMsg = prev[prev.length - 1];
                    if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                        const updated = [...prev];
                        updated[prev.length - 1] = {
                            ...lastMsg,
                            text: lastMsg.text + data.chunk,
                            isCode: (lastMsg.text + data.chunk).includes('```')
                        };
                        return updated;
                    }
                    return prev;
                });
            }));
        }

        if (window.electronAPI.onRAGStreamComplete) {
            cleanups.push(window.electronAPI.onRAGStreamComplete((data: { meetingId?: string; global?: boolean }) => {

                // Only process if this is a chat response (has meetingId or global)
                if (!data.meetingId && !data.global) {
                    console.log('[useGodojoInterface] Ignoring non-chat stream completion');
                    return;
                }

                setIsProcessing(false);
                requestStartTimeRef.current = null;
                setMessages(prev => {
                    const lastMsg = prev[prev.length - 1];
                    if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                        // Detect negotiation coaching response
                        try {
                            const parsed = JSON.parse(lastMsg.text);
                            if (parsed?.__negotiationCoaching) {
                                const coaching = parsed.__negotiationCoaching;
                                return [...prev.slice(0, -1), {
                                    ...lastMsg,
                                    isStreaming: false,
                                    isNegotiationCoaching: true,
                                    negotiationCoachingData: coaching,
                                    text: '',
                                }];
                            }
                        } catch { }

                        // Normal completion - keep the message
                        return [...prev.slice(0, -1), { ...lastMsg, isStreaming: false }];
                    }
                    if (lastMsg && lastMsg.isStreaming) {
                        const updated = [...prev];
                        updated[prev.length - 1] = { ...lastMsg, isStreaming: false };
                        return updated;
                    }
                    return prev;
                });
            }));
        }

        if (window.electronAPI.onRAGStreamError) {
            cleanups.push(window.electronAPI.onRAGStreamError((data: { error: string }) => {
                setIsProcessing(false);
                requestStartTimeRef.current = null;
                setMessages(prev => {
                    const lastMsg = prev[prev.length - 1];
                    if (lastMsg && lastMsg.isStreaming) {
                        const updated = [...prev];
                        updated[prev.length - 1] = {
                            ...lastMsg,
                            isStreaming: false,
                            text: lastMsg.text + `\n\n[RAG Error: ${data.error}]`
                        };
                        return updated;
                    }
                    return prev;
                });
            }));
        }

        return () => cleanups.forEach(fn => fn());
    }, [currentModel]); // Ensure tracking captures correct model


    const handleAnswerNow = async () => {
        if (isManualRecording) {
            // Stop recording - send accumulated voice input to Gemini
            isRecordingRef.current = false;  // Update ref immediately
            setIsManualRecording(false);
            setManualTranscript('');  // Clear live preview

            // Send manual finalization signal to STT Providers
            window.electronAPI.finalizeMicSTT().catch(err => console.error('[useGodojoInterface] Failed to send finalizeMicSTT:', err));

            const currentAttachments = attachedContext;
            setAttachedContext([]); // Clear context immediately on send

            const question = (voiceInputRef.current + (manualTranscriptRef.current ? ' ' + manualTranscriptRef.current : '')).trim();
            setVoiceInput('');
            voiceInputRef.current = '';
            setManualTranscript('');
            manualTranscriptRef.current = '';

            if (!question && currentAttachments.length === 0) {
                // No voice input and no image
                setMessages(prev => [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: '⚠️ No speech detected. Try speaking closer to your microphone.'
                }]);
                return;
            }

            // Show user's spoken question
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'user',
                text: question,
                hasScreenshot: currentAttachments.length > 0,
                screenshotPreview: currentAttachments[0]?.preview
            }]);

            // Add placeholder for streaming response
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: '',
                isStreaming: true
            }]);

            setIsProcessing(true);

            try {
                let prompt = '';

                if (currentAttachments.length > 0) {
                    // Image + Voice Context
                    prompt = `You are a helper. The user has provided a screenshot and a spoken question/command.
                        User said: "${question}"

                        Instructions:
                        1. Analyze the screenshot in the context of what the user said.
                        2. Provide a direct, helpful answer.
                        3. Be concise.`;
                } else {
                    // JIT RAG pre-flight: try to use indexed meeting context first
                    const ragResult = await window.electronAPI.ragQueryLive?.(question);
                    if (ragResult?.success) {
                        // JIT RAG handled it — response streamed via rag:stream-chunk events
                        return;
                    }

                    // Voice Only (Smart Extract) — fallback
                    prompt = `You are a real-time interview assistant. The user just repeated or paraphrased a question from their interviewer.
Instructions:
1. Extract the core question being asked
2. Provide a clear, concise, and professional answer that the user can say out loud
3. Keep the answer conversational but informative (2-4 sentences ideal)
4. Do NOT include phrases like "The question is..." - just give the answer directly
5. Format for speaking out loud, not for reading

Provide only the answer, nothing else.`;
                }

                // Call Streaming API: message = question, context = instructions
                requestStartTimeRef.current = Date.now();
                await window.electronAPI.streamGeminiChat(question, currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined, prompt, { skipSystemPrompt: true });

            } catch (err) {
                // Initial invocation failing (e.g. IPC error before stream starts)
                setIsProcessing(false);
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    // If we just added the empty streaming placeholder, remove it or fill it with error
                    if (last && last.isStreaming && last.text === '') {
                        return prev.slice(0, -1).concat({
                            id: Date.now().toString(),
                            role: 'system',
                            text: `❌ Error starting stream: ${err}`
                        });
                    }
                    return [...prev, {
                        id: Date.now().toString(),
                        role: 'system',
                        text: `❌ Error: ${err}`
                    }];
                });
            }
        } else {
            // Start recording - reset voice input state
            setVoiceInput('');
            voiceInputRef.current = '';
            setManualTranscript('');
            isRecordingRef.current = true;  // Update ref immediately
            setIsManualRecording(true);


            // Ensure native audio is connected
            try {
                // Native audio is now managed by main process
                // await window.electronAPI.invoke('native-audio-connect');
            } catch (err) {
                // Already connected, that's fine
            }
        }
    };

    const handleManualSubmit = async () => {
        if (!inputValue.trim() && attachedContext.length === 0) return;

        const userText = inputValue;
        const currentAttachments = attachedContext;

        // Clear inputs immediately
        setInputValue('');
        setAttachedContext([]);

        setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'user',
            text: userText || (currentAttachments.length > 0 ? 'Analyze this screenshot' : ''),
            hasScreenshot: currentAttachments.length > 0,
            screenshotPreview: currentAttachments[0]?.preview
        }]);

        // Add placeholder for streaming response
        setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'system',
            text: '',
            isStreaming: true
        }]);

        setIsExpanded(true);
        setIsProcessing(true);

        try {
            // JIT RAG pre-flight: try to use indexed meeting context first
            if (currentAttachments.length === 0) {
                const ragResult = await window.electronAPI.ragQueryLive?.(userText || '');
                if (ragResult?.success) {
                    // JIT RAG handled it — response streamed via rag:stream-chunk events
                    return;
                }
            }

            // Pass imagePath if attached, AND conversation context
            requestStartTimeRef.current = Date.now();
            await window.electronAPI.streamGeminiChat(
                userText || 'Analyze this screenshot',
                currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined,
                conversationContext // Pass context so "answer this" works
            );
        } catch (err: any) {
            setIsProcessing(false);
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last && last.isStreaming && last.text === '') {
                    // remove the empty placeholder
                    return prev.slice(0, -1).concat({
                        id: Date.now().toString(),
                        role: 'system',
                        text: `❌ Error starting stream: ${err?.message}`
                    });
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: `❌ Error: ${err?.message}`
                }];
            });
        }
    };

    const clearChat = () => {
        setMessages([]);
    };

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


    // We use a ref to hold the latest handlers to avoid re-binding the event listener on every render
    const handlersRef = useRef({
        handleWhatToSay,
        handleFollowUp,
        handleFollowUpQuestions,
        handleRecap,
        handleAnswerNow,
        handleClarify,
        handleCodeHint,
        handleBrainstorm
    });

    // Update ref on every render so the event listener always access latest state/props
    handlersRef.current = {
        handleWhatToSay,
        handleFollowUp,
        handleFollowUpQuestions,
        handleRecap,
        handleAnswerNow,
        handleClarify,
        handleCodeHint,
        handleBrainstorm
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const { handleWhatToSay, handleFollowUp, handleFollowUpQuestions, handleRecap, handleAnswerNow, handleClarify, handleCodeHint, handleBrainstorm } = handlersRef.current;

            // Chat Shortcuts (Scope: Local to Chat/Overlay usually, but we allow them here if focused)
            if (isShortcutPressed(e, 'whatToAnswer')) {
                e.preventDefault();
                handleWhatToSay();
            } else if (isShortcutPressed(e, 'clarify')) {
                e.preventDefault();
                handleClarify();
            } else if (isShortcutPressed(e, 'followUp')) {
                e.preventDefault();
                handleFollowUpQuestions();
            } else if (isShortcutPressed(e, 'dynamicAction4')) {
                e.preventDefault();
                if (actionButtonMode === 'brainstorm') {
                    handleBrainstorm();
                } else {
                    handleRecap();
                }
            } else if (isShortcutPressed(e, 'answer')) {
                e.preventDefault();
                handleAnswerNow();
            } else if (isShortcutPressed(e, 'clarify')) {
                e.preventDefault();
                handleClarify();
            } else if (isShortcutPressed(e, 'codeHint')) {
                e.preventDefault();
                handleCodeHint();
            } else if (isShortcutPressed(e, 'brainstorm')) {
                e.preventDefault();
                handleBrainstorm();
            } else if (isShortcutPressed(e, 'scrollUp')) {
                e.preventDefault();
                scrollContainerRef.current?.scrollBy({ top: -100, behavior: 'smooth' });
            } else if (isShortcutPressed(e, 'scrollDown')) {
                e.preventDefault();
                scrollContainerRef.current?.scrollBy({ top: 100, behavior: 'smooth' });
            } else if (isShortcutPressed(e, 'moveWindowUp') || isShortcutPressed(e, 'moveWindowDown')) {
                // Prevent default scrolling when moving window
                e.preventDefault();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isShortcutPressed]);

    // General Global Shortcuts (Rebindable)
    // We listen here to handle them when the window is focused (renderer side)
    // Global shortcuts (when window blurred) are handled by Main process -> GlobalShortcuts
    // But Main process events might not reach here if we don't listen, or we want unified handling.
    // Actually, KeybindManager registers global shortcuts. If they are registered as global, 
    // Electron might consume them before they reach here?
    // 'toggle-app' is Global.
    // 'toggle-visibility' is NOT Global in default config (isGlobal: false), so it depends on focus.
    // So we MUST listen for them here.

    const generalHandlersRef = useRef({
        toggleVisibility: () => window.electronAPI.toggleWindow(),
        processScreenshots: handleWhatToSay,
        resetCancel: async () => {
            if (isProcessing) {
                setIsProcessing(false);
            } else {
                await window.electronAPI.resetIntelligence();
                setMessages([]);
                setAttachedContext([]);
                setInputValue('');
            }
        },
        toggleMousePassthrough: () => {
            const newState = !isMousePassthrough;
            setIsMousePassthrough(newState);
            window.electronAPI?.setOverlayMousePassthrough?.(newState);
        },
        takeScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeScreenshot();
                if (data && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                console.error("Error triggering screenshot:", err);
            }
        },
        selectiveScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeSelectiveScreenshot();
                if (data && !data.cancelled && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                console.error("Error triggering selective screenshot:", err);
            }
        }
    });

    // Update ref
    generalHandlersRef.current = {
        toggleVisibility: () => window.electronAPI.toggleWindow(),
        processScreenshots: handleWhatToSay,
        resetCancel: async () => {
            if (isProcessing) {
                setIsProcessing(false);
            } else {
                await window.electronAPI.resetIntelligence();
                setMessages([]);
                setAttachedContext([]);
                setInputValue('');
            }
        },
        toggleMousePassthrough: () => {
            const newState = !isMousePassthrough;
            setIsMousePassthrough(newState);
            window.electronAPI?.setOverlayMousePassthrough?.(newState);
        },
        takeScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeScreenshot();
                if (data && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                console.error("Error triggering screenshot:", err);
            }
        },
        selectiveScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeSelectiveScreenshot();
                if (data && !data.cancelled && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                console.error("Error triggering selective screenshot:", err);
            }
        }
    };

    useEffect(() => {
        const handleGeneralKeyDown = (e: KeyboardEvent) => {
            const handlers = generalHandlersRef.current;
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

            if (isShortcutPressed(e, 'toggleVisibility')) {
                // Always allow toggling visibility
                e.preventDefault();
                handlers.toggleVisibility();
            } else if (isShortcutPressed(e, 'processScreenshots')) {
                if (!isInput) {
                    e.preventDefault();
                    handlers.processScreenshots();
                }
                // If input focused, let default behavior (Enter) happen or handle it via onKeyDown in Input
            } else if (isShortcutPressed(e, 'resetCancel')) {
                e.preventDefault();
                handlers.resetCancel();
            } else if (isShortcutPressed(e, 'takeScreenshot')) {
                e.preventDefault();
                handlers.takeScreenshot();
            } else if (isShortcutPressed(e, 'selectiveScreenshot')) {
                e.preventDefault();
                handlers.selectiveScreenshot();
            } else if (isShortcutPressed(e, 'toggleMousePassthrough')) {
                e.preventDefault();
                handlers.toggleMousePassthrough();
            }
        };

        window.addEventListener('keydown', handleGeneralKeyDown);
        return () => window.removeEventListener('keydown', handleGeneralKeyDown);
    }, [isShortcutPressed]);

    // Global "Capture & Process" shortcut handler (issue #90)
    // Registered separately so it always has the latest handlersRef via stable ref access.
    // Main process takes the screenshot and sends "capture-and-process" with path+preview;
    // we attach the screenshot to context and immediately trigger AI analysis.
    useEffect(() => {
        if (!window.electronAPI.onCaptureAndProcess) return;
        const unsubscribe = window.electronAPI.onCaptureAndProcess((data) => {
            setIsExpanded(true);
            setAttachedContext(prev => {
                if (prev.some(s => s.path === data.path)) return prev;
                return [...prev, data].slice(-5);
            });
            // Wait one tick for React to flush the state update before triggering analysis
            setTimeout(() => {
                handlersRef.current.handleWhatToSay();
            }, 0);
        });
        return unsubscribe;
    }, []);

    // Stealth Global Shortcuts Handler
    // Listens for shortcuts triggered when the app is in the background
    useEffect(() => {
        if (!window.electronAPI.onGlobalShortcut) return;
        const unsubscribe = window.electronAPI.onGlobalShortcut(({ action }) => {
            const handlers = handlersRef.current;
            const generalHandlers = generalHandlersRef.current;

            isStealthRef.current = true;

            if (action === 'whatToAnswer') handlers.handleWhatToSay();
            else if (action === 'shorten') handlers.handleFollowUp('shorten');
            else if (action === 'followUp') handlers.handleFollowUpQuestions();
            else if (action === 'recap') handlers.handleRecap();
            else if (action === 'dynamicAction4') {
                if (actionButtonMode === 'brainstorm') handlers.handleBrainstorm();
                else handlers.handleRecap();
            }
            else if (action === 'answer') handlers.handleAnswerNow();
            else if (action === 'clarify') handlers.handleClarify();
            else if (action === 'codeHint') handlers.handleCodeHint();
            else if (action === 'brainstorm') handlers.handleBrainstorm();
            else if (action === 'scrollUp') scrollContainerRef.current?.scrollBy({ top: -100, behavior: 'smooth' });
            else if (action === 'scrollDown') scrollContainerRef.current?.scrollBy({ top: 100, behavior: 'smooth' });
            else if (action === 'processScreenshots') generalHandlers.processScreenshots();
            else if (action === 'resetCancel') generalHandlers.resetCancel();

            // Safety reset if it didn't trigger an expansion
            setTimeout(() => { isStealthRef.current = false; }, 500);
        });
        return unsubscribe;
    }, []);


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