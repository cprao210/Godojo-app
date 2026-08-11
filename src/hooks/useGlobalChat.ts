// State + streaming layer for GlobalChatOverlay: owns the message list,
// the chat/network state machine, the streaming-token buffer, and every
// DOM-ish concern (auto-scroll, auto-focus, outside-click, Escape-to-close,
// stream cancellation on unmount). Kept separate from the component so the
// component only owns rendering — same split as useCalendarConnections.

import { useCallback, useEffect, useRef, useState } from "react";
import { chatApi, statusLabel } from "@/api/chatApi";
import { useStreamBuffer } from "@/hooks/useStreamBuffer";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";
import { ChatSources, GlobalChatMessage, GlobalChatState, StreamHandle } from "@/types";

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

    const streamBuffer = useStreamBuffer();
    const activeStreamRef = useRef<StreamHandle | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // ── Auto-scroll to bottom on new messages ───────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

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
        let sources: ChatSources | undefined;

        activeStreamRef.current = chatApi.queryGlobal(question, {
            onStatus: (status) => setStatusText(statusLabel(status)),
            onSources: (s) => {
                sources = s;
            },
            onToken: (chunk) => {
                setChatState("streaming_response");
                setStatusText(null);
                streamBuffer.appendToken(chunk, (content) => {
                    setMessages((prev) => prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, content } : msg)));
                });
            },
            // Backend decided this was a factual/RAG query and returned the
            // complete answer in one frame — render it directly, skip the
            // token buffer entirely (no `token` frames will follow).
            onRagAnswer: (ragAnswer) => {
                setMessages((prev) =>
                    prev.map((msg) =>
                        msg.id === assistantMessageId ? { ...msg, content: ragAnswer.answer, isStreaming: false, sources } : msg,
                    ),
                );
                setChatState("idle");
                setStatusText(null);
            },
            onDone: () => {
                const finalContent = streamBuffer.getBufferedContent();
                setMessages((prev) =>
                    prev.map((msg) =>
                        msg.id === assistantMessageId && msg.isStreaming
                            ? { ...msg, content: finalContent, isStreaming: false, sources }
                            : msg,
                    ),
                );
                setChatState("idle");
                setStatusText(null);
                streamBuffer.reset();
                activeStreamRef.current = null;
            },
            onError: (error) => {
                console.error("[GlobalChat] Stream error:", error);
                setMessages((prev) => prev.filter((msg) => msg.id !== assistantMessageId));
                setErrorMessage("Couldn't get a response. Please try again.");
                setChatState("error");
                setStatusText(null);
                streamBuffer.reset();
                activeStreamRef.current = null;
            },
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatState]);

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
                onClose();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose]);

    // ── Click outside the panel closes it and aborts any in-flight stream ──
    // The FAB has its own onClick that owns toggling, so clicks on it are
    // deliberately ignored here to avoid a close-then-reopen race.
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest("[data-global-chat-fab]")) return;
            if (chatWindowRef.current && !chatWindowRef.current.contains(target)) {
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
    }, [isOpen, onClose]);

    // ── Cancel any in-flight stream if the overlay unmounts ─────────────────
    useEffect(() => () => activeStreamRef.current?.abort(), []);

    const handleInputKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
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
        setChatState("idle");
        setMessages([]);
        setErrorMessage(null);
    }, []);

    const isBusy = chatState === "waiting_for_llm" || chatState === "streaming_response";

    return {
        // state
        messages,
        chatState,
        errorMessage,
        statusText,
        query,
        isBusy,
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
        resetOnExit,
    };
}