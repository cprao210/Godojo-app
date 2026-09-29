// Typed wrappers over the FastAPI intelligence routes. The renderer owns both the
// Firebase token (via apiClient) and the live transcript, so it POSTs straight to the
// backend — no IPC round-trip. The renderer also does all transcript preprocessing
// (cleaning + speaker resolution), so it sends a pre-formatted, speaker-labeled
// transcript STRING; the backend has no preprocess step.

import { apiFetch, getAuthHeaders, API_BASE, ApiError } from "@/lib/apiClient";
import { LiveAnalysisTurn, LiveAnalysisData, MeetingType, BackendCompanyAsset } from "@/types";
import { ObjectionDelta, OBJECTION_WINDOW_TURNS, MAX_OPEN_OBJECTIONS } from "@/lib/objections";
import { postSSE, SSEEvent } from "@/lib/sse";
import type { V2EndRequest, V2EndResponse, V2TickRequest } from "@/lib/liveAnalysisV2";
import type { DealOptimizerAlert } from "@/types";

/** Client ceiling for one v2 tick stream — the server's own wall is 20s. */
export const LIVE_ANALYSIS_V2_TIMEOUT_MS = 35_000;
// End-of-call pass: two parallel LLM calls over the whole transcript (backend budget 45s) + margin.
export const LIVE_ANALYSIS_V2_END_TIMEOUT_MS = 60_000;
/** Deal-optimizer window: the last N turns, same idea as the objection tick. */
export const DEAL_ALERT_WINDOW_TURNS = 12;

// Backend has no window cap (preprocess removed), so cap here. Keeps the extract prompt
// small on long calls.
const LIVE_ANALYSIS_MAX_TURNS = 80;

/**
 * Format turns into the backend's speaker-labeled transcript: `user` → SALES PERSON,
 * everyone else → PROSPECT. The backend prompt speaker-scopes on these labels (and RAG
 * uses the recent PROSPECT lines as its query), so the labels must match exactly.
 *
 * `maxTurns` is the trailing-window cap. live-analysis sends a large window; the
 * objection-handler tick sends a deliberately tiny one — that (plus the delta-out
 * response) is what keeps its latency flat as the call runs long.
 */
function formatTranscript(turns: LiveAnalysisTurn[], maxTurns = LIVE_ANALYSIS_MAX_TURNS): string {
  const usable = turns.filter((t) => t.text?.trim());
  // Truncation is silent and permanent on the live path: the first analysis of an
  // already-long call drops everything before the trailing window, and the caller's cursor
  // then advances past the dropped head, so nothing ever re-sends it. Only warn for the
  // DEFAULT window — the objection tick's 16-turn window is deliberate and would otherwise
  // log on every tick.
  if (maxTurns === LIVE_ANALYSIS_MAX_TURNS && usable.length > maxTurns) {
    console.warn(
      `[intelligenceApi] Transcript window truncated: ${usable.length} turns → trailing ` +
      `${maxTurns}. The ${usable.length - maxTurns} earliest turns are not being analysed.`,
    );
  }
  return usable
    .slice(-maxTurns)
    .map((t) => `${t.speaker === "user" ? "SALES PERSON" : "PROSPECT"}: ${t.text.trim()}`)
    .join("\n");
}

