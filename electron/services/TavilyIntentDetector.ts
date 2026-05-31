/**
 * TavilyIntentDetector
 *
 * Synchronous (<1ms) classifier that decides whether a user message
 * needs external company/product knowledge from Tavily Search.
 *
 * Design principles:
 *  - Pure function — no I/O, no async, no side effects
 *  - Two-pass: meeting-context negation guard first, then external signals
 *  - All patterns live here — no scattered regex in callers
 *  - Returns a typed result so callers never inspect raw strings
 *
 * NOT responsible for:
 *  - Calling Tavily (that's TavilySearchService)
 *  - Caching anything
 *  - Deciding what to do with the result
 */

export interface TavilyIntentResult {
    /** Whether this query needs an external web search */
    needsExternalSearch: boolean;
    /**
     * Best single search query to send to Tavily.
     * Only populated when needsExternalSearch is true.
     * Constructed from the detected entity + intent signal,
     * NOT the raw user message (cleaner results from Tavily).
     */
    searchQuery: string | null;
    /**
     * The company/product/entity name extracted from the message.
     * Used as the cache key in TavilySearchService.
     * null when no specific entity was detected.
     */
    entityName: string | null;
    /** Human-readable reason — useful for debug logging */
    reason: string;
}

// ─────────────────────────────────────────────────────────────────
// NEGATION GUARD
// These patterns mean "answer from the meeting transcript, not the web".
// If any matches, we short-circuit and return needsExternalSearch: false
// regardless of what other signals are present.
// ─────────────────────────────────────────────────────────────────
const MEETING_CONTEXT_PATTERNS: RegExp[] = [
    /\b(in this meeting|in the meeting|during the call|on this call)\b/i,
    /\b(just said|just mentioned|they said|he said|she said|was mentioned)\b/i,
    /\b(from the transcript|in the transcript|based on the call)\b/i,
    /\b(summarize|summary|recap|next steps?|action items?|follow[- ]?up)\b/i,
    /\b(meddi[cp]{2}|meddic|meddpicc|medpicc)\b/i,
    /\b(objection|objections|what (were|are) (they|the) (saying|concerned about))\b/i,
    /\b(what did (they|we|he|she) (say|discuss|talk about|mention))\b/i,
    /\b(key (points?|takeaways?|decisions?|outcomes?))\b/i,
    /\b(who spoke|speaker|participants?|attendees?)\b/i,
    /\b(pain points?|discovery questions?|budget|timeline|champion|economic buyer)\b/i,
];

// ─────────────────────────────────────────────────────────────────
// EXTERNAL KNOWLEDGE SIGNALS
// Phrases that signal the user wants facts NOT in the transcript.
// ─────────────────────────────────────────────────────────────────

/** Generic fact-seeking verbs / structures */
const FACT_SEEKING_PATTERNS: RegExp[] = [
    // "tell me about Stripe" — bare proper noun, no company noun required
    /\b(tell me about|what is|who is|who are|give me (info|information|details|background) (on|about))\s+[A-Z][a-zA-Z0-9._-]{1,40}\b/,
    /\b(tell me about|what is|what does|who is|who are|describe)\b.{0,40}\b(company|startup|corp|inc|llc|firm|platform|product|tool|software|service|app)\b/i,
    /\b(company overview|company background|company info|about the company)\b/i,
    /\b(how many employees|employee count|headcount|team size|staff size)\b/i,
    /\b(who (founded|started|created|built)|founders?|co-?founders?)\b/i,
    /\b(headquartered?|hq|office location|where (is|are) (they|the company) based)\b/i,
    /\b(what industry|which (sector|vertical|market|space))\b/i,
    /\b(annual (revenue|arr|mrr)|revenue (run rate|figures?)|how much (do they make|revenue))\b/i,
    /\b(valuation|funding|series [a-z]|raised|investors?|backed by|vc)\b/i,
    /\b(competitors?|competing (with|against)|alternatives? to|vs\.?)\b.{0,30}\b[A-Z][a-z]+\b/,
    /\b(their (product|platform|offering|solution|tech(nology)?|stack))\b/i,
    /\b(what (do|does) [A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)? (do|offer|sell|make|build|provide))\b/,
    /\b(customer(s| base| profile)?|who (uses?|are their (clients?|customers?)))\b/i,
    /\b(public(ly traded)?|private company|ipo|nasdaq|nyse|stock (price|ticker))\b/i,
    /\b(year (founded|established|started)|when (was it|did they|were they) (founded|started|created))\b/i,
    /\b(ceo|cto|coo|cpo|vp of|chief .+ officer|leadership team|executive team)\b/i,
];

