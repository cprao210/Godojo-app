import { describe, expect, it } from 'vitest';
import {
    isLocalOnlyRow,
    localOnlyRowFilter,
    stripLocalOnlyColumns,
} from '../db/supabaseSyncFilters';

describe('supabaseSyncFilters', () => {
    it('strips local-only meeting columns (incl. owner_uid) without mutating the input', () => {
        const row = { id: 'm1', title: 'Demo', owner_uid: 'u1', meeting_types: '["demo"]' };
        const clean = stripLocalOnlyColumns('meetings', row);
        expect(clean).toEqual({ id: 'm1', title: 'Demo' });
        expect(row.owner_uid).toBe('u1');
    });

    it('leaves tables without local-only columns untouched', () => {
        const row = { id: 7, meeting_id: 'm1', text: 'hi' };
        expect(stripLocalOnlyColumns('transcripts', row)).toBe(row);
    });

    it('flags the live placeholder meeting and its child rows', () => {
        expect(isLocalOnlyRow('meetings', { id: 'live-meeting-current' })).toBe(true);
        expect(isLocalOnlyRow('chunks', { id: 3, meeting_id: 'live-meeting-current' })).toBe(true);
        expect(isLocalOnlyRow('meetings', { id: 'real-meeting' })).toBe(false);
        expect(isLocalOnlyRow('transcripts', { id: 1, meeting_id: null })).toBe(false);
        expect(isLocalOnlyRow('meetings', null)).toBe(false);
    });

    it('builds SQL filters that exclude the placeholder', () => {
        expect(localOnlyRowFilter('meetings')).toEqual({ sql: 'id NOT IN (?)', params: ['live-meeting-current'] });
        expect(localOnlyRowFilter('chunks')).toEqual({
            sql: '(meeting_id IS NULL OR meeting_id NOT IN (?))',
            params: ['live-meeting-current'],
        });
        expect(localOnlyRowFilter('app_state')).toEqual({ sql: '1 = 1', params: [] });
    });
});
