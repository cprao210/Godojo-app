// src/lib/meetingsApi.ts
//
// Typed wrappers over the FastAPI meetings routes. Reads return mapped `Meeting`s
// (see meetingMapping.ts); writes return the raw backend response (mutations
// invalidate + refetch, so the shape isn't relied on).

import { apiFetch } from "./apiClient";
import { mapMeetingDetail, mapMeetingRow } from "./meetingMapping";
import type { Meeting } from "../types/meeting";

export const meetingsApi = {
  list: async (): Promise<Meeting[]> => {
    const rows = await apiFetch<any[]>("/meetings");
    // Dedupe by id (defensive — preserves the renderer's previous IPC-side dedup).
    const seen = new Set<string>();
    return (rows ?? []).map(mapMeetingRow).filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  },

  get: async (id: string): Promise<Meeting> => {
    const row = await apiFetch<any>(`/meetings/${id}`);
    return mapMeetingDetail(row);
  },

  updateTitle: (id: string, title: string): Promise<unknown> =>
    apiFetch(`/meetings/${id}/title`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  // The renderer sends a partial detailedSummary object; the backend merges it into
  // summary_json. Body shape matches MeetingSummaryUpdate ({ updates }).
  updateSummary: (id: string, updates: Record<string, unknown>): Promise<unknown> =>
    apiFetch(`/meetings/${id}/summary`, {
      method: "PATCH",
      body: JSON.stringify({ updates }),
    }),

  remove: (id: string): Promise<void> =>
    apiFetch(`/meetings/${id}`, { method: "DELETE" }),

  // NOTE: upload stays on the IPC path until Phase 2 (the Phase-1 backend has no LLM,
  // so an HTTP upload would store an un-summarized meeting). Kept here for completeness;
  // arg order is (title, transcript) to match the TranscriptUpload body.
  uploadTranscript: (title: string, transcript: string): Promise<unknown> =>
    apiFetch("/meetings/upload-transcript", {
      method: "POST",
      body: JSON.stringify({ title, transcript }),
    }),
};
