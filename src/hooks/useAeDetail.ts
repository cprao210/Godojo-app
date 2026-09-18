// State + data-fetching layer for AeDetailView: owns the member-detail fetch
// (GET /tenants/:tenant_id/members/:user_id), maps the raw API shape into the
// presentational props the gauge/list components expect, and owns the
// "open a past call" modal selection. Kept separate from the component so it
// only owns rendering — same split as useManagerDashboard.

import { useEffect, useState } from "react";
import { Briefcase, Search, Target, MessageCircle, Handshake, Radio, type LucideIcon } from "lucide-react";
import { tenantsApi } from "@/api";
import { ApiError } from "@/lib/apiClient";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";
import {
    AeSummary,
    Meeting,
    DimensionScore,
    StrengthOrGap,
    RecentCall,
    MemberDetail,
    MemberDetailRadarScores,
    MemberDetailRecentCall,
} from "@/types";

// How many of the AE's meetings are shown per page in the "Recent calls"
// list on their profile. Pagination here is client-side, over whatever
// `recent_calls` the member-detail endpoint returns — see the note on
// `useAeDetail` below.
export const AE_CALLS_PAGE_SIZE = 10;

// ─── Dimension metadata (icon/color per radar_scores key) ──────────────────
// Order here drives the order the segments are drawn in on the gauge.
const DIMENSION_META: { key: keyof MemberDetailRadarScores; label: string; icon: LucideIcon; color: string; ring: string }[] = [
    { key: "MEDDICC", label: "MEDDICC", icon: Briefcase, color: "#7c3aed", ring: "#a78bfa" },
    { key: "Discovery", label: "Discovery", icon: Search, color: "#7c5cf0", ring: "#a5b4fc" },
    { key: "BANT", label: "BANT", icon: Target, color: "#4f7fee", ring: "#93c5fd" },
    { key: "Objections", label: "Objections", icon: MessageCircle, color: "#22b8cf", ring: "#67e8f9" },
    { key: "Closing", label: "Closing", icon: Handshake, color: "#14b88f", ring: "#6ee7b7" },
    { key: "Signals", label: "Signals", icon: Radio, color: "#22c55e", ring: "#86efac" },
];

function dimensionsFromRadarScores(radar: MemberDetailRadarScores): DimensionScore[] {
    return DIMENSION_META.map((d) => ({
        key: d.key,
        label: d.label,
        score: Math.round(radar[d.key] ?? 0),
        icon: d.icon,
        color: d.color,
        ring: d.ring,
    }));
}

function strengthsAndGapsFrom(detail: MemberDetail): StrengthOrGap[] {
    const items: StrengthOrGap[] = detail.strengths.map((s) => ({
        title: s.title,
        description: s.description,
        tag: "Strength",
    }));
    if (detail.weakest_area) {
        items.push({
            title: `${detail.weakest_area} needs focus`,
            description: `${detail.weakest_area} is the lowest-scoring dimension across recent calls.`,
            tag: "Opportunity",
        });
    }
    return items;
}

