import { useCallback, useEffect, useRef, useState } from 'react';
import { intelligenceApi } from '@/api/intelligenceApi';
import { getMeetingGeneration } from '@/lib/meetingGeneration';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import {
    applyV2Event,
    buildTurns,
    EMPTY_VIEW,
    endResponseToAnalysis,
    keepLiveAddMissed,
    liveObjectionsForEnd,
    shouldTickV2,
    stateToAnalysis,
    V2_END_MAX_TURNS,
    V2_POLL_MS,
    V2Done,
    V2View,
} from '@/lib/liveAnalysisV2';
import { mergeDealAlerts } from '@/lib/dealAlerts';
import type { DealOptimizerAlert, LiveAnalysisData, LiveTranscriptEntry, MeetingType, Objection } from '@/types';

// ─── useLiveAnalysisV2 ─────────────────────────────────────────────────────
//
// Live analysis v2 (godojo-apis docs/LIVE_ANALYSIS_V2_PLAN.md). Drop-in for useLiveAnalysis —
// same arguments, same return shape (plus `changedFields`, `sendFieldFeedback`) — selected at
// module load by VITE_LIVE_ANALYSIS_V2 (see LIVE_ANALYSIS_V2_ENABLED below), so a build without
// the flag behaves exactly as before.
//
// What changes vs v1:
//   • Cadence: a 1s cheap check fires a tick when prospect speech has SETTLED (or piled up), at
//     most every 8s — instead of a minutes-based timer. runAnalysis(true) forces a sweep tick
//     (manual Refresh, end of call); runAnalysis(false) just asks for a normal tick.
//   • Transport: each tick is one POST whose response streams events (SSE). The panel updates as
//     they arrive; `done` carries the full new state + signature.
//   • State: the APP holds it. We post back exactly what the last `done` returned; the server
//     verifies the signature and never stores anything.
//   • Turns: structured, with the ORIGINAL recognized text (evidence grounds on it) and the
//     suspect-line flag from the main process.
//   • Deal Optimizer: a separate fast lane (/intelligence/deal-optimizer) for negotiation calls.
//   • Feedback: 👍/👎 on a field becomes a Langfuse score on the tick that graded it.

export const LIVE_ANALYSIS_V2_ENABLED =
    (import.meta.env?.VITE_LIVE_ANALYSIS_V2 as string | undefined) === 'true';

const DEAL_POLL_MS = 2_000;
const DEAL_MIN_GAP_MS = 5_000;

function sameKeys(a: Record<string, string>, b: Record<string, string>): boolean {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k]);
}

function newSessionId(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
}

