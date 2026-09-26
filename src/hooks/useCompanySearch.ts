// Debounced search over the customer-companies registry (GET /companies?search=) for the global
// chat's company chip and "@" mentions. `term` null = closed (no request).

import { useEffect, useState } from "react";
import { companiesApi } from "@/api/companiesApi";
import type { Company } from "@/types";

export const COMPANY_SEARCH_DEBOUNCE_MS = 200;
export const COMPANY_SEARCH_LIMIT = 8;

export function useCompanySearch(term: string | null): { results: Company[]; loading: boolean } {
    const [results, setResults] = useState<Company[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (term === null) {
            setResults([]);
            setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        const timer = setTimeout(async () => {
            try {
                const rows = await companiesApi.list(term.trim() || undefined, COMPANY_SEARCH_LIMIT);
                if (!cancelled) setResults(rows || []);
            } catch (e) {
                console.warn("[useCompanySearch] company search failed:", e);
                if (!cancelled) setResults([]);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }, COMPANY_SEARCH_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [term]);

    return { results, loading };
}
