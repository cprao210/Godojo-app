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
import { AuthManager } from '../services/AuthManager';

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

    /** Fetch a single meeting's scorecard. Returns null if not found. */
    static async getMeetingScorecard(meetingId: string): Promise<any | null> {
        const client = SupabaseClientManager.getClient();
        if (!client) return null;

        const { data, error } = await client
            .from('meeting_scorecards')
            .select('scorecard_json')
            .eq('meeting_id', meetingId)
            .maybeSingle();

        if (error) throw error;
        if (!data) return null;

        return typeof data.scorecard_json === 'string'
            ? JSON.parse(data.scorecard_json)
            : data.scorecard_json;
    }

    /** Full detail view. Mirrors DatabaseManager.getMeetingDetails(). */
    static async getMeetingDetails(id: string): Promise<Meeting | null> {
        const client = SupabaseClientManager.getClient();
        if (!client) return null;

        const [meetingRes, transcriptRes, usageRes, scorecardRes] = await Promise.all([
            client
                .from('meetings')
                .select('id, title, created_at, duration_ms, summary_json, calendar_event_id, source')
                .eq('id', id)
                .maybeSingle(),
            client
                .from('transcripts')
                .select('id, meeting_id, speaker, content, timestamp_ms, speaker_index, display_name')
                .eq('meeting_id', id)
                .order('timestamp_ms', { ascending: true }),
            client
                .from('ai_interactions')
                .select('id, meeting_id, type, timestamp, user_query, ai_response, metadata_json')
                .eq('meeting_id', id)
                .order('timestamp', { ascending: true }),
            client
                .from('meeting_scorecards')       // ← NEW: 4th parallel query
                .select('scorecard_json')
                .eq('meeting_id', id)
                .maybeSingle()
        ]);

        if (meetingRes.error) throw meetingRes.error;
        if (transcriptRes.error) throw transcriptRes.error;
        if (usageRes.error) throw usageRes.error;
        // scorecardRes errors are non-fatal — a missing scorecard row is expected for
        // unscored meetings and should not prevent the rest of the details from loading.
        if (scorecardRes.error) {
            console.warn('[SupabaseReadService] getMeetingDetails: scorecard fetch failed (non-fatal):', scorecardRes.error);
        }

        const meetingRow = meetingRes.data as any;
        if (!meetingRow) return null;

        const summaryData = this.parseSummary(meetingRow.summary_json);

        // Attach scorecard from dedicated table, mirroring DatabaseManager behaviour.
        // This is the authoritative source; falls back to any scorecard already
        // embedded in summary_json.detailedSummary for legacy rows.
        if (!scorecardRes.error && scorecardRes.data) {
            const rawScorecard = scorecardRes.data.scorecard_json;
            const parsedScorecard = typeof rawScorecard === 'string'
                ? JSON.parse(rawScorecard)
                : rawScorecard;
            if (!summaryData.detailedSummary) summaryData.detailedSummary = {};
            summaryData.detailedSummary.scorecard = parsedScorecard;  // ← NEW: wired in
        }

        const transcript = (transcriptRes.data ?? []).map((row: any) => ({
            speaker: row.speaker,
            text: row.content,
            timestamp: row.timestamp_ms,
            speakerIndex: row.speaker_index ?? undefined,
            displayName: row.display_name ?? undefined
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

    /**
     * Company Context — read directly from Supabase (source of truth for the
     * Company Context settings screen). Falls back to null on any failure so
     * callers can fall back to the local SQLite cache.
     *
     * RLS scopes rows by auth.jwt() 'sub', but we still filter by user_id
     * explicitly to match the local DB's composite (user_id, id) key shape
     * and to be defensive if RLS is ever loosened.
     */
    static async getCompanyContext(): Promise<any | null> {
        const client = SupabaseClientManager.getClient();
        if (!client) return null;
        const uid = AuthManager.getInstance().getUid();
        if (!uid) return null;

        const [identityRes, assetsRes, personasRes, competitorsRes] = await Promise.all([
            client.from('company_context').select('*').eq('user_id', uid).eq('id', 1).maybeSingle(),
            client.from('company_assets').select('*').eq('user_id', uid).order('last_updated', { ascending: false }),
            client.from('company_personas').select('*').eq('user_id', uid).order('sort_order', { ascending: true }),
            client.from('company_competitors').select('*').eq('user_id', uid).order('sort_order', { ascending: true }),
        ]);

        if (identityRes.error) throw identityRes.error;
        const identity = identityRes.data as any;
        // No row on the cloud side (e.g. the user deleted it) — this is a
        // legitimate "no context" state, not a fallback-worthy failure.
        if (!identity) return null;

        if (assetsRes.error) throw assetsRes.error;
        if (personasRes.error) throw personasRes.error;
        if (competitorsRes.error) throw competitorsRes.error;

        const assets = assetsRes.data ?? [];
        const personas = personasRes.data ?? [];
        const competitors = competitorsRes.data ?? [];

        return {
            identity: {
                name: identity.name ?? '',
                website: identity.website ?? '',
                industry: identity.industry ?? '',
                personaEngineEnabled: !!identity.persona_engine_enabled,
            },
            coreValueProposition: identity.core_value_proposition ?? '',
            assets: assets.map((a: any) => ({
                id: a.id,
                type: a.type,
                label: a.label,
                status: a.status,
                lastUpdated: a.last_updated,
            })),
            targetPersonas: personas.map((p: any) => ({
                id: p.id,
                role: p.role,
                description: p.description ?? '',
            })),
            competitors: competitors.map((c: any) => ({
                id: c.id,
                name: c.name,
                moat: c.moat ?? '',
                winRate: c.win_rate ?? 0,
            })),
            dataCompleteness: identity.data_completeness ?? 0,
            completenessBreakdown: {
                hasIdentity: !!(identity.name && identity.industry),
                hasValueProp: (identity.core_value_proposition ?? '').trim().length > 20,
                hasAssets: assets.some((a: any) => a.status === 'mapped'),
                hasPersonaEngine: !!identity.persona_engine_enabled,
            },
        };
    }
}