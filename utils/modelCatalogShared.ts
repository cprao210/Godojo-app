// utils/modelCatalogShared.ts
//
// The SINGLE source of truth for AI model knowledge shared by the Electron
// main process (electron/services/ModelCatalog.ts) and the renderer
// (utils/modelUtils.ts). Pure data + pure functions — no electron imports.
//
// Design goal: provider deprecations (Groq retired its Llama catalog Aug-2026,
// Google shut gemini-3.1-*-preview May-2026) must never again require a code
// change. What lives here is NOT model ids to call, but:
//   - seeds: offline fallback ids per (provider, tier) — the last resort,
//     correct as of the last manual update, used only until a live catalog
//     from the provider's /models endpoint is cached;
//   - tierMatchers: how to classify any live model id into a capability tier
//     (fast / capable / vision) so "give me Groq's capable model" always
//     resolves to whatever is current;
//   - KNOWN_RETIRED: ids we KNOW are dead, mapped to their successor, so
//     stored preferences heal instantly even before any network refresh.
//
// "Auto" selection ids ("auto", "auto:groq", "auto:groq:fast") resolve at call
// time through the live catalog — see ModelCatalog.resolveAuto.

export type ModelTier = 'fast' | 'capable' | 'vision';
export type CatalogProvider = 'gemini' | 'groq' | 'openai' | 'claude';

export const CATALOG_PROVIDERS: CatalogProvider[] = ['gemini', 'groq', 'openai', 'claude'];

export interface ProviderCatalogDef {
    /** Offline fallback per tier, most-preferred first. */
    seeds: Record<ModelTier, string[]>;
    /** Ordered matchers classifying a live /models id into a tier. */
    tierMatchers: Record<ModelTier, RegExp[]>;
    /** Live ids matching these are never used for resolution (non-chat /
     *  preview noise) — they may still be listed in advanced pickers. */
    exclude: RegExp[];
    /** Friendly names for seed + auto ids (dropdowns). */
    displayNames: Record<string, string>;
}

