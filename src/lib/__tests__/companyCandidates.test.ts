import { describe, it, expect } from 'vitest';

import {
    emailDomain,
    registrableDomain,
    companyNameFromDomain,
    companyNameFromTitle,
    deriveCompanyCandidates,
    isInternalMeeting,
    resolveActiveCompany,
    type CompanyCandidate,
} from '../companyCandidates';

const names = (r: ReturnType<typeof deriveCompanyCandidates>) => r.candidates.map((c) => c.companyName);
const domains = (r: ReturnType<typeof deriveCompanyCandidates>) => r.candidates.map((c) => c.domain);

describe('emailDomain', () => {
    it('lower-cases and trims', () => {
        expect(emailDomain('  John@GoDojo.AI ')).toBe('godojo.ai');
    });

    it('rejects things that are not emails', () => {
        for (const bad of ['', 'nope', '@godojo.ai', 'john@', 'john@localhost', 'john@bad domain.com', undefined, null, 42]) {
            expect(emailDomain(bad as unknown), String(bad)).toBeNull();
        }
    });

    it('validates only the domain — an unusual local part must not lose the company', () => {
        expect(emailDomain('"john doe"@acme.com')).toBe('acme.com');
    });
});

describe('registrableDomain', () => {
    it('strips ordinary subdomains', () => {
        expect(registrableDomain('acme.com')).toBe('acme.com');
        expect(registrableDomain('eu.acme.com')).toBe('acme.com');
        expect(registrableDomain('mail.eu.acme.com')).toBe('acme.com');
    });

    it('keeps three labels under country-code second-level suffixes (co.in, co.uk, com.au …)', () => {
        expect(registrableDomain('acme.co.in')).toBe('acme.co.in');
        expect(registrableDomain('mail.acme.co.uk')).toBe('acme.co.uk');
        expect(registrableDomain('acme.com.au')).toBe('acme.com.au');
    });

    it('does not mistake a normal two-letter TLD for a suffix pair', () => {
        expect(registrableDomain('foo.acme.io')).toBe('acme.io');
        expect(registrableDomain('acme.co')).toBe('acme.co');
        expect(registrableDomain('foo.acme.co')).toBe('acme.co');
    });
});

describe('companyNameFromDomain / companyNameFromTitle', () => {
    it('names the company, not the suffix', () => {
        expect(companyNameFromDomain('acme.com')).toBe('Acme');
        expect(companyNameFromDomain('acme.co.uk')).toBe('Acme'); // used to come out as "Co"
    });

    it('parses "with X" / "@ X" titles and returns null otherwise', () => {
        expect(companyNameFromTitle('Demo with Acme')).toBe('Acme');
        expect(companyNameFromTitle('weekly sync')).toBeNull();
        expect(companyNameFromTitle(undefined)).toBeNull();
    });
});

describe('deriveCompanyCandidates — same-domain teammates are not prospects', () => {
    // The scenario from the request.
    const attendees = [
        { email: 'jane@godojo.ai' },
        { email: 'peter@godojo.ai' },
        { email: 'kyle@partner.com' },
    ];

    it('excludes the organizer\'s domain AND every attendee on it (user is the organizer)', () => {
        const r = deriveCompanyCandidates(
            { organizer: 'john@godojo.ai', attendees: [{ email: 'john@godojo.ai', self: true }, ...attendees] },
            { userEmail: 'john@godojo.ai' },
        );
        expect(names(r)).toEqual(['Partner']);
        expect(r.internalDomains).toEqual(['godojo.ai']);
    });

    it('regression: with the `self` flag set, non-self teammates on the same domain are still excluded', () => {
        // The old code trusted `self` alone, so jane@ and peter@ became "Godojo".
        const r = deriveCompanyCandidates({
            organizer: 'john@godojo.ai',
            attendees: [{ email: 'jane@godojo.ai', self: true }, { email: 'john@godojo.ai' }, ...attendees.slice(1)],
        });
        expect(names(r)).toEqual(['Partner']);
    });

    it('works from the signed-in email alone, when the invite carries no self flag', () => {
        const r = deriveCompanyCandidates({ attendees }, { userEmail: 'john@godojo.ai' });
        expect(names(r)).toEqual(['Partner']);
    });

    it('falls back to the organizer\'s domain only when nothing else identifies "us"', () => {
        const r = deriveCompanyCandidates({ organizer: 'john@godojo.ai', attendees });
        expect(names(r)).toEqual(['Partner']);
        expect(r.internalDomains).toEqual(['godojo.ai']);
    });

    it('excludes subdomains and sibling subdomains of our own domain', () => {
        const r = deriveCompanyCandidates(
            { attendees: [{ email: 'bob@us.godojo.ai' }, { email: 'eve@godojo.ai' }, { email: 'kyle@partner.com' }] },
            { userEmail: 'alex@eu.godojo.ai' },
        );
        expect(names(r)).toEqual(['Partner']);
    });

    it('is case-insensitive', () => {
        const r = deriveCompanyCandidates(
            { attendees: [{ email: 'JANE@GoDojo.AI' }, { email: 'kyle@Partner.com' }] },
            { userEmail: 'john@godojo.ai' },
        );
        expect(names(r)).toEqual(['Partner']);
    });

    it('returns nothing when everyone is on our domain (internal practice call)', () => {
        const r = deriveCompanyCandidates(
            { organizer: 'john@godojo.ai', attendees: [{ email: 'jane@godojo.ai' }, { email: 'peter@godojo.ai' }] },
            { userEmail: 'john@godojo.ai' },
        );
        expect(r.candidates).toEqual([]);
    });
});

