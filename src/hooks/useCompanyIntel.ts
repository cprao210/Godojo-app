// Data layer for the "Sales Brief" panel: derives a prospect company from a
// calendar event's attendees, fetches Tavily-backed company intelligence for
// it, and exposes clipboard/URL helpers the panel's UI needs. Kept separate
// from SalesBriefPanel.tsx so the component only owns rendering.

import { useCallback, useEffect, useMemo, useState } from "react";
import { guardSession } from "@/lib/firebase";
import { CompanyIntel, EventLike } from "@/types";

const GENERIC_EMAIL_DOMAINS = new Set([
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
    "aol.com", "protonmail.com", "mail.com", "live.com", "me.com", "msn.com",
]);

/** Cycled while a fetch is in flight to show the user what's happening. */
export const LOADING_STAGES = [
    { icon: "🔍", text: "Searching company data..." },
    { icon: "📰", text: "Fetching latest news..." },
    { icon: "💰", text: "Pulling funding intelligence..." },
    { icon: "🧠", text: "Structuring insights..." },
];

/** True for any populated, non-placeholder value the backend may return
 * (guards against the literal strings "null"/"N/A" some sources send). */
export const hasValue = (value: unknown): boolean =>
    value !== null && value !== undefined && value !== "" && value !== "null" && value !== "N/A";

/**
 * Returns `value` itself when it passes `hasValue()`'s checks, otherwise `null`.
 *
 * Use this — not `hasValue` — anywhere the *value* needs to be rendered via a
 * `pickValue(x) || fallback` pattern (e.g. `{pickValue(intel.industry) || '—'}`).
 * `hasValue` only ever returns `true`/`false`, so using it in that pattern
 * renders the literal boolean `true` instead of the real value whenever data
 * is present. Reserve `hasValue` for boolean guards (`hasValue(x) && <JSX/>`).
 */
export function pickValue<T>(value: T | null | undefined): T | null {
    return hasValue(value) ? (value as T) : null;
}

/** True when the fetched intel has no meaningful fields to show at all. */
export function isIntelEmpty(intel: CompanyIntel): boolean {
    return (
        !hasValue(intel.industry) &&
        !hasValue(intel.revenue) &&
        !hasValue(intel.valuation) &&
        !hasValue(intel.fundingStage) &&
        !hasValue(intel.businessModel) &&
        !hasValue(intel.employeeCount) &&
        !hasValue(intel.headquarters) &&
        !intel.keyProducts?.length &&
        !intel.competitors?.length &&
        !intel.recentNews?.length
    );
}

/** Capitalized company name guessed from a work email's domain, or null for
 * personal/generic providers (gmail, yahoo, etc.) where the domain isn't a company. */
function companyFromEmail(email: string): string | null {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || GENERIC_EMAIL_DOMAINS.has(domain)) return null;
    const parts = domain.split(".");
    const slug = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Best-effort company + domain guess: prefers the first external attendee on
 * a non-generic domain, then falls back to parsing the meeting title. */
function deriveCompany(eventData: EventLike): { companyName: string | null; domain: string | undefined } {
    const attendees = eventData.attendees ?? [];
    const orgDomain = eventData.organizer?.split("@")[1]?.toLowerCase() ?? "";

    const externalAttendees = attendees.filter((a) => {
        const d = a.email.split("@")[1]?.toLowerCase() ?? "";
        return d && d !== orgDomain;
    });

    for (const attendee of externalAttendees) {
        const name = companyFromEmail(attendee.email);
        if (name) return { companyName: name, domain: attendee.email.split("@")[1] };
    }

    const titleMatch = eventData.title?.match(/(?:with|@|–|-)\s+([A-Z][a-zA-Z0-9\s]+)/);
    if (titleMatch) return { companyName: titleMatch[1].trim(), domain: undefined };

    return { companyName: null, domain: undefined };
}

