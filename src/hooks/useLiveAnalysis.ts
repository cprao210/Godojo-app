import { useState, useCallback, useRef, useEffect } from 'react';
import { LiveAnalysisData, LiveAnalysisTurn, MeetingType, Objection } from '@/types';
import { intelligenceApi } from '@/api/intelligenceApi';
import { posthogAnalytics } from '@/lib/analytics/posthog.service';
import { getMeetingGeneration } from '@/lib/meetingGeneration';
import { stableId } from '@/lib/objections';
import { shouldAdvanceCursor } from '@/lib/meetingLifecycle';

// ─── useLiveAnalysis ───────────────────────────────────────────────────────
//
// Drives live BANT/MEDDIC/objection/signal analysis for the call in progress.
//
// The renderer owns the transcript + Firebase token, so it POSTs straight to
// the backend's `/intelligence/live-analysis` route (no IPC round-trip through
// the main-process GodojoClient, and no client-side LLM fallback of any kind —
// the backend is the ONLY producer of analysis). The backend also owns prompt
// construction entirely; this hook's job is just to:
//   1. Track a cursor into the transcript so each run after the first only
//      sends the NEW turns since the last analysis (the "delta"), plus the
//      prior structured result, so the backend can merge incrementally.
//   2. Retry a failed/stuck call a bounded number of times before surfacing
//      an error (see `withAnalysisRetries` below).
//   3. Re-stamp stable ids onto the backend's response and let a few local
//      refs (objections, session id) override/guard pieces of it before it's
//      written into React state.
//
// Incremental contract with the backend:
//   • First run for a session: `previousAnalysis` is null → `turns` is the
//     WHOLE call so far, analysed from scratch.
//   • Every run after that: `previousAnalysis` is the last merged result and
//     `turns` is ONLY the turns added since the cursor — the backend merges
//     the delta into the prior result and returns the full updated analysis.
//   • A 200 response is not automatically a success: when the backend has
//     exhausted its provider budget it mirrors `previousAnalysis` back with
//     `degraded: true` instead of returning a 5xx (a 5xx would blank the
//     panel to an all-missing shell). `shouldAdvanceCursor` is what tells the
//     caller not to move the cursor forward over a degraded response, so the
//     same delta gets retried on the next tick instead of being lost.

// ── Urgent-signal trigger patterns (zero-cost regex check on new prospect turns) ──
// When any pattern matches a new transcript turn, runAnalysis fires immediately
// instead of waiting for the next timer tick. Gated by 60s cooldown + in-flight guard.
const URGENT_TRIGGER_PATTERNS = [
  /\bcompetitor\b|\bsalesforce\b|\bhubspot\b|\bmarketo\b|\boutreach\b|\bgong\b|\bchorus\b/i,
  /\blet'?s\s+move\s+forward\b|\bsend\s+(me\s+)?a?\s*proposal\b|\bready\s+to\s+sign\b/i,
  /\bcontract\s+expires?\b|\board\s+deadline\b|\blegal\s+(team\s+)?needs?\b/i,
  /\bnext\s+quarter\b|\bpausing\s+evaluations?\b|\bnot\s+in\s+a\s+rush\b/i,
  /\bbudget\s+(is\s+)?(approved|confirmed|allocated|set\s+aside)\b/i,
  /\bi\s+(can\s+)?approve\s+this\b|\bfinal\s+(call\s+)?is\s+mine\b/i,
];

const hasUrgentTrigger = (text: string): boolean => URGENT_TRIGGER_PATTERNS.some(r => r.test(text));

/** How often new prospect turns are scanned for the patterns above. Pure regex
 *  over a short slice — cheap enough to run at conversational speed. */
const URGENT_TRIGGER_POLL_MS = 3_000;
/** Floor between an analysis and an urgent-signal-driven re-analysis. */
const URGENT_TRIGGER_COOLDOWN_MS = 60_000;

