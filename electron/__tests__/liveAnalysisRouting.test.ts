// The rules that keep meeting A's analysis out of meeting B. Every case here is
// a real sequence the app can produce when calls are started back-to-back.

import { describe, expect, it } from 'vitest';

import { routeLiveAnalysisWrite, LiveAnalysisRoutingState } from '../liveAnalysisRouting';

/** A meeting (generation 5) live right now, nothing pending. */
const live = (over: Partial<LiveAnalysisRoutingState> = {}): LiveAnalysisRoutingState => ({
    writeGeneration: 5,
    currentGeneration: 5,
    pendingGeneration: null,
    pendingMeetingId: null,
    isMeetingActive: true,
    isClear: false,
    ...over,
});

describe('routeLiveAnalysisWrite', () => {
    it('stores a result from the meeting that is live', () => {
        expect(routeLiveAnalysisWrite(live())).toEqual({ action: 'store' });
    });

    it('patches the ended meeting when its own late result arrives before a new call', () => {
        // endMeeting does not bump the generation, so A is still "current" here.
        const route = routeLiveAnalysisWrite(
            live({ isMeetingActive: false, pendingGeneration: 5, pendingMeetingId: 'meeting-a' }),
        );
        expect(route).toEqual({ action: 'patch', meetingId: 'meeting-a' });
    });

    it('still patches meeting A after meeting B has started', () => {
        // The regression this whole module exists for: A's result must land on
        // A's row and must NOT be visible to B.
        const route = routeLiveAnalysisWrite(
            live({
                writeGeneration: 5,
                currentGeneration: 6,
                pendingGeneration: 5,
                pendingMeetingId: 'meeting-a',
            }),
        );
        expect(route).toEqual({ action: 'patch', meetingId: 'meeting-a' });
    });

    it('drops a stale result that has no row left to patch', () => {
        const route = routeLiveAnalysisWrite(live({ writeGeneration: 5, currentGeneration: 6 }));
        expect(route).toMatchObject({ action: 'drop' });
    });

    it('drops a result for a meeting too short to have been saved', () => {
        // stopMeeting() returns null under 1s, so nothing is pending and there
        // is no live meeting — storing it would poison the next call.
        const route = routeLiveAnalysisWrite(live({ isMeetingActive: false }));
        expect(route).toMatchObject({ action: 'drop' });
    });

    it('never patches a row with a clear', () => {
        const route = routeLiveAnalysisWrite(
            live({ isClear: true, isMeetingActive: false, pendingGeneration: 5, pendingMeetingId: 'meeting-a' }),
        );
        expect(route).toEqual({ action: 'store' });
    });

    it('ignores a clear that arrives from a previous meeting', () => {
        const route = routeLiveAnalysisWrite(live({ isClear: true, writeGeneration: 4, currentGeneration: 6 }));
        expect(route).toMatchObject({ action: 'drop' });
    });

    it('treats an untagged write as belonging to the current meeting', () => {
        expect(routeLiveAnalysisWrite(live({ writeGeneration: null }))).toEqual({ action: 'store' });
    });
});
