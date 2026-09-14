import { describe, expect, it } from 'vitest';

import { diffAcceptedInvitations } from '../useInviteAcceptedWatcher';
import type { Invitation } from '@/types';

const inv = (id: string, status: Invitation['status'], email = `${id}@acme.com`): Invitation => ({
    id,
    tenant_id: 't1',
    email,
    role: 'member',
    token: `tok-${id}`,
    status,
    expires_at: '2030-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
});

describe('diffAcceptedInvitations', () => {
    it('first poll only seeds — pre-existing acceptances never toast on launch', () => {
        const list = [inv('a', 'accepted'), inv('b', 'pending')];
        const { newlyAccepted, snapshot } = diffAcceptedInvitations(null, list);
        expect(newlyAccepted).toEqual([]);
        expect([...snapshot.entries()]).toEqual([['a', 'accepted'], ['b', 'pending']]);
    });

    it('detects pending → accepted transitions', () => {
        const prev = new Map([['a', 'pending'], ['b', 'pending']]);
        const { newlyAccepted } = diffAcceptedInvitations(prev, [inv('a', 'accepted'), inv('b', 'pending')]);
        expect(newlyAccepted.map(i => i.id)).toEqual(['a']);
    });

    it('does not re-notify an invitation already accepted last tick', () => {
        const prev = new Map([['a', 'accepted']]);
        const { newlyAccepted } = diffAcceptedInvitations(prev, [inv('a', 'accepted')]);
        expect(newlyAccepted).toEqual([]);
    });

    it('catches an accept that happened entirely between two polls', () => {
        // Previous poll: 'c' did not exist yet. It shows up already accepted.
        const prev = new Map([['a', 'pending']]);
        const { newlyAccepted } = diffAcceptedInvitations(prev, [inv('a', 'pending'), inv('c', 'accepted')]);
        expect(newlyAccepted.map(i => i.id)).toEqual(['c']);
    });

    it('snapshot keeps every status so later flips revoke→… compare correctly', () => {
        const prev = new Map<string, string>([['a', 'pending']]);
        const { snapshot } = diffAcceptedInvitations(prev, [inv('a', 'revoked'), inv('b', 'expired'), inv('c', 'declined')]);
        expect([...snapshot.entries()]).toEqual([['a', 'revoked'], ['b', 'expired'], ['c', 'declined']]);
    });

    it('tolerates a missing/garbage list', () => {
        const { newlyAccepted, snapshot } = diffAcceptedInvitations(null, null as unknown as Invitation[]);
        expect(newlyAccepted).toEqual([]);
        expect(snapshot.size).toBe(0);
    });
});