// ─── Bounded retry wrapper ─────────────────────────────────────────────────
// The single source of "resilience" for a live-analysis run. There is no LLM
// fallback anymore — a failing backend call is retried in place, up to
// MAX_ANALYSIS_ATTEMPTS total attempts, with a short linear backoff between
// tries. This applies to ANY kind of failure the request can produce: network
// errors, non-2xx responses, a request that hangs until the axios/backend
// timeout fires, or a response body that fails to parse. Only after the last
// attempt fails does the error propagate to the caller's own catch block.
const MAX_ANALYSIS_ATTEMPTS = 3;
const ANALYSIS_RETRY_BASE_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withAnalysisRetries<T>(
  fn: (attempt: number) => Promise<T>,
  { onRetry }: { onRetry?: (attempt: number, err: any) => void } = {}
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ANALYSIS_ATTEMPTS) break;
      onRetry?.(attempt, err);
      // Linear backoff: 1s before attempt 2, 2s before attempt 3. The last
      // attempt never waits — if it fails, we're done and should fail fast.
      await sleep(ANALYSIS_RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

// ─── Stable-id stamp + dedupe (backend response) ──────────────────────────
// The backend performs the incremental merge itself (BANT/MEDDIC status
// ratchet with an evidence-backed downgrade escape hatch, objection/signal
// dedupe-and-append, guaranteed suggested_questions, and quote-grounding that
// exempts quotes carried verbatim from the prior analysis). The renderer
// trusts that merged result directly — it does not re-merge client-side.
//
// Two gaps in the backend response are closed here:
//   • Stable ids — the backend schema has no `id` field, so it's dropped on
//     every round-trip. Re-stamp it deterministically from the quote
//     (stableId is a pure function of the text), so dismiss/checked UI state
//     keyed by id survives refreshes.
//   • Dedupe safety net — the backend dedupes by prompt but not
//     deterministically, so drop any exact id collision, keeping the first
//     (newest, since the backend orders newly-detected items first).
const stampIds = (data: LiveAnalysisData): LiveAnalysisData => {
  const dedupeStamp = <T extends { id?: string; quote: string }>(items: T[]): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of items) {
      const id = item.id ?? stableId(item.quote);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...item, id });
    }
    return out;
  };
  return {
    bant: data.bant,
    meddic: data.meddic,
    objections: dedupeStamp(data.objections),
    signals: dedupeStamp(data.signals),
    dealOptimizer: dedupeStamp(data.dealOptimizer ?? []),
  };
};

