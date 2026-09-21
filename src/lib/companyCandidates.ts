/**
 * Prospect-company detection from a calendar invite.
 *
 * Pure and dependency-free on purpose (no firebase / posthog / electron), so
 * BOTH the Sales Brief hook (useCompanyIntel) and the meeting-reminder popup
 * window — which must not load those modules — share one implementation
 * instead of two hand-synced copies.
 *
 * What counts as "our side" (excluded from candidates):
 *   1. The signed-in user's own domain (`opts.userEmail`) — authoritative.
 *   2. The domain of any attendee flagged `self` by the calendar provider.
 *   3. ONLY when neither of the above is known: the organizer's domain
 *      (legacy fallback for old cached events).
 * Every attendee on one of those domains is dropped — not just the organizer
 * or the `self` attendee — because teammates who join a prospect call to
 * practise or coach are not the prospect.
 *
 * The organizer field is deliberately NOT treated as "our side" when we can
 * anchor on the user: for inbound-booked meetings the *client* sends the
 * invite, and excluding the organizer's domain would then discard the very
 * company we want to research.
 */

import type { EventLike } from "@/types";

export interface CompanyCandidate {
    companyName: string;
    /** Registrable domain ("acme.com", "acme.co.uk") — what Tavily's
     * include_domains and the LinkedIn slug lookup want, rather than a
     * subdomain like "eu.acme.com". */
    domain: string;
    /** How many invitees resolve to this company — shown in the chooser. */
    attendeeCount: number;
}

export interface DerivedCompanies {
    /** Distinct external companies, most invitees first (ties keep invite order). */
    candidates: CompanyCandidate[];
    /** Registrable domains treated as "our side" and excluded. */
    internalDomains: string[];
}

const GENERIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
    "aol.com", "protonmail.com", "mail.com", "live.com", "me.com", "msn.com",
]);

/** Under a two-letter country TLD these labels form a public suffix
 * (co.uk, com.au, co.in, ac.jp …), so the registrable domain has three
 * labels, not two. A heuristic, not the full Public Suffix List. */
const SECOND_LEVEL_SUFFIX_LABELS: ReadonlySet<string> = new Set([
    "co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go",
]);

/** Google Calendar puts meeting rooms (resource.calendar.google.com) and
 * subscribed calendars (group.calendar.google.com) in the attendee list.
 * They are not people, and would otherwise surface a bogus "Google" company. */
const CALENDAR_SYSTEM_DOMAIN_SUFFIX = "calendar.google.com";

/** Lower-cased domain of an email address, or null if it isn't one. */
export function emailDomain(email: unknown): string | null {
    if (typeof email !== "string") return null;
    const raw = email.trim().toLowerCase();
    const at = raw.lastIndexOf("@");
    if (at < 1) return null;
    const domain = raw.slice(at + 1);
    return /^[^\s@.]+(\.[^\s@.]+)+$/u.test(domain) ? domain : null;
}

/** "eu.acme.com" → "acme.com"; "mail.acme.co.uk" → "acme.co.uk". */
export function registrableDomain(domain: string): string {
    const parts = domain.split(".");
    if (parts.length <= 2) return domain;
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    const keep = tld.length === 2 && SECOND_LEVEL_SUFFIX_LABELS.has(sld) ? 3 : 2;
    return parts.slice(-keep).join(".");
}

/** "acme.com" → "Acme"; "acme.co.uk" → "Acme". */
export function companyNameFromDomain(registrable: string): string {
    const slug = registrable.split(".")[0] ?? registrable;
    return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Best-effort company guess from a title like "Demo with Acme". */
export function companyNameFromTitle(title: string | null | undefined): string | null {
    const match = title?.match(/(?:with|@|–|-)\s+([A-Z][a-zA-Z0-9\s]+)/);
    return match ? match[1].trim() : null;
}

function isGenericOrSystemDomain(domain: string, root: string): boolean {
    return (
        GENERIC_EMAIL_DOMAINS.has(domain) ||
        GENERIC_EMAIL_DOMAINS.has(root) ||
        domain === CALENDAR_SYSTEM_DOMAIN_SUFFIX ||
        domain.endsWith(`.${CALENDAR_SYSTEM_DOMAIN_SUFFIX}`)
    );
}

export function deriveCompanyCandidates(
    event: EventLike,
    opts: { userEmail?: string | null } = {},
): DerivedCompanies {
    const attendees = event.attendees ?? [];

    // ── 1. Which domains are "our side"? ────────────────────────────────
    const internal = new Set<string>();
    let anchored = false;
    const addInternal = (email: unknown) => {
        const domain = emailDomain(email);
        if (!domain) return;
        anchored = true;
        internal.add(registrableDomain(domain));
    };
    addInternal(opts.userEmail);
    for (const a of attendees) if (a.self) addInternal(a.email);
    if (!anchored) {
        // Can't tell who "we" are — fall back to the organizer's domain.
        const orgDomain = emailDomain(event.organizer);
        if (orgDomain) internal.add(registrableDomain(orgDomain));
    }

    // ── 2. Group everyone else by company ───────────────────────────────
    const byRoot = new Map<string, { count: number; firstSeen: number }>();
    attendees.forEach((a, index) => {
        if (a.self) return;
        const domain = emailDomain(a.email);
        if (!domain) return;
        const root = registrableDomain(domain);
        if (isGenericOrSystemDomain(domain, root)) return;
        if (internal.has(root)) return;
        const entry = byRoot.get(root);
        if (entry) entry.count += 1;
        else byRoot.set(root, { count: 1, firstSeen: index });
    });

    const candidates = [...byRoot.entries()]
        .sort(([, a], [, b]) => b.count - a.count || a.firstSeen - b.firstSeen)
        .map(([root, { count }]) => ({
            companyName: companyNameFromDomain(root),
            domain: root,
            attendeeCount: count,
        }));

    return { candidates, internalDomains: [...internal] };
}

export interface ActiveCompany {
    /** More than one external company and none chosen yet: the caller must
     * ask the user and must NOT start generating anything. */
    awaitingSelection: boolean;
    selected: CompanyCandidate | null;
    companyName: string | null;
    domain: string | undefined;
}

/**
 * Which company should insights be generated for right now?
 *   0 candidates → the title-based guess (legacy behaviour, may be null)
 *   1 candidate  → that one, no question asked
 *   2+           → nothing until the user picks. The title guess is
 *                  deliberately ignored here: a guess must never pre-empt
 *                  the choice we're about to ask for.
 */
export function resolveActiveCompany(
    candidates: CompanyCandidate[],
    selectedIndex: number | null,
    titleFallbackName: string | null,
): ActiveCompany {
    if (candidates.length === 0) {
        return { awaitingSelection: false, selected: null, companyName: titleFallbackName, domain: undefined };
    }
    if (candidates.length === 1) {
        const only = candidates[0];
        return { awaitingSelection: false, selected: only, companyName: only.companyName, domain: only.domain };
    }
    const chosen = selectedIndex !== null ? candidates[selectedIndex] : undefined;
    if (!chosen) {
        return { awaitingSelection: true, selected: null, companyName: null, domain: undefined };
    }
    return { awaitingSelection: false, selected: chosen, companyName: chosen.companyName, domain: chosen.domain };
}