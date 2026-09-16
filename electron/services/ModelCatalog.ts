// ModelCatalog.ts
//
// Live model-catalog service: caches each provider's current model list
// (fetched from the provider's /models endpoint via utils/modelFetcher) in
// the app_state KV store, and resolves "which model should we actually call"
// from that cache with the pure rules in utils/modelCatalogShared.ts.
//
// Why: hardcoded model ids rot (Groq retired its Llama catalog Aug-2026,
// Google shut gemini-3.1-*-preview May-2026). With this service the app
// resolves capability tiers ("capable", "fast", "vision") against whatever
// the provider currently serves, migrates away from retired ids the moment
// a failure confirms them, and only falls back to the seed lists when no
// live catalog exists (fresh install, offline).
//
// Cache shape (app_state key below): { [provider]: { ids: string[], fetchedAt: number } }

import {
    MODEL_CATALOG, KNOWN_RETIRED, seedIds, pickTierModel, classifyTier,
    isAutoId, parseAutoId, CATALOG_PROVIDERS,
} from '../../utils/modelCatalogShared';
import type { CatalogProvider, ModelTier } from '../../utils/modelCatalogShared';

const CACHE_KEY = 'model_catalog_cache_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Error text patterns that MIGHT mean "model retired". A suspected
 *  retirement always triggers a forced catalog refresh; the migration only
 *  happens if the refreshed catalog confirms the id is gone (so a genuine
 *  "high demand" 503 on a live model is propagated, not migrated). */
const RETIREMENT_SUSPECT_RE =
    /does not exist|not found|model_not_found|no access to it|experiencing high demand|decommissioned|shut ?down/i;

interface CacheAdapter {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

interface Fetcher {
    (provider: CatalogProvider, apiKey: string): Promise<Array<{ id: string; label?: string }>>;
}

type CachedEntry = { ids: string[]; fetchedAt: number };
type CacheShape = Partial<Record<CatalogProvider, CachedEntry>>;
type KeyGetter = (provider: CatalogProvider) => string | null | undefined;

export interface MigrationResult {
    id: string;
    migratedFrom?: string;
    tier: ModelTier;
}

export class ModelCatalog {
    private static instance: ModelCatalog | null = null;
    private cache: CacheShape = {};
    private loaded = false;
    private inflight = new Map<CatalogProvider, Promise<string[] | null>>();

    constructor(
        private cacheAdapter: CacheAdapter = ModelCatalog.defaultAdapter(),
        private fetcher: Fetcher = ModelCatalog.defaultFetcher(),
        private keyGetter: KeyGetter = ModelCatalog.defaultKeyGetter(),
    ) { }

    static getInstance(): ModelCatalog {
        if (!ModelCatalog.instance) {
            ModelCatalog.instance = new ModelCatalog();
        }
        return ModelCatalog.instance;
    }

    /** Test seam: build with fakes instead of the singleton. */
    static createForTest(cache: CacheAdapter, fetcher: Fetcher, keyGetter?: KeyGetter): ModelCatalog {
        return new ModelCatalog(cache, fetcher, keyGetter ?? (() => 'test-key'));
    }

    /** Stored API key per provider (lazy require — keeps tests electron-free;
 *  a missing CredentialsManager just means "no key, no refresh"). */
    private static defaultKeyGetter(): KeyGetter {
        return (provider: CatalogProvider): string | null => {
            try {
                const { CredentialsManager } = require('./CredentialsManager');
                const cm = CredentialsManager.getInstance();
                return (
                    provider === 'groq' ? cm.getGroqApiKey() :
                        provider === 'gemini' ? cm.getGeminiApiKey() :
                            provider === 'openai' ? cm.getOpenaiApiKey() :
                                cm.getClaudeApiKey()
                );
            } catch {
                return null;
            }
        };
    }

    private static defaultAdapter(): CacheAdapter {
        const { DatabaseManager } = require('../db/DatabaseManager');
        const db = DatabaseManager.getInstance();
        return {
            get: (k) => db.getAppState(k),
            set: (k, v) => db.setAppState(k, v),
        };
    }

