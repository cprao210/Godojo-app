/**
 * liveAnalysisRouting.ts
 *
 * Where does an incoming live-analysis result belong?
 *
 * The renderer runs analysis asynchronously against an LLM: a run started
 * during meeting A can resolve after A ended and even after meeting B has
 * started. Main used to keep live analysis in a single untagged slot and
 * assign to it unconditionally, which meant a late result from A both
 * disappeared from A's saved record *and* was still sitting in the slot that
 * B's summary generation would later read. That is how "Meeting A's analysis
 * showed up inside Meeting B" happened.
 *
 * The fix is a monotonic *generation*: main bumps it once per startMeeting and
 * every renderer write carries the generation it was computed for. This module
 * is the single decision that turns (write generation, current state) into one
 * of three outcomes, kept pure so the routing rules are directly testable
 * without an Electron app around them.
 */

export type LiveAnalysisRoute =
    /** Belongs to the meeting that is live right now — keep it in the hot slot. */
    | { action: 'store' }
    /**
     * Belongs to a meeting that already ended and is being finalized. Its
     * transcript snapshot is long gone, so the only place left to put this is
     * that meeting's saved row.
     */
    | { action: 'patch'; meetingId: string }
    /**
     * Belongs to no meeting we can still write to (a stale generation with
     * nothing pending, or a meeting too short to have been saved). Dropping is
     * mandatory, not merely convenient: storing it would leak it into whatever
     * meeting reads the slot next.
     */
    | { action: 'drop'; reason: string };

export interface LiveAnalysisRoutingState {
    /** Generation the incoming write was computed for. `null` = untagged legacy caller. */
    writeGeneration: number | null;
    /** Generation of the meeting that is currently live (bumped by startMeeting). */
    currentGeneration: number;
    /** Generation of the meeting awaiting a late analysis result, if any. */
    pendingGeneration: number | null;
    /** Row id of that meeting. `null` when nothing is awaiting a late result. */
    pendingMeetingId: string | null;
    /** Is a meeting live right now? */
    isMeetingActive: boolean;
    /** Is this a clearing write (`data === null`)? Those never patch a row. */
    isClear: boolean;
}

/**
 * Decide where a live-analysis write goes.
 *
 * Precedence, in order:
 *  1. A clear only ever touches the hot slot, and only for the current
 *     generation — a stale clear must not wipe the live meeting's analysis.
 *  2. An explicitly pending generation always wins over the hot slot, even
 *     when its generation still equals `currentGeneration` (endMeeting does
 *     not bump; only startMeeting does). That meeting's snapshot has already
 *     been taken, so writing the slot would only risk leaking into the next
 *     meeting.
 *  3. Otherwise, store iff the write matches the current generation.
 */
export function routeLiveAnalysisWrite(state: LiveAnalysisRoutingState): LiveAnalysisRoute {
    const {
        writeGeneration,
        currentGeneration,
        pendingGeneration,
        pendingMeetingId,
        isMeetingActive,
        isClear,
    } = state;

    // An untagged write predates generation threading. Treat it as "current"
    // so an older renderer bundle degrades to the previous behaviour instead
    // of silently losing every analysis.
    const generation = writeGeneration ?? currentGeneration;

    if (isClear) {
        return generation === currentGeneration
            ? { action: 'store' }
            : { action: 'drop', reason: `stale clear for generation ${generation}` };
    }

    if (pendingMeetingId && pendingGeneration !== null && generation === pendingGeneration) {
        return { action: 'patch', meetingId: pendingMeetingId };
    }

    if (generation !== currentGeneration) {
        return {
            action: 'drop',
            reason: `generation ${generation} is not the active meeting (${currentGeneration})`,
        };
    }

    // Current generation, but the meeting has already ended and left nothing
    // pending — i.e. it was too short to save, or the in-flight flag was never
    // set. There is no row to patch and no live meeting to serve.
    if (!isMeetingActive) {
        return { action: 'drop', reason: 'no meeting is active and nothing is pending' };
    }

    return { action: 'store' };
}
