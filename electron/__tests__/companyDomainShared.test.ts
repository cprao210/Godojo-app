import { describe, it, expect } from 'vitest';

import {
    emailDomainRoot,
    isConsumerEmailDomain,
    deriveExternalAttendeeDomains,
    deriveCompanyCandidates,
} from '../../utils/companyDomainShared';

describe('emailDomainRoot', () => {
    it('strips subdomains and schemes', () => {
        expect(emailDomainRoot('eu.acme.com')).toBe('acme.com');
        expect(emailDomainRoot('https://www.acme.com/x')).toBe('acme.com');
        expect(emailDomainRoot('JOHN@ACME.COM')).toBe('acme.com');
    });

    it('rejects garbage', () => {
        expect(emailDomainRoot('')).toBeNull();
        expect(emailDomainRoot('not a domain')).toBeNull();
        expect(emailDomainRoot('localhost')).toBeNull();
    });
});

describe('isConsumerEmailDomain', () => {
    it('flags the common personal providers', () => {
        for (const d of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com']) {
            expect(isConsumerEmailDomain(d), d).toBe(true);
        }
    });

    it('passes corporate domains through', () => {
        expect(isConsumerEmailDomain('acme.com')).toBe(false);
        expect(isConsumerEmailDomain(null)).toBe(false);
    });
});

describe('deriveExternalAttendeeDomains', () => {
    const attendees = [
        { email: 'alex@godojo.ai', self: true, organizer: true },   // the rep
        { email: 'john@acme.com' },
        { email: 'sarah@acme.com' },
        { email: 'mike@partner.com' },
        { email: 'friend@gmail.com' },                              // consumer
        { email: 'colleague@eu.godojo.ai' },                        // subdomain of the rep's own
    ];

    it('excludes organizer (self/organizer), consumer, and the rep\'s own domain', () => {
        expect(deriveExternalAttendeeDomains(attendees, { userEmail: 'alex@godojo.ai' }))
            .toEqual(['acme.com', 'partner.com']);
    });

    it('excludes only self/organizer-flagged attendees without a userEmail — callers pass the email to cover the rep\'s whole domain', () => {
        // colleague@eu.godojo.ai carries no self/organizer flag: without the
        // signed-in user's email the helper cannot know godojo.ai is internal.
        // Production callers (MeetingPersistence.stopMeeting) always pass it.
        expect(deriveExternalAttendeeDomains(attendees))
            .toEqual(['acme.com', 'partner.com', 'godojo.ai']);
    });

    it('subdomain of the rep\'s own domain is excluded via the userEmail', () => {
        expect(deriveExternalAttendeeDomains(attendees, { userEmail: 'alex@godojo.ai' }))
            .toEqual(['acme.com', 'partner.com']);
    });

    it('returns ALL external domains, most frequent first', () => {
        const meta = [
            { email: 'a@acme.com' }, { email: 'b@acme.com' },
            { email: 'c@partner.com' },
        ];
        expect(deriveExternalAttendeeDomains(meta)).toEqual(['acme.com', 'partner.com']);
    });

    it('returns empty when nothing external exists', () => {
        expect(deriveExternalAttendeeDomains([
            { email: 'rep@godojo.ai', self: true },
            { email: 'friend@gmail.com' },
        ])).toEqual([]);
    });

    it('accepts bare email strings', () => {
        expect(deriveExternalAttendeeDomains(['buyer@acme.com'])).toEqual(['acme.com']);
    });
});

describe('deriveCompanyCandidates', () => {
    it('shapes candidates for the picker', () => {
        expect(deriveCompanyCandidates([
            { email: 'alex@godojo.ai', self: true },
            { email: 'john@acme.com' },
            { email: 'mike@partner.com' },
        ], { userEmail: 'alex@godojo.ai' })).toEqual([
            { name: 'Acme', domain: 'acme.com' },
            { name: 'Partner', domain: 'partner.com' },
        ]);
    });
});