    private static defaultFetcher(): Fetcher {
        const { fetchProviderModels } = require('../utils/modelFetcher');
        return fetchProviderModels as Fetcher;
    }

    private load(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const raw = this.cacheAdapter.get(CACHE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') this.cache = parsed as CacheShape;
            }
        } catch {
            this.cache = {};
        }
    }

    private persist(): void {
        try {
            this.cacheAdapter.set(CACHE_KEY, JSON.stringify(this.cache));
        } catch (e) {
            console.warn('[ModelCatalog] cache persist failed (non-fatal):', e);
        }
    }

    /** Current ids for a provider: live cache if present, seeds otherwise. */
    getIds(provider: CatalogProvider): string[] {
        this.load();
        const entry = this.cache[provider];
        return entry && entry.ids.length > 0 ? entry.ids : seedIds(provider);
    }

    /** True only when a live catalog exists — a negative "not in catalog"
     *  retirement verdict is only trustworthy then. */
    hasLiveCatalog(provider: CatalogProvider): boolean {
        this.load();
        const entry = this.cache[provider];
        return !!(entry && entry.ids.length > 0);
    }

    fetchedAt(provider: CatalogProvider): number | null {
        this.load();
        return this.cache[provider]?.fetchedAt ?? null;
    }

    /** Resolve a tier to the current best model (live catalog > seeds). */
    resolve(provider: CatalogProvider, tier: ModelTier = 'capable'): string {
        const live = pickTierModel(provider, tier, this.getIds(provider));
        if (live) return live;
        return MODEL_CATALOG[provider].seeds[tier][0];
    }

    /** Resolve an auto id ("auto", "auto:groq", "auto:groq:fast"). Returns the
     *  raw id unchanged when it isn't an auto id (caller then treats it as a
     *  concrete model). */
    resolveAuto(requested: string, fallbackProvider: CatalogProvider = 'gemini'): string {
        if (!isAutoId(requested)) return requested;
        const parsed = parseAutoId(requested);
        const provider = parsed?.provider ?? fallbackProvider;
        const tier = parsed?.tier ?? 'capable';
        return this.resolve(provider, tier);
    }

    /** Merge a freshly fetched list into the cache (also called from the
     *  provider-card "fetch models" action so manual fetches refresh it). */
    updateCache(provider: CatalogProvider, ids: string[]): void {
        this.load();
        this.cache[provider] = { ids, fetchedAt: Date.now() };
        this.persist();
    }

    /** Fetch the provider's live model list. TTL-gated unless force. Returns
     *  null on failure (stale cache is kept — a failed refresh must never
     *  downgrade us to seeds). */
    async refresh(
        provider: CatalogProvider,
        apiKey: string | null | undefined,
        opts: { force?: boolean } = {},
    ): Promise<string[] | null> {
        this.load();
        const entry = this.cache[provider];
        if (!opts.force && entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
            return entry.ids;
        }
        if (!apiKey) return entry?.ids ?? null;

        const existing = this.inflight.get(provider);
        if (existing) return existing;

        const job = (async () => {
            try {
                const models = await this.fetcher(provider, apiKey);
                const ids = (models || []).map((m) => m.id).filter(Boolean);
                if (ids.length > 0) this.updateCache(provider, ids);
                return ids.length > 0 ? ids : this.cache[provider]?.ids ?? null;
            } catch (e) {
                console.warn(`[ModelCatalog] refresh failed for ${provider} (keeping stale cache):`, e instanceof Error ? e.message : e);
                return this.cache[provider]?.ids ?? null;
            } finally {
                this.inflight.delete(provider);
            }
        })();
        this.inflight.set(provider, job);
        return job;
    }