export const intelligenceApi = {
  /**
   * POST the formatted transcript to /intelligence/live-analysis. The backend runs RAG +
   * the fast extract (or the deep critique/revise loop) and returns LiveAnalysisData.
   * `meetingId` is null for a live (not-yet-ingested) call.
   *
   * `meetingTypes` mirrors the panel's Meeting Type multi-select — the backend produces
   * `dealOptimizer` only when it includes "negotiation". `mode` defaults to "deep"
   * (extract + the backend critique/revise loop); pass "fast" for the single-pass
   * extract.
   *
   * Incremental contract: the backend is stateless — the renderer carries the analysis
   * state. Pass `opts.previousAnalysis` (the last response) and then `turns` is ONLY the
   * new speech since that call (the delta); the backend merges the delta into the prior
   * analysis and returns the full updated result. Omit it and `turns` is treated as the
   * full call, analysed fresh. An empty delta with a previous analysis is a no-op on the
   * backend (it echoes the prior analysis back without an LLM call).
   *
   * A 200 can still mean "no new analysis": when the backend spends its provider budget
   * without an answer it mirrors `previous_analysis` back with `degraded: true` instead of
   * 5xx-ing. Callers must not advance their transcript cursor over one — see
   * `shouldAdvanceCursor` in src/lib/meetingLifecycle.ts.
   */
  analyzeLive: (
    turns: LiveAnalysisTurn[],
    meetingId: string | null = null,
    opts: {
      mode?: "fast" | "deep";
      meetingTypes?: MeetingType[];
      previousAnalysis?: LiveAnalysisData | null;
    } = {},
  ): Promise<LiveAnalysisData> =>
    apiFetch<LiveAnalysisData>("/intelligence/live-analysis", {
      method: "POST",
      body: JSON.stringify({
        transcript: formatTranscript(turns),
        meeting_id: meetingId,
        mode: opts.mode ?? "deep",
        meeting_types: opts.meetingTypes ?? [],
        // Only sent on incremental (delta) calls — see the contract note above.
        ...(opts.previousAnalysis
          ? { previous_analysis: opts.previousAnalysis }
          : {}),
      }),
    }),

  /**
   * POST the recent transcript window to /intelligence/objection-handler — the fast
   * (p95 ≤ 1.5s) sibling of analyzeLive, which handles objections and nothing else:
   * no BANT/MEDDIC, no signals, no RAG.
   *
   * DELTA IN / DELTA OUT. `turns` is a short recent window (not the whole call) and
   * `openObjections` is the quotes of the objections the client currently has open.
   * The response carries only what changed — objections `new` since that window, and
   * quotes echoed back as `resolved` once the transcript actually answers them. The
   * payload therefore stays ~50–150 tokens no matter how long the call runs, which is
   * what keeps latency flat late in a meeting.
   *
   * The CLIENT owns the resulting list (see src/lib/objections.ts) and posts the
   * accumulated version back as `previous_analysis.objections` on analyzeLive.
   *
   * `signal` bounds the request well under apiClient's 60s ceiling — a dropped tick
   * must never stall the live panel.
   */
  detectObjections: (
    turns: LiveAnalysisTurn[],
    openObjections: string[] = [],
    meetingId: string | null = null,
    signal?: AbortSignal,
  ): Promise<ObjectionDelta> =>
    apiFetch<ObjectionDelta>("/intelligence/objection-handler", {
      method: "POST",
      signal,
      body: JSON.stringify({
        transcript: formatTranscript(turns, OBJECTION_WINDOW_TURNS),
        meeting_id: meetingId,
        open_objections: openObjections.slice(0, MAX_OPEN_OBJECTIONS),
      }),
    }),

  /**
   * Tells the backend to re-index company knowledge assets (the docs uploaded
   * in Settings → Company Context) for RAG. Note the stale-era wording this
   * used to carry ("upload handled entirely by Electron") predates
   * uploadCompanyAsset below — committing an uploaded file to the backend is
   * that function's job (via the company:uploadAssetToBackend IPC); this
   * reindex call only refreshes derived state afterwards. Fire-and-forget.
   */
  reindexCompanyAssets: (): Promise<void> =>
    apiFetch<void>("/intelligence/company-assets/reindex", { method: "POST" }),

  /**
   * Lists company knowledge-base assets, tenant-scoped the same way as
   * /company-context: with X-Tenant-Id (auto-attached by apiClient once the
   * user is on a team), this returns the ADMIN's shared assets for every
   * member, not just whatever's uploaded from the caller's own device — the
   * local Electron/SQLite asset list is per-device and can't see another
   * user's uploads, which is why a member couldn't see admin-uploaded docs
   * before this existed.
   */
  listCompanyAssets: (): Promise<BackendCompanyAsset[]> =>
    apiFetch<BackendCompanyAsset[]>("/intelligence/company-assets"),

  /**
 * Uploads a company asset to the tenant-scoped backend (multipart). This is
 * what makes an uploaded doc visible + RAG-queryable for the whole team,
 * not just the uploading device. 415 => legacy binary Office file (re-save
 * as .docx/.pptx/.xlsx or PDF); 403 => member (only admin can upload).
 *
 * The backend queues indexing and returns 202 immediately; the returned
 * promise here only resolves once main has polled the job to a terminal
 * state ("indexed" | "empty") or given up after ~10 minutes ('timeout').
 */
  uploadCompanyAsset: async (params: {
    filePath: string;
    assetId: string;
    label: string;
    assetType: string;
  }): Promise<{ status: string; chunks?: number }> => {
    const tenantId =
      (await window.electronAPI?.getCurrentTenantId?.().catch(() => null)) ?? null;

    const res = await window.electronAPI.companyUploadAssetToBackend({
      filePath: params.filePath,
      assetId: params.assetId,
      label: params.label,
      assetType: params.assetType,
      tenantId,
    });

    // Main returns a structured error instead of throwing; normalize to ApiError
    // (carrying main's `code`, e.g. 'timeout', so callers can branch on it).
    if (res.status === "error") {
      throw new ApiError(res.statusCode ?? 500, res.code ?? "upload_failed", res.error ?? "Upload failed");
    }
    return res;
  },


  /**
   * Deletes a company asset's vectors + metadata on the backend. Note: the
   * primary delete path is the `companyDeleteAsset` IPC call (main process),
   * which also cleans up the local SQLite mirror — use this directly only if
   * you need a renderer-side delete without touching local file state.
   */
  deleteCompanyAsset: (assetId: string): Promise<void> =>
    apiFetch<void>(`/intelligence/company-assets/${encodeURIComponent(assetId)}`, {
      method: "DELETE",
    }),

  /**
   * Live analysis v2: one tick as an SSE stream (godojo-apis POST /intelligence/live-analysis/v2).
   * Events: ack, signals_update, qualification_update, questions_update, degraded, done. The
   * `done` event carries the full new state + signature, which the caller must post back on the
   * next tick. Resolves when the stream closes.
   */
  streamLiveAnalysisV2: (
    body: V2TickRequest,
    onEvent: (ev: SSEEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> =>
    postSSE("/intelligence/live-analysis/v2", body, {
      onEvent,
      signal,
      timeoutMs: LIVE_ANALYSIS_V2_TIMEOUT_MS,
    }),

  /**
   * Live analysis v2 end-of-call pass (POST /intelligence/live-analysis/v2/end): final BANT/MEDDIC,
   * consolidated buying signals and objections for the whole call, in one JSON round trip. Seeded
   * by the last tick's signed state when there is one (app calls); `state: null` + turns for an
   * uploaded transcript. Degraded lanes are reported in `degraded`, never as an error.
   */
  endLiveAnalysisV2: (body: V2EndRequest, signal?: AbortSignal): Promise<V2EndResponse> =>
    apiFetch<V2EndResponse>("/intelligence/live-analysis/v2/end", {
      method: "POST",
      signal,
      timeoutMs: LIVE_ANALYSIS_V2_END_TIMEOUT_MS,
      body: JSON.stringify(body),
    }),

  /**
   * A rep's 👍/👎 on one field (or signal) of a v2 tick. Recorded server-side as a Langfuse score
   * on that tick's trace, so real misgrades can be found and turned into eval cases.
   * Fire-and-forget: feedback must never interrupt the call.
   */
  sendLiveAnalysisFeedback: (params: {
    traceId: string;
    sessionId: string;
    target: string;
    value: 1 | -1;
    comment?: string;
  }): Promise<{ ok: boolean; recorded: boolean }> =>
    apiFetch<{ ok: boolean; recorded: boolean }>("/intelligence/live-analysis/v2/feedback", {
      method: "POST",
      timeoutMs: 10_000,
      body: JSON.stringify({
        trace_id: params.traceId,
        session_id: params.sessionId,
        target: params.target,
        value: params.value,
        comment: params.comment ?? "",
      }),
    }),

  /**
   * Deal Optimizer fast lane (POST /intelligence/deal-optimizer). Only produces alerts for
   * "negotiation" meetings and only when the prospect's words trip the backend's money/competitor
   * prefilter. DELTA OUT like the objection route: `openQuotes` are the alerts already shown.
   */
  detectDealAlerts: (
    turns: LiveAnalysisTurn[],
    meetingTypes: MeetingType[],
    openQuotes: string[] = [],
    sessionId: string | null = null,
    signal?: AbortSignal,
  ): Promise<{ new: DealOptimizerAlert[]; triggered: boolean }> =>
    apiFetch<{ new: DealOptimizerAlert[]; triggered: boolean }>("/intelligence/deal-optimizer", {
      method: "POST",
      signal,
      timeoutMs: 15_000,
      body: JSON.stringify({
        transcript: formatTranscript(turns, DEAL_ALERT_WINDOW_TURNS),
        meeting_types: meetingTypes,
        open_quotes: openQuotes.slice(0, 25),
        session_id: sessionId,
      }),
    }),
};