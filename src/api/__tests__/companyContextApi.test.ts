import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/apiClient', () => ({ apiFetch: vi.fn().mockResolvedValue({}) }));

import { apiFetch } from '@/lib/apiClient';
import { companyContextApi } from '@/api/companyContextApi';

const mockedApiFetch = vi.mocked(apiFetch);
const bodyOf = (i = 0) => JSON.parse((mockedApiFetch.mock.calls[i][1] as RequestInit).body as string);

describe('companyContextApi', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('GET /company-context', async () => {
        await companyContextApi.get();
        expect(mockedApiFetch).toHaveBeenCalledWith('/company-context');
    });

    it('PUT upsert sends only provided fields', async () => {
        await companyContextApi.upsert({ name: 'Acme Inc', industry: 'SaaS' });
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/company-context');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('PUT');
        expect(bodyOf()).toEqual({ name: 'Acme Inc', industry: 'SaaS' });
    });

    it('DELETE /company-context', async () => {
        await companyContextApi.delete();
        expect(mockedApiFetch).toHaveBeenCalledWith('/company-context', { method: 'DELETE' });
    });

    it('createPersona honors a client-supplied id (optimistic temp-id)', async () => {
        await companyContextApi.createPersona({ id: 'p-temp', role: 'VP Sales', description: 'pipeline', sort_order: 0 });
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/company-context/personas');
        expect(bodyOf().id).toBe('p-temp');
    });

    it('updatePersona PATCHes the persona path', async () => {
        await companyContextApi.updatePersona('p1', { role: 'CRO' });
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/company-context/personas/p1');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    });

    it('deleteCompetitor DELETEs the competitor path', async () => {
        await companyContextApi.deleteCompetitor('c1');
        expect(mockedApiFetch).toHaveBeenCalledWith('/company-context/competitors/c1', { method: 'DELETE' });
    });
});