    /** Sync health check/migration for stored ids (setModel-time). Uses the
     *  cached catalog only — no network. Never returns an empty id. */
    healSync(provider: CatalogProvider, requested: string): MigrationResult {
        const tier = classifyTier(provider, requested) ?? 'capable';
        const known = KNOWN_RETIRED[provider][requested];
        if (known && known !== requested) {
            return { id: known, migratedFrom: requested, tier };
        }
        // Only trust a negative verdict when a live catalog exists — without
        // one, every non-seed id (custom/dated variants) would "migrate".
        if (this.hasLiveCatalog(provider) && !this.getIds(provider).includes(requested)) {
            const replacement = pickTierModel(provider, tier, this.getIds(provider));
            if (replacement && replacement !== requested) {
                return { id: replacement, migratedFrom: requested, tier };
            }
        }
        return { id: requested, tier };
    }

    /** Does this error text look like a possible model retirement? */
    isRetirementSuspect(errorText: string | undefined | null): boolean {
        return !!errorText && RETIREMENT_SUSPECT_RE.test(errorText);
    }

    /** Emit PostHog telemetry for a heal result that's actually being ADOPTED
     *  as the model to use (setModel, switchToGemini, a connection test, a
     *  confirmed failure-driven migration, …) — not for filtering/dropdown
     *  display purposes (see snapshot(), which calls healSync per-id purely
     *  to drop stale ids from a list and must NOT fire telemetry per call).
     *  No-op when `healed` isn't actually a migration. Best-effort: never
     *  throws, so telemetry can't take down a model switch. */
    recordMigration(provider: CatalogProvider, healed: MigrationResult): void {
        if (!healed.migratedFrom) return;
        console.warn(
            `[ModelCatalog] ${provider} model "${healed.migratedFrom}" retired — migrating to "${healed.id}"`,
        );
        try {
            const { posthogMain } = require('./PostHogMainService');
            posthogMain.capture('model_auto_migrated', {
                provider,
                from: healed.migratedFrom,
                to: healed.id,
                tier: healed.tier,
            });
        } catch { /* telemetry is best-effort */ }
    }

    /** Failure-driven migration: force-refresh the catalog, and only if the
     *  refreshed list confirms the model is gone, migrate + emit telemetry.
     *  Returns the new id, or null when the model is still live (genuine
     *  overload — caller should propagate the original error). */
    async migrateOnFailure(
        provider: CatalogProvider,
        requested: string,
        errorText: string | undefined | null,
    ): Promise<string | null> {
        if (!this.isRetirementSuspect(errorText)) return null;

        await this.refresh(provider, this.keyGetter(provider), { force: true });
        const healed = this.healSync(provider, requested);
        if (!healed.migratedFrom) return null;

        this.recordMigration(provider, healed);
        return healed.id;
    }

    /** Snapshot for the renderer dropdowns (IPC model-catalog:get). */
    snapshot(): Record<CatalogProvider, { ids: string[]; source: 'live' | 'seed'; fetchedAt: number | null; auto: string }> {
        this.load();
        const out = {} as Record<CatalogProvider, { ids: string[]; source: 'live' | 'seed'; fetchedAt: number | null; auto: string }>;
        for (const p of CATALOG_PROVIDERS) {
            const live = this.hasLiveCatalog(p);
            const tierIds = this.getIds(p)
                .filter((id) => !this.healSync(p, id).migratedFrom) // drop known-retired
                .filter((id) => classifyTier(p, id) !== null);       // keep tier-classifiable
            out[p] = {
                ids: tierIds.length > 0 ? tierIds : seedIds(p),
                source: live ? 'live' : 'seed',
                fetchedAt: this.fetchedAt(p),
                auto: this.resolve(p, 'capable'),
            };
        }
        return out;
    }

    /** Startup/periodic refresh for every provider with a stored key. */
    async refreshAll(keyGetters?: Record<CatalogProvider, () => string | null | undefined>): Promise<void> {
        const keys = keyGetters ?? {
            gemini: () => this.keyGetter('gemini'),
            groq: () => this.keyGetter('groq'),
            openai: () => this.keyGetter('openai'),
            claude: () => this.keyGetter('claude'),
        };
        await Promise.all(
            CATALOG_PROVIDERS.map((p) => this.refresh(p, keys[p]?.()).catch((): null => null)),
        );
    }
}