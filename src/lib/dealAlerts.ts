import type { DealOptimizerAlert } from '@/types';
import { normalizeQuote } from '@/lib/objections';

/**
 * Merge new deal-optimizer alerts (delta from /intelligence/deal-optimizer) into the list the
 * client owns: newest first, deduped by id and by normalized quote.
 */
export function mergeDealAlerts(
    current: DealOptimizerAlert[],
    incoming: DealOptimizerAlert[],
): DealOptimizerAlert[] {
    const seenIds = new Set(current.map(a => a.id).filter(Boolean));
    const seenQuotes = new Set(current.map(a => normalizeQuote(a.quote)));
    const fresh: DealOptimizerAlert[] = [];
    for (const a of incoming) {
        if (!a?.quote) continue;
        const q = normalizeQuote(a.quote);
        if ((a.id && seenIds.has(a.id)) || seenQuotes.has(q)) continue;
        seenQuotes.add(q);
        if (a.id) seenIds.add(a.id);
        fresh.push(a);
    }
    return fresh.length ? [...fresh, ...current].slice(0, 20) : current;
}
