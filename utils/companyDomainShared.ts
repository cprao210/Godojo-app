/**
 * Company-domain classification shared by the Electron main process and the
 * renderer (the backend keeps the authoritative Python list in
 * godojo-apis/app/services/company_resolution.py — keep the two in sync).
 *
 * Used to derive the "Suggested for this meeting" candidates at end-of-call:
 * every attendee email domain EXCEPT the organizer's/rep's own and personal
 * consumer providers is a candidate customer company.
 */

export const CONSUMER_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
    'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
    'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
    'gmx.com', 'gmx.de', 'mail.com', 'zoho.com', 'yandex.com', 'hey.com',
]);

export interface AttendeeLike {
    email?: string;
    self?: boolean;
    organizer?: boolean;
}

/** 'eu.acme.com' → 'acme.com'; invalid/empty → null. */
export function emailDomainRoot(input: string): string | null {
    const raw = (input || '').trim().toLowerCase();
    if (!raw) return null;
    const domain = raw.includes('@') ? raw.split('@').pop()! : raw;
    const cleaned = domain.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/:]/)[0];
    if (!cleaned || !cleaned.includes('.') || !/^[a-z0-9.\-]+$/.test(cleaned)) return null;
    const parts = cleaned.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : cleaned;
}

export function isConsumerEmailDomain(domain: string | null): boolean {
    return !!domain && CONSUMER_EMAIL_DOMAINS.has(domain);
}

/** Title-cased display name from a domain root: 'acme.com' → 'Acme'. */
export function companyNameFromDomainRoot(root: string): string {
    return (root.split('.')[0] || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * ALL distinct external attendee domains, most-frequent first. Excluded:
 *   1. attendees flagged self/organizer (the rep),
 *   2. the rep's own email domain when known (opts.userEmail),
 *   3. personal/consumer providers.
 * Zero, one, or many — choosing between them is the user's call.
 */
export function deriveExternalAttendeeDomains(
    attendees: AttendeeLike[] | string[] | undefined | null,
    opts?: { userEmail?: string | null },
): string[] {
    const exclude = new Set<string>();
    const userRoot = opts?.userEmail ? emailDomainRoot(opts.userEmail) : null;
    if (userRoot) exclude.add(userRoot);

    const counts = new Map<string, number>();
    for (const att of attendees ?? []) {
        const email = typeof att === 'string' ? att : (att?.email || '');
        if (!email) continue;
        if (typeof att === 'object' && (att.self || att.organizer)) continue;
        const root = emailDomainRoot(email);
        if (!root || isConsumerEmailDomain(root) || exclude.has(root)) continue;
        counts.set(root, (counts.get(root) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

/** [{name, domain}] for the end-of-call picker's "Suggested" group. */
export function deriveCompanyCandidates(
    attendees: AttendeeLike[] | string[] | undefined | null,
    opts?: { userEmail?: string | null },
): { name: string; domain: string }[] {
    return deriveExternalAttendeeDomains(attendees, opts).map(domain => ({
        name: companyNameFromDomainRoot(domain),
        domain,
    }));
}