describe('deriveCompanyCandidates — must not discard the real prospect', () => {
    it('client-organized invite: the organizer\'s (client\'s) domain is kept when we can anchor on the user', () => {
        // Inbound booking: the CLIENT sends the invite. The old code's own
        // comment documents that treating `organizer` as "our side" flips
        // internal/external here and researches the wrong company.
        const r = deriveCompanyCandidates(
            {
                organizer: 'lead@partner.com',
                attendees: [{ email: 'lead@partner.com' }, { email: 'rep@godojo.ai', self: true }],
            },
            { userEmail: 'rep@godojo.ai' },
        );
        expect(names(r)).toEqual(['Partner']);
        expect(r.internalDomains).toEqual(['godojo.ai']);
    });

    it('same result from the self flag alone (no signed-in email available, e.g. the popup window)', () => {
        const r = deriveCompanyCandidates({
            organizer: 'lead@partner.com',
            attendees: [{ email: 'lead@partner.com' }, { email: 'rep@godojo.ai', self: true }],
        });
        expect(names(r)).toEqual(['Partner']);
    });

    it('a rep on a .co.in domain does not exclude every other .co.in company', () => {
        const r = deriveCompanyCandidates(
            { attendees: [{ email: 'x@other.co.in' }, { email: 'y@sub.acme.co.in' }, { email: 'z@acme.co.in' }] },
            { userEmail: 'rep@acme.co.in' },
        );
        expect(names(r)).toEqual(['Other']);
        expect(domains(r)).toEqual(['other.co.in']);
        expect(r.internalDomains).toEqual(['acme.co.in']);
    });

    it('ignores consumer providers, malformed emails and the self attendee', () => {
        const r = deriveCompanyCandidates(
            {
                attendees: [
                    { email: 'me@godojo.ai', self: true },
                    { email: 'friend@gmail.com' },
                    { email: 'not-an-email' },
                    { email: undefined },
                    { email: 'kyle@partner.com' },
                ],
            },
            { userEmail: 'me@godojo.ai' },
        );
        expect(names(r)).toEqual(['Partner']);
    });

    it('ignores Google Calendar meeting-room / calendar addresses', () => {
        const r = deriveCompanyCandidates(
            {
                attendees: [
                    { email: 'c_1a2b3c@resource.calendar.google.com' },
                    { email: 'team@group.calendar.google.com' },
                    { email: 'kyle@partner.com' },
                ],
            },
            { userEmail: 'me@godojo.ai' },
        );
        expect(names(r)).toEqual(['Partner']);
    });
});

