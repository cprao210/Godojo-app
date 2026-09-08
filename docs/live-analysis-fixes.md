# Live Analysis Fixes — Frontend Changes

**Branch:** `fix/live-analysis-tick-reliability`
**Files changed:**

| File | Change |
|---|---|
| `src/hooks/useLiveAnalysis.tsx` | Tick queueing, degraded-cursor hold, first-run diarization fix, self-contained mode |
| `src/api/intelligenceApi.ts` | Speaker-label allow-list hardening in `formatTranscript` |
| `src/types/index.tsx` | Added `degraded?: boolean` to `LiveAnalysisData` |

---

## Background

Live analysis runs on a **tick** model: a timer (or the manual Refresh button, or an
urgent-signal trigger) fires `runAnalysis()`, which sends the transcript delta to
`POST /intelligence/live-analysis` and merges the response into the panel state.

The backend is **stateless** — the renderer owns the analysis state and the transcript
cursor (`lastAnalyzedIndexRef`). Each tick sends only the speech added since the last
successful analysis (the *delta*) plus the previous analysis; the backend merges and
returns the full updated result.

That incremental contract is what makes the old failure modes expensive:

1. **Dropped ticks lose speech permanently.** If a tick was skipped while a run was
   in flight, and the cursor was later advanced past that slice, that slice of the
   conversation was never analyzed.
2. **An aborted/failed tick lost its slice too** if anything advanced the cursor.
3. **Seller speech was being mislabeled as prospect speech**, so seller signals were
   scoped out of extraction and RAG queries were built from the rep's own words.

Server-side tracing showed steady-state ticks taking ~10s (~2s retrieve + ~8s extract),
while the client was dropping/superseding ticks — so a 6-tick meeting could end up
analyzed from a single tick. These changes fix the client side of that contract.

---

## Change 1 — Queue, don't drop (`useLiveAnalysis.tsx`)

**Before:** a tick arriving while a run was in flight was skipped entirely.

**After:** it is queued and chained off the in-flight run's `finally` block.

Three refs implement it:

```ts
const runQueuedRef = useRef(false);      // "a tick is waiting to run"
const queuedForceRef = useRef(false);    // force flag of the latest dropped caller
const runAnalysisSelfRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
```

In `runAnalysis`:

```ts
if (isLoadingRef.current) {
  if (!runQueuedRef.current) {
    runQueuedRef.current = true;          // repeated drops collapse into ONE queued run
  }
  if (force) queuedForceRef.current = true; // manual Refresh outranks an auto tick
  return;
}
```

In the `finally` block — after the in-flight run has fully unwound and the in-flight
guard is clear:

```ts
if (runQueuedRef.current) {
  const queuedForce = queuedForceRef.current;
  runQueuedRef.current = false;
  queuedForceRef.current = false;
  const sid = sessionIdRef.current;
  if (sid === runSessionId) {
    setTimeout(() => {
      if (sessionIdRef.current === sid) {
        void runAnalysisSelfRef.current?.(queuedForce);
      }
    }, 0);
  }
}
```

Design notes:

- **`setTimeout(0)`, not a direct call** — guarantees the in-flight guard is already
  cleared when the queued run re-enters `runAnalysis`.
- **Session guard** — the queued run re-checks `sessionIdRef` before and after
  scheduling, so a tick queued for a meeting that has ended never runs against the
  next meeting.
- **`resetAnalysis()` clears both queue flags** so nothing queued for a previous
  meeting survives a session reset.
- The ref indirection (`runAnalysisSelfRef`) keeps `runAnalysis`'s `useCallback`
  identity stable, so the FloatingDock auto-refresh timer holding `runAnalysisRef`
  never resets.

**Effect:** every tick's delta is analyzed exactly once. No supersede-on-new-tick, no
unmount abort (`analyzeLive` passes no `AbortSignal`; the axios timeout stays at 60s).

---

## Change 2 — Honor `degraded: true` and hold the cursor on failure

The backend can answer **200 with `degraded: true`** when it could not actually run the
analysis (LLM chain down / thinking budget exhausted) and instead mirrored the previous
result back. Previously the client treated that as a normal success — advancing the
cursor and overwriting state with the mirror.

**After** (backend path in `runAnalysis`):

```ts
if (parsed.degraded) {
  console.warn('[useLiveAnalysis] Degraded response — holding transcript cursor; delta will be re-sent next tick.');
  return;
}
```

- The transcript cursor (`lastAnalyzedIndexRef`) is **not advanced** → the same delta
  is re-sent next tick.
