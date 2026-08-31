// Typed wrappers over the FastAPI intelligence routes. The renderer owns both the
// Firebase token (via apiClient) and the live transcript, so it POSTs straight to the
// backend — no IPC round-trip. The renderer also does all transcript preprocessing
// (cleaning + speaker resolution), so it sends a pre-formatted, speaker-labeled
// transcript STRING; the backend has no preprocess step.

import { apiFetch, getAuthHeaders, API_BASE, ApiError } from "@/lib/apiClient";
import { LiveAnalysisTurn, LiveAnalysisData, MeetingType, BackendCompanyAsset } from "@/types";
import { ObjectionDelta, OBJECTION_WINDOW_TURNS, MAX_OPEN_OBJECTIONS } from "@/lib/objections";

// Backend has no window cap (preprocess removed), so cap here. Keeps the extract prompt
// small on long calls.
const MAX_TURNS = 80;

/**
 * Format turns into the backend's speaker-labeled transcript: `user` → SALES PERSON,
 * everyone else → PROSPECT. The backend prompt speaker-scopes on these labels (and RAG
 * uses the recent PROSPECT lines as its query), so the labels must match exactly.
 *
 * `maxTurns` is the trailing-window cap. live-analysis sends a large window; the
 * objection-handler tick sends a deliberately tiny one — that (plus the delta-out
 * response) is what keeps its latency flat as the call runs long.
 */
function formatTranscript(turns: LiveAnalysisTurn[], maxTurns = MAX_TURNS): string {
  return turns
    .filter((t) => t.text?.trim())
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
   * `dealOptimizer` only when it includes "negotiation". `mode` defaults to "fast"
   * (single extract call); "deep" adds the backend critique/revise loop.
   *
   * Incremental contract: the backend is stateless — the renderer carries the analysis
   * state. Pass `opts.previousAnalysis` (the last response) and then `turns` is ONLY the
   * new speech since that call (the delta); the backend merges the delta into the prior
   * analysis and returns the full updated result. Omit it and `turns` is treated as the
   * full call, analysed fresh. An empty delta with a previous analysis is a no-op on the
   * backend (it echoes the prior analysis back without an LLM call).
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
        mode: opts.mode ?? "fast",
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
   * in Settings → Company Context) for RAG. The upload itself is still handled
   * entirely by Electron (companySelectFile / companyUploadAsset write the file
   * and register it locally) — this call just lets the backend know it should
   * pick up the new/changed asset set. Fire-and-forget from the caller's side;
   * the response has no fields the UI needs to act on.
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
    // so the hook's existing 415/403 handling works unchanged.
    if (res.status === "error") {
      throw new ApiError(res.statusCode ?? 500, "upload_failed", res.error ?? "Upload failed");
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
    })
};