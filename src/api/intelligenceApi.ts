// Typed wrappers over the FastAPI intelligence routes. The renderer owns both the
// Firebase token (via apiClient) and the live transcript, so it POSTs straight to the
// backend — no IPC round-trip. The renderer also does all transcript preprocessing
// (cleaning + speaker resolution), so it sends a pre-formatted, speaker-labeled
// transcript STRING; the backend has no preprocess step.

import { apiFetch } from "@/lib/apiClient";
import { LiveAnalysisTurn, LiveAnalysisData, MeetingType } from "@/types";

// Backend has no window cap (preprocess removed), so cap here. Keeps the extract prompt
// small on long calls.
const MAX_TURNS = 80;

/**
 * Format turns into the backend's speaker-labeled transcript: `user` → SALES PERSON,
 * everyone else → PROSPECT. The backend prompt speaker-scopes on these labels (and RAG
 * uses the recent PROSPECT lines as its query), so the labels must match exactly.
 */
function formatTranscript(turns: LiveAnalysisTurn[]): string {
  return turns
    .filter((t) => t.text?.trim())
    .slice(-MAX_TURNS)
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
