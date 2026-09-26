/**
 * useMeetingChat.ts
 *
 * Owns the RAG-streaming chat logic behind MeetingChatOverlay: submitting a
 * question, buffering the streamed response, and all the open/close/scroll
 * effects around it. The overlay component only renders what this returns.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useStreamBuffer } from './useStreamBuffer';
import { chatApi, statusLabel } from '@/api';
import { indexSourceMap } from '@/features/chat/citations';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import type { ChatHistoryTurn, MeetingChatMessage, MeetingChatState, StreamHandle, MeetingContext } from '@/types';

export interface UseMeetingChatArgs {
    isOpen: boolean;
    onClose: () => void;
    onMessagesChange: (updater: (prev: MeetingChatMessage[]) => MeetingChatMessage[]) => void;
    messages: MeetingChatMessage[];
    meetingContext: MeetingContext;
    initialQuery?: { text: string; id: number } | null;
    /** Called once a turn's stream completes successfully (P1-7). */
    onTurnComplete?: () => void;
}

export function useMeetingChat({ isOpen, onClose, onMessagesChange, messages, meetingContext, initialQuery, onTurnComplete }: UseMeetingChatArgs) {
    // Latest callback for the stream's onDone — submitQuestion's closure is
    // memoized on [meetingContext.id, sessionId] and would otherwise call a
    // stale one.
    const onTurnCompleteRef = useRef(onTurnComplete);
    useEffect(() => { onTurnCompleteRef.current = onTurnComplete; }, [onTurnComplete]);
    const [chatState, setChatState] = useState<MeetingChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [statusText, setStatusText] = useState<string | null>(null);

    // One session per meeting, same session_id/history contract as
    // useGlobalChat. No sidebar here — messages are already scoped to a
    // single meeting via useMeetingDetails' chatMessages state, so this just
    // needs to remember the id the backend hands back on the first turn and
    // keep reusing it for the rest of this meeting's conversation.
    const [sessionId, setSessionId] = useState<string | null>(null);
    // Mirror for async code (the resume lookup) that must see the latest id,
    // not the one captured when it started.
    const sessionIdRef = useRef<string | null>(null);
    useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);
    const streamBuffer = useStreamBuffer();
    const activeStreamRef = useRef<StreamHandle | null>(null);

    const pendingQuestionRef = useRef<string | null>(null);
    const chatStateRef = useRef<MeetingChatState>('idle');
    const lastSubmittedQueryIdRef = useRef<number | null>(null);
    // Tracks the assistant placeholder id for whichever turn is in flight,
    // so stopGeneration() can finalize the right message without threading
    // the id through the submitQuestion closure.
    const currentAssistantIdRef = useRef<string | null>(null);

    // A different meeting means a different conversation — don't carry the
    // previous meeting's session_id over. Instead, resume THIS meeting's
    // existing session if it has one (P1-6): reuse its id so new turns land
    // in the same conversation, and rehydrate its turns when nothing is on
    // screen yet. Best-effort — a failed lookup just starts a fresh session.
    useEffect(() => {
        setSessionId(null);
        sessionIdRef.current = null;
        const meetingId = meetingContext.id;
        if (!meetingId) return;
        let cancelled = false;
        (async () => {
            try {
                const found = await chatApi.findMeetingSession(meetingId);
                if (cancelled || !found) return;
                // A turn submitted while the lookup was in flight already
                // minted a session — keep that one.
                if (sessionIdRef.current) return;
                sessionIdRef.current = found;
                setSessionId(found);
                const history: ChatHistoryTurn[] = await chatApi.getSessionMessages(found);
                if (cancelled || history.length === 0) return;
                const restored: MeetingChatMessage[] = history.map((turn, i) => ({
                    id: `${found}-${i}`,
                    role: turn.role,
                    content: turn.content,
                    sourceMap: turn.source_map?.length ? indexSourceMap(turn.source_map) : undefined,
                }));
                // Only fill an empty transcript — never clobber turns the
                // user already has on screen.
                onMessagesChange(prev => (prev.length > 0 ? prev : restored));
            } catch (e) {
                console.warn('[MeetingChat] Session resume failed:', e);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meetingContext.id]);

    // Unmount: abort AND finalize. streamSSE resolves silently on an aborted
    // signal (no onDone/onError), so a bare abort() would strand the
    // assistant placeholder at isStreaming:true — and the messages live in
    // the PARENT (useMeetingDetails), which may outlive this overlay's
    // unmount. The body runs at cleanup time, after render, so the forward
    // reference to stopGeneration below is safe.
    useEffect(() => () => {
        if (activeStreamRef.current) stopGeneration();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        chatStateRef.current = chatState;
    }, [chatState]);

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Submit initial query when overlay opens
    useEffect(() => {
        if (isOpen && initialQuery?.text && initialQuery.id !== lastSubmittedQueryIdRef.current) {
            lastSubmittedQueryIdRef.current = initialQuery.id;
            // Small delay so overlay is visible before question fires
            const t = setTimeout(() => submitQuestion(initialQuery.text), 100);
            return () => clearTimeout(t);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, initialQuery?.id]);

    // Fire once per genuine open — not on every re-render while already open.
    useEffect(() => {
        if (isOpen) posthogAnalytics.trackMeetingChatOpened();
    }, [isOpen]);

    // Reset state when overlay closes — FINALIZE the turn, not just abort it.
    // A bare abort() leaves the assistant placeholder isStreaming:true
    // forever (streamSSE resolves silently on abort — no onDone/onError),
    // and the messages live in the parent and survive close/reopen, so the
    // truncated answer would reappear with a permanently blinking cursor.
    // stopGeneration commits the buffered text and drops the cursor. The
    // callback body runs post-render, so the forward reference is safe.
    useEffect(() => {
        if (!isOpen) {
            stopGeneration();
            setErrorMessage(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const handleClose = useCallback(() => {
        onClose();
    }, [onClose]);

    // ESC key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                handleClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, handleClose]);

    // Click outside handler
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            handleClose();
        }
    }, [handleClose]);

    // Submit question using RAG streaming
    const submitQuestion = useCallback(async (question: string) => {
        if (!question.trim()) return;
        if (chatStateRef.current === 'waiting_for_llm' || chatStateRef.current === 'streaming_response') {
            pendingQuestionRef.current = question; // store it, don't drop it
            return;
        }

        if (!meetingContext.id) {
            setErrorMessage("This meeting hasn't been processed for chat yet.");
            setChatState('error');
            return;
        }

        posthogAnalytics.trackMeetingChatQuery();

        const userMessage: MeetingChatMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: question
        };
        onMessagesChange((prev) => [...prev, userMessage]);
        setChatState('waiting_for_llm');
        setErrorMessage(null);
        setStatusText(null);

        const assistantMessageId = `assistant-${Date.now()}`;
        currentAssistantIdRef.current = assistantMessageId;

        // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
        await new Promise(resolve => setTimeout(resolve, 200));

        onMessagesChange(prev => [...prev, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            isStreaming: true
        }]);

        streamBuffer.reset();

        // history is only consulted by the backend when sessionId is null
        // (first turn of a new session); once a session exists it loads
        // prior turns itself, same as queryGlobal — see chatApi.ts.
        activeStreamRef.current = chatApi.queryMeeting(meetingContext.id, question, sessionId, [], {
            onStatus: (status) => setStatusText(statusLabel(status)),
            // Retry = the turn starts over: show it, and drop whatever the
            // failed attempt delivered so a retry that comes back without
            // sources/citations can't inherit stale ones.
            onRetry: (attempt, max) => {
                setStatusText(`Reconnecting… (${attempt}/${max})`);
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId ? { ...msg, sourceMap: undefined } : msg
                ));
            },
            onSessionCreated: (id) => { sessionIdRef.current = id; setSessionId(id); },
            // [n] -> source map, sent before the first token: ONLY the cited
            // entries (with the exact excerpt each drew on). Sources are shown
            // solely as these inline chips — there is no separate list.
            onSourceMap: (entries) => {
                const map = indexSourceMap(entries);
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId ? { ...msg, sourceMap: map } : msg
                ));
            },
            // Post-stream: chips for these indices failed semantic
            // verification and render dimmed.
            onSourcesVerified: (_verified, unverified) => {
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId ? { ...msg, unverifiedCitations: unverified } : msg
                ));
            },
            // Backend discarded a partial answer and is starting over — drop
            // the buffered frames so the retry replaces rather than appends,
            // but keep the partial text on screen dimmed with a badge instead
            // of wiping the bubble (a vanishing answer reads as a glitch).
            onReset: () => {
                streamBuffer.reset();
                setStatusText('Rewriting…');
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId ? { ...msg, rewriting: true } : msg
                ));
            },
            onToken: (chunk) => {
                setChatState('streaming_response');
                setStatusText(null);
                streamBuffer.appendToken(chunk, (content) => {
                    onMessagesChange(prev => prev.map(msg =>
                        msg.id === assistantMessageId ? { ...msg, content, rewriting: false } : msg
                    ));
                });
            },
            // Backend decided this was a factual/RAG query and returned the
            // complete answer in one frame — render it directly, skip the
            // token buffer entirely (no `token` frames will follow).
            onRagAnswer: (ragAnswer) => {
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: ragAnswer.answer, isStreaming: false, rewriting: false }
                        : msg
                ));
                setChatState('idle');
                setStatusText(null);
            },
            onDone: () => {
                // A late onDone from an older turn must not touch the shared
                // buffer/refs a newer turn now owns — just stop its cursor.
                const isCurrentTurn = currentAssistantIdRef.current === assistantMessageId;
                const finalContent = isCurrentTurn ? streamBuffer.getBufferedContent() : null;
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId && msg.isStreaming
                        ? { ...msg, content: finalContent ?? msg.content, isStreaming: false, rewriting: false }
                        : msg
                ));
                if (!isCurrentTurn) return;
                setChatState('idle');
                setStatusText(null);
                streamBuffer.reset();
                activeStreamRef.current = null;
                currentAssistantIdRef.current = null;
                // The turn is saved — let the parent refresh the Ask-Dojo tab.
                onTurnCompleteRef.current?.();
                if (pendingQuestionRef.current) {
                    const next = pendingQuestionRef.current;
                    pendingQuestionRef.current = null;
                    setTimeout(() => submitQuestion(next), 50);
                }
            },
            onError: (error) => {
                console.error('[MeetingChat] Stream error:', error);
                onMessagesChange(prev => prev.filter(msg => msg.id !== assistantMessageId));
                setErrorMessage("Couldn't get a response. Please try again.");
                setChatState('error');
                setStatusText(null);
                streamBuffer.reset();
                activeStreamRef.current = null;
                currentAssistantIdRef.current = null;
                if (pendingQuestionRef.current) {
                    const next = pendingQuestionRef.current;
                    pendingQuestionRef.current = null;
                    setTimeout(() => submitQuestion(next), 50);
                }
            },
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meetingContext.id, sessionId]);

    // ── Stop / cancel an in-flight generation ────────────────────────────────
    // chatApi's streamSSE resolves silently on an aborted signal (no onDone /
    // onError fires — see chatApi.ts), so stopping here has to do the
    // finalizing work those callbacks would otherwise have done: commit
    // whatever text has streamed in so far, drop the streaming cursor, and
    // put the chat state back to idle so the input re-enables immediately.
    // This is also the close/unmount finalizer: the overlay-close effect and
    // the unmount cleanup both route through it, so no abort path can leave
    // a placeholder stuck isStreaming:true.
    const stopGeneration = useCallback(() => {
        activeStreamRef.current?.abort();
        activeStreamRef.current = null;

        const assistantMessageId = currentAssistantIdRef.current;
        if (assistantMessageId) {
            const finalContent = streamBuffer.getBufferedContent();
            onMessagesChange(prev => prev.map(msg =>
                msg.id === assistantMessageId
                    ? { ...msg, content: finalContent, isStreaming: false, rewriting: false }
                    : msg
            ));
        }

        streamBuffer.reset();
        currentAssistantIdRef.current = null;
        // Don't fire a queued follow-up after an explicit stop — the person
        // cancelled the turn on purpose, not because it failed.
        pendingQuestionRef.current = null;
        setChatState('idle');
        setStatusText(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const isBusy = chatState === 'waiting_for_llm' || chatState === 'streaming_response';

    return {
        chatState,
        errorMessage,
        statusText,
        sessionId,
        isBusy,
        messagesEndRef,
        chatWindowRef,
        handleBackdropClick,
        handleClose,
        submitQuestion,
        stopGeneration,
    };
}