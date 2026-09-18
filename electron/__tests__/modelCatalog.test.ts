// Covers the auto-updating model catalog: the pure shared rules
// (utils/modelCatalogShared.ts) and the ModelCatalog service
// (electron/services/ModelCatalog.ts).
//
// These are the invariants that make provider deprecations a non-event:
//   - a tier resolves to whatever the provider CURRENTLY serves (live cache
//     wins, seeds are only the offline fallback)
//   - known-retired ids heal instantly, even with no network
//   - an id absent from a LIVE catalog migrates; an id absent from a seed
//     list does NOT (custom/dated ids must never be "migrated" blind)
//   - a failure only migrates when the refreshed catalog CONFIRMS the model
//     is gone — a genuine "high demand" 503 on a live model propagates
//   - auto ids resolve through the same machinery

import { describe, it, expect } from 'vitest';
import {
    MODEL_CATALOG, KNOWN_RETIRED, classifyTier, pickTierModel, detectProvider,
    isAutoId, parseAutoId, buildAutoId, autoDisplayName, seedIds, versionRank,
} from '../../utils/modelCatalogShared';
import { ModelCatalog } from '../services/ModelCatalog';

// ── Shared pure rules ──────────────────────────────────────────────────────

describe('modelCatalogShared — tier classification', () => {
    it('classifies the current Groq catalog into tiers', () => {
        expect(classifyTier('groq', 'openai/gpt-oss-120b')).toBe('capable');
        expect(classifyTier('groq', 'openai/gpt-oss-20b')).toBe('fast');
        expect(classifyTier('groq', 'qwen/qwen3.6-27b')).toBe('vision');
        expect(classifyTier('groq', 'whisper-large-v3')).toBeNull();
    });

    it('classifies Gemini and Claude families', () => {
        expect(classifyTier('gemini', 'gemini-3.1-flash-lite')).toBe('fast');
        expect(classifyTier('gemini', 'gemini-3.1-pro')).toBe('capable');
        expect(classifyTier('gemini', 'gemini-4.2-flash')).toBe('capable'); // future GA
        expect(classifyTier('claude', 'claude-haiku-4-5-20251001')).toBe('fast');
        expect(classifyTier('claude', 'claude-opus-4-6')).toBe('capable');
    });

    it('picks the newest match within a tier family', () => {
        const ids = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-200b'];
        expect(pickTierModel('groq', 'capable', ids)).toBe('openai/gpt-oss-200b');
    });

    it('prefers matcher order over version rank (flash-lite stays fast)', () => {
        expect(pickTierModel('gemini', 'fast', ['gemini-3.1-flash', 'gemini-3.1-flash-lite'])).toBe('gemini-3.1-flash-lite');
    });

    it('excludes non-chat ids from resolution', () => {
        expect(pickTierModel('groq', 'capable', ['whisper-large-v3', 'openai/gpt-oss-120b'])).toBe('openai/gpt-oss-120b');
    });

    it('detects the provider for arbitrary ids', () => {
        expect(detectProvider('llama-3.3-70b-versatile')).toBe('groq');
        expect(detectProvider('openai/gpt-oss-120b')).toBe('groq');
        expect(detectProvider('gemini-3.1-flash-lite')).toBe('gemini');
        expect(detectProvider('claude-sonnet-4-6')).toBe('claude');
        expect(detectProvider('gpt-5.4')).toBe('openai');
    });

    it('maps known-retired ids to their successors', () => {
        expect(KNOWN_RETIRED.groq['llama-3.3-70b-versatile']).toBe('openai/gpt-oss-120b');
        expect(KNOWN_RETIRED.gemini['gemini-3.1-flash-lite-preview']).toBe('gemini-3.1-flash-lite');
    });

    it('ranks parameter size and dotted versions', () => {
        expect(versionRank('openai/gpt-oss-120b')).toBeGreaterThan(versionRank('openai/gpt-oss-20b'));
        expect(versionRank('gemini-4.0-flash')).toBeGreaterThan(versionRank('gemini-3.1-flash'));
    });
});

