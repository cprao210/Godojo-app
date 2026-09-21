import { describe, it, expect, vi } from 'vitest';

import {
    generateCompanyIntel,
    createTavilySearch,
    isCachedIntelFresh,
    normalizeDomain,
    mentionsDomain,
    INTEL_SCHEMA_VERSION,
    INTEL_CACHE_TTL_MS,
    type TavilyRequest,
    type TavilyResult,
    type SearchFn,
} from '../services/CompanyIntelService';

// ── Fixtures (shaped like the "Raksham" case from the bug report) ───────────

const NOW = new Date('2026-09-21T10:00:00Z');
const DOMAIN = 'raksham.ai';
const NAME = 'Raksham';

const SITE_HOME: TavilyResult = {
    url: 'https://raksham.ai/',
    title: 'Raksham — Workforce management for security teams',
    content:
        'Raksham is a workforce management platform for security companies: staff attendance, guard management, ' +
        'payroll management, task management and geo-tracking. Founded in 2019 by James Symes. Headquartered in Austin, Texas.',
};
const SITE_ABOUT: TavilyResult = {
    url: 'https://raksham.ai/about',
    title: 'About Raksham',
    content: 'Raksham was founded by James Symes. Our team works from Austin, Texas and serves customers across India and the United States.',
};
const PROFILE: TavilyResult = {
    url: 'https://www.crunchbase.com/organization/raksham',
    title: 'Raksham (raksham.ai) - Crunchbase Company Profile',
    content: 'Raksham, founded in 2019, is based in Austin, Texas. Employees: 51-200. Industry: Workforce Management Software.',
};
const FUNDING: TavilyResult = {
    url: 'https://techcrunch.com/2025/11/03/raksham-raises-seed',
    title: 'Raksham raises $4.5 million seed round',
    content: 'Raksham, the workforce platform at raksham.ai, raised a $4.5 million seed round led by Sequoia Surge.',
    published_date: '2025-11-03',
};
const NEWS_RECENT: TavilyResult = {
    url: 'https://news.example.com/raksham-launches-geo-tracking',
    title: 'Raksham launches geo-tracking for guards',
    content: 'Raksham (raksham.ai) launched a geo-tracking module for guard patrols.',
    published_date: '2026-06-10',
};
const NEWS_MID: TavilyResult = {
    url: 'https://news.example.com/raksham-signs-partner',
    title: 'Raksham signs channel partner in Gulf',
    content: 'Raksham announced a channel partnership.',
    published_date: '2026-03-02',
    raw_content: 'Raksham announced a channel partnership. More at [raksham.ai](https://raksham.ai/blog/partner).',
};
const NEWS_OLD: TavilyResult = {
    url: 'https://news.example.com/raksham-2024',
    title: 'Raksham attends 2024 expo',
    content: 'Raksham exhibited at a 2024 security expo.',
    published_date: '2024-11-01',
    raw_content: 'Raksham exhibited at a 2024 security expo. [raksham.ai](https://raksham.ai)',
};
const NEWS_UNDATED: TavilyResult = {
    url: 'https://news.example.com/raksham-undated',
    title: 'Raksham in the spotlight',
    content: 'Raksham is mentioned here without a publication date.',
    raw_content: 'Raksham is mentioned here without a publication date. [raksham.ai](https://raksham.ai)',
};
const LEADERSHIP: TavilyResult = {
    url: 'https://news.example.com/raksham-appoints-cro',
    title: 'Raksham appoints Priya Nair as Chief Revenue Officer',
    content: 'Raksham has appointed Priya Nair as its Chief Revenue Officer.',
    published_date: '2026-05-20',
    raw_content: 'Raksham has appointed Priya Nair as its Chief Revenue Officer. About Raksham: https://raksham.ai',
};
const COMPETITORS: TavilyResult = {
    url: 'https://www.g2.com/products/raksham/competitors',
    title: 'Top Raksham alternatives',
    content: 'Raksham alternatives and competitors include Deputy, Connecteam and When I Work.',
    raw_content: 'Raksham alternatives and competitors. Raksham (raksham.ai) is a workforce platform.',
};
const LINKEDIN: TavilyResult = {
    url: 'https://www.linkedin.com/company/raksham/',
    title: 'Raksham | LinkedIn',
    content: 'Raksham (raksham.ai) | 51-200 employees | Workforce Management Software',
};
// A DIFFERENT company that shares the brand name: right name, wrong domain.
const SAME_NAME_FUNDING: TavilyResult = {
    url: 'https://www.yogaraksham.com/press/series-b',
    title: 'Raksham raises $20 million Series B',
    content: 'Raksham, the yoga studio chain, raised a $20 million Series B led by Lotus Capital.',
    published_date: '2026-04-01',
    raw_content: 'Raksham, the yoga studio chain, raised a $20 million Series B led by Lotus Capital. Visit yogaraksham.com.',
};
const UNRELATED: TavilyResult = {
    url: 'https://example.com/acme-raises',
    title: 'Acme raises $50 million',
    content: 'Acme, an unrelated logistics firm, raised $50 million.',
};