// ─────────────────────────────────────────────────────────────────
// ENTITY EXTRACTION
// Tries to pull a company/product name out of the message.
// Used to build a cleaner Tavily query and as the cache key.
// ─────────────────────────────────────────────────────────────────

/**
 * Known common stopwords — prevent these from being returned as entity names.
 * Extended as edge cases appear in the wild.
 */
const ENTITY_STOPWORDS = new Set([
    'the', 'a', 'an', 'this', 'that', 'their', 'our', 'your', 'my',
    'company', 'startup', 'product', 'platform', 'tool', 'service', 'app',
    'software', 'firm', 'corp', 'inc', 'llc', 'it', 'they', 'us', 'them',
    'tell', 'what', 'who', 'how', 'when', 'where', 'why', 'does', 'do',
    'is', 'are', 'can', 'could', 'would', 'should', 'we', 'he', 'she',
]);

/**
 * Patterns to extract an entity name from the message.
 * Listed in priority order — first match wins.
 */
const ENTITY_EXTRACTION_PATTERNS: RegExp[] = [
    // "tell me about Stripe" / "what is Salesforce" / "who is Anthropic"
    /(?:tell me about|what (?:is|does)|who (?:is|are)|about|describe)\s+([A-Z][a-zA-Z0-9._-]{1,40}(?:\s+[A-Z][a-zA-Z0-9._-]{1,40})?)/,
    // "Stripe's employees" / "OpenAI's CEO"
    /^([A-Z][a-zA-Z0-9._-]{1,40}(?:\s+[A-Z][a-zA-Z0-9._-]{1,40})?)'s?\b/,
    // "employees at Stripe" / "founded by the team at Anthropic"
    /(?:at|for|of|by|from)\s+([A-Z][a-zA-Z0-9._-]{1,40}(?:\s+[A-Z][a-zA-Z0-9._-]{1,40})?)\b/,
    // First capitalized word/phrase as last-resort heuristic
    /\b([A-Z][a-zA-Z0-9._-]{2,40}(?:\s+[A-Z][a-zA-Z0-9._-]{2,40})?)\b/,
];

/**
 * Try to extract a company/product entity name from the raw message.
 * Returns null if nothing usable is found.
 */
function extractEntityName(message: string): string | null {
    for (const pattern of ENTITY_EXTRACTION_PATTERNS) {
        const match = message.match(pattern);
        if (match?.[1]) {
            const candidate = match[1].trim();
            // Reject stopwords and overly short strings
            if (!ENTITY_STOPWORDS.has(candidate.toLowerCase()) && candidate.length > 1) {
                return candidate;
            }
        }
    }
    return null;
}

/**
 * Build a clean, structured Tavily search query from an entity name
 * and the original message intent. This produces much better results
 * than passing the raw user message directly to Tavily.
 *
 * Examples:
 *   entity="Stripe", message with "employees" → "Stripe company employee count headcount"
 *   entity="Salesforce", message with "founded" → "Salesforce founded CEO history overview"
 *   entity="OpenAI"  → "OpenAI company overview industry funding employees"
 */
function buildSearchQuery(entityName: string, message: string): string {
    const lower = message.toLowerCase();

    if (/employ|headcount|team size|staff|how many people/.test(lower)) {
        return `${entityName} company employee count headcount team size`;
    }
    if (/found(ed|er|ers?)|start(ed)?|created|built|origin|history/.test(lower)) {
        return `${entityName} founded history founders CEO overview`;
    }
    if (/headquarter|hq|located|based|office/.test(lower)) {
        return `${entityName} headquarters location office`;
    }
    if (/revenue|arr|mrr|sales|annual|run rate/.test(lower)) {
        return `${entityName} annual revenue ARR financials`;
    }
    if (/valuation|funding|raised|series|investor|vc/.test(lower)) {
        return `${entityName} funding valuation investors series`;
    }
    if (/industry|sector|vertical|market|space/.test(lower)) {
        return `${entityName} industry sector market`;
    }
    if (/competi|vs\.?|alternative|rival/.test(lower)) {
        return `${entityName} competitors alternatives market position`;
    }
    if (/ceo|cto|coo|executive|leader|management/.test(lower)) {
        return `${entityName} CEO executives leadership team`;
    }
    if (/product|platform|offer|sell|make|build|provide|solution/.test(lower)) {
        return `${entityName} product overview what they do`;
    }
    if (/customer|client|user base|who uses/.test(lower)) {
        return `${entityName} customers clients use cases`;
    }
    if (/stock|ipo|public|nasdaq|nyse|ticker/.test(lower)) {
        return `${entityName} stock IPO public company`;
    }

    // Generic fallback — broad overview
    return `${entityName} company overview industry employees funding`;
}

