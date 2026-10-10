// Rules for what must never be sent to Supabase. Shared by every path that
// mirrors local rows — the live mirror (SupabaseMirrorService), the one-time
// backfill (SupabaseBackfill) and the startup gap audit (SupabaseSyncAudit) —
// so they cannot drift apart again (the audit once kept sending owner_uid
// after the backfill had learned to strip it, and every meetings upsert it
// queued was rejected).

/**
 * Columns that exist locally (SQLite) but not in the Supabase schema.
 * PostgREST rejects a whole upsert if any column is unrecognized (PGRST204).
 * TODO(supabase): delete an entry once that column is added to the cloud schema.
 */
export const LOCAL_ONLY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
    meetings: ['meeting_types', 'owner_uid'],
};

/**
 * Meeting ids that are local bookkeeping, never real meetings. RAGManager
 * inserts 'live-meeting-current' during a call purely to satisfy the chunks
 * table's FK; it is deleted when the call ends but survives a crash.
 */
export const LOCAL_ONLY_MEETING_IDS: ReadonlySet<string> = new Set(['live-meeting-current']);

/** Tables whose rows belong to a meeting via a meeting_id column. */
const MEETING_CHILD_TABLES: ReadonlySet<string> = new Set(['transcripts', 'ai_interactions', 'chunks', 'chunk_summaries', 'embedding_queue']);

/** Copy of `row` without the columns Supabase doesn't have. */
export function stripLocalOnlyColumns(table: string, row: Record<string, any>): Record<string, any> {
    const drop = LOCAL_ONLY_COLUMNS[table];
    if (!drop) return row;
    const clean = { ...row };
    for (const col of drop) delete clean[col];
    return clean;
}

/** True for the live placeholder meeting and any row that belongs to it. */
export function isLocalOnlyRow(table: string, row: Record<string, any> | null | undefined): boolean {
    if (!row) return false;
    const meetingId = table === 'meetings' ? row.id : row.meeting_id;
    return typeof meetingId === 'string' && LOCAL_ONLY_MEETING_IDS.has(meetingId);
}

/**
 * SQL WHERE fragment (with its bind values) that excludes local-only rows
 * from a SELECT on `table`. Tables without a meeting link get no filter.
 */
export function localOnlyRowFilter(table: string): { sql: string; params: string[] } {
    const ids = [...LOCAL_ONLY_MEETING_IDS];
    const marks = ids.map(() => '?').join(', ');
    if (table === 'meetings') return { sql: `id NOT IN (${marks})`, params: ids };
    if (MEETING_CHILD_TABLES.has(table)) return { sql: `(meeting_id IS NULL OR meeting_id NOT IN (${marks}))`, params: ids };
    return { sql: '1 = 1', params: [] };
}

