import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/apiClient', () => ({
    apiFetch: vi.fn().mockResolvedValue([]),
}));

import { apiFetch } from '@/lib/apiClient';
import { companiesApi } from '@/api';

const mockedApiFetch = vi.mocked(apiFetch);

describe('companiesApi.list', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('GETs /companies with defaults and no tenant header when tenantId is omitted', async () => {
        await companiesApi.list();
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/companies?limit=20');
        expect(mockedApiFetch.mock.calls[0][1]).toBeUndefined();
    });

    it('encodes the search term and forwards the tenant header', async () => {
        await companiesApi.list('acme', 50, 't1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/companies?search=acme&limit=50');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).headers).toEqual({ 'x-tenant-id': 't1' });
    });
});

describe('companiesApi.create', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs the name (create-or-get is idempotent server-side)', async () => {
        await companiesApi.create('Acme Inc');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/companies');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
        expect(JSON.parse((mockedApiFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({ name: 'Acme Inc' });
    });

    it('includes domain when given and the tenant header when scoped', async () => {
        await companiesApi.create('Acme', 'acme.com', 't1');
        expect(JSON.parse((mockedApiFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({ name: 'Acme', domain: 'acme.com' });
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).headers).toEqual({ 'x-tenant-id': 't1' });
    });
});
