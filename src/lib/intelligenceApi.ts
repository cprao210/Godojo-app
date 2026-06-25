// src/lib/intelligenceApi.ts
//
// Typed wrappers over the FastAPI intelligence routes. The renderer owns both the
// Firebase token (via apiClient) and the live transcript, so it POSTs straight to the
// backend — no IPC round-trip. The renderer also does all transcript preprocessing
// (cleaning + speaker resolution), so it sends a pre-formatted, speaker-labeled
// transcript STRING; the backend has no preprocess step.

import { apiFetch } from "./apiClient";
import type { LiveAnalysisData, LiveAnalysisTurn } from "../types/liveAnalysis";

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
   */
  analyzeLive: (
    turns: LiveAnalysisTurn[],
    meetingId: string | null = null,
  ): Promise<LiveAnalysisData> =>
    apiFetch<LiveAnalysisData>("/intelligence/live-analysis", {
      method: "POST",
      body: JSON.stringify({ transcript: formatTranscript(turns), meeting_id: meetingId }),
    }),
};
