// src/hooks/useObjectionWatch.ts
//
// Owns the live objection list, ticking POST /intelligence/objection-handler at
// conversational speed (seconds) instead of live-analysis speed (minutes).
//
// NAME: deliberately NOT "useObjectionHandler". `generate-objection-handler` /
// ObjectionHandlerLLM in the main process is a different, currently-orphaned feature
// (markdown coaching streamed into the overlay chat). This hook is the structured
// objections list behind the Intelligence panel's Objections tab.
//
// The renderer is the OWNER of this list — it merges `new`, marks `resolved`, and
// hands the accumulated list to useLiveAnalysis, which posts it back as
// `previous_analysis.objections`. All the mergeable/testable logic lives in
// src/lib/objections.ts; this file is only the React + network shell.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Objection } from '@/types';
import { intelligenceApi } from '@/api/intelligenceApi';
import { ApiError } from '@/lib/apiClient';
import {
    ObjectionDelta,
    mergeObjectionDelta,
    partitionObjections,
    openQuotes,
    shouldTick,
    OBJECTION_POLL_MS,
    OBJECTION_OVERLAP_TURNS,
    OBJECTION_CLIENT_TIMEOUT_MS,
} from '@/lib/objections';

type TranscriptTurn = { speaker: string; displayName?: string; text: string; timestamp: number };
type TranscriptRef = React.MutableRefObject<TranscriptTurn[]>;

// Same exclusion list useLiveAnalysis applies — internal system/AI turns are never
// conversation, so they must not move the cursor or be sent as transcript.
const NON_HUMAN_SPEAKERS = ['system', 'ai', 'assistant', 'model'];

const humanTurnsOf = (transcript: TranscriptTurn[] | undefined): TranscriptTurn[] =>
    (transcript ?? []).filter(t => !NON_HUMAN_SPEAKERS.includes(t.speaker?.toLowerCase()));

export const useObjectionWatch = (transcriptRef: TranscriptRef, isMeetingPaused: boolean) => {
    // The single owned list — active and resolved together, newest first. Kept in a ref
    // as well as state so the tick loop (and useLiveAnalysis, which reads this ref at
    // RESPONSE time) never sees a stale closure.
    const [objections, setObjections] = useState<Objection[]>([]);
    const objectionsRef = useRef<Objection[]>([]);

    const [isDetecting, setIsDetecting] = useState(false);
    // Trips to false permanently (for the session) if the backend doesn't have the
    // route yet — see the 404 handling below.
    const [isEnabled, setIsEnabled] = useState(true);

    const inFlightRef = useRef(false);
    const cursorRef = useRef(0);
    const lastTickAtRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const isEnabledRef = useRef(true);
    const isMeetingPausedRef = useRef(isMeetingPaused);

    useEffect(() => { isMeetingPausedRef.current = isMeetingPaused; }, [isMeetingPaused]);

    const commit = useCallback((next: Objection[]) => {
        objectionsRef.current = next;
        setObjections(next);
    }, []);

    const resetObjections = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        inFlightRef.current = false;
        cursorRef.current = 0;
        lastTickAtRef.current = 0;
        objectionsRef.current = [];
        setObjections([]);
        setIsDetecting(false);
    }, []);

    // ── The tick loop ────────────────────────────────────────────────────────
    // A poll, not an effect on the transcript: `transcriptRef` is a plain ref mutated
    // from an IPC listener in useGodojoInterface, so React gets no signal when it
    // grows. (That is exactly why useLiveAnalysis's urgent-trigger effect, whose deps
    // are all stable refs, only re-evaluates incidentally.) Comparing a length against
    // a cursor once a second is free; shouldTick owns the actual fire/skip decision.
    useEffect(() => {
        const tick = async () => {
            if (!isEnabledRef.current || inFlightRef.current) return;

            const humanTurns = humanTurnsOf(transcriptRef.current);
            const cursor = cursorRef.current;

            // Transcript was reset out from under us (new session) — re-anchor.
            if (cursor > humanTurns.length) cursorRef.current = 0;

            const deltaTurns = humanTurns.slice(cursorRef.current);
            const hasNewProspectTurn = deltaTurns.some(
                t => t.speaker !== 'user' && t.text?.trim(),
            );

            const now = Date.now();
            const decision = shouldTick({
                now,
                turnCount: humanTurns.length,
                cursor: cursorRef.current,
                newestTurnAt: humanTurns[humanTurns.length - 1]?.timestamp ?? 0,
                lastTickAt: lastTickAtRef.current,
                inFlight: inFlightRef.current,
                isMeetingPaused: isMeetingPausedRef.current,
                hasNewProspectTurn,
            });

            if (!decision) {
                // An AE-only delta is not an objection — skip the call, but consume the
                // turns so they don't hold the cursor back forever.
                if (
                    !isMeetingPausedRef.current &&
                    deltaTurns.length > 0 &&
                    !hasNewProspectTurn
                ) {
                    cursorRef.current = humanTurns.length;
                }
                return;
            }

            // Include AE turns in the window: the backend needs them to detect
            // `ae_deferral` objections and to judge whether an open objection was
            // actually answered. The small overlap keeps a quote that straddles the
            // previous boundary from being lost.
            const windowStart = Math.max(cursorRef.current - OBJECTION_OVERLAP_TURNS, 0);
            const turns = humanTurns
                .slice(windowStart)
                .filter(t => (t.speaker === 'user' || t.speaker === 'client') && t.text?.trim())
                .map(t => ({ speaker: t.speaker, text: t.text }));

            if (turns.length === 0) {
                cursorRef.current = humanTurns.length;
                return;
            }

            const endIndex = humanTurns.length;
            const controller = new AbortController();
            abortRef.current = controller;
            const deadline = setTimeout(() => controller.abort(), OBJECTION_CLIENT_TIMEOUT_MS);

            inFlightRef.current = true;
            setIsDetecting(true);
            // Advance the throttle clock even if this attempt fails, so a sick backend
            // can't be hammered at poll frequency.
            lastTickAtRef.current = now;

            try {
                const delta: ObjectionDelta = await intelligenceApi.detectObjections(
                    turns,
                    openQuotes(objectionsRef.current),
                    null,
                    controller.signal,
                );
                commit(mergeObjectionDelta(objectionsRef.current, delta));
                // Only on success — a failed tick retries with a wider window.
                cursorRef.current = endIndex;
            } catch (err) {
                // A dropped tick must be invisible: no error banner, no retry storm.
                // The route is specified never to 500; a timeout/abort just means this
                // window is retried on the next tick.
                if (err instanceof ApiError && err.status === 404) {
                    // Backend predates the split. Stop polling and let live-analysis
                    // keep producing objections as it does today.
                    isEnabledRef.current = false;
                    setIsEnabled(false);
                    console.warn('[useObjectionWatch] objection-handler route not available — disabled for this session');
                } else {
                    console.debug('[useObjectionWatch] tick failed, will retry', err);
                }
            } finally {
                clearTimeout(deadline);
                if (abortRef.current === controller) abortRef.current = null;
                inFlightRef.current = false;
                setIsDetecting(false);
            }
        };

        const id = setInterval(tick, OBJECTION_POLL_MS);
        return () => {
            clearInterval(id);
            abortRef.current?.abort();
        };
    }, [transcriptRef, commit]);

    const { active, resolved } = useMemo(() => partitionObjections(objections), [objections]);

    return { objections, active, resolved, objectionsRef, isDetecting, isEnabled, resetObjections };
};
