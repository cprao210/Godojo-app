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
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import type { ChatSources, MeetingChatMessage, MeetingChatState, StreamHandle, MeetingContext } from '@/types';

export interface UseMeetingChatArgs {
    isOpen: boolean;
    onClose: () => void;
    onMessagesChange: (updater: (prev: MeetingChatMessage[]) => MeetingChatMessage[]) => void;
    messages: MeetingChatMessage[];
    meetingContext: MeetingContext;
    initialQuery?: { text: string; id: number } | null;
}

export function useMeetingChat({ isOpen, onClose, onMessagesChange, messages, meetingContext, initialQuery }: UseMeetingChatArgs) {
    const [chatState, setChatState] = useState<MeetingChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [statusText, setStatusText] = useState<string | null>(null);

    // One session per meeting, same session_id/history contract as
    // useGlobalChat. No sidebar here — messages are already scoped to a
    // single meeting via useMeetingDetails' chatMessages state, so this just
    // needs to remember the id the backend hands back on the first turn and
    // keep reusing it for the rest of this meeting's conversation.
    const [sessionId, setSessionId] = useState<string | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);
    const streamBuffer = useStreamBuffer();
    const activeStreamRef = useRef<StreamHandle | null>(null);

    const pendingQuestionRef = useRef<string | null>(null);
    const chatStateRef = useRef<MeetingChatState>('idle');
    const lastSubmittedQueryIdRef = useRef<number | null>(null);

    // A different meeting means a different conversation — don't carry the
    // previous meeting's session_id over.
    useEffect(() => {
        setSessionId(null);
    }, [meetingContext.id]);

    useEffect(() => () => activeStreamRef.current?.abort(), []);

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

    // Reset state when overlay closes
    useEffect(() => {
        if (!isOpen) {
            setChatState('idle');
            setErrorMessage(null);
            activeStreamRef.current?.abort();
        }
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

        // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
        await new Promise(resolve => setTimeout(resolve, 200));

        onMessagesChange(prev => [...prev, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            isStreaming: true
        }]);

        streamBuffer.reset();
        let sources: ChatSources | undefined;

        // history is only consulted by the backend when sessionId is null
        // (first turn of a new session); once a session exists it loads
        // prior turns itself, same as queryGlobal — see chatApi.ts.
        activeStreamRef.current = chatApi.queryMeeting(meetingContext.id, question, sessionId, [], {
            onStatus: (status) => setStatusText(statusLabel(status)),
            onRetry: (attempt, max) => setStatusText(`Reconnecting… (${attempt}/${max})`),
            onSessionCreated: (id) => setSessionId(id),
            onSources: (s) => { sources = s; },
            onToken: (chunk) => {
                setChatState('streaming_response');
                setStatusText(null);
                streamBuffer.appendToken(chunk, (content) => {
                    onMessagesChange(prev => prev.map(msg =>
                        msg.id === assistantMessageId ? { ...msg, content } : msg
                    ));
                });
            },
            // Backend decided this was a factual/RAG query and returned the
            // complete answer in one frame — render it directly, skip the
            // token buffer entirely (no `token` frames will follow).
            onRagAnswer: (ragAnswer) => {
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: ragAnswer.answer, isStreaming: false, sources }
                        : msg
                ));
                setChatState('idle');
                setStatusText(null);
            },
            onDone: () => {
                const finalContent = streamBuffer.getBufferedContent();
                onMessagesChange(prev => prev.map(msg =>
                    msg.id === assistantMessageId && msg.isStreaming
                        ? { ...msg, content: finalContent, isStreaming: false, sources }
                        : msg
                ));
                setChatState('idle');
                setStatusText(null);
                streamBuffer.reset();
                activeStreamRef.current = null;
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
                if (pendingQuestionRef.current) {
                    const next = pendingQuestionRef.current;
                    pendingQuestionRef.current = null;
                    setTimeout(() => submitQuestion(next), 50);
                }
            },
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meetingContext.id, sessionId]);

    return {
        chatState,
        errorMessage,
        statusText,
        sessionId,
        messagesEndRef,
        chatWindowRef,
        handleBackdropClick,
        handleClose,
        submitQuestion,
    };
}