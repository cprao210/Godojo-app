// Durable meeting → company linking, shared by every surface that associates a
// company OUTSIDE the CompanySelectModal (today: the transcript-upload flow).
//
// Why this exists: a meeting id handed back by MeetingPersistence
// (stopMeeting / uploadTranscript) only proves the LOCAL SQLite row was
// written. The FastAPI/Supabase row — the one PUT /meetings/:id/company needs
// — lands later, when SupabaseMirrorService's outbox drains, and the backend
// correctly answers 404 until then (data_service.set_meeting_company re-selects
// the meeting and raises NotFoundError). App.tsx's post-call prompt already
// waits for 'meeting-backend-ready' for exactly this reason; this module gives
// the upload path the same guarantee, plus retries, a crash-safe queue and
// cache reconciliation.

import type { QueryClient } from "react-query";
import { meetingsApi } from "@/api";
import { ApiError } from "@/lib/apiClient";
import type { CompanyRef, Meeting, PickedCompany } from "@/types";

const ROW_READY_TIMEOUT_MS = 45_000;
const ROW_READY_POLL_MS = 1_500;
const LINK_ATTEMPTS = 4;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** PickedCompany → PUT body. The backend's MeetingCompanyAssociate validator
 * REJECTS company_id and name together, so this is strictly either/or. */
export function companyPayload(picked: PickedCompany): {
    company_id?: string;
    name?: string;
    domain?: string;
} {
    if (picked.companyId) return { company_id: picked.companyId };
    return { name: picked.name, ...(picked.domain ? { domain: picked.domain } : {}) };
}

/**
 * Resolves once GET /meetings/:id answers for this id (the mirror landed the
 * row), or false on timeout.
 *
 * Two racing signals: 'meeting-backend-ready' is the fast path (main.ts bridges
 * SupabaseMirrorService's 'meeting-synced'), and the poll covers a missed
 * event, a web build with no electronAPI, or a row that synced before this
 * listener was attached.
 */
export function waitForMeetingRow(
    meetingId: string,
    timeoutMs: number = ROW_READY_TIMEOUT_MS,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let settled = false;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        let offReady: (() => void) | undefined;
        const timeout = setTimeout(() => finish(false), timeoutMs);

        function finish(ok: boolean) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (pollTimer) clearTimeout(pollTimer);
            try { offReady?.(); } catch { /* listener already gone */ }
            resolve(ok);
        }

        try {
            offReady = window.electronAPI?.onMeetingBackendReady?.(({ meetingId: id }) => {
                if (id === meetingId) finish(true);
            });
        } catch {
            // Non-Electron build — the poll below is the only path.
        }

        const tick = async () => {
            try {
                await meetingsApi.get(meetingId);
                finish(true);
                return;
            } catch {
                // 404 while the mirror drains is the expected case here.
            }
            if (!settled) pollTimer = setTimeout(tick, ROW_READY_POLL_MS);
        };
        void tick();
    });
}

/**
 * Link a company to a meeting that may not exist on the backend yet.
 *
 * Retries 404 (row not mirrored / read replica lag) and 5xx. A 403 is thrown
 * straight through — that's the scope guard in set_meeting_company, and
 * retrying it would never succeed.
 */
export async function linkMeetingCompany(
    meetingId: string,
    picked: PickedCompany,
    opts?: { timeoutMs?: number; skipWait?: boolean },
): Promise<CompanyRef> {
    if (!opts?.skipWait) await waitForMeetingRow(meetingId, opts?.timeoutMs);

    let lastError: unknown;
    for (let attempt = 0; attempt < LINK_ATTEMPTS; attempt++) {
        try {
            return await meetingsApi.setCompany(meetingId, companyPayload(picked));
        } catch (e) {
            lastError = e;
            const status = e instanceof ApiError ? e.status : 0;
            const retryable = status === 0 || status === 404 || status === 409 || status >= 500;
            if (!retryable) throw e;
            await delay(1_000 * 2 ** attempt);
        }
    }
    throw lastError;
}

/**
 * Single place that teaches every meetings cache about an association.
 * Optimistic patch + invalidate — the same pair MeetingDetails.tsx's edit
 * modal does, which is what the upload path was missing entirely.
 */
export function applyCompanyToCaches(
    queryClient: QueryClient,
    meetingId: string,
    company: CompanyRef | null,
): void {
    queryClient.setQueryData<Meeting | undefined>(["meeting", meetingId], (prev) =>
        prev ? { ...prev, company, company_skipped: company ? false : prev.company_skipped } : prev,
    );
    queryClient.setQueryData<CompanyRef | null>(["meeting-company", meetingId], company);
    queryClient.setQueryData<Meeting[]>(["meetings"], (prev = []) =>
        prev.map((m) =>
            m.id === meetingId
                ? { ...m, company, company_skipped: company ? false : m.company_skipped }
                : m,
        ),
    );
    void queryClient.invalidateQueries(["meeting", meetingId]);
    void queryClient.invalidateQueries(["meetings"]);
}

// ── Crash-safe pending queue ────────────────────────────────────────────────
// The wait-then-PUT above lives entirely in memory. Quitting the app during
// the mirror window (or a renderer reload) would drop the association with no
// record of it anywhere — the user picked a company and it evaporated. The
// queue makes the intent survive a restart; flushPendingLinks drains it.

const PENDING_KEY = "godojo.pendingCompanyLinks";
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingLink {
    meetingId: string;
    company: PickedCompany;
    queuedAt: number;
}

export function readPendingLinks(): PendingLink[] {
    try {
        const raw = window.localStorage.getItem(PENDING_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        const cutoff = Date.now() - PENDING_TTL_MS;
        return parsed.filter(
            (l): l is PendingLink =>
                !!l?.meetingId && !!l?.company?.name && (l.queuedAt ?? 0) > cutoff,
        );
    } catch {
        return [];
    }
}

function writePendingLinks(links: PendingLink[]): void {
    try {
        window.localStorage.setItem(PENDING_KEY, JSON.stringify(links));
    } catch {
        // Quota/private mode — the in-memory attempt still runs.
    }
}

export function rememberPendingLink(meetingId: string, company: PickedCompany): void {
    const next = readPendingLinks().filter((l) => l.meetingId !== meetingId);
    next.push({ meetingId, company, queuedAt: Date.now() });
    writePendingLinks(next);
}

export function forgetPendingLink(meetingId: string): void {
    writePendingLinks(readPendingLinks().filter((l) => l.meetingId !== meetingId));
}

/**
 * Retry every association that never completed, on launcher mount.
 *
 * Deliberately skips the row wait (skipWait): anything still queued from a
 * previous session has long since mirrored, and a 404 here means the meeting
 * was deleted — drop it rather than hold the entry forever.
 */
export async function flushPendingLinks(queryClient: QueryClient): Promise<void> {
    for (const pending of readPendingLinks()) {
        try {
            const saved = await linkMeetingCompany(pending.meetingId, pending.company, {
                skipWait: true,
            });
            applyCompanyToCaches(queryClient, pending.meetingId, saved);
            forgetPendingLink(pending.meetingId);
        } catch (e) {
            const status = e instanceof ApiError ? e.status : 0;
            // 404 = meeting gone, 403 = scope guard refused it. Neither is
            // recoverable by retrying on the next launch.
            if (status === 404 || status === 403) forgetPendingLink(pending.meetingId);
            else console.warn("[companyAssociation] pending link still failing:", e);
        }
    }
}