// liveAnalysisIds.ts
//
// The one gap every consumer of /intelligence/live-analysis has to close.
//
// The backend schema has no `id` field, so an id is dropped on every
// round-trip — but the UI keys per-item dismiss/checked state by it, and the
// saved meeting needs it to survive a reload. It also dedupes by prompt rather
// than deterministically, so an exact collision can come back.
//
// Extracted from useLiveAnalysis so the live panel and the uploaded-transcript
// replay stamp identically instead of keeping two copies in step by hand.

import { LiveAnalysisData } from '@/types';
import { stableId } from '@/lib/objections';

/**
 * Re-stamp stable ids onto every quoted item and drop exact id collisions,
 * keeping the first (the backend orders newly-detected items first).
 * `stableId` is a pure function of the quote, so the same quote keeps the same
 * id across refreshes and across the upload/live paths.
 */
export const stampIds = (data: LiveAnalysisData): LiveAnalysisData => {
  const dedupeStamp = <T extends { id?: string; quote: string }>(items: T[] | undefined): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of items ?? []) {
      const id = item.id ?? stableId(item.quote);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...item, id });
    }
    return out;
  };
  return {
    // bant/meddic pass through BY REFERENCE, on purpose. This object is posted
    // straight back to the backend as `previous_analysis` on the next tick, and
    // these two carry keys this client does not model (the contract has gained
    // fields without warning before). Rewriting them here would silently drop
    // whatever we don't know about. Readers normalize at READ time instead —
    // see the accessors in src/lib/bantMeddic.
    bant: data.bant,
    meddic: data.meddic,
    objections: dedupeStamp(data.objections),
    signals: dedupeStamp(data.signals),
    dealOptimizer: dedupeStamp(data.dealOptimizer),
  };
};
