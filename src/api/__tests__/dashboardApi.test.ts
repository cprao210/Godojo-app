import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/apiClient', () => ({
    apiFetch: vi.fn().mockResolvedValue({}),
}));

import { apiFetch } from '@/lib/apiClient';
import { dashboardApi } from '@/api';

const mockedApiFetch = vi.mocked(apiFetch);

describe('dashboardApi.get', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('builds the query string with tenant_id and period', async () => {
        await dashboardApi.get('tenant-1', 'last_week');
        expect(mockedApiFetch).toHaveBeenCalledWith('/dashboard?tenant_id=tenant-1&period=last_week');
    });

    it('URL-encodes tenant_id', async () => {
        await dashboardApi.get('tenant/with spaces', 'last_30_days');
        expect(mockedApiFetch).toHaveBeenCalledWith(
            '/dashboard?tenant_id=tenant%2Fwith%20spaces&period=last_30_days',
        );
    });

    it('resolves with whatever apiFetch returns', async () => {
        const payload = { totals: { meetings: 5 } };
        mockedApiFetch.mockResolvedValueOnce(payload);
        await expect(dashboardApi.get('tenant-1', 'last_quarter')).resolves.toEqual(payload);
    });
});