// src/lib/meetingsApi.ts
//
// Typed wrappers over the FastAPI meetings routes. Reads return mapped `Meeting`s
// (see meetingMapping.ts); writes return the raw backend response (mutations
// invalidate + refetch, so the shape isn't relied on).

import { apiFetch } from "./apiClient";
import { mapMeetingDetail, mapMeetingRow } from "./meetingMapping";
import type { Meeting } from "../types/meeting";

// ── Live-meeting request/response shapes ────────────────────────────────────
// Mirror app/models/meeting.py 1:1 so the payloads the backend expects line up
// with what TypeScript lets us send.

export interface MeetingAttendee {
  email: string;
  name?: string;
  self?: boolean;
}

export interface StartMeetingRequest {
  title?: string;
  attendees?: MeetingAttendee[];
  audio?: {
    input_device_id?: string | null;
    output_device_id?: string | null;
  };
  calendar_event_id?: string;
}

export interface StartMeetingResponse {
  success: boolean;
  meeting_id: string;
  started_at: number; // ms since epoch
}

export interface PauseMeetingResponse {
  success: boolean;
  paused_at?: number;
  already_paused?: boolean;
}

export interface ResumeMeetingResponse {
  success: boolean;
  resumed_at?: number;
  not_paused?: boolean;
}

export interface MeetingStateResponse {
  is_active: boolean;
  is_paused: boolean;
  meeting_id: string | null;
}

export type TranscriptSpeaker = "user" | "client" | "assistant" | "system";

export interface TranscriptSegmentInput {
  speaker: TranscriptSpeaker;
  text: string;
  timestamp: number; // ms since epoch
  final?: boolean;
  confidence?: number;
}

export interface SubmitTranscriptResponse {
  accepted?: number;
  dropped?: number;
  reason?: string;
}

export type MeetingType = "discovery" | "demo" | "negotiation";

export interface EndMeetingResponse {
  success: boolean;
  meeting_id: string;
  duration_ms: number;
}

export interface ChunkMeetingResponse {
  meeting_id: string;
  duration_ms: number;
  ingested: boolean;
  is_processed: number;
}

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
