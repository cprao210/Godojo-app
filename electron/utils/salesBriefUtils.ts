/**
 * Sales Brief Utilities
 * Extracts company info from attendee emails, classifies participants,
 * and infers meeting type from title keywords.
 */

const GENERIC_DOMAINS = new Set([
    'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com',
    'aol.com', 'protonmail.com', 'mail.com', 'live.com', 'me.com',
    'msn.com', 'ymail.com', 'zoho.com', 'fastmail.com', 'tutanota.com',
]);

export interface AttendeeInfo {
    email: string;
    name?: string;
    domain: string;
    company: string | null; // null for generic domains
    isInternal: boolean;
}

export interface MeetingClassification {
    type: 'discovery' | 'demo' | 'follow-up' | 'negotiation' | 'onboarding' | 'general';
    label: string;
}

/**
 * Extract company name from an email domain.
 * Returns null for generic consumer email domains.
 */
export function extractCompanyFromEmail(email: string): string | null {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || GENERIC_DOMAINS.has(domain)) return null;

    // Take the second-level domain and capitalize
    const parts = domain.split('.');
    const companySlug = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return companySlug.charAt(0).toUpperCase() + companySlug.slice(1);
}

/**
 * Classify attendees into internal (same domain as organizer) and external (prospects).
 */
export function classifyAttendees(
    attendees: Array<{ email: string; name?: string }>,
    organizerEmail: string
): { internal: AttendeeInfo[]; external: AttendeeInfo[] } {
    const orgDomain = organizerEmail.split('@')[1]?.toLowerCase() || '';

    const internal: AttendeeInfo[] = [];
    const external: AttendeeInfo[] = [];

    for (const att of attendees) {
        const domain = att.email.split('@')[1]?.toLowerCase() || '';
        const company = extractCompanyFromEmail(att.email);
        const isInternal = domain === orgDomain;

        const info: AttendeeInfo = {
            email: att.email,
            name: att.name,
            domain,
            company,
            isInternal,
        };

        if (isInternal) {
            internal.push(info);
        } else {
            external.push(info);
        }
    }

    return { internal, external };
}

/**
 * Infer meeting type from the title string.
 */
export function inferMeetingType(title: string): MeetingClassification {
    const t = title.toLowerCase();

    if (/intro|discovery|connect|initial|first\s+call|exploratory/.test(t)) {
        return { type: 'discovery', label: 'Discovery Call' };
    }
    if (/demo|walkthrough|product\s+tour|showcase|presentation/.test(t)) {
        return { type: 'demo', label: 'Product Demo' };
    }
    if (/follow[\s-]?up|sync|check[\s-]?in|touch\s+base|status|recap/.test(t)) {
        return { type: 'follow-up', label: 'Follow-up Meeting' };
    }
    if (/negotiat|pricing|proposal|contract|deal|close/.test(t)) {
        return { type: 'negotiation', label: 'Negotiation / Pricing' };
    }
    if (/onboard|kickoff|kick[\s-]?off|welcome|setup|implementation/.test(t)) {
        return { type: 'onboarding', label: 'Onboarding / Kickoff' };
    }

    return { type: 'general', label: 'Sales Meeting' };
}

/**
 * Build a structured context string for the LLM prompt from calendar event data.
 */
export function buildSalesBriefContext(event: {
    title: string;
    startTime: string;
    endTime: string;
    attendees?: Array<{ email: string; name?: string }>;
    organizer?: string;
    description?: string;
}): string {
    const attendees = event.attendees || [];
    const organizer = event.organizer || '';
    const { internal, external } = classifyAttendees(attendees, organizer);
    const meetingType = inferMeetingType(event.title);

    const prospectCompanies = [...new Set(
        external.map(a => a.company).filter(Boolean)
    )];

    const lines: string[] = [
        `Meeting Title: ${event.title}`,
        `Meeting Type (inferred): ${meetingType.label}`,
        `Date & Time: ${new Date(event.startTime).toLocaleString()} – ${new Date(event.endTime).toLocaleTimeString()}`,
        `Organizer: ${organizer}`,
        '',
        '--- Attendees ---',
        `Internal participants (${internal.length}):`,
        ...internal.map(a => `  - ${a.name || a.email} (${a.email})`),
        `External / Prospect participants (${external.length}):`,
        ...external.map(a => `  - ${a.name || a.email} (${a.email})${a.company ? ` — Company: ${a.company}` : ''}`),
        '',
        `Prospect companies: ${prospectCompanies.length > 0 ? prospectCompanies.join(', ') : 'Unknown (generic email domains)'}`,
    ];

    if (event.description) {
        lines.push('', '--- Meeting Description / Notes ---', event.description);
    }

    return lines.join('\n');
}
