// Covers electron/utils/backendCompanyIntel — the Sales Brief research sent to the backend so
// global chat can use it ("worth", "risks", competitors) as labelled research. Pins: the field
// mapping and caps, the domain normalisation the backend keys on, and that low-confidence or
// domain-less intel never goes up and a failure never throws.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bareDomain,
    resetCompanyIntelSyncForTests,
    syncCompanyIntel,
    toBackendIntel,
} from '../utils/backendCompanyIntel';

const INTEL: Record<string, any> = {
    companyName: 'Oolka',
    website: 'https://www.oolka.in',
    foundedYear: 2021,
    headquarters: 'Bengaluru',
    employeeCount: '200-500',
    industry: 'Fintech',
    revenue: null,
    valuation: null,
    fundingStage: 'Series B',
    latestFundingNews: 'Raised $40M led by Peak XV',
    investors: ['Peak XV'],
    keyProducts: ['Credit score app', 'Collections'],
    competitors: ['CRED', 'Slice'],
    recentNews: [{ headline: 'Oolka launches collections AI', date: '2026-08-02T00:00:00Z', url: 'u', source: null }],
    leadershipChanges: [{ name: 'Asha Rao', role: 'CTO', date: '2026-07-01', url: 'u' }],
    businessModel: 'B2C subscriptions',
    geographicPresence: ['India'],
    topCustomers: null,
    _confidence: 'high',
};

describe('toBackendIntel', () => {
    it('maps the research to the backend fields', () => {
        const body = toBackendIntel(INTEL, null)!;
        expect(body.domain).toBe('oolka.in');                       // from the website when no domain given
        expect(body).toMatchObject({
            company_name: 'Oolka', industry: 'Fintech', company_size: '200-500',
            funding_stage: 'Series B', business_model: 'B2C subscriptions',
            products: ['Credit score app', 'Collections'], competitors: ['CRED', 'Slice'],
        });
        expect(body.annual_revenue).toBeUndefined();
        expect(body.description).toContain('Headquarters: Bengaluru');
        expect(body.description).toContain('Investors: Peak XV');
        expect(body.recent_news).toContain('2026-08-02: Oolka launches collections AI');
        expect(body.recent_news).toContain('Leadership: Asha Rao — CTO (2026-07-01)');
        expect(body.recent_news).toContain('Funding: Raised $40M');
    });

    it('prefers the explicit domain and caps long fields', () => {
        const body = toBackendIntel({ ...INTEL, businessModel: 'x'.repeat(500) }, 'Oolka.in')!;
        expect(body.domain).toBe('oolka.in');
        expect(body.business_model).toHaveLength(300);
    });

    it('returns null without a usable domain', () => {
        expect(toBackendIntel({ ...INTEL, website: null }, null)).toBeNull();
        expect(bareDomain('localhost')).toBeNull();
        expect(bareDomain('HTTPS://www.Oolka.in/about?x=1')).toBe('oolka.in');
    });
});

describe('syncCompanyIntel', () => {
    beforeEach(() => resetCompanyIntelSyncForTests());

    it('sends confident research once per session when asked', async () => {
        const put = vi.fn(async () => { });
        expect(await syncCompanyIntel(INTEL, 'oolka.in', { put, onlyOncePerSession: true })).toBe(true);
        expect(await syncCompanyIntel(INTEL, 'oolka.in', { put, onlyOncePerSession: true })).toBe(false);
        expect(put).toHaveBeenCalledTimes(1);
        expect(await syncCompanyIntel(INTEL, 'oolka.in', { put })).toBe(true);   // a refresh always sends
    });

    it('never sends low-confidence or missing intel', async () => {
        const put = vi.fn(async () => { });
        expect(await syncCompanyIntel({ ...INTEL, _confidence: 'low' }, 'oolka.in', { put })).toBe(false);
        expect(await syncCompanyIntel(null, 'oolka.in', { put })).toBe(false);
        expect(put).not.toHaveBeenCalled();
    });

    it('swallows a failed request', async () => {
        const put = vi.fn(async () => { throw new Error('503'); });
        await expect(syncCompanyIntel(INTEL, 'oolka.in', { put })).resolves.toBe(false);
    });
});