type Sections = Partial<Record<'siteHome' | 'siteAbout' | 'profile' | 'funding' | 'news' | 'leadership' | 'competitors' | 'linkedin', TavilyResult[] | Error>>;

const DEFAULT_SECTIONS: Required<Sections> = {
    siteHome: [SITE_HOME],
    siteAbout: [SITE_ABOUT],
    profile: [PROFILE],
    funding: [FUNDING, UNRELATED],
    news: [NEWS_RECENT, NEWS_MID, NEWS_OLD, NEWS_UNDATED],
    leadership: [LEADERSHIP],
    competitors: [COMPETITORS],
    linkedin: [LINKEDIN],
};

function sectionOf(req: TavilyRequest): keyof Sections {
    if (req.includeDomains?.includes('linkedin.com')) return 'linkedin';
    if (req.includeDomains?.length) return req.query.includes('about us') ? 'siteAbout' : 'siteHome';
    if (req.topic === 'news') return req.query.includes('appoint') ? 'leadership' : 'news';
    if (req.query.includes('funding')) return 'funding';
    if (req.query.includes('competitors')) return 'competitors';
    return 'profile';
}

function makeSearch(sections: Sections = {}) {
    const merged = { ...DEFAULT_SECTIONS, ...sections };
    const calls: TavilyRequest[] = [];
    const search: SearchFn = async (req) => {
        calls.push(req);
        const out = merged[sectionOf(req)];
        if (out instanceof Error) throw out;
        return out;
    };
    return { search, calls };
}

