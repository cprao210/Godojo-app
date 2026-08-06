// src/lib/meetingMapping.ts
//
// Pure backend-row → Meeting mappers for the HTTP path.
//
// NOTE: this mirrors electron/db/SupabaseReadService.ts (the main-process/IPC path).
// The renderer can't import from electron/ (it would drag node/electron deps into the
// browser bundle) and vice-versa, so the mapping is intentionally duplicated. Keep the
// two in sync: column renames (created_at→date, duration_ms→duration), the
// summary_json {legacySummary, detailedSummary} split, and the is_processed coercion.

import type { Meeting, MeetingTranscriptLine, MeetingUsageEntry } from "../types/meeting";

/** ms → "m:ss" (or "h:mm:ss"). Matches DatabaseManager.formatDuration / SupabaseReadService. */
export function formatDuration(ms: number | null | undefined): string {
  const totalSec = Math.floor((ms ?? 0) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** summary_json is a JSONB object from Supabase but a JSON string from SQLite — normalize both. */
function parseSummary(summaryJson: unknown): any {
  if (!summaryJson) return {};
  if (typeof summaryJson === "string") {
    try {
      return JSON.parse(summaryJson || "{}");
    } catch {
      return {};
    }
  }
  return summaryJson;
}

/** Raw `meetings` row → Meeting (list view; transcript/usage stay empty). */
export function mapMeetingRow(row: any): Meeting {
  const s = parseSummary(row?.summary_json);
  return {
    id: row.id,
    title: row.title,
    date: row.created_at,
    duration: formatDuration(row.duration_ms),
    durationMs: row.duration_ms ?? undefined,
    summary: s.legacySummary || "",
    // When a summary exists, guarantee the two list arrays so consumers (UI, PDF, email)
    // can treat them as arrays; a missing summary stays undefined ("No summary yet").
    detailedSummary: s.detailedSummary
      ? { actionItems: [], keyPoints: [], ...s.detailedSummary }
      : undefined,
    calendarEventId: row.calendar_event_id ?? undefined,
    source: row.source ?? undefined,
    isProcessed: row.is_processed === true || row.is_processed === 1,
    transcript: [],
    usage: [],
  };
}

/**
 * Detail payload → Meeting. The backend's GET /meetings/{id} returns the meeting row
 * plus already-shaped `transcript` ({speaker,text,timestamp}) and `usage`
 * ({type,timestamp,question,answer,items}) arrays (see app/services/meetings.get_meeting).
 */
export function mapMeetingDetail(row: any): Meeting {
  const transcript: MeetingTranscriptLine[] = Array.isArray(row?.transcript)
    ? row.transcript.map((t: any) => ({
        speaker: t.speaker,
        text: t.text,
        timestamp: t.timestamp,
      }))
    : [];

  const usage: MeetingUsageEntry[] = Array.isArray(row?.usage)
    ? row.usage.map((u: any) => ({
        type: u.type,
        timestamp: u.timestamp,
        question: u.question ?? undefined,
        answer: u.answer ?? undefined,
        items: Array.isArray(u.items) ? u.items : undefined,
      }))
    : [];

  return { ...mapMeetingRow(row), transcript, usage };
}