export const MODEL_CATALOG: Record<CatalogProvider, ProviderCatalogDef> = {
    gemini: {
        seeds: {
            fast: ['gemini-3.1-flash-lite'],
            capable: ['gemini-3.1-pro', 'gemini-3.1-flash-lite'],
            vision: ['gemini-3.1-flash-lite'],
        },
        tierMatchers: {
            // GA stable aliases only — dated (-07-25) and -preview variants
            // stay out of auto-resolution but remain pickable manually.
            fast: [/^gemini-[\d.]+-flash-lite$/],
            capable: [/^gemini-[\d.]+-pro$/, /^gemini-[\d.]+-flash$/],
            vision: [/^gemini-[\d.]+-flash$/],
        },
        exclude: [/preview/, /embedding/, /tts/, /image-generation/, /imagen/, /learnlm/, /aqa/, /live/i],
        displayNames: {
            'gemini-3.1-flash-lite': 'Gemini 3.1 Flash',
            'gemini-3.1-pro': 'Gemini 3.1 Pro',
        },
    },
    groq: {
        seeds: {
            fast: ['openai/gpt-oss-20b'],
            capable: ['openai/gpt-oss-120b'],
            // Groq's vision family is Qwen VL; gpt-oss is text-only on Groq.
            vision: ['qwen/qwen3.6-27b'],
        },
        tierMatchers: {
            // small (≤2-digit param) gpt-oss = fast tier; 3-digit = capable.
            fast: [/^openai\/gpt-oss-(?:[1-9]|[1-9]\d)b$/, /^llama-[\d.]+-\d+b-instant$/],
            capable: [/^openai\/gpt-oss-\d+b$/, /^groq\/compound$/, /^llama-[\d.]+-\d+b-versatile$/],
            vision: [/^qwen\//],
        },
        exclude: [/whisper/i, /guard/i, /tts/i, /speech/i, /playai/i, /distil/i, /orca/i, /tool/i],
        displayNames: {
            'openai/gpt-oss-120b': 'Groq GPT-OSS 120B',
            'openai/gpt-oss-20b': 'Groq GPT-OSS 20B',
            'qwen/qwen3.6-27b': 'Groq Qwen VL (Vision)',
        },
    },
    openai: {
        seeds: {
            fast: ['gpt-5.4-mini'],
            capable: ['gpt-5.4'],
            vision: ['gpt-5.4'],
        },
        tierMatchers: {
            fast: [/^gpt-[\d.]+-mini$/, /^o[134]-mini$/],
            capable: [/^gpt-[\d.]+$/, /^o[134]$/],
            vision: [/^gpt-[\d.]+/, /^o[134]$/],
        },
        exclude: [/audio/i, /realtime/i, /embedding/i, /instruct/i, /transcri/i],
        displayNames: {
            'gpt-5.4': 'GPT 5.4',
            'gpt-5.4-mini': 'GPT 5.4 Mini',
        },
    },
    claude: {
        seeds: {
            fast: ['claude-haiku-4-5-20251001'],
            capable: ['claude-sonnet-4-6', 'claude-opus-4-6'],
            vision: ['claude-sonnet-4-6'],
        },
        tierMatchers: {
            fast: [/^claude-haiku/],
            capable: [/^claude-sonnet/, /^claude-opus/],
            vision: [/^claude-(haiku|sonnet|opus)/],
        },
        exclude: [],
        displayNames: {
            'claude-opus-4-6': 'Claude Opus 4.6',
            'claude-sonnet-4-6': 'Claude Sonnet 4.6',
            'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
        },
    },
};

/** Ids we KNOW are retired, mapped to their successor. Applied before any
 *  catalog lookup so stored preferences heal even with no cached catalog. */
export const KNOWN_RETIRED: Record<CatalogProvider, Record<string, string>> = {
    groq: {
        'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
        'llama-3.1-70b-versatile': 'openai/gpt-oss-120b',
        'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
        'meta-llama/llama-4-scout-17b-16e-instruct': 'qwen/qwen3.6-27b',
    },
    gemini: {
        'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
        'gemini-3.1-pro-preview': 'gemini-3.1-pro',
    },
    openai: {},
    claude: {},
};

// ── Auto selection ids ─────────────────────────────────────────────────────
// "auto" (current provider's capable tier), "auto:groq", "auto:groq:fast"…

export function buildAutoId(provider: CatalogProvider, tier: ModelTier = 'capable'): string {
    return `auto:${provider}:${tier}`;
}

export function isAutoId(id: string): boolean {
    return id === 'auto' || id.startsWith('auto:');
}

/** Parses "auto[:provider[:tier]]" → null when tier/provider unknown. */
export function parseAutoId(id: string): { provider: CatalogProvider | null; tier: ModelTier } | null {
    if (!isAutoId(id)) return null;
    const parts = id.split(':');
    const provider = parts[1] ? (parts[1] as CatalogProvider) : null;
    const tier = (parts[2] as ModelTier) || 'capable';
    if (provider && !CATALOG_PROVIDERS.includes(provider)) return null;
    if (!['fast', 'capable', 'vision'].includes(tier)) return null;
    return { provider, tier };
}

export function autoDisplayName(id: string): string | null {
    const parsed = parseAutoId(id);
    if (!parsed) return null;
    const p = parsed.provider
        ? parsed.provider.charAt(0).toUpperCase() + parsed.provider.slice(1)
        : '';
    const tierLabel = parsed.tier === 'fast' ? 'Fast' : parsed.tier === 'vision' ? 'Vision' : '';
    return `${p} Auto${tierLabel ? ` (${tierLabel})` : ' (Recommended)'}`.trim();
}

// ── Pure resolution helpers ────────────────────────────────────────────────

/** Best-effort numeric rank for ordering same-family ids ("gpt-oss-120b" →
 *  120, "gemini-3.1-flash" → 3.1). Matcher order dominates; this only breaks
 *  ties within one matcher family. */
export function versionRank(id: string): number {
    const params = id.match(/(\d+)(?=b\b)/);   // parameter size: 120b
    if (params) return parseInt(params[1], 10);
    const dotted = id.match(/\d+\.\d+/);        // 3.1
    if (dotted) return parseFloat(dotted[0]);
    const plain = id.match(/\d+/);              // 4 (claude-sonnet-4-6)
    return plain ? parseInt(plain[0], 10) : 0;
}

export function isExcludedId(provider: CatalogProvider, id: string): boolean {
    const p = id.toLowerCase();
    return MODEL_CATALOG[provider].exclude.some((re) => re.test(p));
}

/** Which tier an id belongs to (fast > capable > vision check order so e.g.
 *  flash-lite lands in "fast", not "capable"). Null = no tier match. */
export function classifyTier(provider: CatalogProvider, id: string): ModelTier | null {
    const tiers: ModelTier[] = ['fast', 'capable', 'vision'];
    for (const t of tiers) {
        if (MODEL_CATALOG[provider].tierMatchers[t].some((re) => re.test(id))) return t;
    }
    return null;
}

/** Pick the current best id for a tier from a list (live catalog or seeds). */
export function pickTierModel(
    provider: CatalogProvider,
    tier: ModelTier,
    ids: string[],
): string | null {
    const matchers = MODEL_CATALOG[provider].tierMatchers[tier];
    const candidates = ids.filter(
        (id) => !isExcludedId(provider, id) && matchers.some((re) => re.test(id)),
    );
    if (candidates.length === 0) return null;
    // Matcher order first, then highest version within the matcher group.
    for (const re of matchers) {
        const group = candidates.filter((id) => re.test(id));
        if (group.length > 0) {
            return group.sort((a, b) => versionRank(b) - versionRank(a))[0];
        }
    }
    return candidates[0];
}

/** Flatten a provider's seeds (unique, tier order fast→capable→vision). */
export function seedIds(provider: CatalogProvider): string[] {
    const out: string[] = [];
    for (const t of ['fast', 'capable', 'vision'] as ModelTier[]) {
        for (const id of MODEL_CATALOG[provider].seeds[t]) {
            if (!out.includes(id)) out.push(id);
        }
    }
    return out;
}

/** Coarse provider detection for an arbitrary model id (used to route
 *  retirement healing to the right provider's catalog). */
export function detectProvider(id: string): CatalogProvider | null {
    const i = id.toLowerCase();
    if (i.startsWith('gemini-') || i.startsWith('models/')) return 'gemini';
    if (
        i.startsWith('llama-') || i.startsWith('mixtral-') || i.startsWith('gemma-') ||
        i.startsWith('meta-llama/') || i.startsWith('qwen/') || i.startsWith('qwen-') ||
        i.startsWith('openai/gpt-oss') || i.startsWith('groq/')
    ) return 'groq';
    if (i.startsWith('claude-')) return 'claude';
    if (i.startsWith('gpt-') || /^o[134]/.test(i)) return 'openai';
    return null;
}

export function displayNameFor(id: string): string {
    const provider = detectProvider(id);
    const named = provider ? MODEL_CATALOG[provider].displayNames[id] : undefined;
    return named ?? autoDisplayName(id) ?? id;
}