describe('deriveCompanyCandidates — multiple external companies', () => {
    it('merges subdomains of one company, counts invitees, and ranks by headcount then invite order', () => {
        const r = deriveCompanyCandidates(
            {
                attendees: [
                    { email: 'a@beta.com' },
                    { email: 'b@acme.com' },
                    { email: 'c@eu.acme.com' },
                    { email: 'd@gamma.io' },
                ],
            },
            { userEmail: 'me@godojo.ai' },
        );
        expect(r.candidates).toEqual([
            { companyName: 'Acme', domain: 'acme.com', attendeeCount: 2 },
            { companyName: 'Beta', domain: 'beta.com', attendeeCount: 1 },
            { companyName: 'Gamma', domain: 'gamma.io', attendeeCount: 1 },
        ]);
    });

    it('handles an event with no attendees', () => {
        expect(deriveCompanyCandidates({ title: 'x' }).candidates).toEqual([]);
    });
});

describe('resolveActiveCompany — ask before generating', () => {
    const acme: CompanyCandidate = { companyName: 'Acme', domain: 'acme.com', attendeeCount: 2 };
    const beta: CompanyCandidate = { companyName: 'Beta', domain: 'beta.com', attendeeCount: 1 };

    it('no candidates: falls back to the title guess and does not ask', () => {
        expect(resolveActiveCompany([], null, 'Sarah')).toEqual({
            awaitingSelection: false, selected: null, companyName: 'Sarah', domain: undefined,
        });
        expect(resolveActiveCompany([], null, null).companyName).toBeNull();
    });

    it('exactly one candidate: generates straight away, no question', () => {
        const r = resolveActiveCompany([acme], null, 'ignored');
        expect(r.awaitingSelection).toBe(false);
        expect(r.companyName).toBe('Acme');
        expect(r.domain).toBe('acme.com');
    });

    it('two or more candidates and nothing chosen: waits, and the title guess must not leak through', () => {
        const r = resolveActiveCompany([acme, beta], null, 'Sarah');
        expect(r.awaitingSelection).toBe(true);
        expect(r.selected).toBeNull();
        expect(r.companyName).toBeNull();
        expect(r.domain).toBeUndefined();
    });

    it('two or more candidates once the user has chosen: resolves to the choice', () => {
        const r = resolveActiveCompany([acme, beta], 1, null);
        expect(r.awaitingSelection).toBe(false);
        expect(r.companyName).toBe('Beta');
        expect(r.domain).toBe('beta.com');
    });

    it('a stale/out-of-range index goes back to asking rather than guessing', () => {
        expect(resolveActiveCompany([acme, beta], 5, null).awaitingSelection).toBe(true);
    });
});

describe('isInternalMeeting', () => {
    const me = 'cp@geoserves.com';

    it('is true when every other attendee is on our domain', () => {
        const event = { attendees: [{ email: me, self: true }, { email: 'sahla@geoserves.com' }, { email: 'ayush@eu.geoserves.com' }] };
        expect(isInternalMeeting(event, { userEmail: me })).toBe(true);
    });

    it('is false as soon as one outside attendee is invited', () => {
        const event = { attendees: [{ email: me }, { email: 'sahla@geoserves.com' }, { email: 'buyer@oolka.in' }] };
        expect(isInternalMeeting(event, { userEmail: me })).toBe(false);
    });

    it('ignores meeting rooms and people without an email', () => {
        const event = { attendees: [
            { email: me }, { email: 'sahla@geoserves.com' },
            { email: 'room-3@resource.calendar.google.com' }, { displayName: 'Guest' },
        ] };
        expect(isInternalMeeting(event, { userEmail: me })).toBe(true);
    });

    it("is false when it can't tell", () => {
        expect(isInternalMeeting(undefined, { userEmail: me })).toBe(false);
        expect(isInternalMeeting({ attendees: [{ email: me }] }, { userEmail: me })).toBe(false); // nobody else
        expect(isInternalMeeting({ attendees: [{ email: 'a@acme.com' }] }, {})).toBe(false);       // who are we?
        // a consumer domain says nothing about who is a colleague
        expect(isInternalMeeting({ attendees: [{ email: 'x@gmail.com' }] }, { userEmail: 'me@gmail.com' })).toBe(false);
    });

    it("falls back to the calendar's self flag for our domain", () => {
        const event = { attendees: [{ email: 'cp@geoserves.com', self: true }, { email: 'sahla@geoserves.com' }] };
        expect(isInternalMeeting(event, {})).toBe(true);
    });
});
