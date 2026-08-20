// src/lib/objections.ts
//
// Pure objection-list logic for the fast /intelligence/objection-handler route.
//
// The backend endpoint speaks a DELTA contract: the client posts a recent transcript
// window plus the quotes of currently-open objections, and gets back only `new` +
// `resolved`. That makes the RENDERER the owner of the objection list — it merges
// `new`, marks `resolved`, and posts the accumulated list back as
// `previous_analysis.objections` on the slower live-analysis call.
//
// Everything here is deliberately free of React and of the network so it can be unit
// tested under the repo's existing vitest setup (`environment: 'node'`, no jsdom).
// The hook that drives it is src/hooks/useObjectionWatch.ts.

import { Objection, LiveAnalysisData } from "@/types";

/** Wire shape of POST /api/v1/intelligence/objection-handler. */
export interface ObjectionDelta {
  /** Objections detected in this window that weren't already open. */
  new: Objection[];
  /** Quotes echoed back from the posted `open_objections`, now answered. */
  resolved: string[];
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Deterministic short id from a quote string — djb2 hash, base-36, 6 chars.
 *
 * Single definition for the whole app: useLiveAnalysis imports it from here for its
 * `stampIds` / `mergeWithPrior` paths, and the UI keys objection cards on
 * `obj.id ?? obj.quote`. Because it's a pure function of the text, dismiss/checked
 * UI state survives every refresh and every backend round-trip (the backend schema
 * has no `id` field, so it's dropped and re-derived on each response).
 */
export const stableId = (quote: string): string => {
  let h = 5381;
  for (let i = 0; i < quote.length; i++) h = ((h << 5) + h) ^ quote.charCodeAt(i);
  return (h >>> 0).toString(36).slice(0, 6);
};

/**
 * Loose comparison key for matching a `resolved` quote back to a tracked objection.
 * The backend is asked to echo an open quote verbatim, but whitespace/punctuation
 * drift through an LLM is cheap to absorb and expensive to debug.
 */
export const normalizeQuote = (quote: string): string =>
  quote.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ── Merge ────────────────────────────────────────────────────────────────────

/** Backend cap: ObjectionRequest.open_objections has max_length=25. */
export const MAX_OPEN_OBJECTIONS = 25;

/**
 * Apply one delta to the client-owned list.
 *
 * `new` items are stamped with a stable id, filtered against everything already
 * tracked (active AND resolved — a re-detected objection must not resurrect), and
 * PREPENDED as a batch so the newest-first ordering the UI assumes is preserved.
 *
 * `resolved` quotes flip the matching entry's client-only `resolved` flag rather
 * than dropping it, so the objection still ships in `previous_analysis.objections`
 * and still reaches the post-call summary. A quote matching nothing is ignored.
 */
export const mergeObjectionDelta = (
  current: Objection[],
  delta: ObjectionDelta | null | undefined,
): Objection[] => {
  const incoming = delta?.new ?? [];
  const resolvedQuotes = delta?.resolved ?? [];

  const knownIds = new Set(current.map((o) => o.id ?? stableId(o.quote)));
  const seen = new Set<string>();
  const fresh: Objection[] = [];
  for (const obj of incoming) {
    if (!obj?.quote?.trim()) continue;
    const id = obj.id ?? stableId(obj.quote);
    if (knownIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    fresh.push({ ...obj, id });
  }

  const merged = [...fresh, ...current];
  if (resolvedQuotes.length === 0) return merged;

  const resolvedKeys = new Set(resolvedQuotes.map(normalizeQuote));
  return merged.map((obj) =>
    !obj.resolved && resolvedKeys.has(normalizeQuote(obj.quote))
      ? { ...obj, resolved: true }
      : obj,
  );
};

/** Split the single owned list into what the panel renders as active vs. collapsed. */
export const partitionObjections = (
  all: Objection[],
): { active: Objection[]; resolved: Objection[] } => {
  const active: Objection[] = [];
  const resolved: Objection[] = [];
  for (const obj of all) (obj.resolved ? resolved : active).push(obj);
  return { active, resolved };
};

/**
 * The `open_objections` payload: still-open quotes only, newest first, capped to the
 * backend's limit. Sending resolved ones back would invite the model to re-resolve
 * them every tick for no benefit.
 */
export const openQuotes = (all: Objection[], cap = MAX_OPEN_OBJECTIONS): string[] =>
  all
    .filter((o) => !o.resolved && o.quote?.trim())
    .slice(0, cap)
    .map((o) => o.quote);

// ── Cadence ──────────────────────────────────────────────────────────────────

/** How often the watcher compares the transcript length against its cursor. */
export const OBJECTION_POLL_MS = 1_000;
/** Debounce: let the sentence finish before spending a call on it. */
export const OBJECTION_SETTLE_MS = 1_200;
/** Floor between two objection calls, however fast the prospect talks. */
export const OBJECTION_MIN_GAP_MS = 6_000;
/** Recent-window cap sent to the backend — the delta contract's whole point. */
export const OBJECTION_WINDOW_TURNS = 16;
/** Re-send a few pre-cursor turns so a quote straddling a boundary isn't lost. */
export const OBJECTION_OVERLAP_TURNS = 4;
/** Client-side deadline. The route targets p95 ≤ 1.5s; this is a hang guard. */
export const OBJECTION_CLIENT_TIMEOUT_MS = 4_000;

export interface TickDecisionArgs {
  now: number;
  /** Number of human turns currently in the transcript. */
  turnCount: number;
  /** Index of the last turn already sent to the endpoint. */
  cursor: number;
  /** Timestamp of the newest human turn, or 0 when there are none. */
  newestTurnAt: number;
  /** Timestamp of the last attempted tick (success or failure). */
  lastTickAt: number;
  /** True when a request is already in flight. */
  inFlight: boolean;
  isMeetingPaused: boolean;
  /** True when at least one turn past the cursor came from the prospect. */
  hasNewProspectTurn: boolean;
}

/**
 * The whole "should we spend a call right now" decision, extracted from the hook so
 * the timing rules are testable without React.
 *
 * An AE-only delta returns false — the caller advances the cursor without a request,
 * because the rep talking is not itself an objection. (AE turns are also EXCLUDED from
 * the window when a tick does fire: only prospect speech is posted to the route.)
 */
export const shouldTick = (args: TickDecisionArgs): boolean => {
  const {
    now, turnCount, cursor, newestTurnAt, lastTickAt,
    inFlight, isMeetingPaused, hasNewProspectTurn,
  } = args;

  if (isMeetingPaused || inFlight) return false;
  if (turnCount <= cursor) return false;
  if (!hasNewProspectTurn) return false;
  if (now - newestTurnAt < OBJECTION_SETTLE_MS) return false;
  if (now - lastTickAt < OBJECTION_MIN_GAP_MS) return false;
  return true;
};

// ── Standalone container ─────────────────────────────────────────────────────

/** A field the backend hasn't spoken to yet. `status: 'missing'` (not '') on purpose:
 *  FloatingIntelligencePanel's hasContent() treats any status other than 'missing' as
 *  real content, so '' here would make an empty skeleton look populated. */
const MISSING_FIELD = { emoji: '\u274c', status: 'missing', evidence: '' } as const;

/**
 * An otherwise-empty LiveAnalysisData carrying nothing but `objections`.
 *
 * Objections are produced by their own endpoint on a seconds cadence; live analysis
 * lands in minutes and can fail outright. The panel reads its objection list off
 * `analysisData.objections`, so before this existed a null analysis meant the
 * Objections tab stayed empty even though the fast route had already answered — and
 * stayed empty for the whole call if live analysis never succeeded.
 *
 * RENDER ONLY. Never send this to updateLiveAnalysis: its all-missing BANT/MEDDIC
 * would reach reconcileBantMeddicWithLiveAnalysis (electron/MeetingPersistence.ts),
 * which treats live analysis as authoritative and would wipe the summary LLM's own
 * extraction. useFloatingDock keeps the persistence path gated on the real analysis.
 */
export const objectionsOnlyAnalysis = (objections: Objection[]): LiveAnalysisData => ({
  bant: {
    budget: { ...MISSING_FIELD },
    authority: { ...MISSING_FIELD },
    need: { ...MISSING_FIELD },
    timeline: { ...MISSING_FIELD },
  },
  meddic: {
    metrics: { ...MISSING_FIELD },
    economic_buyer: { ...MISSING_FIELD },
    decision_criteria: { ...MISSING_FIELD },
    decision_process: { ...MISSING_FIELD },
    identify_pain: { ...MISSING_FIELD },
    champion: { ...MISSING_FIELD },
    competition: { ...MISSING_FIELD },
  },
  objections,
  signals: [],
});