export const useLiveAnalysis = (
  transcriptRef: React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>,
  isMeetingPaused: boolean,
  // Pre-call company research, kept as a hook parameter for call-site
  // compatibility. The backend builds the prompt server-side and does not yet
  // accept company context on this route, so it isn't sent anywhere below —
  // wire it into the request body here if/when the backend adds support.
  companyIntel?: Record<string, any> | null,
  // Meeting Type multi-select state (owned by FloatingDock). Sent to the backend as
  // `meeting_types`; dealOptimizer is produced only when it includes 'negotiation'.
  meetingTypes: MeetingType[] = [],
  // The client-owned objection list from useObjectionWatch. When provided, the fast
  // /intelligence/objection-handler route is the SOLE producer of objections: this
  // hook posts the list as `previous_analysis.objections` (the backend carries it
  // through verbatim) and overrides the response's objections with it.
  // Pass null to fall back to the response's own objections — the behaviour against a
  // backend that hasn't shipped the split yet.
  objectionsRef: React.MutableRefObject<Objection[]> | null = null
) => {
  const [analysisData, setAnalysisData] = useState<LiveAnalysisData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the currently in-flight (or most recent) run was a refresh run.
  // Used by the UI to show "Refreshing…" vs "Analysing…" in the header.
  const [isRefreshRun, setIsRefreshRun] = useState(false);
  // Ref-based in-flight guard — avoids stale closure issues that a state-based check would have.
  const isLoadingRef = useRef(false);
  // Bumped by resetAnalysis() every time a new session starts. runAnalysis snapshots
  // this at call time and re-checks it after its await — if the next meeting starts
  // while a request from the PREVIOUS meeting is still in flight, that stale response
  // must never be written into the new meeting's state.
  const sessionIdRef = useRef(0);
  // Cursor: index into the FILTERED humanTurns array (system/ai/assistant/model excluded)
  // of the last entry included in the previous analysis run.
  // IMPORTANT: this must track humanTurns indices, NOT raw transcript.length, because
  // humanTurns is a filtered subset and slicing it with a raw-transcript cursor skips
  // all new turns (deltaStartIndex >= humanTurns.length), producing an empty delta and
  // stale live analysis on every refresh run.
  const lastAnalyzedIndexRef = useRef<number>(0);
  // Mirror of analysisData in a ref so runAnalysis can read the latest prior result
  // without a stale closure (useCallback deps would force re-creating on every render).
  const analysisDataRef = useRef<LiveAnalysisData | null>(null);
  // Timestamp of last completed analysis — used by the urgent-trigger cooldown.
  const lastAnalysisTimeRef = useRef<number>(0);
  // Cursor for urgent-trigger scanning — avoids re-scanning already-checked turns.
  const lastTriggerScanIndexRef = useRef<number>(0);

  const companyIntelRef = useRef<Record<string, any> | null | undefined>(companyIntel);
  useEffect(() => {
    companyIntelRef.current = companyIntel;
  }, [companyIntel]);

  // Ref-mirror (same pattern as companyIntelRef): runAnalysis reads the latest selection
  // without meetingTypes becoming a useCallback dep — its identity stays stable, so the
  // FloatingDock auto-refresh timer holding runAnalysisRef never resets on a toggle.
  const meetingTypesRef = useRef<MeetingType[]>(meetingTypes);
  useEffect(() => {
    meetingTypesRef.current = meetingTypes;
  }, [meetingTypes]);

  // Keep ref in sync with state so the runAnalysis closure always sees the latest value.
  const setAnalysisDataAndRef = useCallback((data: LiveAnalysisData | null) => {
    analysisDataRef.current = data;
    setAnalysisData(data);
  }, []);

  const runAnalysis = useCallback(async (force = false) => {
    const transcript = transcriptRef.current;
    if (!transcript?.length || (!force && isMeetingPaused)) return;

    if (isLoadingRef.current) {
      console.warn('[useLiveAnalysis] Analysis already in-flight, skipping duplicate call.');
      return;
    }

    // force=true is the manual "Refresh" button (and the first-open kick);
    // force=false is the unattended auto-refresh timer firing on its own.
    posthogAnalytics.trackLiveAnalysisRefresh(force ? 'manual' : 'auto');

    isLoadingRef.current = true;
    setIsLoading(true);
    setError(null);
    // Snapshot cursor, prior state, and the meeting this run belongs to at call
    // time — this function is async and everything below can resolve after the
    // call has ended and the next one started. runSessionId guards renderer
    // state; runGeneration guards what we write back into main.
    const priorState = analysisDataRef.current;
    const runSessionId = sessionIdRef.current;
    const runGeneration = getMeetingGeneration();
    // How long this run actually took, for the degraded/failure logs. A run that
    // dies at ~60s is the axios ceiling firing (which Chrome renders as
    // "(canceled)"); one that dies immediately is the backend being unreachable.
    const runStartedAt = Date.now();
    window.electronAPI?.setLiveAnalysisInFlight?.(true, runGeneration).catch(() => { });

    try {
      // Exclude internal system/AI turns — the backend only ever analyses
      // real speaker turns. NOTE: deltaStartIndex and currentEndIndex are
      // computed AFTER humanTurns is built so both the cursor and the slice
      // operate on the same filtered array — using transcript.length as the
      // cursor end-index would cause humanTurns.slice(deltaStartIndex) to
      // return an empty array on every refresh run (cursor ≥ humanTurns.length).
      const humanTurns = transcript.filter(
        t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase())
      );

      // Two cursors, two index spaces — keep them straight. lastAnalyzedIndexRef
      // indexes humanTurns (it drives the delta slice), while
      // lastTriggerScanIndexRef indexes prospect turns only (the urgent-trigger
      // effect slices `prospectTurns`). Advancing the trigger cursor with a
      // humanTurns index over-counted it, so trigger scanning silently skipped
      // every prospect turn between the two totals.
      const prospectTurnCount = humanTurns.filter(t => t.speaker !== 'user').length;

      const currentEndIndex = humanTurns.length;

      // Guard: if the cursor is ahead of the current transcript length,
      // the transcript was reset mid-session — treat this as a first run.
      if (priorState && lastAnalyzedIndexRef.current > humanTurns.length) {
        console.warn('[useLiveAnalysis] Cursor ahead of transcript length — resetting to first-run mode.');
        lastAnalyzedIndexRef.current = 0;
      }
      const adjustedDeltaStartIndex = priorState ? lastAnalyzedIndexRef.current : 0;

      setIsRefreshRun(Boolean(priorState));

      // ── Build the turns payload ────────────────────────────────────────
      // First run (no priorState): send the WHOLE call so far.
      // Refresh run: send only the delta — turns added since the cursor.
      // The backend builds its own prompt from these turns server-side, so
      // no prompt text is constructed on the client at all.
      const deltaTurns = priorState
        ? humanTurns.slice(adjustedDeltaStartIndex)
        : humanTurns;
      const turns: LiveAnalysisTurn[] = deltaTurns
        .filter(t => (t.speaker === 'user' || t.speaker === 'client') && t.text?.trim())
        .map(t => ({ speaker: t.speaker, text: t.text }));

      // Any failure on this call (network error, 5xx, timeout, stuck request,
      // malformed response, etc.) is retried up to MAX_ANALYSIS_ATTEMPTS times
      // with a short backoff before it's allowed to reach the outer catch below.
      const parsed = await withAnalysisRetries(
        (attempt) => {
          if (attempt > 1) {
            console.warn(
              `[useLiveAnalysis] Retry attempt ${attempt}/${MAX_ANALYSIS_ATTEMPTS} ` +
              `for ${priorState ? 'refresh' : 'first'} run.`
            );
          }
          return intelligenceApi.analyzeLive(turns, null, {
            meetingTypes: meetingTypesRef.current,
            // null on the first run → backend analyses `turns` as the full call.
            // When the objection watcher is active, the objections we send are the
            // client-owned accumulated list, not whatever the last response happened
            // to contain — the client is the owner of that slice of state.
            previousAnalysis:
              priorState && objectionsRef
                ? { ...priorState, objections: objectionsRef.current }
                : priorState,
          });
        },
        {
          onRetry: (attempt, err) => {
            console.error(
              `[useLiveAnalysis] Analysis attempt ${attempt}/${MAX_ANALYSIS_ATTEMPTS} failed ` +
              `after ${Date.now() - runStartedAt}ms (code=${err?.code ?? 'unknown'} status=${err?.status ?? '-'}): ` +
              `${err?.message ?? err} — retrying.`
            );
          },
        }
      );

      // Stale-session guard: discard a response that belongs to a meeting
      // that's no longer current instead of writing it into the new one.
      if (sessionIdRef.current !== runSessionId) return;

      // A 200 is not automatically a success. When the backend exhausts its
      // provider budget it mirrors `previous_analysis` back with `degraded: true`
      // rather than 5xx-ing (a 5xx would blank the panel to the all-missing
      // shell). See shouldAdvanceCursor for why the cursors must then hold.
      if (!shouldAdvanceCursor(parsed)) {
        // The cooldown ref still moves: it rate-limits the urgent-signal
        // trigger, and not touching it would let a struggling backend get
        // hammered on the very next poll tick.
        lastAnalysisTimeRef.current = Date.now();
        console.warn(
          `[useLiveAnalysis] Backend degraded (budget exhausted) after ${Date.now() - runStartedAt}ms — ` +
          `holding cursor at ${lastAnalyzedIndexRef.current}/${currentEndIndex}; the delta will be re-sent next tick.`
        );
        // Deliberately NOT stored. The mirror carries nothing the panel doesn't
        // already show, and on a degraded FIRST run it is an all-missing
        // analysis — writing that into state would push empty BANT/MEDDIC
        // through updateLiveAnalysis into summary_json.liveAnalysis, which
        // MeetingPersistence treats as authoritative (the same hazard
        // useFloatingDock's persist effect guards against). Objections are
        // unaffected: the panel reads them from the watcher, not from here.
        return;
      }

      // Backend already merged (see stampIds note); just re-stamp stable ids + dedupe.
      // Objections are then overridden from the watcher's ref read HERE, at response
      // time rather than request time: this call can be in flight for seconds while
      // several objection ticks land, and without this the slow response would clobber
      // the newer ones.
      const stamped = stampIds(parsed);
      const merged = objectionsRef
        ? { ...stamped, objections: objectionsRef.current }
        : stamped;

      // Advance cursor so next delta run only processes new turns
      lastAnalyzedIndexRef.current = currentEndIndex;
      lastAnalysisTimeRef.current = Date.now();
      lastTriggerScanIndexRef.current = prospectTurnCount;

      setAnalysisDataAndRef(merged);
      window.electronAPI?.updateLiveAnalysis?.(merged, runGeneration).catch((err: any) =>
        console.error('[useLiveAnalysis] Failed to persist analysis:', err)
      );
    } catch (e: any) {
      // Every attempt (up to MAX_ANALYSIS_ATTEMPTS) already failed by the time
      // we get here. Log the elapsed time and the transport code alongside the
      // message: those two together are what separate "the backend never
      // answered inside our 60s ceiling" (code client_timeout, ~60000ms) from
      // "the backend is down" (service_unavailable, near-instant) —
      // indistinguishable from the message alone.
      console.error(
        `[useLiveAnalysis] Analysis failed after ${MAX_ANALYSIS_ATTEMPTS} attempt(s), ` +
        `${Date.now() - runStartedAt}ms total ` +
        `(code=${e?.code ?? 'unknown'} status=${e?.status ?? '-'}): ${e?.message ?? e}`
      );
      // A stale request failing must not surface an error banner on the new
      // session — so this is guarded, not unconditional.
      if (sessionIdRef.current === runSessionId) {
        setError(e?.message || 'Analysis failed');
      }
    } finally {
      // Unconditional: this gates whether the NEXT session's runAnalysis can run at
      // all — must always clear regardless of which session it belonged to.
      isLoadingRef.current = false;
      setIsLoading(false);
      // Tagged, unlike the two flags above: main tracks in-flight state per
      // meeting, and a run from the previous call clearing the flag would tell
      // main "nothing in flight" for a meeting that is mid-analysis.
      window.electronAPI?.setLiveAnalysisInFlight?.(false, runGeneration).catch(() => { });
    }
  }, [transcriptRef, isMeetingPaused, setAnalysisDataAndRef]);

  // ── Urgent-signal trigger ──────────────────────────────────────────────────
  // Scans new prospect turns for high-value signal patterns (competitor mentions,
  // buying intent, stall signals, etc.) and fires runAnalysis() immediately when
  // one hits, instead of waiting for the next auto-refresh deadline. Zero LLM
  // cost — pure regex.
  //
  // A POLL, not an effect keyed on the transcript. `transcriptRef` is a plain ref
  // mutated by an IPC listener over in useGodojoInterface, so React is never told
  // it grew — and this used to be a plain effect whose deps
  // ([transcriptRef, isMeetingPaused, runAnalysis]) are all stable identities.
  // It therefore ran on mount (empty transcript) and on pause/resume, and never
  // once while the prospect was actually talking: the trigger was dead for the
  // whole call, even though useFloatingDock's comments credited it with owning
  // the refresh cadence. useObjectionWatch polls for exactly this reason.
  //
  // Gated by: transcript actively growing + 60s cooldown since the last
  // analysis + not already in-flight.
  useEffect(() => {
    if (isMeetingPaused) return;

    // Prospect-turn count at the previous tick.
    let prevProspectCount = -1;

    const scan = () => {
      const humanTurns = (transcriptRef.current ?? []).filter(
        t => !['system', 'ai', 'assistant', 'model'].includes(t.speaker?.toLowerCase())
      );
      const prospectTurns = humanTurns.filter(t => t.speaker !== 'user');

      // Only act while the transcript is actively growing. After a call ends the
      // ref still holds that call's turns — useGodojoInterface clears it when the
      // NEXT meeting starts — so a static transcript means nothing is being said
      // right now, and firing on it would analyse a finished call in the
      // background. The first tick has no previous count to compare against.
      const grew = prevProspectCount >= 0 && prospectTurns.length > prevProspectCount;
      prevProspectCount = prospectTurns.length;
      if (!grew || isLoadingRef.current) return;

      const newTurns = prospectTurns.slice(lastTriggerScanIndexRef.current);
      if (!newTurns.length) return;

      // Cooldown is checked BEFORE the cursor advances on purpose: turns that
      // arrive mid-cooldown stay unscanned and get re-examined on a later tick
      // instead of being silently consumed.
      if (Date.now() - lastAnalysisTimeRef.current <= URGENT_TRIGGER_COOLDOWN_MS) return;

      const triggered = newTurns.some(t => hasUrgentTrigger(t.text));
      lastTriggerScanIndexRef.current = prospectTurns.length;
      if (!triggered) return;

      console.log('[useLiveAnalysis] Urgent signal detected — triggering immediate analysis');
      runAnalysis(true);
    };

    const id = setInterval(scan, URGENT_TRIGGER_POLL_MS);
    return () => clearInterval(id);
  }, [transcriptRef, isMeetingPaused, runAnalysis]);

  const resetAnalysis = useCallback(() => {
    sessionIdRef.current += 1;
    analysisDataRef.current = null;
    lastAnalyzedIndexRef.current = 0;
    lastAnalysisTimeRef.current = 0;
    lastTriggerScanIndexRef.current = 0;
    setAnalysisData(null);
    setError(null);
  }, []);

  /**
   * Ref-backed snapshot of "what has this session analyzed so far", read at the
   * moment the call ends to decide whether one final run is needed. Reads refs
   * rather than state on purpose: the End Call handler runs inside a click
   * callback that closed over an older render.
   */
  const getAnalysisProgress = useCallback(() => ({
    hasAnalysis: analysisDataRef.current !== null,
    lastAnalyzedTurnIndex: lastAnalyzedIndexRef.current,
    isLoading: isLoadingRef.current,
  }), []);

  return { analysisData, isLoading, error, runAnalysis, resetAnalysis, isRefreshRun, getAnalysisProgress };
};