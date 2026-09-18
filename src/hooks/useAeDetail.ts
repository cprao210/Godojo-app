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

// How many of the AE's meetings the backend returns per page of "Recent
// calls". Pagination is server-side: each page change triggers a fresh GET
// with a new meeting_offset (the AE detail route speaks raw offset/limit,
// unlike listMembers' page/limit). The response carries calls_total +
// pagination.has_more so the footer can render "x to y of N".
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
    // ── "Recent calls" pagination (server-side) ──────────────────────────────
    // Page 1 doubles as the initial detail fetch; changing the page re-runs
    // the same GET with a shifted meeting_offset. The gauge/strengths cards
    // only need page 1's aggregate data, and since those aggregates are
    // all-time on the backend, every page returns identical values for them —
    // we simply stop re-rendering them from a stale page.
    const [callsPage, setCallsPage] = useState(1);
    // ── Detail fetch (GET /tenants/:tenant_id/members/:user_id) ─────────────
    const [detail, setDetail] = useState<MemberDetail | null>(null);
    const [isLoadingDetail, setIsLoadingDetail] = useState(false);
    // Distinguishes "first load for this AE" (skeletons) from "paging to
    // another page of calls" (keep the old rows visible, just dimmed).
    const [isPaging, setIsPaging] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);

    // Opening a different AE (or closing the panel) resets both the cached
    // detail and the page cursor — otherwise the new AE would inherit the
    // previous one's offset and could land past their last page.
    useEffect(() => {
        setCallsPage(1);
        setDetail(null);
        setDetailError(null);
    }, [ae?.userId, tenantId]);

    useEffect(() => {
        if (!ae || !tenantId) {
            setDetail(null);
            setDetailError(null);
            setIsPaging(false);
            return;
        }
        let cancelled = false;
        // First paint for this AE gets skeletons; page flips keep the
        // previous page's rows on screen instead.
        setIsPaging(detail !== null);
        if (detail === null) setIsLoadingDetail(true);
        setDetailError(null);
        tenantsApi
            .getMember(tenantId, ae.userId, {
                meetingOffset: (callsPage - 1) * AE_CALLS_PAGE_SIZE,
                meetingLimit: AE_CALLS_PAGE_SIZE,
            })
            .then((data) => {
                if (cancelled) return;
                setDetail(data);
                setIsLoadingDetail(false);
                setIsPaging(false);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setDetailError(err instanceof ApiError ? err.message : "Failed to load AE detail.");
                setIsLoadingDetail(false);
                setIsPaging(false);
            });
        return () => {
            cancelled = true;
        };
        // Re-fetch whenever a different AE (or tenant) is opened, or the
        // requested page of calls changes. `detail` is read (not tracked) to
        // decide skeleton vs soft-refresh, hence the eslint disable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ae?.userId, tenantId, callsPage]);

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

    // ── Pagination math, straight from the server's numbers ──────────────────
    // calls_total is the AE's all-time meeting count, so totalPages is stable
    // across pages; has_more from the current response is the tie-breaker if
    // a meeting lands between two page fetches.
    const callsTotal = detail?.calls_total ?? 0;
    const offset = detail?.pagination.offset ?? (callsPage - 1) * AE_CALLS_PAGE_SIZE;
    const hasMore = detail?.pagination.has_more ?? false;
    const callsTotalPages = Math.max(1, Math.ceil(callsTotal / AE_CALLS_PAGE_SIZE));
    // A narrower response (calls deleted mid-session) can leave callsPage
    // pointing past the last page — clamp so the footer never claims an
    // impossible range.
    const safeCallsPage = Math.min(callsPage, callsTotalPages);
    const callsRangeStart = recentCalls.length === 0 ? 0 : offset + 1;
    const callsRangeEnd = offset + recentCalls.length;

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
        isPaging,
        detailError,
        displayName,
        displayRole,
        displayCalls,
        displayScore,
        dimensions,
        strengthsAndGaps,
        recentCalls,
        recentCallsPage: recentCalls,
        pagedCalls: recentCalls,
        callsPage: safeCallsPage,
        setCallsPage,
        callsTotalPages,
        callsRangeStart,
        callsRangeEnd,
        callsTotal,
        hasMore,
        sparkline,
        selectedMeeting,
        setSelectedMeeting,
        handleSelectCall,
    };
}
