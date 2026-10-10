// State + streaming layer for GlobalChatOverlay: owns the message list,
// the chat/network state machine, the streaming-token buffer, and every
// DOM-ish concern (auto-scroll, auto-focus, outside-click, Escape-to-close,
// stream cancellation on unmount). Kept separate from the component so the
// component only owns rendering — same split as useCalendarConnections.

import { useCallback, useEffect, useRef, useState } from "react";
import { chatApi, statusLabel } from "@/api/chatApi";
import { indexSourceMap } from "@/features/chat/citations";
import { useStreamBuffer } from "@/hooks/useStreamBuffer";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";
import { pinFromHistory } from "@/lib/chatCompanyPin";
import { isOutsideClick } from "@/lib/outsideClick";
import { ChatCompanyPin, ChatHistoryTurn, ChatSession, GlobalChatMessage, GlobalChatState, StreamHandle } from "@/types";

interface UseGlobalChatArgs {
    isOpen: boolean;
    onClose: () => void;
    initialQuery?: string;
}

export function useGlobalChat({ isOpen, onClose, initialQuery = "" }: UseGlobalChatArgs) {
    const [messages, setMessages] = useState<GlobalChatMessage[]>([]);
    const [chatState, setChatState] = useState<GlobalChatState>("idle");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [statusText, setStatusText] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    // null = not-yet-started chat. Backend fills this in via the
    // `session_created` frame on the first message; loadSession() sets it
    // directly when resuming from the sidebar.
    const [sessionId, setSessionId] = useState<string | null>(null);
    // Company pinned to this chat (chip / @mention): sent with every question and saved on each
    // answered turn by the backend, so reopening the session restores it (pinFromHistory).
    const [pinnedCompany, setPinnedCompany] = useState<ChatCompanyPin | null>(null);

    // ── Session sidebar state ────────────────────────────────────────────────
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [isLoadingSessions, setIsLoadingSessions] = useState(false);

    const streamBuffer = useStreamBuffer();
    const activeStreamRef = useRef<StreamHandle | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    // Tracks the assistant placeholder id for whichever turn is currently
    // in flight, so stopGeneration() can finalize the right message without
    // threading the id through the submitQuestion closure.
    const currentAssistantIdRef = useRef<string | null>(null);

    // ── Auto-scroll to bottom on new messages ───────────────────────────────
    // Runs on every streamed flush; restarting a smooth-scroll animation each
    // time kept the compositor busy, so jump instantly while streaming.
    useEffect(() => {
        const streaming = messages.some(m => m.isStreaming);
        messagesEndRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth" });
    }, [messages]);

    // Auto-resize textarea
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 96)}px`; // max ~4 lines
    }, [query]);

    // ── Load the sidebar's session list whenever the overlay opens ──────────
    const refreshSessions = useCallback(async () => {
        setIsLoadingSessions(true);
        try {
            const list = await chatApi.listSessions();
            setSessions(list);
        } catch (e) {
            console.error("[GlobalChat] Failed to load sessions:", e);
        } finally {
            setIsLoadingSessions(false);
        }
    }, []);

    useEffect(() => {
        if (isOpen) refreshSessions();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    // ── Delete a session from the sidebar ────────────────────────────────────
    const deleteSession = useCallback(async (id: string) => {
        // Optimistic removal so the sidebar feels instant.
        const prevSessions = sessions;
        setSessions((prev) => prev.filter((s) => s.id !== id));

        // If the deleted session is the one currently open, drop back to a
        // fresh chat rather than leaving the transcript of a now-gone session
        // on screen.
        if (id === sessionId) {
            activeStreamRef.current?.abort();
            setSessionId(null);
            setPinnedCompany(null);
            setMessages([]);
            setChatState("idle");
            setErrorMessage(null);
            setStatusText(null);
        }

        try {
            await chatApi.deleteSession(id);
        } catch (e) {
            console.error("[GlobalChat] Failed to delete session:", e);
            // Roll back — it's still on the backend, so put it back in the list.
            setSessions(prevSessions);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessions, sessionId]);

    // ── Focus the input as soon as the widget opens ─────────────────────────
    useEffect(() => {
        if (isOpen) {
            const t = setTimeout(() => inputRef.current?.focus(), 250);
            return () => clearTimeout(t);
        }
    }, [isOpen]);

    // ── Submit question using global RAG ─────────────────────────────────────
    const submitQuestion = useCallback(async (question: string) => {
        if (!question.trim() || chatState === "waiting_for_llm" || chatState === "streaming_response") return;

        posthogAnalytics.trackGlobalChatQuery();

        const userMessage: GlobalChatMessage = {
            id: `user-${Date.now()}`,
            role: "user",
            content: question,
        };
        setMessages((prev) => [...prev, userMessage]);
        setChatState("waiting_for_llm");
        setErrorMessage(null);
        setStatusText(null);

        const assistantMessageId = `assistant-${Date.now()}`;
        currentAssistantIdRef.current = assistantMessageId;

        // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Create assistant message placeholder
        setMessages((prev) => [
            ...prev,
            {
                id: assistantMessageId,
                role: "assistant",
                content: "",
                isStreaming: true,
            },
        ]);

        streamBuffer.reset();
        // The session id for THIS turn. Starts as the state captured when
        // submitQuestion ran (null on a brand-new chat) and is updated by
        // onSessionCreated — which fires before the title frame on the same
        // stream — so onTitleUpdated can patch the sidebar row in place.
        // Reading the `sessionId` state directly here would be a stale
        // closure: setSessionId() re-renders but never reaches the in-flight
        // stream's callbacks, so a brand-new chat's title frame used to be
        // dropped (s.id === null never matched).
        let activeSessionId = sessionId;

        // history is only consulted by the backend when sessionId is null
        // (brand-new chat, first turn); once a session exists it loads the
        // last 20 turns from ai_interactions itself, so we always pass [].
        activeStreamRef.current = chatApi.queryGlobal(question, sessionId, [], {
            onStatus: (status) => setStatusText(statusLabel(status)),
            // A transient failure (5xx, dropped connection, backend `error`
            // frame, empty stream) before any answer text — chatApi is about
            // to re-ask. Show it, and drop whatever the failed attempt
            // delivered so a retry that comes back without sources/citations
            // can't inherit stale ones.
            onRetry: (attempt, max) => {
                setStatusText(`Reconnecting… (${attempt}/${max})`);
                setMessages((prev) =>
                    prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, sourceMap: undefined } : msg)),
                );
            },
            // Arrives BEFORE the first token: ONLY the entries the answer cites
            // inline, each with the exact excerpt it drew on. Sources are shown
            // solely as these inline chips — there is no separate list.
            onSourceMap: (entries) => {
                const map = indexSourceMap(entries);
                setMessages((prev) =>
                    prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, sourceMap: map } : msg)),
                );
            },
            // Arrives after the final token: chips for these indices failed
            // semantic verification and render dimmed.
            onSourcesVerified: (_verified, unverified) => {
                setMessages((prev) =>
                    prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, unverifiedCitations: unverified } : msg)),
                );
            },
            onSessionCreated: (id) => {
                activeSessionId = id;
                setSessionId(id);
                // A brand-new session — the sidebar doesn't know about it yet.
                // Re-fetch so it shows up (title arrives moments later via
                // onTitleUpdated and gets patched in below).
                refreshSessions();
            },
            onTitleUpdated: (title) => {
                setSessions((prev) =>
                    prev.map((s) => (s.id === activeSessionId ? { ...s, title } : s)),
                );
            },
            // Backend discarded a partial answer and is starting over — drop
            // the buffered frames so the retry replaces rather than appends,
            // but keep the partial text on screen dimmed with a badge instead
            // of wiping the bubble (a vanishing answer reads as a glitch).
            onReset: () => {
                streamBuffer.reset();
                setStatusText("Rewriting…");
                setMessages((prev) =>
                    prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, rewriting: true } : msg)),
                );
            },
            onToken: (chunk) => {
                setChatState("streaming_response");
                setStatusText(null);
                streamBuffer.appendToken(chunk, (content) => {
                    setMessages((prev) => prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, content, rewriting: false } : msg)));
                });
            },
            // Backend decided this was a factual/RAG query and returned the
            // complete answer in one frame — render it directly, skip the
            // token buffer entirely (no `token` frames will follow).
            onRagAnswer: (ragAnswer) => {
                setMessages((prev) =>
                    prev.map((msg) =>
                        msg.id === assistantMessageId ? { ...msg, content: ragAnswer.answer, isStreaming: false, rewriting: false } : msg,
                    ),
                );
                setChatState("idle");
                setStatusText(null);
            },
            onDone: () => {
                // A late onDone from an older turn must not touch the shared
                // buffer/refs a newer turn now owns — just stop its cursor.
                const isCurrentTurn = currentAssistantIdRef.current === assistantMessageId;
                const finalContent = isCurrentTurn ? streamBuffer.getBufferedContent() : null;
                setMessages((prev) =>
                    prev.map((msg) =>
                        msg.id === assistantMessageId && msg.isStreaming
                            ? { ...msg, content: finalContent ?? msg.content, isStreaming: false, rewriting: false }
                            : msg,
                    ),
                );
                if (!isCurrentTurn) return;
                setChatState("idle");
                setStatusText(null);
                streamBuffer.reset();
                activeStreamRef.current = null;
                currentAssistantIdRef.current = null;
            },
            onError: (error) => {
                console.error("[GlobalChat] Stream error:", error);
                setMessages((prev) => prev.filter((msg) => msg.id !== assistantMessageId));
                setErrorMessage("Couldn't get a response. Please try again.");
                setChatState("error");
                setStatusText(null);
                streamBuffer.reset();
                activeStreamRef.current = null;
                currentAssistantIdRef.current = null;
            },
        }, pinnedCompany?.id ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatState, sessionId, refreshSessions, pinnedCompany]);

    // ── Stop / cancel an in-flight generation ────────────────────────────────
    // chatApi's streamSSE resolves silently on an aborted signal (no onDone /
    // onError fires — see chatApi.ts), so stopping here has to do the
    // finalizing work those callbacks would otherwise have done: commit
    // whatever text has streamed in so far, drop the streaming cursor, and
    // put the chat state back to idle so the input re-enables immediately.
    const stopGeneration = useCallback(() => {
        activeStreamRef.current?.abort();
        activeStreamRef.current = null;

        const assistantMessageId = currentAssistantIdRef.current;
        if (assistantMessageId) {
            const finalContent = streamBuffer.getBufferedContent();
            setMessages((prev) =>
                prev.map((msg) =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: finalContent, isStreaming: false, rewriting: false }
                        : msg,
                ),
            );
        }

        streamBuffer.reset();
        currentAssistantIdRef.current = null;
        setChatState("idle");
        setStatusText(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Close the overlay, aborting any in-flight stream first ────────────────
    // X and Escape route through this instead of raw onClose: the overlay is
    // mounted unconditionally (Launcher), so the unmount-abort effect never
    // fires on close — without this, the server turn keeps running after the
    // UI reset and late onToken callbacks re-busy the hook (a "streaming"
    // state with no visible window; the answer only findable by reloading
    // the session later). Mirrors the click-outside behavior below.
    // resetOnExit wipes the transcript on close, so no placeholder
    // finalization is needed (unlike stopGeneration); streamSSE resolves
    // silently on an aborted signal, so no onDone/onError follows.
    const requestClose = useCallback(() => {
        activeStreamRef.current?.abort();
        activeStreamRef.current = null;
        currentAssistantIdRef.current = null;
        onClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onClose]);

    // ── Start a fresh chat — clears the active session + transcript ─────────
    const startNewChat = useCallback(() => {
        activeStreamRef.current?.abort();
        setSessionId(null);
        setPinnedCompany(null);
        setMessages([]);
        setChatState("idle");
        setErrorMessage(null);
        setStatusText(null);
    }, []);

    // ── Resume a chat picked from the sidebar ────────────────────────────────
    const loadSession = useCallback(async (id: string) => {
        activeStreamRef.current?.abort();
        setChatState("idle");
        setErrorMessage(null);
        setStatusText(null);
        try {
            const history: ChatHistoryTurn[] = await chatApi.getSessionMessages(id);
            setMessages(
                history.map((turn, i) => ({
                    id: `${id}-${i}`,
                    role: turn.role,
                    content: turn.content,
                    // Inline-citation map persisted at answer time — restored so
                    // reloaded answers re-render the numbered chips, same as live.
                    sourceMap: turn.source_map?.length ? indexSourceMap(turn.source_map) : undefined,
                })),
            );
            setSessionId(id);
            setPinnedCompany(pinFromHistory(history));
        } catch (e) {
            console.error("[GlobalChat] Failed to load session:", e);
            setErrorMessage("Couldn't load that conversation. Please try again.");
        }
    }, []);

    // ── Submit initial query when overlay opens ──────────────────────────────
    useEffect(() => {
        if (isOpen && initialQuery && messages.length === 0) {
            setTimeout(() => {
                submitQuestion(initialQuery);
            }, 100);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, initialQuery]);

    // ── Listen for follow-up queries pushed in from the parent ──────────────
    useEffect(() => {
        if (isOpen && initialQuery && messages.length > 0) {
            submitQuestion(initialQuery);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialQuery]);

    // ── Escape key closes the overlay ────────────────────────────────────────
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && isOpen) {
                requestClose();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, requestClose]);

    // ── Click outside the panel closes it and aborts any in-flight stream ──
    // The FAB has its own onClick that owns toggling, so clicks on it are
    // deliberately ignored here to avoid a close-then-reopen race.
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest("[data-global-chat-fab]")) return;
            // composedPath + isConnected: picking a company from the chat's suggestion list removes
            // the clicked item before this runs; contains() alone saw it as outside and closed the
            // chat (the app then showed Home). See lib/outsideClick.
            const path = typeof e.composedPath === "function" ? e.composedPath() : [];
            if (isOutsideClick({ path, panel: chatWindowRef.current, target })) {
                activeStreamRef.current?.abort();
                onClose();
            }
        };

        // Delay to avoid closing immediately from the click that opened it
        const timer = setTimeout(() => {
            document.addEventListener("mousedown", handleClickOutside);
        }, 150);

        return () => {
            clearTimeout(timer);
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isOpen, requestClose]);

    // ── Cancel any in-flight stream if the overlay unmounts ─────────────────
    useEffect(() => () => activeStreamRef.current?.abort(), []);

    const handleInputKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            // Shift+Enter inserts a newline — let the textarea handle it
            // natively instead of submitting.
            if (e.key === "Enter" && e.shiftKey) {
                return;
            }
            if (e.key === "Enter" && query.trim()) {
                e.preventDefault();
                submitQuestion(query);
                setQuery("");
            }
        },
        [query, submitQuestion],
    );

    const handleSendClick = useCallback(() => {
        if (query.trim()) {
            submitQuestion(query);
            setQuery("");
        }
    }, [query, submitQuestion]);

    // Called by AnimatePresence's onExitComplete once the closing animation
    // finishes — resets state so the next open starts from a clean slate.
    const resetOnExit = useCallback(() => {
        // Safety net: every close path should already have aborted via
        // requestClose (X/Escape/click-outside), but this runs for ANY exit
        // route — a stream still alive here would keep firing callbacks into
        // the freshly reset hook (onToken re-busies chatState).
        activeStreamRef.current?.abort();
        activeStreamRef.current = null;
        currentAssistantIdRef.current = null;
        setChatState("idle");
        setMessages([]);
        setErrorMessage(null);
        setSessionId(null);
        setPinnedCompany(null);
    }, []);

    const isBusy = chatState === "waiting_for_llm" || chatState === "streaming_response";

    return {
        // state
        messages,
        sessions,
        isLoadingSessions,
        chatState,
        errorMessage,
        statusText,
        query,
        isBusy,
        sessionId,
        // setters
        setQuery,
        // refs
        messagesEndRef,
        chatWindowRef,
        inputRef,
        // handlers
        submitQuestion,
        handleInputKeyDown,
        handleSendClick,
        stopGeneration,
        resetOnExit,
        requestClose,
        startNewChat,
        loadSession,
        deleteSession,
        // company pinned to this chat
        pinnedCompany,
        setPinnedCompany,
    };
}