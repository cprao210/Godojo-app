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
 * Builds a compact company context block for LLM prompt injection.
 * Used by ipcHandlers (chat, followup email) and MeetingPersistence (post-call summary).
 */
export function buildCompanyContextBlock(intel: Record<string, any> | null): string {
    if (!intel) return '';
    const v = (x: any) => x && x !== 'null' && x !== 'N/A' ? x : null;

    const lines: string[] = [
        '═══════════════════════════════════════',
        'PROSPECT COMPANY INTELLIGENCE (pre-call research — use to personalise your analysis)',
        '═══════════════════════════════════════',
    ];

    if (v(intel.companyName)) lines.push(`Company:        ${intel.companyName}`);
    if (v(intel.industry)) lines.push(`Industry:       ${intel.industry}`);
    if (v(intel.businessModel)) lines.push(`Business Model: ${intel.businessModel}`);
    if (v(intel.employeeCount)) lines.push(`Employees:      ${intel.employeeCount}`);
    if (v(intel.headquarters)) lines.push(`HQ:             ${intel.headquarters}`);
    if (v(intel.revenue)) lines.push(`Revenue:        ${intel.revenue}`);
    if (v(intel.fundingStage)) lines.push(`Funding Stage:  ${intel.fundingStage}`);
    if (v(intel.valuation)) lines.push(`Valuation:      ${intel.valuation}`);
    if (v(intel.latestFundingNews)) lines.push(`Latest Funding: ${intel.latestFundingNews}`);
    if (intel.founders?.length) lines.push(`Founders:       ${intel.founders.join(', ')}`);
    if (intel.investors?.length) lines.push(`Investors:      ${intel.investors.slice(0, 3).join(', ')}`);
    if (intel.keyProducts?.length) lines.push(`Products:       ${intel.keyProducts.slice(0, 4).join(', ')}`);
    if (intel.competitors?.length) lines.push(`Competitors:    ${intel.competitors.slice(0, 4).join(', ')}`);
    if (intel.topCustomers?.length) lines.push(`Top Customers:  ${intel.topCustomers.slice(0, 3).join(', ')}`);
    if (intel.geographicPresence?.length) lines.push(`Geography:      ${intel.geographicPresence.join(', ')}`);

    if (intel.recentNews?.length) {
        lines.push('Recent News:');
        intel.recentNews.slice(0, 2).forEach((n: any) =>
            lines.push(`  • ${n.headline}${n.date ? ` (${n.date})` : ''}`)
        );
    }
    if (intel.leadershipChanges?.length) {
        lines.push('Leadership Changes:');
        intel.leadershipChanges.slice(0, 2).forEach((l: any) =>
            lines.push(`  • ${l.name} → ${l.role}${l.date ? ` (${l.date})` : ''}`)
        );
    }

    lines.push('═══════════════════════════════════════');
    return lines.join('\n');
}
