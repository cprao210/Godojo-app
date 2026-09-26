import { describe, it, expect } from 'vitest';
import { groupMeetingsByCompany, normalizeCompanyKey, stageIndex, AccountMeeting } from './accountUtils';

const now = new Date('2026-09-26T12:00:00Z');

const meeting = (id: string, date: string, ds: AccountMeeting['detailedSummary'], extra: Partial<AccountMeeting> = {}): AccountMeeting => ({
    id, title: `Meeting ${id}`, date, detailedSummary: ds, ...extra,
});

describe('accountUtils', () => {
    it('normalizes company names across legal suffixes and punctuation', () => {
        expect(normalizeCompanyKey('Acme, Inc.')).toBe('acme');
        expect(normalizeCompanyKey('ACME Corp')).toBe('acme');
        expect(normalizeCompanyKey('Vertex Solutions LLC')).toBe('vertex solutions');
    });

    it('groups meetings by company and skips meetings without one', () => {
        const accounts = groupMeetingsByCompany([
            meeting('1', '2026-09-01T10:00:00Z', { company: 'Acme Inc' }),
            meeting('2', '2026-09-20T10:00:00Z', { company: 'ACME' }),
            meeting('3', '2026-09-10T10:00:00Z', { company: null }),
            meeting('4', '2026-09-15T10:00:00Z', { company: 'Globex' }),
            meeting('5', '2026-09-25T10:00:00Z', { company: 'Globex' }, { isProcessed: false }),
        ], now);
        expect(accounts.map(a => a.key)).toEqual(['acme', 'globex']);
        expect(accounts[0].meetings.map(m => m.id)).toEqual(['2', '1']);
        expect(accounts[0].daysSinceLastTouch).toBe(6);
        expect(accounts[1].meetings).toHaveLength(1);
    });

    it('keeps the strongest qualification evidence across meetings', () => {
        const [acct] = groupMeetingsByCompany([
            meeting('1', '2026-09-01T10:00:00Z', {
                company: 'Acme',
                dealStatus: { stage: 'Discovery' },
                bant: { budget: { status: 'Clear', detail: '$50k approved' } },
                meddicc: { champion: { status: 'Partial', detail: 'Jane seems keen' } },
            }),
            meeting('2', '2026-09-20T10:00:00Z', {
                company: 'Acme',
                dealStatus: { stage: 'Demo' },
                bant: { budget: { status: 'Missing', detail: '' } },
                meddicc: { champion: { status: 'Clear', detail: 'Jane is selling internally' } },
            }),
        ], now);
        expect(acct.stage).toBe('Demo');
        expect(acct.bant.budget).toMatchObject({ status: 'clear', detail: '$50k approved', meetingId: '1' });
        expect(acct.meddicc.champion).toMatchObject({ status: 'clear', meetingId: '2' });
        expect(acct.healthScore).toBeGreaterThan(0);
        expect(acct.risks.some(r => /Economic buyer/.test(r.text))).toBe(true);
        expect(acct.risks.some(r => /champion/i.test(r.text))).toBe(false);
    });

    it('collects stakeholders from lead names and non-self participants', () => {
        const [acct] = groupMeetingsByCompany([
            meeting('1', '2026-09-01T10:00:00Z', { company: 'Acme', leadName: 'Jane Doe' }, {
                participants: [
                    { name: 'Me', email: 'me@us.com', self: true },
                    { name: 'Jane Doe', email: 'jane@acme.com' },
                ],
            }),
            meeting('2', '2026-09-20T10:00:00Z', { company: 'Acme', leadName: 'Jane Doe' }, {
                participants: [{ name: 'Bob CFO', email: 'bob@acme.com' }],
            }),
        ], now);
        expect(acct.stakeholders.map(s => s.name)).toEqual(['Jane Doe', 'Bob CFO']);
        expect(acct.stakeholders[0].meetings).toBe(2);
    });

    it('maps stages onto the pipeline', () => {
        expect(stageIndex('Demo')).toBe(2);
        expect(stageIndex('Closed Won')).toBe(5);
        expect(stageIndex('Unknown')).toBe(-1);
    });
});