describe('modelCatalogShared — auto ids', () => {
    it('builds and parses auto ids', () => {
        expect(buildAutoId('groq')).toBe('auto:groq:capable');
        expect(buildAutoId('gemini', 'fast')).toBe('auto:gemini:fast');
        expect(parseAutoId('auto:groq:fast')).toEqual({ provider: 'groq', tier: 'fast' });
        expect(parseAutoId('auto')).toEqual({ provider: null, tier: 'capable' });
        expect(parseAutoId('auto:nonsense')).toBeNull();
        expect(isAutoId('gpt-5.4')).toBe(false);
    });

    it('names auto ids for dropdowns', () => {
        expect(autoDisplayName('auto:groq')).toBe('Groq Auto (Recommended)');
        expect(autoDisplayName('auto:gemini:fast')).toBe('Gemini Auto (Fast)');
    });
});

// ── ModelCatalog service (injected cache + fetcher — no electron deps) ─────

function makeCatalog(initial: Record<string, { ids: string[]; fetchedAt: number }> = {}) {
    const store = new Map<string, string>(
        initial['x'] ? [] : Object.entries({ 'model_catalog_cache_v1': JSON.stringify(initial) }),
    );
    let fetchResult: string[] | Error = [];
    let fetchCalls = 0;
    const cache = {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => { store.set(k, v); },
    };
    const fetcher = async (_p: any, _k: string) => {
        fetchCalls += 1;
        if (fetchResult instanceof Error) throw fetchResult;
        return fetchResult.map((id) => ({ id, label: id }));
    };
    const catalog = ModelCatalog.createForTest(cache as any, fetcher as any);
    return {
        catalog,
        setFetch: (r: string[] | Error) => { fetchResult = r; },
        fetchCalls: () => fetchCalls,
    };
}

describe('ModelCatalog — resolution', () => {
    it('falls back to seeds with no live catalog', () => {
        const { catalog } = makeCatalog();
        expect(catalog.resolve('groq', 'capable')).toBe('openai/gpt-oss-120b');
        expect(catalog.resolve('gemini', 'fast')).toBe('gemini-3.1-flash-lite');
        expect(catalog.getIds('groq')).toEqual(seedIds('groq'));
    });

    it('prefers the live catalog once refreshed', () => {
        const { catalog, setFetch } = makeCatalog();
        setFetch(['openai/gpt-oss-130b', 'openai/gpt-oss-20b', 'whisper-x']);
        return catalog.refresh('groq', 'key', { force: true }).then(() => {
            expect(catalog.resolve('groq', 'capable')).toBe('openai/gpt-oss-130b');
            expect(catalog.hasLiveCatalog('groq')).toBe(true);
        });
    });

    it('resolves auto ids through the live catalog', () => {
        const { catalog, setFetch } = makeCatalog();
        setFetch(['openai/gpt-oss-130b']);
        return catalog.refresh('groq', 'key', { force: true }).then(() => {
            expect(catalog.resolveAuto('auto:groq')).toBe('openai/gpt-oss-130b');
            // non-auto ids pass through untouched
            expect(catalog.resolveAuto('openai/gpt-oss-20b')).toBe('openai/gpt-oss-20b');
        });
    });

    it('honors the 24h TTL — no refetch inside the window', () => {
        const { catalog, setFetch, fetchCalls } = makeCatalog({
            groq: { ids: ['openai/gpt-oss-120b'], fetchedAt: Date.now() },
        });
        setFetch(['openai/gpt-oss-999b']);
        return catalog.refresh('groq', 'key').then(() => {
            expect(fetchCalls()).toBe(0);
            expect(catalog.resolve('groq', 'capable')).toBe('openai/gpt-oss-120b');
        });
    });

    it('keeps the stale cache when a refresh fails', () => {
        const { catalog, setFetch } = makeCatalog({
            groq: { ids: ['openai/gpt-oss-120b'], fetchedAt: Date.now() - 48 * 3600_000 },
        });
        setFetch(new Error('network down'));
        return catalog.refresh('groq', 'key', { force: true }).then((ids) => {
            expect(ids).toEqual(['openai/gpt-oss-120b']);
            expect(catalog.resolve('groq', 'capable')).toBe('openai/gpt-oss-120b');
        });
    });
});

