// src/api/companyContextApi.ts
//
// Typed wrappers over the FastAPI /company-context routes (singleton company
// context + personas + competitors). Same shape as tenantsApi: apiFetch
// attaches the Firebase Bearer token + X-Tenant-Id header and handles the
// {"error":{...}} envelope, so callers here just build the path/body.
//
// NOTE: X-Tenant-Id is attached automatically by apiClient's request
// interceptor (via window.electronAPI.getCurrentTenantId()) whenever the
// user is on a team — no need to pass it manually here. Write calls made
// while on a team, by a non-admin member, will 403 per the backend contract;
// callers should surface ApiError.code === 'forbidden' as a permissions
// message rather than a generic save failure.

import { apiFetch } from "@/lib/apiClient";
import {
    BackendCompanyContext,
    BackendCompanyContextUpdate,
    BackendCompetitor,
    BackendCompetitorUpdate,
    BackendPersona,
    BackendPersonaUpdate,
} from "@/types";

export const companyContextApi = {
    // GET /company-context — returns null if nothing exists yet.
    get: (): Promise<BackendCompanyContext | null> =>
        apiFetch<BackendCompanyContext | null>("/company-context"),

    // PUT /company-context — create or update (upsert). Send only changed fields.
    upsert: (data: BackendCompanyContextUpdate): Promise<BackendCompanyContext> =>
        apiFetch<BackendCompanyContext>("/company-context", {
            method: "PUT",
            body: JSON.stringify(data),
        }),

    // DELETE /company-context
    delete: (): Promise<void> =>
        apiFetch<void>("/company-context", { method: "DELETE" }),

    // ── Personas ────────────────────────────────────────────────────────────
    listPersonas: (): Promise<BackendPersona[]> =>
        apiFetch<BackendPersona[]>("/company-context/personas"),

    createPersona: (persona: {
        id?: string;
        role: string;
        description: string;
        sort_order?: number;
    }): Promise<BackendPersona> =>
        apiFetch<BackendPersona>("/company-context/personas", {
            method: "POST",
            body: JSON.stringify(persona),
        }),

    updatePersona: (personaId: string, updates: BackendPersonaUpdate): Promise<BackendPersona> =>
        apiFetch<BackendPersona>(`/company-context/personas/${personaId}`, {
            method: "PATCH",
            body: JSON.stringify(updates),
        }),

    deletePersona: (personaId: string): Promise<void> =>
        apiFetch<void>(`/company-context/personas/${personaId}`, { method: "DELETE" }),

    // ── Competitors ─────────────────────────────────────────────────────────
    listCompetitors: (): Promise<BackendCompetitor[]> =>
        apiFetch<BackendCompetitor[]>("/company-context/competitors"),

    createCompetitor: (competitor: {
        id?: string;
        name: string;
        moat: string;
        win_rate: number;
        sort_order?: number;
    }): Promise<BackendCompetitor> =>
        apiFetch<BackendCompetitor>("/company-context/competitors", {
            method: "POST",
            body: JSON.stringify(competitor),
        }),

    updateCompetitor: (competitorId: string, updates: BackendCompetitorUpdate): Promise<BackendCompetitor> =>
        apiFetch<BackendCompetitor>(`/company-context/competitors/${competitorId}`, {
            method: "PATCH",
            body: JSON.stringify(updates),
        }),

    deleteCompetitor: (competitorId: string): Promise<void> =>
        apiFetch<void>(`/company-context/competitors/${competitorId}`, { method: "DELETE" }),
};