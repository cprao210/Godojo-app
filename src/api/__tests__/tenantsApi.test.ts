import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/apiClient', () => ({
    apiFetch: vi.fn().mockResolvedValue({}),
}));

import { apiFetch } from '@/lib/apiClient';
import { tenantsApi } from '@/api';

const mockedApiFetch = vi.mocked(apiFetch);

const bodyOfCall = (i = 0) =>
    JSON.parse((mockedApiFetch.mock.calls[i][1] as RequestInit).body as string);

describe('tenantsApi.create', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs the tenant name', async () => {
        await tenantsApi.create('Acme Inc');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/tenants');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
        expect(bodyOfCall()).toEqual({ name: 'Acme Inc' });
    });
});

describe('tenantsApi.listMine', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('GETs /tenants/me', async () => {
        await tenantsApi.listMine();
        expect(mockedApiFetch).toHaveBeenCalledWith('/tenants/me');
    });
});

describe('tenantsApi.listMembers', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('builds an empty query string and sends the tenant header when no query is given', async () => {
        await tenantsApi.listMembers('t1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/tenants/t1/members');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).headers).toEqual({ 'x-tenant-id': 't1' });
    });

    it('includes only the query params that are set', async () => {
        await tenantsApi.listMembers('t1', { search: 'ann', page: 2 });
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/tenants/t1/members?search=ann&page=2');
    });

    it('omits empty-string params', async () => {
        await tenantsApi.listMembers('t1', { search: '', role: 'admin' as any });
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/tenants/t1/members?role=admin');
    });
});

describe('tenantsApi.inviteMember', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs email and role', async () => {
        await tenantsApi.inviteMember('t1', 'a@b.com', 'member' as any);
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/tenants/t1/invitations');
        expect(bodyOfCall()).toEqual({ email: 'a@b.com', role: 'member' });
    });
});

describe('tenantsApi.listInvitations', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('omits status_filter when not provided', async () => {
        await tenantsApi.listInvitations('t1');
        expect(mockedApiFetch).toHaveBeenCalledWith('/tenants/t1/invitations');
    });

    it('includes status_filter when provided', async () => {
        await tenantsApi.listInvitations('t1', 'pending' as any);
        expect(mockedApiFetch).toHaveBeenCalledWith('/tenants/t1/invitations?status_filter=pending');
    });
});

describe('tenantsApi.getMember', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('fetches the member detail with the tenant header', async () => {
        await tenantsApi.getMember('t1', 'u1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/tenants/t1/members/u1');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).headers).toEqual({ 'x-tenant-id': 't1' });
    });
});

describe('tenantsApi.suspendMember', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('hits the suspend sub-route', async () => {
        await tenantsApi.suspendMember('t1', 'u1');
        expect(mockedApiFetch).toHaveBeenCalledWith('/tenants/t1/members/u1/suspend');
    });
});

describe('tenantsApi.updateMember', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('PATCHes the updates with the tenant header', async () => {
        await tenantsApi.updateMember('t1', 'u1', { role: 'admin' });
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/tenants/t1/members/u1');
        const init = mockedApiFetch.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('PATCH');
        expect(init.headers).toEqual({ 'x-tenant-id': 't1' });
        expect(bodyOfCall()).toEqual({ role: 'admin' });
    });
});

describe('tenantsApi.resendInvitation', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs with tenant_id as a query param', async () => {
        await tenantsApi.resendInvitation('inv1', 't1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/tenants/inv1/resend?tenant_id=t1');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
    });
});

describe('tenantsApi.revokeInvitation', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('PATCHes with tenant_id as a query param', async () => {
        await tenantsApi.revokeInvitation('inv1', 't1');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/tenants/inv1/revoke?tenant_id=t1');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    });
});

describe('tenantsApi.previewInvitation', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('GETs the accept route with the token as a query param (no auth needed)', async () => {
        await tenantsApi.previewInvitation('tok123');
        expect(mockedApiFetch).toHaveBeenCalledWith('/invitations/accept?token=tok123');
    });
});

describe('tenantsApi.acceptInvitation', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs the same accept route', async () => {
        await tenantsApi.acceptInvitation('tok123');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/invitations/accept?token=tok123');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
    });
});

describe('tenantsApi.declineInvitation', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('POSTs the decline route with the token', async () => {
        await tenantsApi.declineInvitation('tok123');
        expect(mockedApiFetch.mock.calls[0][0]).toBe('/invitations/decline?token=tok123');
        expect((mockedApiFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
    });
});

describe('tenantsApi.listMyInvitations', () => {
    beforeEach(() => mockedApiFetch.mockClear());

    it('GETs /invitations/me', async () => {
        await tenantsApi.listMyInvitations();
        expect(mockedApiFetch).toHaveBeenCalledWith('/invitations/me');
    });
});