/** Source id the prompt assigned to the result whose url contains `fragment`. */
const idFor = (prompt: string, fragment: string): string => {
    const m = prompt.match(new RegExp(`\\[(S\\d+)\\][^\\n]*url=[^\\n]*${fragment.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    if (!m) throw new Error(`no source for ${fragment} in prompt`);
    return m[1];
};

/** Like idFor, but yields nothing when that section legitimately isn't in the prompt (e.g. its search failed). */
const idsFor = (prompt: string, ...fragments: string[]): string[] =>
    fragments.flatMap((f) => { try { return [idFor(prompt, f)]; } catch { return []; } });

const GOOD_ANSWER = (prompt: string): Record<string, unknown> => ({
    companyName: 'Raksham',
    identityMatch: 'confirmed',
    foundedYear: 2019,
    founders: ['James Symes'],
    headquarters: 'Austin, Texas',
    employeeCount: '51-200',
    industry: 'Workforce Management Software',
    businessModel: 'Software platform',
    keyProducts: ['Staff Attendance', 'Guard Management', 'Payroll Management'],
    geographicPresence: ['India', 'United States'],
    revenue: null,
    valuation: null,
    fundingStage: 'Seed',
    latestFundingNews: 'Raised a $4.5 million seed round',
    investors: ['Sequoia Surge'],
    competitors: ['Deputy', 'Connecteam'],
    topCustomers: null,
    newsSourceIds: idsFor(prompt, 'raksham-launches-geo-tracking', 'raksham-signs-partner'),
    leadershipChanges: idsFor(prompt, 'raksham-appoints-cro').map((sourceId) => ({ name: 'Priya Nair', role: 'Chief Revenue Officer', sourceId })),
});

function makeLlm(answer: (prompt: string) => Record<string, unknown> | string = GOOD_ANSWER) {
    const prompts: string[] = [];
    const generate = vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        const a = answer(prompt);
        return typeof a === 'string' ? a : JSON.stringify(a);
    });
    return { generate, prompts };
}

async function run(opts: { sections?: Sections; answer?: (p: string) => Record<string, unknown> | string; domain?: string | undefined; name?: string } = {}) {
    const { search, calls } = makeSearch(opts.sections);
    const llm = makeLlm(opts.answer);
    const result = await generateCompanyIntel(
        { companyName: opts.name ?? NAME, domain: 'domain' in opts ? opts.domain : DOMAIN },
        { search, generate: llm.generate, now: () => NOW, log: () => { } },
    );
    return { result, calls, ...llm };
}

function ok(r: Awaited<ReturnType<typeof run>>['result']) {
    if (r.success === false) throw new Error(`expected success, got: ${r.error}`);
    return r;
}

// ── Search plan ─────────────────────────────────────────────────────────────

describe('search plan', () => {
    it('restricts ONLY the two own-site queries to the company domain (it used to restrict all six)', async () => {
        const { calls } = await run();
        const restricted = calls.filter((c) => c.includeDomains?.includes(DOMAIN));
        expect(restricted).toHaveLength(2);
        for (const c of calls.filter((c) => !c.includeDomains?.includes(DOMAIN))) {
            // funding / news / leadership / competitors / profile can now reach third-party sources
            expect(c.includeDomains ?? []).not.toContain(DOMAIN);
        }
        const funding = calls.find((c) => c.query.includes('funding'))!;
        expect(funding.includeDomains).toBeUndefined();
    });

    it('LinkedIn is searched by restricting to linkedin.com (the old site: query could never match)', async () => {
        const { calls } = await run();
        const li = calls.find((c) => c.includeDomains?.includes('linkedin.com'))!;
        expect(li.includeDomains).toEqual(['linkedin.com']);
        expect(li.query).not.toContain('site:');
    });

    it('news queries use Tavily\'s news topic with a one-year window, and no stale hard-coded years', async () => {
        const { calls } = await run();
        const news = calls.filter((c) => c.topic === 'news');
        expect(news).toHaveLength(2);
        for (const c of news) {
            expect(c.timeRange).toBe('year');
            expect(c.query).not.toMatch(/2024|2025/);
        }
    });

    it('does not cost more than before (12 Tavily credits: advanced = 2, basic = 1)', async () => {
        const { calls } = await run();
        const credits = calls.reduce((n, c) => n + (c.searchDepth === 'advanced' ? 2 : 1), 0);
        expect(credits).toBeLessThanOrEqual(12);
    });

    it('with no known domain there are no own-site queries and confidence is low', async () => {
        const { calls, result } = await run({ domain: undefined });
        expect(calls.some((c) => c.includeDomains?.includes(DOMAIN))).toBe(false);
        expect(ok(result).intel._confidence).toBe('low');
    });
});

// ── Domain-anchored search ──────────────────────────────────────────────────
// A bare brand name matches every company that ever used it ("Godojo", "Raksham"
// …); a domain identifies exactly one. Third-party research therefore searches
// for — and must be about — the exact domain.

describe('domain-anchored search', () => {
    const thirdParty = (calls: TavilyRequest[]) => calls.filter((c) => !c.includeDomains?.includes(DOMAIN));

    it('anchors every third-party query on the exact domain — the bare brand name never appears', async () => {
        const { calls } = await run();
        const queries = thirdParty(calls);
        expect(queries).toHaveLength(6); // profile, funding, news, leadership, competitors, LinkedIn
        for (const c of queries) {
            expect(c.query).toContain(`"${DOMAIN}"`);
            expect(c.query.replace(/raksham\.ai/gi, '')).not.toMatch(/raksham/i);
        }
    });

    it('falls back to the quoted brand name only when no domain is known', async () => {
        const { calls } = await run({ domain: undefined });
        for (const c of calls) {
            expect(c.query).toContain(`"${NAME}"`);
            expect(c.query).not.toContain('.ai');
        }
    });

    it('asks Tavily for full page text on third-party queries (identity check only), never on own-site ones', async () => {
        const { calls } = await run();
        for (const c of calls) {
            expect(!!c.includeRawContent, c.query).toBe(!c.includeDomains?.includes(DOMAIN));
        }
    });

    it('drops a same-name page about a DIFFERENT company (right name, wrong domain) before the model sees it', async () => {
        const { prompts, result } = await run({
            sections: { funding: [FUNDING, SAME_NAME_FUNDING], news: [NEWS_RECENT, { ...SAME_NAME_FUNDING, url: 'https://news.example.com/yoga-raksham' }] },
            answer: (p) => ({ ...GOOD_ANSWER(p), investors: ['Sequoia Surge', 'Lotus Capital'], newsSourceIds: idsFor(p, 'yoga-raksham', 'raksham-launches-geo-tracking') }),
        });
        expect(prompts[0]).not.toContain('yoga');
        expect(prompts[0]).not.toContain('Lotus Capital');
        expect(prompts[0]).toContain('$4.5 million');
        const { intel } = ok(result);
        expect(intel.investors).toEqual(['Sequoia Surge']);
        expect(intel.recentNews!.map((n) => n.url)).toEqual([NEWS_RECENT.url]);
    });

    it('accepts an article whose excerpt omits the domain when the full page text links to it — and never sends that page text to the model', async () => {
        const { prompts } = await run();
        // NEWS_MID's excerpt has no domain; only its raw_content does.
        expect(prompts[0]).toContain('raksham-signs-partner');
        expect(prompts[0]).not.toContain('raksham.ai/blog/partner');
    });

    it('tells the model the third-party sources were retrieved by exact domain (and not, when there is no domain)', async () => {
        expect((await run()).prompts[0]).toContain('exact domain raksham.ai');
        expect((await run({ domain: undefined })).prompts[0]).not.toContain('exact domain');
    });

    it('with no domain, name-only pages are still accepted (nothing better exists) — confidence stays low', async () => {
        const { prompts, result } = await run({ domain: undefined, sections: { competitors: [{ url: 'https://www.g2.com/x', title: 'Raksham alternatives', content: 'Raksham competitors include Deputy.' }] } });
        expect(prompts[0]).toContain('g2.com/x');
        expect(ok(result).intel._confidence).toBe('low');
    });

    it('cache entries written by the older, name-anchored pipeline are regenerated', () => {
        expect(INTEL_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
        expect(isCachedIntelFresh({ _schema: 3, _generatedAt: new Date(NOW.getTime() - 1000).toISOString() }, NOW)).toBe(false);
    });
});

describe('mentionsDomain', () => {
    it('matches the domain as a whole token: bare, with a path, on a subdomain, in an email or a link', () => {
        for (const text of [
            'Raksham (raksham.ai) raised', 'see www.raksham.ai/pricing today', 'https://app.raksham.ai/login',
            'mail info@raksham.ai', '[Raksham](https://raksham.ai)', 'Website: RAKSHAM.AI', 'Visit raksham.ai.', 'raksham.ai, and more',
        ]) expect(mentionsDomain(text, 'raksham.ai'), text).toBe(true);
    });

    it('does not match look-alikes: longer names, longer TLDs, trailing labels, other TLDs, no dot', () => {
        for (const text of [
            'notraksham.ai', 'raksham.airlines', 'raksham.ai.evil.com', 'raksham.io', 'raksham ai', 'my-raksham.ai', 'yogaraksham.com',
        ]) expect(mentionsDomain(text, 'raksham.ai'), text).toBe(false);
    });
});

// ── Per-field source links ──────────────────────────────────────────────────
// Every displayed field gets ONE link to a retrieved page that actually supports
// it, so a rep can click through and verify. Attribution is done in code from the
// retrieved text — never taken from the model — and a field nothing supports gets
// no link (rather than a misleading one).

describe('per-field source links (_fieldSources)', () => {
    const urls = (fs: Record<string, { url: string }> | undefined) =>
        Object.fromEntries(Object.entries(fs ?? {}).map(([k, v]) => [k, v.url]));

    it('links each grounded field to the retrieved page that supports it', async () => {
        const { intel } = ok((await run()).result);
        expect(urls(intel._fieldSources)).toEqual({
            foundedYear: SITE_HOME.url,
            founders: SITE_ABOUT.url,             // "was founded by James Symes" states it outright; the home page says "founded in 2019 by"
            headquarters: SITE_HOME.url,
            employeeCount: LINKEDIN.url,          // profile page AND LinkedIn state it; LinkedIn is preferred for headcount
            industry: PROFILE.url,                // the page that states it in full beats one that states two of three words
            fundingStage: FUNDING.url,
            latestFundingNews: FUNDING.url,
            investors: FUNDING.url,
            keyProducts: SITE_HOME.url,
            competitors: COMPETITORS.url,
            geographicPresence: SITE_ABOUT.url,
        });
    });

    it('carries a title for each link (page title, else host)', async () => {
        const { intel } = ok((await run()).result);
        expect(intel._fieldSources!.fundingStage).toEqual({ url: FUNDING.url, title: FUNDING.title });
    });

    it('has no entry for a field that is empty', async () => {
        const { intel } = ok((await run()).result);
        for (const k of ['revenue', 'valuation', 'topCustomers']) expect(intel._fieldSources).not.toHaveProperty(k);
    });

    it('a value no retrieved page supports is still shown (existing behaviour) but gets NO link', async () => {
        const { intel } = ok((await run({ answer: (p) => ({ ...GOOD_ANSWER(p), industry: 'Quantum Biotechnology Instruments' }) })).result);
        expect(intel.industry).toBe('Quantum Biotechnology Instruments');
        expect(intel._fieldSources).not.toHaveProperty('industry');
    });

    it('a vague free-text value that pages only half-match gets no link (better none than a misleading one)', async () => {
        // "Software platform": SITE_HOME has "platform" but not "software"; PROFILE has "software" but not "platform".
        const { intel } = ok((await run()).result);
        expect(intel.businessModel).toBe('Software platform');
        expect(intel._fieldSources).not.toHaveProperty('businessModel');
    });

    it('links come only from retrieved pages — URLs the model supplies are ignored', async () => {
        const { intel } = ok((await run({
            answer: (p) => ({ ...GOOD_ANSWER(p), fieldSources: { industry: 'https://evil.example/x' }, sourceUrls: { employeeCount: 'https://evil.example/y' } }),
        })).result);
        const known = new Set((Object.values(DEFAULT_SECTIONS) as TavilyResult[][]).flat().map((r) => r.url));
        for (const v of Object.values(intel._fieldSources!)) expect(known.has(v.url), v.url).toBe(true);
    });

    it('the pages the links point to are listed in _sources', async () => {
        const { intel } = ok((await run()).result);
        const listed = new Set(intel._sources.map((s) => s.url));
        for (const v of Object.values(intel._fieldSources!)) expect(listed.has(v.url), v.url).toBe(true);
    });

    it('a number is only linked to a page that actually contains it', async () => {
        // Only the LinkedIn page states 51-200 now; the profile says something else.
        const { intel } = ok((await run({ sections: { profile: [{ ...PROFILE, content: 'Raksham, founded in 2019, is based in Austin, Texas. Employees: 11-50.' }] } })).result);
        expect(intel._fieldSources!.employeeCount!.url).toBe(LINKEDIN.url);
        const { intel: none } = ok((await run({ sections: { linkedin: [], profile: [{ ...PROFILE, content: 'Raksham, founded in 2019, is based in Austin, Texas. Employees: 11-50.' }] } })).result);
        expect(none.employeeCount).toBeNull(); // ungrounded → dropped, exactly as before
        expect(none._fieldSources).not.toHaveProperty('employeeCount');
    });

    it('ignores non-http(s) result URLs so a link can never be a javascript:/file: URL', async () => {
        const evil = { url: 'javascript:alert(1)//raksham.ai', title: 'Raksham', content: 'Raksham (raksham.ai) has 51-200 employees.' };
        const { intel, prompts } = await (async () => {
            const r = await run({ sections: { profile: [evil, PROFILE] } });
            return { intel: ok(r.result).intel, prompts: r.prompts };
        })();
        expect(prompts[0]).not.toContain('javascript:');
        for (const v of Object.values(intel._fieldSources!)) expect(v.url).toMatch(/^https?:\/\//);
    });
});

// ── What the model gets to see ──────────────────────────────────────────────

describe('prompt construction', () => {
    it('gives every section its own budget — late sections are no longer cut off by early ones', async () => {
        const huge = (url: string) => ({ url, title: 't', content: `Raksham ${'x'.repeat(5000)}` });
        const { prompts } = await run({
            sections: {
                siteHome: [huge('https://raksham.ai/a'), huge('https://raksham.ai/b'), huge('https://raksham.ai/c')],
                siteAbout: [huge('https://raksham.ai/d')],
                profile: [huge('https://www.crunchbase.com/organization/raksham')],
            },
        });
        // The old code sliced the joined text to 10,000 chars, so LinkedIn (last) never arrived.
        expect(prompts[0]).toContain('linkedin.com/company/raksham');
        expect(prompts[0]).toContain('Deputy');
    });

    it('never shows the model a third-party page that does not mention the company', async () => {
        const { prompts } = await run();
        expect(prompts[0]).not.toContain('Acme');
        expect(prompts[0]).toContain('$4.5 million');
    });

    it('tags tiers, states today\'s date, and marks web text as untrusted', async () => {
        const { prompts } = await run();
        expect(prompts[0]).toContain('2026-09-21');
        expect(prompts[0]).toContain('tier=SITE');
        expect(prompts[0]).toContain('tier=NEWS');
        expect(prompts[0]).toMatch(/untrusted/i);
        expect(prompts[0]).toMatch(/null is always better than a guess/i);
    });
});

// ── Verifying the model's answer ────────────────────────────────────────────

describe('grounding: nothing the sources do not support survives', () => {
    it('drops invented numbers, names, stages and places; keeps supported ones', async () => {
        const { result } = await run({
            answer: (p) => ({
                ...GOOD_ANSWER(p),
                foundedYear: 2010,                           // not in any source
                employeeCount: '5,000 employees',            // not in any source
                fundingStage: 'Bootstrapped',                // not in any source
                headquarters: 'Berlin, Germany',             // not in any source
                investors: ['Sequoia Surge', 'Andreessen Horowitz'],
                competitors: ['Deputy', 'Workday'],
                founders: ['James Symes', 'Jane Invented'],
                geographicPresence: ['India', 'Worldwide', 'Brazil'],
            }),
        });
        const { intel } = ok(result);
        expect(intel.foundedYear).toBeNull();
        expect(intel.companyAge).toBeNull();
        expect(intel.employeeCount).toBeNull();
        expect(intel.fundingStage).toBeNull();
        expect(intel.headquarters).toBeNull();
        expect(intel.investors).toEqual(['Sequoia Surge']);
        expect(intel.competitors).toEqual(['Deputy']);
        expect(intel.founders).toEqual(['James Symes']);
        expect(intel.geographicPresence).toEqual(['India']); // "Worldwide" is marketing; "Brazil" is unsupported
    });

    it('keeps values that ARE in the sources', async () => {
        const { intel } = ok((await run()).result);
        expect(intel.foundedYear).toBe(2019);
        expect(intel.employeeCount).toBe('51-200');
        expect(intel.fundingStage).toBe('Seed');
        expect(intel.headquarters).toBe('Austin, Texas');
        expect(intel.investors).toEqual(['Sequoia Surge']);
        expect(intel.competitors).toEqual(['Deputy', 'Connecteam']);
    });

    it('computes company age in code — the model\'s own arithmetic is ignored', async () => {
        const { intel } = ok((await run({ answer: (p) => ({ ...GOOD_ANSWER(p), companyAge: 12 }) })).result);
        expect(intel.foundedYear).toBe(2019);
        expect(intel.companyAge).toBe(7); // 2026 − 2019, not 12
    });

    it('never lists the company as its own competitor', async () => {
        const { intel } = ok((await run({
            sections: { competitors: [{ ...COMPETITORS, content: 'Raksham competitors include Raksham, Deputy.' }] },
            answer: (p) => ({ ...GOOD_ANSWER(p), competitors: ['Raksham', 'Deputy'] }),
        })).result);
        expect(intel.competitors).toEqual(['Deputy']);
    });

    it('website is the domain we researched; LinkedIn is a retrieved URL — model-supplied URLs are ignored', async () => {
        const { intel } = ok((await run({
            answer: (p) => ({ ...GOOD_ANSWER(p), website: 'https://totally-other.com', linkedinUrl: 'https://linkedin.com/company/invented' }),
        })).result);
        expect(intel.website).toBe('https://raksham.ai');
        expect(intel.linkedinUrl).toBe('https://www.linkedin.com/company/raksham');
    });

    it('no LinkedIn link at all when the search did not find the company page', async () => {
        const { intel } = ok((await run({
            sections: { linkedin: [{ url: 'https://www.linkedin.com/in/someone', title: 'Someone', content: 'Raksham employee' }] },
            answer: (p) => ({ ...GOOD_ANSWER(p), linkedinUrl: 'https://linkedin.com/company/raksham' }),
        })).result);
        expect(intel.linkedinUrl).toBeNull();
    });
});

describe('news: headline, link and date always belong to the same article', () => {
    it('builds items from the chosen articles, newest first, dropping old/undated/unknown ids', async () => {
        const { intel } = ok((await run({
            answer: (p) => ({
                ...GOOD_ANSWER(p),
                newsSourceIds: [
                    idFor(p, 'raksham-signs-partner'),
                    idFor(p, 'raksham-launches-geo-tracking'),
                    idFor(p, 'raksham-2024'),        // older than a year
                    idFor(p, 'raksham-undated'),     // no publication date
                    'S999',                           // does not exist
                ],
            }),
        })).result);
        expect(intel.recentNews).toEqual([
            { headline: 'Raksham launches geo-tracking for guards', date: '2026-06-10', url: NEWS_RECENT.url, source: 'news.example.com' },
            { headline: 'Raksham signs channel partner in Gulf', date: '2026-03-02', url: NEWS_MID.url, source: 'news.example.com' },
        ]);
    });

    it('regression: picking only the SECOND retrieved article links to the second article (used to link the first)', async () => {
        const { intel } = ok((await run({
            answer: (p) => ({ ...GOOD_ANSWER(p), newsSourceIds: [idFor(p, 'raksham-signs-partner')] }),
        })).result);
        expect(intel.recentNews).toHaveLength(1);
        expect(intel.recentNews![0].url).toBe(NEWS_MID.url);
        expect(intel.recentNews![0].headline).toBe(NEWS_MID.title);
        expect(intel._newsSnippets).toEqual([{ title: NEWS_MID.title, url: NEWS_MID.url, date: '2026-03-02' }]);
    });

    it('a headline the model invents cannot appear — only retrieved articles can', async () => {
        const { intel } = ok((await run({
            answer: (p) => ({ ...GOOD_ANSWER(p), newsSourceIds: null, recentNews: [{ headline: 'Raksham acquired by MegaCorp' }] }),
        })).result);
        expect(intel.recentNews).toBeNull();
    });
});

describe('leadership: announced changes only', () => {
    it('keeps a grounded, announced change, dated by the announcing article', async () => {
        const { intel } = ok((await run()).result);
        expect(intel.leadershipChanges).toEqual([{ name: 'Priya Nair', role: 'Chief Revenue Officer', date: '2026-05-20', url: LEADERSHIP.url }]);
    });

    it('drops un-grounded names, undated sources and non-news sources', async () => {
        const { intel } = ok((await run({
            answer: (p) => ({
                ...GOOD_ANSWER(p),
                leadershipChanges: [
                    { name: 'Invented Person', role: 'CEO', sourceId: idFor(p, 'raksham-appoints-cro') },
                    { name: 'Priya Nair', role: 'CRO', sourceId: idFor(p, 'raksham-undated') },
                    { name: 'James Symes', role: 'CEO', sourceId: idFor(p, 'raksham.ai/about') },
                ],
            }),
        })).result);
        expect(intel.leadershipChanges).toBeNull();
    });
});

// ── Confidence, warnings, caching ───────────────────────────────────────────

describe('confidence and warnings', () => {
    it('high: domain known, own site read, identity confirmed — and cacheable', async () => {
        const r = ok((await run()).result);
        expect(r.intel._confidence).toBe('high');
        expect(r.intel._warnings).toEqual([]);
        expect(r.cacheable).toBe(true);
        expect(r.intel._schema).toBe(INTEL_SCHEMA_VERSION);
        expect(r.intel._generatedAt).toBe(NOW.toISOString());
        expect(r.intel._sources.length).toBeGreaterThan(0);
    });

    it('medium + warning when the company website could not be read', async () => {
        const r = ok((await run({ sections: { siteHome: [], siteAbout: [] } })).result);
        expect(r.intel._confidence).toBe('medium');
        expect(r.intel._warnings.join(' ')).toMatch(/website/i);
    });

    it('medium + warning when the model is unsure the sources are the same company', async () => {
        const r = ok((await run({ answer: (p) => ({ ...GOOD_ANSWER(p), identityMatch: 'uncertain' }) })).result);
        expect(r.intel._confidence).toBe('medium');
        expect(r.intel._warnings.join(' ')).toMatch(/similar name/i);
    });

    it('low + explicit warning + not cached when the company was only guessed from a title', async () => {
        const r = ok((await run({ domain: undefined })).result);
        expect(r.intel._confidence).toBe('low');
        expect(r.intel._warnings.join(' ')).toMatch(/meeting title/i);
        expect(r.cacheable).toBe(false);
    });

    it('a name collision (identityMatch=mismatch) yields NO facts, not another company\'s facts', async () => {
        const r = ok((await run({ answer: (p) => ({ ...GOOD_ANSWER(p), identityMatch: 'mismatch' }) })).result);
        expect(r.intel.industry).toBeNull();
        expect(r.intel.foundedYear).toBeNull();
        expect(r.intel.recentNews).toBeNull();
        expect(r.intel._confidence).toBe('low');
        expect(r.intel._warnings.join(' ')).toMatch(/different company/i);
        expect(r.cacheable).toBe(false);
    });

    it('one failed lookup: shown with a warning, still cached; several failures: not cached', async () => {
        const one = ok((await run({ sections: { competitors: new Error('Tavily error: 500') } })).result);
        expect(one.intel._warnings.join(' ')).toMatch(/1 of 8 lookups failed/);
        expect(one.cacheable).toBe(true);

        const many = ok((await run({ sections: { competitors: new Error('x'), news: new Error('x'), leadership: new Error('x') } })).result);
        expect(many.intel._warnings.join(' ')).toMatch(/3 of 8 lookups failed/);
        expect(many.cacheable).toBe(false);
    });

    it('sparse results are not cached (they used to be, permanently)', async () => {
        const r = ok((await run({
            answer: () => ({ companyName: 'Raksham', identityMatch: 'confirmed', industry: 'Software' }),
        })).result);
        expect(r.cacheable).toBe(false);
    });
});

describe('failure handling', () => {
    it('all lookups failing is an error naming the cause (was: an LLM asked to extract from nothing)', async () => {
        const err = new Error('Tavily error: 401');
        const { result, generate } = await run({
            sections: Object.fromEntries(Object.keys(DEFAULT_SECTIONS).map((k): [string, Error] => [k, err])) as Sections,
        });
        expect(result.success).toBe(false);
        if (result.success === false) expect(result.error).toMatch(/401/);
        expect(generate).not.toHaveBeenCalled();
    });

    it('nothing relevant found: empty low-confidence result, the model is NOT asked to answer from memory', async () => {
        const { result, generate } = await run({
            sections: Object.fromEntries(Object.keys(DEFAULT_SECTIONS).map((k): [string, TavilyResult[]] => [k, []])) as Sections,
        });
        const r = ok(result);
        expect(generate).not.toHaveBeenCalled();
        expect(r.intel.industry).toBeNull();
        expect(r.intel._confidence).toBe('low');
        expect(r.cacheable).toBe(false);
    });

    it('surfaces an LLM failure, and unparseable output', async () => {
        const { search } = makeSearch();
        const deps = { search, now: () => NOW, log: () => { } };
        const failing = await generateCompanyIntel({ companyName: NAME, domain: DOMAIN }, { ...deps, generate: async () => { throw new Error('All reasoning models failed'); } });
        expect(failing.success).toBe(false);
        const garbage = await generateCompanyIntel({ companyName: NAME, domain: DOMAIN }, { ...deps, generate: async () => 'sorry, I cannot help' });
        expect(garbage).toEqual({ success: false, error: 'Could not parse company intelligence' });
    });

    it('accepts JSON wrapped in markdown fences or prose', async () => {
        const fenced = await run({ answer: (p) => '```json\n' + JSON.stringify(GOOD_ANSWER(p)) + '\n```' });
        expect(ok(fenced.result).intel.foundedYear).toBe(2019);
        const prose = await run({ answer: (p) => 'Here you go: ' + JSON.stringify(GOOD_ANSWER(p)) });
        expect(ok(prose.result).intel.foundedYear).toBe(2019);
    });
});

// ── Tavily client ───────────────────────────────────────────────────────────

describe('createTavilySearch', () => {
    const json = (status: number, body: unknown = { results: [] }) =>
        ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    it('sends include_domains only when given, turns the unused answer off, and applies topic/time_range', async () => {
        const fetchImpl = vi.fn(async () => json(200, { results: [{ url: 'https://a.com', content: 'x' }] }));
        const search = createTavilySearch('key', { fetchImpl: fetchImpl as unknown as typeof fetch });

        await search({ query: 'q', searchDepth: 'basic', maxResults: 3 });
        await search({ query: 'q', searchDepth: 'advanced', maxResults: 3, includeDomains: ['raksham.ai'], topic: 'news', timeRange: 'year' });

        const bodies = fetchImpl.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
        expect(bodies[0]).not.toHaveProperty('include_domains');
        expect(bodies[0]).not.toHaveProperty('topic');
        expect(bodies[0].include_answer).toBe(false);
        expect(bodies[1].include_domains).toEqual(['raksham.ai']);
        expect(bodies[1].topic).toBe('news');
        expect(bodies[1].time_range).toBe('year');
    });

    it('requests raw page content only when the request asks for it', async () => {
        const fetchImpl = vi.fn(async () => json(200, { results: [] }));
        const search = createTavilySearch('key', { fetchImpl: fetchImpl as unknown as typeof fetch });

        await search({ query: 'q', searchDepth: 'basic', maxResults: 3 });
        await search({ query: 'q', searchDepth: 'basic', maxResults: 3, includeRawContent: true });

        const bodies = fetchImpl.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
        expect(bodies[0].include_raw_content).toBe(false);
        expect(bodies[1].include_raw_content).toBe(true);
    });

    it('retries 429 with backoff and then succeeds', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(json(429))
            .mockResolvedValueOnce(json(503))
            .mockResolvedValueOnce(json(200, { results: [{ url: 'https://a.com', content: 'ok' }] }));
        const sleep = vi.fn(async () => { });
        const search = createTavilySearch('key', { fetchImpl: fetchImpl as unknown as typeof fetch, sleep });

        const out = await search({ query: 'q', searchDepth: 'basic', maxResults: 1 });
        expect(out).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('does not retry a bad API key (401)', async () => {
        const fetchImpl = vi.fn(async () => json(401));
        const search = createTavilySearch('bad', { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => { } });
        await expect(search({ query: 'q', searchDepth: 'basic', maxResults: 1 })).rejects.toThrow('Tavily error: 401');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('retries network errors, then gives up with the last error', async () => {
        const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
        const search = createTavilySearch('key', { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => { } });
        await expect(search({ query: 'q', searchDepth: 'basic', maxResults: 1 })).rejects.toThrow('fetch failed');
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
});

// ── Cache freshness ─────────────────────────────────────────────────────────

describe('isCachedIntelFresh', () => {
    const fresh = (offsetMs: number, schema: number = INTEL_SCHEMA_VERSION) => ({
        _schema: schema,
        _generatedAt: new Date(NOW.getTime() - offsetMs).toISOString(),
    });

    it('accepts current-schema entries younger than the TTL', () => {
        expect(isCachedIntelFresh(fresh(60_000), NOW)).toBe(true);
        expect(isCachedIntelFresh(fresh(INTEL_CACHE_TTL_MS - 1000), NOW)).toBe(true);
    });

    it('rejects expired entries', () => {
        expect(isCachedIntelFresh(fresh(INTEL_CACHE_TTL_MS + 1000), NOW)).toBe(false);
    });

    it('rejects entries from the old pipeline (no schema) so wrong cached intel is regenerated', () => {
        expect(isCachedIntelFresh({ companyName: 'Raksham', industry: 'x' }, NOW)).toBe(false);
        expect(isCachedIntelFresh({ _generatedAt: new Date(NOW.getTime() - 1000).toISOString() }, NOW)).toBe(false);
        expect(isCachedIntelFresh(fresh(1000, INTEL_SCHEMA_VERSION - 1), NOW)).toBe(false);
    });

    it('rejects garbage and future timestamps', () => {
        for (const bad of [null, undefined, 'x', 3, {}, { _schema: INTEL_SCHEMA_VERSION, _generatedAt: 'not a date' }, fresh(-60_000)]) {
            expect(isCachedIntelFresh(bad, NOW), JSON.stringify(bad)).toBe(false);
        }
    });
});

describe('normalizeDomain', () => {
    it('reduces urls/hosts to a bare domain', () => {
        expect(normalizeDomain('https://www.Raksham.ai/about?x=1')).toBe('raksham.ai');
        expect(normalizeDomain('raksham.ai')).toBe('raksham.ai');
        expect(normalizeDomain('')).toBeUndefined();
        expect(normalizeDomain('localhost')).toBeUndefined();
        expect(normalizeDomain(undefined)).toBeUndefined();
    });
});