describe('ModelCatalog — retirement healing', () => {
    it('heals known-retired ids instantly (no network)', () => {
        const { catalog } = makeCatalog();
        const healed = catalog.healSync('groq', 'llama-3.3-70b-versatile');
        expect(healed).toEqual({ id: 'openai/gpt-oss-120b', migratedFrom: 'llama-3.3-70b-versatile', tier: 'capable' });
        expect(catalog.healSync('gemini', 'gemini-3.1-pro-preview').id).toBe('gemini-3.1-pro');
    });

    it('migrates an id that vanished from a LIVE catalog', () => {
        const { catalog, setFetch } = makeCatalog({
            groq: { ids: ['openai/gpt-oss-130b', 'openai/gpt-oss-20b'], fetchedAt: Date.now() },
        });
        // User's stored pick is absent from the fresh catalog.
        expect(catalog.healSync('groq', 'openai/gpt-oss-120b').id).toBe('openai/gpt-oss-130b');
        void setFetch;
    });

    it('does NOT migrate unknown ids when only seeds exist (custom ids are safe)', () => {
        const { catalog } = makeCatalog();
        // No live catalog → absence cannot be trusted → id passes through.
        expect(catalog.healSync('groq', 'my-custom-dated-model-07-25').migratedFrom).toBeUndefined();
    });

    it('migrates on failure only when the refreshed catalog confirms retirement', async () => {
        const { catalog, setFetch } = makeCatalog();
        setFetch(['openai/gpt-oss-130b']); // refresh proves 120b is gone
        const migrated = await catalog.migrateOnFailure(
            'groq', 'openai/gpt-oss-120b', "The model 'openai/gpt-oss-120b' does not exist or you do not have access to it.",
        );
        expect(migrated).toBe('openai/gpt-oss-130b');
    });

    it('propagates genuine overload when the model is still live', async () => {
        const { catalog, setFetch } = makeCatalog();
        setFetch(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']); // still served
        const migrated = await catalog.migrateOnFailure(
            'groq', 'openai/gpt-oss-120b', 'This model is currently experiencing high demand.',
        );
        expect(migrated).toBeNull();
    });

    it('ignores unrelated errors entirely', async () => {
        const { catalog } = makeCatalog();
        const migrated = await catalog.migrateOnFailure('groq', 'openai/gpt-oss-120b', 'rate limit exceeded');
        expect(migrated).toBeNull();
    });
});

describe('ModelCatalog — snapshot for dropdowns', () => {
    it('marks source and drops known-retired + non-tier ids', () => {
        const { catalog } = makeCatalog({
            groq: { ids: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'whisper-x', 'qwen/qwen3.6-27b'], fetchedAt: Date.now() },
        });
        const snap = catalog.snapshot();
        expect(snap.groq.source).toBe('live');
        expect(snap.groq.ids).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.6-27b']);
        expect(snap.gemini.source).toBe('seed');
        expect(snap.groq.auto).toBe('openai/gpt-oss-120b');
    });
});

// Guard: every seed id must classify into SOME tier — an unclassifiable seed
// could not be routed to a sensible replacement by retirement healing. (A
// seed may legitimately sit under a broader tier than it classifies as —
// e.g. gemini flash-lite is the fallback for capable/vision but classifies
// as 'fast', which is exactly where healing should send it.)
describe('MODEL_CATALOG — seed sanity', () => {
    it('every seed id classifies into a tier', () => {
        for (const [provider, def] of Object.entries(MODEL_CATALOG)) {
            for (const [tier, ids] of Object.entries(def.seeds)) {
                for (const id of ids) {
                    expect(classifyTier(provider as any, id), `${provider}/${tier}/${id}`).not.toBeNull();
                }
            }
        }
    });
});