export const useLiveAnalysisV2 = (
    transcriptRef: React.MutableRefObject<LiveTranscriptEntry[]>,
    isMeetingPaused: boolean,
    _companyIntel?: Record<string, any> | null,
    meetingTypes: MeetingType[] = [],
    objectionsRef: React.MutableRefObject<Objection[]> | null = null,
) => {
    const [analysisData, setAnalysisData] = useState<LiveAnalysisData | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isRefreshRun, setIsRefreshRun] = useState(false);
    const [changedFields, setChangedFields] = useState<Record<string, string>>({});

    const viewRef = useRef<V2View>(EMPTY_VIEW);
    const sessionIdRef = useRef<string>(newSessionId());
    const sessionEpochRef = useRef(0);
    const inFlightRef = useRef(false);
    // Index into transcriptRef of the first entry not yet covered by a successful `done`.
    const cursorRef = useRef(0);
    const lastTickStartedAtRef = useRef(0);
    const callStartRef = useRef<number>(0);
    const forcePendingRef = useRef(false);
    const tickNoRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    // Set once the end-of-call pass has run: no more ticks for this call (resetAnalysis clears it).
    const finalizedRef = useRef(false);
    // Which tick (trace) last changed each field — feedback lands on THAT trace.
    const fieldTraceRef = useRef<Record<string, string>>({});
    const dealAlertsRef = useRef<DealOptimizerAlert[]>([]);
    const meetingTypesRef = useRef<MeetingType[]>(meetingTypes);
    useEffect(() => { meetingTypesRef.current = meetingTypes; }, [meetingTypes]);
    const isPausedRef = useRef(isMeetingPaused);
    useEffect(() => { isPausedRef.current = isMeetingPaused; }, [isMeetingPaused]);

    const publish = useCallback((view: V2View) => {
        viewRef.current = view;
        if (!view.state) return;
        const data = stateToAnalysis(view.state, objectionsRef?.current ?? [], dealAlertsRef.current);
        setAnalysisData(data);
        setChangedFields(prev => (sameKeys(prev, view.changed) ? prev : { ...view.changed }));
    }, [objectionsRef]);

    const runTick = useCallback(async (force: boolean) => {
        if (finalizedRef.current) return;
        if (inFlightRef.current) {
            if (force) forcePendingRef.current = true;
            return;
        }
        const entries = transcriptRef.current ?? [];
        if (!entries.length) return;
        if (!callStartRef.current) callStartRef.current = entries[0]?.arrivalMs ?? entries[0]?.timestamp ?? Date.now();

        const epoch = sessionEpochRef.current;
        const generation = getMeetingGeneration();
        const { turns, endIndex } = buildTurns(entries, cursorRef.current, callStartRef.current);
        if (!turns.length && !force) return;

        inFlightRef.current = true;
        forcePendingRef.current = false;
        lastTickStartedAtRef.current = Date.now();
        tickNoRef.current += 1;
        const tickNo = tickNoRef.current;
        setIsLoading(true);
        setIsRefreshRun(viewRef.current.state !== null);
        setError(null);
        posthogAnalytics.trackLiveAnalysisRefresh(force ? 'manual' : 'auto');
        window.electronAPI?.setLiveAnalysisInFlight?.(true, generation).catch(() => { });

        const controller = new AbortController();
        abortRef.current = controller;
        let done: V2Done | null = null;
        const changedThisTick = new Set<string>();
        try {
            const view0 = viewRef.current;
            await intelligenceApi.streamLiveAnalysisV2(
                {
                    session_id: sessionIdRef.current,
                    tick_id: `${sessionIdRef.current.slice(0, 8)}-${tickNo}`,
                    state: view0.state,
                    state_sig: view0.sig,
                    meeting_types: meetingTypesRef.current,
                    turns,
                    force_sweep: force,
                },
                (ev) => {
                    if (sessionEpochRef.current !== epoch) return; // a new call started
                    if (ev.event === 'qualification_update') {
                        for (const c of ((ev.data as any)?.changes || [])) changedThisTick.add(c.path);
                    }
                    if (ev.event === 'done') done = ev.data as V2Done;
                    if (ev.event === 'degraded') {
                        console.warn('[useLiveAnalysisV2] degraded tick:', ev.data);
                    }
                    publish(applyV2Event(viewRef.current, ev.event, ev.data, tickNo));
                },
                controller.signal,
            );
            if (sessionEpochRef.current !== epoch) return;
            if (!done) throw new Error('Live analysis stream ended without a result');
            // Only a completed tick moves the cursor; an interrupted one re-sends the same turns
            // (the server dedupes by turn id, so a partial success can't double-count).
            cursorRef.current = endIndex;
            const traceId = (done as V2Done).trace_id;
            if (traceId) for (const p of changedThisTick) fieldTraceRef.current[p] = traceId;
            const data = stateToAnalysis((done as V2Done).state, objectionsRef?.current ?? [], dealAlertsRef.current);
            window.electronAPI?.updateLiveAnalysis?.(data, generation).catch((err: any) =>
                console.error('[useLiveAnalysisV2] Failed to persist analysis:', err),
            );
        } catch (e: any) {
            if (sessionEpochRef.current === epoch && e?.code !== 'request_aborted') {
                console.error(`[useLiveAnalysisV2] tick failed (code=${e?.code ?? 'unknown'}): ${e?.message ?? e}`);
                setError(e?.message || 'Analysis failed');
            }
        } finally {
            inFlightRef.current = false;
            abortRef.current = null;
            setIsLoading(false);
            window.electronAPI?.setLiveAnalysisInFlight?.(false, generation).catch(() => { });
            if (forcePendingRef.current && sessionEpochRef.current === epoch) {
                forcePendingRef.current = false;
                void runTickRef.current(true);
            }
        }
    }, [transcriptRef, publish, objectionsRef]);

    const runTickRef = useRef(runTick);
    useEffect(() => { runTickRef.current = runTick; }, [runTick]);

    // Settled-speech cadence.
    useEffect(() => {
        if (isMeetingPaused) return;
        const id = setInterval(() => {
            const entries = transcriptRef.current ?? [];
            const pending = entries.slice(cursorRef.current);
            if (shouldTickV2({
                now: Date.now(),
                inFlight: inFlightRef.current,
                lastTickStartedAt: lastTickStartedAtRef.current,
                pending,
            })) {
                void runTickRef.current(false);
            }
        }, V2_POLL_MS);
        return () => clearInterval(id);
    }, [transcriptRef, isMeetingPaused]);

    // Deal Optimizer fast lane — negotiation meetings only; 404 disables it for the session.
    const dealEnabledRef = useRef(true);
    const dealCursorRef = useRef(0);
    const dealInFlightRef = useRef(false);
    const dealLastAtRef = useRef(0);
    useEffect(() => {
        if (isMeetingPaused) return;
        const id = setInterval(async () => {
            if (!dealEnabledRef.current || dealInFlightRef.current) return;
            if (!meetingTypesRef.current.includes('negotiation')) return;
            const entries = transcriptRef.current ?? [];
            const fresh = entries.slice(dealCursorRef.current).filter(e => e.speaker !== 'user' && !e.asrSuspect);
            if (!fresh.length || Date.now() - dealLastAtRef.current < DEAL_MIN_GAP_MS) return;
            const epoch = sessionEpochRef.current;
            const end = entries.length;
            const windowTurns = entries.slice(Math.max(0, end - 12)).map(e => ({
                speaker: e.speaker,
                text: e.textOriginal ?? e.text,
            }));
            dealInFlightRef.current = true;
            dealLastAtRef.current = Date.now();
            try {
                const res = await intelligenceApi.detectDealAlerts(
                    windowTurns,
                    meetingTypesRef.current,
                    dealAlertsRef.current.map(a => a.quote),
                    sessionIdRef.current,
                );
                if (sessionEpochRef.current !== epoch) return;
                dealCursorRef.current = end;
                if (res.new?.length) {
                    dealAlertsRef.current = mergeDealAlerts(dealAlertsRef.current, res.new);
                    publish(viewRef.current);
                }
            } catch (err: any) {
                if (err?.status === 404) {
                    dealEnabledRef.current = false;
                    console.warn('[useLiveAnalysisV2] deal-optimizer route not available — disabled for this session');
                }
            } finally {
                dealInFlightRef.current = false;
            }
        }, DEAL_POLL_MS);
        return () => clearInterval(id);
    }, [transcriptRef, isMeetingPaused, publish]);

    const runAnalysis = useCallback(async (force = false) => {
        if (!force && isPausedRef.current) return;
        await runTickRef.current(force);
    }, []);

    /**
     * End-of-call pass (POST /v2/end). One request over the WHOLE call — every transcript entry,
     * original text + turn ids — seeded with the last tick's signed state. Replaces the old
     * "force one more tick and wait" at call end: an in-flight tick is aborted (the final pass
     * covers its turns), no further ticks run, and the returned analysis carries the final
     * BANT/MEDDIC, the consolidated buying signals and the objections for the saved meeting.
     * Resolves null when there is nothing to analyse or the call failed; main then falls back.
     */
    const finalizeAnalysis = useCallback(async (): Promise<LiveAnalysisData | null> => {
        const entries = transcriptRef.current ?? [];
        if (!callStartRef.current) callStartRef.current = entries[0]?.arrivalMs ?? entries[0]?.timestamp ?? Date.now();
        const { turns } = buildTurns(entries, 0, callStartRef.current, V2_END_MAX_TURNS);
        if (!turns.some(t => t.role === 'prospect')) return null;

        finalizedRef.current = true;
        abortRef.current?.abort();
        const epoch = sessionEpochRef.current;
        const view0 = viewRef.current;
        const startedAt = Date.now();
        setIsLoading(true);
        try {
            // What the rep saw live — the saved meeting keeps all of it (keepLiveAddMissed).
            const liveObjections = objectionsRef?.current ?? [];
            const liveSignals = view0.state ? stateToAnalysis(view0.state).signals : [];
            const res = await intelligenceApi.endLiveAnalysisV2({
                session_id: sessionIdRef.current,
                state: view0.state,
                state_sig: view0.sig,
                meeting_types: meetingTypesRef.current,
                turns,
                live_objections: liveObjectionsForEnd(liveObjections),
            });
            if (sessionEpochRef.current !== epoch) return null;
            if (res.degraded?.length) console.warn('[useLiveAnalysisV2] end-of-call pass degraded:', res.degraded);
            cursorRef.current = entries.length;
            publish({ ...viewRef.current, state: res.state, sig: res.state_sig, traceId: res.trace_id ?? viewRef.current.traceId, changed: {} });
            const data = keepLiveAddMissed(
                endResponseToAnalysis(res, dealAlertsRef.current),
                { objections: liveObjections, signals: liveSignals },
            );
            console.log(
                `[useLiveAnalysisV2] end-of-call pass: ${turns.length} turns, ${data.objections.length} objections ` +
                `(${liveObjections.length} live), ${data.signals.length} signals (${liveSignals.length} live) ` +
                `in ${Date.now() - startedAt}ms`,
            );
            return data;
        } catch (e: any) {
            console.error(`[useLiveAnalysisV2] end-of-call pass failed (code=${e?.code ?? 'unknown'}): ${e?.message ?? e}`);
            return null;
        } finally {
            if (sessionEpochRef.current === epoch) setIsLoading(false);
        }
    }, [transcriptRef, publish, objectionsRef]);

    const resetAnalysis = useCallback(() => {
        finalizedRef.current = false;
        sessionEpochRef.current += 1;
        abortRef.current?.abort();
        sessionIdRef.current = newSessionId();
        viewRef.current = EMPTY_VIEW;
        cursorRef.current = 0;
        lastTickStartedAtRef.current = 0;
        callStartRef.current = 0;
        forcePendingRef.current = false;
        fieldTraceRef.current = {};
        dealAlertsRef.current = [];
        dealCursorRef.current = 0;
        dealEnabledRef.current = true;
        inFlightRef.current = false;
        setAnalysisData(null);
        setChangedFields({});
        setError(null);
    }, []);

    /** Same contract as useLiveAnalysis: the cursor in the FILTERED human-turn index space. */
    const getAnalysisProgress = useCallback(() => {
        const entries = transcriptRef.current ?? [];
        const human = entries
            .slice(0, cursorRef.current)
            .filter(t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase())).length;
        return {
            hasAnalysis: viewRef.current.state !== null,
            lastAnalyzedTurnIndex: human,
            isLoading: inFlightRef.current,
        };
    }, [transcriptRef]);

    const sendFieldFeedback = useCallback((target: string, value: 1 | -1, comment?: string) => {
        const traceId = fieldTraceRef.current[target] || viewRef.current.traceId;
        if (!traceId) return;
        intelligenceApi
            .sendLiveAnalysisFeedback({ traceId, sessionId: sessionIdRef.current, target, value, comment })
            .catch(err => console.warn('[useLiveAnalysisV2] feedback failed:', err?.message ?? err));
    }, []);

    return {
        analysisData,
        isLoading,
        error,
        runAnalysis,
        resetAnalysis,
        isRefreshRun,
        getAnalysisProgress,
        changedFields,
        sendFieldFeedback,
        finalizeAnalysis,
    };
};