function isAllowedEntity(entityName: string, allowedCompanies: Set<string>): boolean {
    if (allowedCompanies.size === 0) return false;
    const lowerEntity = entityName.toLowerCase();
    for (const allowed of allowedCompanies) {
        const lowerAllowed = allowed.toLowerCase();
        if (lowerEntity === lowerAllowed || lowerEntity.includes(lowerAllowed) || lowerAllowed.includes(lowerEntity)) {
            return true;
        }
    }
    return false;
}

export function extractAllowedCompaniesFromAttendees(
    attendees: Array<{ email?: string; self?: boolean }>,
    selfEmail?: string,
): Set<string> {
    const PERSONAL_DOMAINS = new Set([
        'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
        'icloud.com', 'proton.me', 'protonmail.com', 'live.com',
        'msn.com', 'aol.com', 'ymail.com', 'mail.com',
    ]);
    const companies = new Set<string>();
    for (const attendee of attendees) {
        if (attendee.self) continue;
        if (!attendee.email) continue;
        if (selfEmail && attendee.email.toLowerCase() === selfEmail.toLowerCase()) continue;
        const domain = attendee.email.split('@')[1];
        if (!domain || PERSONAL_DOMAINS.has(domain.toLowerCase())) continue;
        const parts = domain.split('.');
        const namePart = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
        companies.add(namePart.charAt(0).toUpperCase() + namePart.slice(1).toLowerCase());
    }
    return companies;
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────

/**
 * Classify whether a user message requires external company/product
 * knowledge from Tavily Search.
 *
 * Synchronous — safe to call inline before any await.
 * Never throws.
 *
 * @param message  The raw user message from the chat input
 * @returns        TavilyIntentResult with classification and optional search query
 */
export function detectTavilyIntent(message: string, allowedCompanies: Set<string> = new Set()): TavilyIntentResult {
    const text = message.trim();

    if (!text) {
        return {
            needsExternalSearch: false,
            searchQuery: null,
            entityName: null,
            reason: 'empty message',
        };
    }

    // if (allowedCompanies.size === 0) {
    //     return {
    //         needsExternalSearch: false,
    //         searchQuery: null,
    //         entityName: null,
    //         reason: 'no allowed companies in meeting context — Tavily disabled',
    //     };
    // }

    // ── Pass 1: Meeting-context negation guard ──
    // If the user is clearly asking about THIS meeting, skip web search.
    for (const pattern of MEETING_CONTEXT_PATTERNS) {
        if (pattern.test(text)) {
            return {
                needsExternalSearch: false,
                searchQuery: null,
                entityName: null,
                reason: `meeting-context signal matched: ${pattern.source.slice(0, 60)}`,
            };
        }
    }

    // ── Pass 2: External knowledge signal detection ──
    for (const pattern of FACT_SEEKING_PATTERNS) {
        if (pattern.test(text)) {
            const entityName = extractEntityName(text);
            if (!entityName) {
                return {
                    needsExternalSearch: false,
                    searchQuery: null,
                    entityName: null,
                    reason: 'no recognisable entity found in message',
                };
            }
            const searchQuery = buildSearchQuery(entityName, text);
            return {
                needsExternalSearch: true,
                searchQuery,
                entityName,
                reason: `external signal matched for entity "${entityName}"`,
            };
        }
    }

    // ── Default: no external search needed ──
    return {
        needsExternalSearch: false,
        searchQuery: null,
        entityName: null,
        reason: 'no external knowledge signal detected',
    };
}