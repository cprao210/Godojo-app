// Typed wrappers over the FastAPI meetings routes. Reads return mapped `Meeting`s
// (see meetingMapping.ts); writes return the raw backend response (mutations
// invalidate + refetch, so the shape isn't relied on).

import { AiInteractionsResponse, ChunkMeetingResponse, EndMeetingResponse, Meeting, MeetingStateResponse } from "@/types";
import { MeetingType, PauseMeetingResponse, ResumeMeetingResponse, StartMeetingRequest, StartMeetingResponse } from "@/types";
import { SubmitTranscriptResponse, TranscriptSegmentInput } from "@/types";
import { apiFetch } from "@/lib/apiClient";
import { mapMeetingDetail, mapMeetingRow } from "@/api/meetingMapping";

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

  // Persisted "Ask Dojo" Q&A history for a meeting — fetched lazily when the
  // user opens the tab, rather than bundled into the main meeting payload.
  getAiInteractions: (meetingId: string): Promise<AiInteractionsResponse> =>
    apiFetch(`/meetings/${meetingId}/ai-interactions`),

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

  // ── Live meeting lifecycle ────────────────────────────────────────────────
  // These map 1:1 to the FastAPI routes in app/api/v1/meetings.py. Audio capture
  // and STT stay client-side; the backend only tracks session state + persists
  // transcript/usage as they're submitted.

  start: (body: StartMeetingRequest = {}): Promise<StartMeetingResponse> =>
    apiFetch("/meetings/start", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  pause: (meetingId: string): Promise<PauseMeetingResponse> =>
    apiFetch("/meetings/pause", {
      method: "POST",
      body: JSON.stringify({ meeting_id: meetingId }),
    }),

  resume: (meetingId: string): Promise<ResumeMeetingResponse> =>
    apiFetch("/meetings/resume", {
      method: "POST",
      body: JSON.stringify({ meeting_id: meetingId }),
    }),

  getState: (meetingId: string): Promise<MeetingStateResponse> =>
    apiFetch(`/meetings/state?meeting_id=${encodeURIComponent(meetingId)}`),

  // Sends transcript segments collected locally. Per the backend contract this
  // should be called once, at end-of-meeting — not streamed chunk-by-chunk.
  submitTranscript: (
    meetingId: string,
    segments: TranscriptSegmentInput[],
  ): Promise<SubmitTranscriptResponse> =>
    apiFetch("/meetings/transcript", {
      method: "POST",
      body: JSON.stringify({ meeting_id: meetingId, segments }),
    }),

  end: (meetingId: string, meetingTypes: MeetingType[] = []): Promise<EndMeetingResponse> =>
    apiFetch("/meetings/end", {
      method: "POST",
      body: JSON.stringify({ meeting_id: meetingId, meeting_types: meetingTypes }),
    }),

  // Chunks + ingests the meeting transcript for RAG (chat/rag/query/meeting and
  // the global chat both depend on this having run). Call once, right after
  // `end` — the backend can't chunk a meeting still marked active.
  chunk: (meetingId: string): Promise<ChunkMeetingResponse> =>
    apiFetch(`/meetings/${meetingId}/chunking`, { method: "POST" }),

  // NOTE: upload stays on the IPC path until Phase 2 (the Phase-1 backend has no LLM,
  // so an HTTP upload would store an un-summarized meeting). Kept here for completeness;
  // arg order is (title, transcript) to match the TranscriptUpload body.
  uploadTranscript: (title: string, transcript: string): Promise<unknown> =>
    apiFetch("/meetings/upload-transcript", {
      method: "POST",
      body: JSON.stringify({ title, transcript }),
    }),
};
