// electron/db/SupabaseReadService.ts
//
// Read-side counterpart to SupabaseMirrorService: when the project is
// configured AND a user is signed in, meetings data is read directly FROM
// Supabase (the cloud copy is authoritative across devices). Callers fall
// back to DatabaseManager (local SQLite) when Supabase is unavailable.
//
// RLS keyed off the Firebase uid means every SELECT is implicitly scoped to
// the signed-in user; we don't add an explicit user_id filter.
//
// Rows are mapped to the exact same `Meeting` shape that
// DatabaseManager.getRecentMeetings() / getMeetingDetails() return so the
// renderer is agnostic about the source.

import { SupabaseClientManager } from './SupabaseClient';
import { Meeting, formatDuration } from './DatabaseManager';

export class SupabaseReadService {
    /** True iff the project is configured AND a Firebase user is signed in. */
    static isAvailable(): boolean {
        return SupabaseClientManager.isConfigured();
    }

    /**
     * summary_json arrives as a parsed object from Supabase JSONB, but the
     * SQLite path stored it as a JSON string. Normalize both into an object.
     */
    private static parseSummary(summaryJson: any): any {
        if (!summaryJson) return {};
        if (typeof summaryJson === 'string') {
            try {
                return JSON.parse(summaryJson || '{}');
            } catch (e) {
                console.warn('[SupabaseReadService] Failed to parse summary_json string:', e);
                return {};
            }
        }
        return summaryJson;
    }

    /** Newest-first list view. Mirrors DatabaseManager.getRecentMeetings(). */
    static async getRecentMeetings(limit: number = 50): Promise<Meeting[]> {
        const client = SupabaseClientManager.getClient();
        if (!client) return [];

        const { data, error } = await client
            .from('meetings')
            .select('id, title, created_at, duration_ms, summary_json, calendar_event_id, source, is_processed')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;

        return (data ?? []).map((row: any) => {
            const summaryData = this.parseSummary(row.summary_json);

            return {
                id: row.id,
                title: row.title,
                date: row.created_at,
                duration: formatDuration(row.duration_ms),
                durationMs: row.duration_ms,
                summary: summaryData.legacySummary || '',
                detailedSummary: summaryData.detailedSummary,
                calendarEventId: row.calendar_event_id,
                source: row.source as any,
                isProcessed: row.is_processed === true || row.is_processed === 1,
                // List view stays light — no transcript/usage.
                transcript: [] as any[],
                usage: [] as any[]
            };
        });
    }

    /** Full detail view. Mirrors DatabaseManager.getMeetingDetails(). */
    static async getMeetingDetails(id: string): Promise<Meeting | null> {
        const client = SupabaseClientManager.getClient();
        if (!client) return null;

        const [meetingRes, transcriptRes, usageRes] = await Promise.all([
            client
                .from('meetings')
                .select('id, title, created_at, duration_ms, summary_json, calendar_event_id, source')
                .eq('id', id)
                .maybeSingle(),
            client
                .from('transcripts')
                .select('id, meeting_id, speaker, content, timestamp_ms')
                .eq('meeting_id', id)
                .order('timestamp_ms', { ascending: true }),
            client
                .from('ai_interactions')
                .select('id, meeting_id, type, timestamp, user_query, ai_response, metadata_json')
                .eq('meeting_id', id)
                .order('timestamp', { ascending: true })
        ]);

        if (meetingRes.error) throw meetingRes.error;
        if (transcriptRes.error) throw transcriptRes.error;
        if (usageRes.error) throw usageRes.error;

        const meetingRow = meetingRes.data as any;
        if (!meetingRow) return null;

        const summaryData = this.parseSummary(meetingRow.summary_json);

        const transcript = (transcriptRes.data ?? []).map((row: any) => ({
            speaker: row.speaker,
            text: row.content,
            timestamp: row.timestamp_ms
        }));

        const usage = (usageRes.data ?? []).map((row: any) => {
            let items: string[] | undefined;
            const answer = row.ai_response;

            if (row.metadata_json) {
                try {
                    // metadata_json is JSONB from Supabase (object/array) but a
                    // JSON string from SQLite — handle both.
                    const parsed = typeof row.metadata_json === 'string'
                        ? JSON.parse(row.metadata_json)
                        : row.metadata_json;
                    if (Array.isArray(parsed)) {
                        items = parsed;
                    }
                } catch (e) {
                    console.warn('[SupabaseReadService] Failed to parse metadata_json for interaction:', row?.id, e);
                }
            }

            return {
                type: row.type,
                timestamp: row.timestamp,
                question: row.user_query,
                answer: answer,
                items: items
            };
        });

        return {
            id: meetingRow.id,
            title: meetingRow.title,
            date: meetingRow.created_at,
            duration: formatDuration(meetingRow.duration_ms),
            durationMs: meetingRow.duration_ms,
            summary: summaryData.legacySummary || '',
            detailedSummary: summaryData.detailedSummary,
            calendarEventId: meetingRow.calendar_event_id,
            source: meetingRow.source,
            transcript: transcript,
            usage: usage
        };
    }
}
