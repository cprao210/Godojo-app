// backendCompanyIntel.ts
//
// Sends the Sales Brief's prospect research (CompanyIntelService) to the backend,
// PUT /api/v1/companies/intel, stored per (domain, user) in company_intelligence.
// Global chat's company pack reads it back as "research, not said on the calls"
// (godojo-apis agent_v2/company_pack.py) — before this, the research lived only in
// this app's local cache and never reached chat.
//
// Only research we'd show with confidence goes up: low-confidence intel (company
// guessed from a meeting title, or a name collision) and sparse/unverified results
// the cache refuses are not sent. Fire-and-forget: never throws, never blocks the brief.

const BACKEND_URL = process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";
const SYNC_TIMEOUT_MS = 15_000;

/** Backend body (CompanyIntelUpsert) — field caps mirror the pydantic model. */
export interface BackendIntelBody {
    domain: string;
    company_name?: string;
    industry?: string;
    company_size?: string;
    annual_revenue?: string;
    funding_stage?: string;
    business_model?: string;
    description?: string;
    products: string[];
    competitors: string[];
    technologies: string[];
    recent_news?: string;
}

const cap = (s: unknown, n: number): string | undefined => {
    const t = typeof s === 'string' ? s.trim() : '';
    return t ? t.slice(0, n) : undefined;
};
const capList = (xs: unknown, n: number, each = 200): string[] =>
    (Array.isArray(xs) ? xs : [])
        .map((x) => (typeof x === 'string' ? x.trim().slice(0, each) : ''))
        .filter(Boolean)
        .slice(0, n);

/** Bare hostname: "https://www.Oolka.in/about" → "oolka.in". */
export function bareDomain(raw: string | null | undefined): string | null {
    const s = (raw || '').trim().toLowerCase();
    if (!s) return null;
    const host = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '');
    return host.includes('.') ? host : null;
}

/** Map a CompanyIntelRecord (loosely typed — cached entries are plain JSON) to the backend body. */
export function toBackendIntel(intel: Record<string, any>, domain?: string | null): BackendIntelBody | null {
    const d = bareDomain(domain) ?? bareDomain(intel?.website);
    if (!d) return null;

    const about = [
        intel.headquarters && `Headquarters: ${intel.headquarters}`,
        intel.foundedYear && `Founded ${intel.foundedYear}`,
        capList(intel.geographicPresence, 10).length && `Present in: ${capList(intel.geographicPresence, 10).join(', ')}`,
        capList(intel.topCustomers, 10).length && `Customers: ${capList(intel.topCustomers, 10).join(', ')}`,
        capList(intel.investors, 10).length && `Investors: ${capList(intel.investors, 10).join(', ')}`,
        intel.valuation && `Valuation: ${intel.valuation}`,
    ].filter(Boolean).join('. ');

    const news = [
        ...(Array.isArray(intel.recentNews) ? intel.recentNews : [])
            .filter((n: any) => n?.headline)
            .map((n: any) => `${n.date ? `${String(n.date).slice(0, 10)}: ` : ''}${n.headline}`),
        ...(Array.isArray(intel.leadershipChanges) ? intel.leadershipChanges : [])
            .filter((l: any) => l?.name)
            .map((l: any) => `Leadership: ${l.name}${l.role ? ` — ${l.role}` : ''}${l.date ? ` (${String(l.date).slice(0, 10)})` : ''}`),
        intel.latestFundingNews && `Funding: ${intel.latestFundingNews}`,
    ].filter(Boolean).join('\n');

    return {
        domain: d,
        company_name: cap(intel.companyName, 200),
        industry: cap(intel.industry, 200),
        company_size: cap(intel.employeeCount, 100),
        annual_revenue: cap(intel.revenue, 100),
        funding_stage: cap(intel.fundingStage, 100),
        business_model: cap(intel.businessModel, 300),
        description: cap(about, 2000),
        products: capList(intel.keyProducts, 30),
        competitors: capList(intel.competitors, 30),
        technologies: [],
        recent_news: cap(news, 3000),
    };
}

/** One PUT to the backend. Exported for tests to inject. */
export async function putCompanyIntel(body: BackendIntelBody): Promise<void> {
    const { AuthManager } = require('../services/AuthManager');
    const token: string | null = AuthManager.getInstance().getIdToken();
    if (!token) throw new Error('not-authenticated');
    const { tenantContext } = require('../services/TenantContext');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const tenant = tenantContext.get?.() ?? null;
    if (tenant) headers['X-Tenant-Id'] = tenant;
    const axios = require('axios');
    await axios.put(`${BACKEND_URL}/api/v1/companies/intel`, body, { headers, timeout: SYNC_TIMEOUT_MS });
}

// Cached intel is re-sent at most once per app session (so research cached before this sync
// existed reaches the backend too, without a PUT on every Sales Brief open).
const syncedThisSession = new Set<string>();

/** Send the research to the backend. Never throws. Returns whether a request was made. */
export async function syncCompanyIntel(
    intel: Record<string, any> | null | undefined,
    domain: string | null | undefined,
    opts: { put?: (body: BackendIntelBody) => Promise<void>; onlyOncePerSession?: boolean } = {},
): Promise<boolean> {
    if (!intel || intel._confidence === 'low') return false;
    const body = toBackendIntel(intel, domain);
    if (!body) return false;
    if (opts.onlyOncePerSession && syncedThisSession.has(body.domain)) return false;
    try {
        await (opts.put ?? putCompanyIntel)(body);
        syncedThisSession.add(body.domain);
        console.log(`[CompanyIntel] research for ${body.domain} sent to backend`);
        return true;
    } catch (err: any) {
        console.warn(`[CompanyIntel] backend sync failed for ${body.domain}: ${err?.message ?? err}`);
        return false;
    }
}

/** Test hook. */
export function resetCompanyIntelSyncForTests(): void {
    syncedThisSession.clear();
}
