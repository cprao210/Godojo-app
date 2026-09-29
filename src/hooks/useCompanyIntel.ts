// Data layer for the "Sales Brief" panel: derives the prospect company from a
// calendar event's attendees, fetches Tavily-backed company intelligence for
// it, and exposes clipboard/URL helpers the panel's UI needs. Kept separate
// from SalesBriefPanel.tsx so the component only owns rendering.
//
// Which companies are candidates (and which domains are "our side" and get
// excluded) lives in @/lib/companyCandidates — pure, and shared with the
// meeting-reminder popup. This file only owns the fetch/selection state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFirebaseAuth, guardSession } from "@/lib/firebase";
import { CompanyIntel, EventLike } from "@/types";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";
import {
    CompanyCandidate,
    companyNameFromTitle,
    deriveCompanyCandidates,
    resolveActiveCompany,
} from "@/lib/companyCandidates";

export type { CompanyCandidate };

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

/** The signed-in user's email, or null. Read defensively: if Firebase isn't
 * available this must degrade to the calendar's own `self`/organizer hints,
 * never break the panel. */
function currentUserEmail(): string | null {
    try {
        return getFirebaseAuth().currentUser?.email ?? null;
    } catch {
        return null;
    }
}

export function useCompanyIntel(eventData: EventLike) {
    const [intel, setIntel] = useState<CompanyIntel | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [loadingStage, setLoadingStage] = useState(0);
    const [hasTavily, setHasTavily] = useState<boolean | null>(null);
    const [isCopied, setIsCopied] = useState(false);
    const [fromCache, setFromCache] = useState(false);

    // Read once per panel mount — the panel is a short-lived overlay.
    const [userEmail] = useState(currentUserEmail);

    // External companies on the invite, with the user's own domain (and every
    // teammate on it) already removed.
    const { candidates } = useMemo(
        () => deriveCompanyCandidates(eventData, { userEmail }),
        [eventData, userEmail],
    );
    const titleFallbackName = useMemo(() => companyNameFromTitle(eventData.title), [eventData.title]);

    // The user's pick when there is more than one candidate. Stored together
    // with a signature of the candidate list so a different event (or a
    // re-derived list) can never inherit a stale index — the selection just
    // reads as "not chosen yet" and the chooser is shown again.
    const candidatesKey = candidates.map((c) => c.domain).join("|");
    const [selection, setSelection] = useState<{ key: string; index: number } | null>(null);
    const chosenIndex = selection?.key === candidatesKey ? selection.index : null;

    // 0 candidates → title guess; 1 → that one; 2+ → NOTHING until the user
    // picks (awaitingSelection), so no Tavily call is spent on a guess.
    const { awaitingSelection, selected, companyName, domain } = resolveActiveCompany(
        candidates,
        chosenIndex,
        titleFallbackName,
    );
    const selectedIndex = selected ? candidates.indexOf(selected) : null;

    // Only the latest request may write state. Switching company quickly
    // must not let the slower, older response overwrite the newer one.
    const requestSeq = useRef(0);

    // Only "busy" once there is actually something to fetch.
    const busy = loading && !awaitingSelection;

    // Cycle the "still working" messages while a fetch is in flight.
    useEffect(() => {
        if (!busy) return;
        const interval = setInterval(() => setLoadingStage((s) => (s + 1) % LOADING_STAGES.length), 1800);
        return () => clearInterval(interval);
    }, [busy]);

    const fetchIntel = useCallback(async (forceRefresh = false) => {
        const requestId = ++requestSeq.current;
        const isCurrent = () => requestId === requestSeq.current;

        // Flip to the loading state synchronously (before any await) so there
        // is no frame between "company chosen" and "skeleton shown".
        setLoading(true);
        setError(null);
        // Only clear displayed intel on a force-refresh so the previous data
        // stays visible while the new request is in-flight.
        if (forceRefresh) setIntel(null);

        const sessionActive = await guardSession();
        if (!sessionActive || !isCurrent()) return;

        if (!companyName) {
            setError("Could not identify the prospect company from this meeting's attendees.");
            setLoading(false);
            return;
        }

        try {
            const creds = await window.electronAPI.getStoredCredentials();
            if (!isCurrent()) return;
            const tavily = !!creds?.hasTavilyKey;
            setHasTavily(tavily);

            if (!tavily) {
                setError("no_tavily_key");
                posthogAnalytics.trackCompanyInsightsFailed("no_tavily_key", companyName);
                return;
            }

            const result = await window.electronAPI?.fetchCompanyIntel({ companyName, domain, forceRefresh });
            if (!isCurrent()) return;
            if (result.success && result.intel) {
                setIntel(result.intel);
                setFromCache(result.fromCache ?? false);
                // Persist to AppState so the LLM has this context too. Best-effort —
                // a failure here shouldn't block showing the fetched intel. Low-confidence
                // intel is shown to the user (with its warning) but NOT handed to the LLM
                // as prospect fact; null also clears any previous company's intel.
                window.electronAPI?.setCompanyIntel?.(result.intel._confidence === 'low' ? null : result.intel).catch((e: unknown) =>
                    console.warn("[useCompanyIntel] Failed to store company intel:", e),
                );
            } else {
                const reason = result.error || "Failed to fetch company intelligence.";
                setError(reason);
                posthogAnalytics.trackCompanyInsightsFailed(reason, companyName);
            }
        } catch (e: any) {
            if (!isCurrent()) return;
            const reason = e?.message || "Unexpected error";
            setError(reason);
            posthogAnalytics.trackCompanyInsightsFailed(reason, companyName);
            posthogAnalytics.trackException(e instanceof Error ? e : new Error(String(e)), "useCompanyIntel.fetchIntel", { companyName, domain });
        } finally {
            if (isCurrent()) setLoading(false);
        }
    }, [companyName, domain]);

    useEffect(() => {
        if (awaitingSelection) {
            // Nothing to generate yet. Invalidate anything still in flight
            // (e.g. the candidate list just changed) and show the chooser.
            requestSeq.current += 1;
            setLoading(false);
            return;
        }
        fetchIntel();
    }, [fetchIntel, awaitingSelection]);

    /** Pick which company to research; triggers a fresh fetch for it. */
    const selectCandidate = useCallback((index: number) => {
        // Drop the previous company's data straight away so it can't be
        // copied or shown under the new company's name while loading.
        setIntel(null);
        setError(null);
        setFromCache(false);
        setLoading(true);
        setSelection({ key: candidatesKey, index });
    }, [candidatesKey]);

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
        /** False while the chooser is showing — nothing is being fetched then. */
        loading: busy,
        error,
        loadingStage,
        hasTavily,
        isCopied,
        fromCache,
        companyName,
        domain,
        /** External companies found among attendees, our own domain excluded —
         * length 1 in the common case, >1 when attendees span companies. */
        candidates,
        /** True when there are several candidates and the user hasn't chosen
         * one yet: the panel must ask first, and no insights are generated. */
        awaitingSelection,
        /** Index of the active candidate, or null while awaiting selection
         * (or when the company came from the title fallback). */
        selectedIndex,
        selectCandidate,
        /** Pass `true` to force a fresh lookup (bypasses the backend cache). */
        fetchIntel,
        copyToClipboard,
    };
}