function formatCallMeta(startTimeMs: number): string {
    const d = new Date(startTimeMs);
    const datePart = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${datePart} · ${timePart}`;
}

function recentCallsFrom(detail: MemberDetail): RecentCall[] {
    return detail.recent_calls.map((c) => ({
        meetingId: c.meeting_id,
        title: c.title,
        meta: formatCallMeta(c.start_time),
        highlight: c.highlight || "—",
        score: c.score,
    }));
}

// Builds a minimal placeholder Meeting so MeetingDetails can paint instantly
// (title/date) while its own useQuery (meetingsApi.get) fetches the full
// record — same "list row as initialData" pattern Launcher/MeetingDetails use.
function placeholderMeetingFromCall(c: MemberDetailRecentCall): Meeting {
    return {
        id: c.meeting_id,
        title: c.title,
        date: new Date(c.start_time).toISOString(),
        duration: "",
        summary: "",
    };
}

interface UseAeDetailArgs {
    ae: AeSummary | null;
    tenantId: string | null;
}

export function useAeDetail({ ae, tenantId }: UseAeDetailArgs) {
    // ── Detail fetch (GET /tenants/:tenant_id/members/:user_id) ─────────────
    const [detail, setDetail] = useState<MemberDetail | null>(null);
    const [isLoadingDetail, setIsLoadingDetail] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);

    useEffect(() => {
        if (!ae || !tenantId) {
            setDetail(null);
            setDetailError(null);
            return;
        }
        let cancelled = false;
        setIsLoadingDetail(true);
        setDetailError(null);
        setDetail(null);
        tenantsApi
            .getMember(tenantId, ae.userId)
            .then((data) => {
                if (!cancelled) setDetail(data);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setDetailError(err instanceof ApiError ? err.message : "Failed to load AE detail.");
            })
            .finally(() => {
                if (!cancelled) setIsLoadingDetail(false);
            });
        return () => {
            cancelled = true;
        };
        // Re-fetch whenever a different AE (or tenant) is opened.
    }, [ae?.userId, tenantId]);

    // Prefer live detail once it's back; fall back to the dashboard summary
    // (name/role/calls/score) so the header paints instantly on open.
    const displayName = detail?.name ?? ae?.name ?? "";
    const displayRole = ae?.role ?? (detail?.role === "admin" ? "Admin" : "Member");
    const displayCalls = detail?.calls_total ?? ae?.calls ?? 0;
    const displayScore = detail?.avg_score ?? ae?.score ?? 0;

    const dimensions = detail ? dimensionsFromRadarScores(detail.radar_scores) : [];
    const strengthsAndGaps = detail ? strengthsAndGapsFrom(detail) : [];
    const recentCalls = detail ? recentCallsFrom(detail) : [];
    const sparkline = recentCalls.map((c) => c.score).reverse();

    // ── "Recent calls" pagination (client-side, over the array the member-
    // detail endpoint already returned) ──────────────────────────────────
    // NOTE: the backend's GET /tenants/:tenant_id/members/:user_id route
    // doesn't currently take a page/limit for recent_calls (unlike
    // listMembers, which does) — it hands back whatever it considers
    // "recent". This paginates that array so the admin can page through it
    // instead of scrolling one long list; if the backend caps recent_calls
    // itself (e.g. only ever sends the last N), this can't surface calls
    // beyond that cap until the route grows its own pagination.
    const [callsPage, setCallsPage] = useState(1);

    // Re-fetching a different AE, or the list getting shorter (e.g. a
    // narrower detail response) than the page we were on — snap back to
    // page 1 rather than landing on an empty page.
    useEffect(() => {
        setCallsPage(1);
    }, [ae?.userId]);

    const callsTotalPages = Math.max(1, Math.ceil(recentCalls.length / AE_CALLS_PAGE_SIZE));
    const safeCallsPage = Math.min(callsPage, callsTotalPages);
    const callsRangeStart = recentCalls.length === 0 ? 0 : (safeCallsPage - 1) * AE_CALLS_PAGE_SIZE + 1;
    const callsRangeEnd = Math.min(safeCallsPage * AE_CALLS_PAGE_SIZE, recentCalls.length);
    const pagedCalls = recentCalls.slice((safeCallsPage - 1) * AE_CALLS_PAGE_SIZE, safeCallsPage * AE_CALLS_PAGE_SIZE);

    // ── Post-call analysis (opens the same MeetingDetails view used elsewhere) ─
    const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);

    // Reset the open call whenever a different AE is opened / the panel closes.
    useEffect(() => {
        setSelectedMeeting(null);
    }, [ae?.userId]);

    const handleSelectCall = (call: RecentCall) => {
        const raw = detail?.recent_calls.find((c) => c.meeting_id === call.meetingId);
        if (!raw) return;
        posthogAnalytics.trackAeMeetingView();
        setSelectedMeeting(placeholderMeetingFromCall(raw));
    };

    return {
        detail,
        isLoadingDetail,
        detailError,
        displayName,
        displayRole,
        displayCalls,
        displayScore,
        dimensions,
        strengthsAndGaps,
        recentCalls,
        pagedCalls,
        callsPage: safeCallsPage,
        setCallsPage,
        callsTotalPages,
        callsRangeStart,
        callsRangeEnd,
        sparkline,
        selectedMeeting,
        setSelectedMeeting,
        handleSelectCall,
    };
}