/** Formats fetched intel as a shareable plain-text summary. */
function buildClipboardText(intel: CompanyIntel, fallbackName: string | null): string {
    const lines: string[] = [];
    const add = (label: string, value: unknown) => {
        if (hasValue(value)) lines.push(`${label}: ${value}`);
    };
    const addList = (label: string, items: string[] | null | undefined) => {
        if (items?.length) lines.push(`${label}: ${items.join(", ")}`);
    };
    const section = (title: string) => lines.push("", `── ${title} ──`);

    lines.push(hasValue(intel.companyName) ? intel.companyName : fallbackName ?? "");
    if (hasValue(intel.website)) lines.push(intel.website!.replace(/^https?:\/\//, "").split("/")[0]);
    lines.push("");

    section("Company Profile");
    add("Industry", intel.industry);
    add("Founded", intel.foundedYear);
    add("Age", hasValue(intel.companyAge) ? `${intel.companyAge} years` : null);
    add("Employees", intel.employeeCount);
    add("Headquarters", intel.headquarters);
    add("Revenue", intel.revenue);
    add("Valuation", intel.valuation);
    add("Funding Stage", intel.fundingStage);
    add("Latest Funding", intel.latestFundingNews);
    add("Business Model", intel.businessModel);
    addList("Founders", intel.founders);
    addList("Investors", intel.investors);

    section("Products & Market");
    addList("Key Products / Services", intel.keyProducts);
    addList("Competitors", intel.competitors);
    addList("Geographic Presence", intel.geographicPresence);
    addList("Top Customers", intel.topCustomers);

    if (intel.recentNews?.length) {
        section("Recent News");
        intel.recentNews.slice(0, 3).forEach((n) => lines.push(`• ${n.headline}${n.date ? ` (${n.date})` : ""}`));
    }

    if (intel.leadershipChanges?.length) {
        section("Leadership Changes");
        intel.leadershipChanges
            .slice(0, 2)
            .forEach((l) => lines.push(`• ${l.name} appointed as ${l.role}${l.date ? ` (${l.date})` : ""}`));
    }

    if (hasValue(intel.linkedinUrl)) {
        section("LinkedIn");
        lines.push(intel.linkedinUrl!);
    }

    // Collapse consecutive blank lines left by sections that ended up empty.
    return lines.filter((line, i) => !(line === "" && lines[i - 1] === "")).join("\n");
}

/** Opens a URL in the system browser, guarding against non-http(s) schemes
 * (javascript:, file:, etc.) before handing off to window.open. */
export function openExternalUrl(url: string): void {
    if (!url) return;
    const normalised = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    try {
        const { protocol } = new URL(normalised);
        if (protocol !== "https:" && protocol !== "http:") return;
    } catch {
        return; // unparseable — skip silently
    }
    window.open(normalised, "_blank");
}

export function useCompanyIntel(eventData: EventLike) {
    const [intel, setIntel] = useState<CompanyIntel | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [loadingStage, setLoadingStage] = useState(0);
    const [hasTavily, setHasTavily] = useState<boolean | null>(null);
    const [isCopied, setIsCopied] = useState(false);
    const [fromCache, setFromCache] = useState(false);

    const { companyName, domain } = useMemo(() => deriveCompany(eventData), [eventData]);

    // Cycle the "still working" messages while a fetch is in flight.
    useEffect(() => {
        if (!loading) return;
        const interval = setInterval(() => setLoadingStage((s) => (s + 1) % LOADING_STAGES.length), 1800);
        return () => clearInterval(interval);
    }, [loading]);

    const fetchIntel = useCallback(async (forceRefresh = false) => {
        const sessionActive = await guardSession();
        if (!sessionActive) return;

        if (!companyName) {
            setError("Could not identify the prospect company from this meeting's attendees.");
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);
        // Only clear displayed intel on a force-refresh so the previous data
        // stays visible while the new request is in-flight.
        if (forceRefresh) setIntel(null);

        try {
            const creds = await window.electronAPI.getStoredCredentials();
            const tavily = !!creds?.hasTavilyKey;
            setHasTavily(tavily);

            if (!tavily) {
                setError("no_tavily_key");
                return;
            }

            const result = await window.electronAPI?.fetchCompanyIntel({ companyName, domain, forceRefresh });
            if (result.success && result.intel) {
                setIntel(result.intel);
                setFromCache(result.fromCache ?? false);
                // Persist to AppState so the LLM has this context too. Best-effort —
                // a failure here shouldn't block showing the fetched intel.
                window.electronAPI?.setCompanyIntel?.(result.intel).catch((e: unknown) =>
                    console.warn("[useCompanyIntel] Failed to store company intel:", e),
                );
            } else {
                setError(result.error || "Failed to fetch company intelligence.");
            }
        } catch (e: any) {
            setError(e?.message || "Unexpected error");
        } finally {
            setLoading(false);
        }
    }, [companyName, domain]);

    useEffect(() => {
        fetchIntel();
    }, [fetchIntel]);

    const copyToClipboard = useCallback(() => {
        if (!intel) return;
        navigator.clipboard
            .writeText(buildClipboardText(intel, companyName))
            .then(() => {
                setIsCopied(true);
                setTimeout(() => setIsCopied(false), 2000);
            })
            .catch(console.error);
    }, [intel, companyName]);

    return {
        intel,
        loading,
        error,
        loadingStage,
        hasTavily,
        isCopied,
        fromCache,
        companyName,
        domain,
        /** Pass `true` to force a fresh lookup (bypasses the backend cache). */
        fetchIntel,
        copyToClipboard,
    };
}