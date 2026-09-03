// Pure backend-row → Meeting mappers for the HTTP path, plus the pure list
// semantics both meeting lists share (what counts as "processing", which copy of
// a meeting wins when two sources disagree, how a refetch folds over what's
// already on screen). Kept dependency-free so it's unit-testable and so the
// renderer's HTTP path and its IPC path can't drift on these rules.
//
// NOTE: this mirrors electron/db/SupabaseReadService.ts (the main-process/IPC path).
// The renderer can't import from electron/ (it would drag node/electron deps into the
// browser bundle) and vice-versa, so the mapping is intentionally duplicated. Keep the
// two in sync: column renames (created_at→date, duration_ms→duration), the
// summary_json {legacySummary, detailedSummary} split, and the is_processed coercion.

import { Meeting, MeetingTranscriptLine, MeetingUsageEntry } from "@/types";

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

/**
 * Title MeetingPersistence writes on the synchronous placeholder row it saves
 * the instant a call ends (see stopMeeting / uploadTranscript). Exported so the
 * renderer never has to hard-code the string in more than one place.
 */
export const PROCESSING_TITLE = "Processing...";

/**
 * True while a meeting's transcript/summary/scorecard are still being generated.
 *
 * `isProcessed === false` is the authoritative signal — MeetingPersistence saves
 * the placeholder row with is_processed = 0 and only flips it to 1 after the
 * final save lands. The title check stays as a fallback for the two cases the
 * flag alone misses: the renderer-side optimistic placeholder (inserted before
 * any DB row exists) and legacy rows written before is_processed existed.
 *
 * Use this instead of comparing `title === 'Processing...'` — a calendar meeting
 * carries its real title from the first save, so a title-only check renders it
 * as a finished meeting while its summary is still being generated.
 */
export function isMeetingProcessing(m: Pick<Meeting, "isProcessed" | "title">): boolean {
  return m.isProcessed === false || m.title === PROCESSING_TITLE;
}

/**
 * How far back a locally-known meeting the backend hasn't listed yet is still
 * trusted. Covers the SQLite → Supabase mirror lag window: without it a meeting
 * VANISHES from the list at the exact moment it finishes processing locally (it
 * stops qualifying as "still processing") and only reappears once the mirror
 * catches up.
 */
export const LOCAL_MERGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Should a local SQLite row the backend list doesn't contain be shown anyway?
 *
 * Single rule for local-over-backend precedence, shared by the HTTP list merge
 * (meetingsApi.list) and the post-call local seed (useLauncher.mergeLocalMeetings)
 * so the two can't disagree about which rows are safe to surface. Bounded rather
 * than unconditional so the local DB can't resurrect history deleted on another
 * device for longer than the mirror lag.
 */
export function shouldMergeLocalMeeting(
  m: Pick<Meeting, "isProcessed" | "title" | "date">,
): boolean {
  if (isMeetingProcessing(m)) return true;
  const createdAt = new Date(m.date).getTime();
  return !Number.isNaN(createdAt) && Date.now() - createdAt < LOCAL_MERGE_WINDOW_MS;
}

/**
 * Reconcile two copies of the same meeting that arrived from different sources.
 *
 * A meeting only ever moves processing → processed. Nothing moves it back: the
 * final save in MeetingPersistence sets is_processed = 1, and regenerateSummary
 * rewrites summary_json without touching the flag. So when two copies disagree,
 * the processed one is the fresher read and the processing one is stale —
 * virtually always the Supabase mirror still serving the placeholder row that
 * local SQLite has already replaced.
 *
 * Letting the stale copy win is what made a finished card revert to its
 * processing state a few seconds after showing its real title, then flip
 * forward again once the mirror caught up.
 *
 * `known` wins field-by-field when it's the processed copy; `incoming` fills in
 * anything `known` doesn't carry. Returns `incoming` by reference when there's
 * nothing to repair, so callers can use identity to detect a change.
 */
export function mergeMeetingCopies(incoming: Meeting, known: Meeting): Meeting {
  if (isMeetingProcessing(incoming) && !isMeetingProcessing(known)) {
    return { ...incoming, ...known };
  }
  return incoming;
}

/** Newest first — the order the Recent Meetings list renders in. */
export const byNewestFirst = (a: Meeting, b: Meeting) =>
  new Date(b.date).getTime() - new Date(a.date).getTime();

/**
 * Id of the renderer-only card shown between "user hit End" and "main has
 * committed a row for this call". Fixed rather than timestamped so inserting it
 * is idempotent and the live-call-ended handler can patch exactly one row.
 */
export const OPTIMISTIC_LIVE_ID = "optimistic-live-call";

/** Renderer-invented row that no backend/DB list can possibly return yet. */
export const isOptimisticId = (id: string) => id.startsWith("optimistic-");

/**
 * How long an optimistic card may survive on its own. It exists only to cover
 * the gap until main commits a real row; if that never happens (finalization
 * crashed), it must not linger on the list forever.
 */
export const OPTIMISTIC_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * Fold a freshly fetched list over the one already on screen.
 *
 * Two jobs, both about a refetch not being allowed to move the UI backwards:
 *
 * 1. A row that's already processed stays processed (see mergeMeetingCopies) —
 *    this is what stops the flip-flop between the real title and the processing
 *    state while the Supabase mirror catches up with local SQLite.
 * 2. The optimistic card survives. By definition no list contains it, so a plain
 *    `useQuery` result would wipe the card covering the call that just ended. It
 *    is retired the moment a real processing row appears (the row it stood in
 *    for), and it ages out so a failed finalization can't leave it stranded.
 *
 * Returns `fresh` by reference when there's nothing to carry over.
 */
export function reconcileFetchedMeetings(previous: Meeting[], fresh: Meeting[]): Meeting[] {
  if (previous.length === 0) return fresh;

  const knownById = new Map(previous.map((m) => [m.id, m]));
  let repaired = false;
  const merged = fresh.map((row) => {
    const known = knownById.get(row.id);
    if (!known) return row;
    const next = mergeMeetingCopies(row, known);
    if (next !== row) repaired = true;
    return next;
  });

  const hasRealProcessingRow = merged.some(
    (m) => !isOptimisticId(m.id) && isMeetingProcessing(m),
  );
  const carried = hasRealProcessingRow
    ? []
    : previous.filter(
      (m) =>
        isOptimisticId(m.id) &&
        Date.now() - new Date(m.date).getTime() < OPTIMISTIC_MAX_AGE_MS,
    );

  if (carried.length === 0) return repaired ? merged : fresh;
  return [...carried, ...merged].sort(byNewestFirst);
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
    calendarEventMetadata: row.calendar_event_metadata ?? undefined,
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
