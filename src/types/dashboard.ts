export type DashboardPeriod =
    | "last_1_day" | "last_5_days" | "last_week" | "last_2_weeks"
    | "last_30_days" | "last_quarter" | "last_year";

export interface DashboardActiveMember { user_id: string; name: string; email: string; image: string; role: string; status: string; joined_at: string; calls: number; avg_score: number; }
export interface DashboardRecentCall { meeting_id: string; user_id: string; title: string; start_time: number; duration_ms: number; }
export interface DashboardTrendPoint { label: string; avg_score: number; }
export interface DashboardObjection { category: string; count: number; }
export interface DashboardPerformer { user_id: string; name: string; image: string | null; avg_score: number; call_count: number; }

export interface DashboardResponse {
    tenant_id: string;
    period: DashboardPeriod;
    period_start_ms: number;
    active_members_count: number;
    active_members: DashboardActiveMember[];
    total_calls: number;
    team_avg_score: number;
    recent_calls: DashboardRecentCall[];
    trend_mode: string;
    trend: DashboardTrendPoint[];
    top_objections: DashboardObjection[];
    total_objections: number;
    top_performers: DashboardPerformer[];
    lowest_performers: DashboardPerformer[];
}