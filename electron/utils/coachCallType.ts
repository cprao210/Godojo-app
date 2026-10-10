// coachCallType.ts
//
// Resolves which KIND of call a meeting was — 'discovery' | 'demo' |
// 'negotiation' — for the call-type-aware summary generator. This is the
// meeting FORMAT, deliberately separate from `dealStatus.stage`: a Proposal-
// stage deal can perfectly well be negotiated on a demo call.
//
// Sources, in priority order (first source containing any valid type wins):
//   1. Explicit meeting types the rep selected (live End Call / upload modal —
//      `hintMeetingTypes`, and the meeting row's `meetingTypes` where present).
//   2. The persisted `detailedSummary.coachCallType` — the resolution stamped
//      when the summary was first generated, so regeneration stays consistent.
//   3. Detected types from the scorecard (meeting_scorecards.detected_types /
//      detailedSummary.scorecard.detectedTypes).
//   4. Default: 'discovery'.
//
// Within the winning source, negotiation > demo > discovery (a call that was
// partly a demo and partly a negotiation is coached as a negotiation).

import { CoachCallType } from '../../src/types';
import { meetingTypesForRegenerate } from './callAnalysis';

/**
 * Resolve the coach call type from any number of sources. Each source may be
 * an array of meeting types or a single type string; invalid values are
 * dropped (via meetingTypesForRegenerate) and empty sources are skipped.
 */
export function resolveCoachCallType(...sources: Array<unknown>): CoachCallType {
    const asLists = sources.map((s) => (Array.isArray(s) ? s : [s]));
    // ?? [] — meetingTypesForRegenerate always returns an array, but this runs
    // inside the summary-generation try block: a bad mock/override returning
    // undefined must never cost the whole summary.
    const types = meetingTypesForRegenerate(...asLists) ?? [];
    if (types.includes('negotiation')) return 'negotiation';
    if (types.includes('demo')) return 'demo';
    return 'discovery';
}