- Current state is left untouched (the mirror is what's already on screen).

The failure path (`catch`) already held the cursor; it is now documented explicitly:

```ts
// NOTE: lastAnalyzedIndexRef is intentionally NOT advanced on failure/abort —
// the same delta is re-sent next tick (self-healing under the incremental
// contract; in SELF_CONTAINED_TICKS mode nothing was lost anyway).
```

**Contract for any future transport code:** the cursor advances **only** on a
successful, non-degraded response. Never cancel an in-flight request; never advance
the cursor on abort, error, or degraded.

---

## Change 3 — Diarization: seller speech must read as SALES PERSON

Both weak analyses traced to the same root cause: seller (local mic) speech being
labeled `PROSPECT` downstream. Two fixes.

### 3a. `formatTranscript` allow-list (`intelligenceApi.ts`)

`formatTranscript` is the last stop before the prompt — the backend speaker-scopes
extraction on the exact labels `SALES PERSON` / `PROSPECT`, and RAG builds its query
from recent `PROSPECT` lines. The old mapping was effectively "everything not `user`
is prospect", which silently relabeled seller turns arriving under legacy/alias labels.

**After** — explicit allow-list for local mic labels:

```ts
const LOCAL_SPEAKER_LABELS = new Set(["user", "me", "self", "sales"]);

const speaker = (t.speaker ?? "").toLowerCase();
const isLocal =
  LOCAL_SPEAKER_LABELS.has(speaker) ||
  speaker.startsWith("user"); // e.g. "user_mobile" still means the mic
return `${isLocal ? "SALES PERSON" : "PROSPECT"}: ${t.text.trim()}`;
```

Unrecognized labels still fall through to `PROSPECT` — on a sales call, unattributed
audio is far more likely the far end — but every known local label is pinned to
`SALES PERSON`. Only the two exact strings are ever emitted.

### 3b. Seller turns included in the first-run context (`useLiveAnalysis.tsx`)

The fallback first-run context builder had a dead filter that **excluded all seller
turns** (`humanTurns.filter(t => t.speaker !== 'user')` followed by an unreachable
`'SALES PERSON (Me)'` branch). The prompt scopes BANT/MEDDIC/signal extraction to
prospect lines, but **Type B objection detection (AE deferrals) is impossible without
the seller's own turns**.

The shared `formatTurn` now labels and includes both roles:

```ts
const isLocal = ['user', 'me', 'self', 'sales'].includes(s) || s.startsWith('user');
const role = isLocal ? 'SALES PERSON (Me)' : 'PROSPECT (Client)';
```

This applies to the compressed "earlier call context" block, the full-fidelity recent
block, and the no-old-turns fallback path. `getFirstRunPrompt`'s transcript header was
updated to match. Refresh (delta) runs are unchanged — the delta remains prospect-only,
since seller turns are scaffolding context, not signal sources.

---

## Change 4 (optional) — Self-contained tick mode

```ts
const SELF_CONTAINED_TICKS = false;
```

Flip to `true` **while transport is flaky**: every tick then ignores the delta slice
and `previous_analysis`, sending the **cumulative transcript-so-far** instead. Every
tick becomes a self-contained fresh analysis, so a lost/failed tick costs nothing —
the next one re-analyzes everything.

Trade-offs (documented at the constant):

- Larger prompt and re-derivation of BANT/MEDDIC from scratch on every tick.
- The client-owned objection list is still re-applied from `objectionsRef` at merge
  time, so objections are unaffected by the missing `previous_analysis`.

Mechanically, in the backend path:

```ts
const selfContained = SELF_CONTAINED_TICKS && !!priorState;
const deltaTurns = priorState && !selfContained ? humanTurns.slice(adjustedDeltaStartIndex) : humanTurns;
// ...
previousAnalysis: priorState && !selfContained ? { ...priorState, objections: objectionsRef.current } : null,
```

Default is `false` — the incremental (delta) contract remains the production path.

---

## Type change (`types/index.tsx`)

```ts
degraded?: boolean;  // added to LiveAnalysisData
```

Backend-only flag. The client consumes it in `runAnalysis` (Change 2) and drops it
before persisting the analysis via `updateLiveAnalysis`.

---

## Untouched by design

- **`useObjectionWatch.ts`** — already follows the hold-cursor contract (success-only
  advance + overlap retry). No change needed.
- **`useFloatingDock.ts`** — the auto-refresh timer and manual Refresh now feed the
  queue instead of dropping; no logic change was required there.
- **Electron main-process STT** — the mic path already labels local speech `'user'`
  correctly (`createSTTProvider(speaker)` closure); the mislabeling risk was entirely
  in the consumers above.

---

## Verification

- `npx tsc --noEmit` — clean for all changed files. The 3 remaining errors are
  pre-existing in `useSignIn.ts` / `SignIn.tsx` (auth form types, untouched files).
- `npx vitest run` — **365/368 pass**. The 3 failures in
  `electron/__tests__/ipcGuards.test.ts` are pre-existing (verified with the changes
  stashed) and unrelated to this work.
- 44/44 targeted tests in `src/api/__tests__` pass.

## Suggested next step

Restart the dev server and run one live meeting with backend tracing (Langfuse) on.
If anything still looks off, each tick's trace shows exactly what the model received
and how long each stage took — and with these fixes, a lost or degraded tick can no
longer silently cost a slice of the conversation.
