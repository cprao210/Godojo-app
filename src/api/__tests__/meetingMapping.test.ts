// The list rules that keep a meeting card from moving backwards. These are the
// invariants behind the processing → title → processing → title flip-flop fix:
// a meeting only ever goes processing → processed, so any "processing" copy that
// disagrees with a "processed" copy is a stale read and must lose.

import { describe, expect, it } from 'vitest';

import {
    OPTIMISTIC_LIVE_ID,
    OPTIMISTIC_MAX_AGE_MS,
    PROCESSING_TITLE,
    byNewestFirst,
    formatDuration,
    isMeetingProcessing,
    isOptimisticId,
    mergeMeetingCopies,
    reconcileFetchedMeetings,
    shouldMergeLocalMeeting,
} from '@/api/meetingMapping';
import { Meeting } from '@/types';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A finished meeting: real title, is_processed = 1. */
const done = (over: Partial<Meeting> = {}): Meeting => ({
    id: 'm1',
    title: 'Discovery call with Acme',
    date: ago(60_000),
    duration: '12:30',
    durationMs: 750_000,
    summary: 'See detailed summary',
    isProcessed: true,
    transcript: [],
    usage: [],
    ...over,
});

/** The placeholder row MeetingPersistence writes the instant a call ends. */
const pending = (over: Partial<Meeting> = {}): Meeting =>
    done({ title: PROCESSING_TITLE, summary: '', isProcessed: false, ...over });

describe('isMeetingProcessing', () => {
    it('treats isProcessed === false as processing regardless of title', () => {
        // A calendar meeting carries its real title from the very first save —
        // a title-only check renders it as finished while it is still generating.
        expect(isMeetingProcessing(pending({ title: 'Weekly sync' }))).toBe(true);
    });

    it('falls back to the placeholder title for rows with no flag (legacy/optimistic)', () => {
        expect(isMeetingProcessing({ title: PROCESSING_TITLE } as Meeting)).toBe(true);
    });

    it('is false for a finished meeting', () => {
        expect(isMeetingProcessing(done())).toBe(false);
    });
});

describe('shouldMergeLocalMeeting', () => {
    it('surfaces a local row that is still processing, however old', () => {
        expect(shouldMergeLocalMeeting(pending({ date: ago(60 * 60 * 1000) }))).toBe(true);
    });

    it('keeps a just-finished local row visible while the mirror catches up', () => {
        // Without this the card VANISHES at the exact moment it finishes locally.
        expect(shouldMergeLocalMeeting(done({ date: ago(30_000) }))).toBe(true);
    });

    it('stops trusting a finished local row past the mirror-lag window', () => {
        // Bounded so local SQLite can't resurrect history deleted on another device.
        expect(shouldMergeLocalMeeting(done({ date: ago(60 * 60 * 1000) }))).toBe(false);
    });

    it('does not trust an unparseable date', () => {
        expect(shouldMergeLocalMeeting(done({ date: 'not-a-date' }))).toBe(false);
    });
});

describe('mergeMeetingCopies', () => {
    it('repairs a stale processing row from the processed copy we already know', () => {
        const stale = pending({ id: 'm1', duration: '0:00' });
        const known = done({ id: 'm1' });

        const merged = mergeMeetingCopies(stale, known);

        expect(merged.title).toBe('Discovery call with Acme');
        expect(merged.isProcessed).toBe(true);
        expect(merged.duration).toBe('12:30');
    });

    it('returns incoming by reference when there is nothing to repair', () => {
        const incoming = done();
        // Identity is load-bearing: callers use it to detect "did anything change".
        expect(mergeMeetingCopies(incoming, done({ title: 'Older copy' }))).toBe(incoming);
    });

    it('never downgrades a processed incoming row to a known processing one', () => {
        const incoming = done({ id: 'm1' });
        const merged = mergeMeetingCopies(incoming, pending({ id: 'm1' }));
        expect(merged).toBe(incoming);
        expect(merged.title).toBe('Discovery call with Acme');
    });

    it('leaves a row alone while both copies are still processing', () => {
        const incoming = pending();
        expect(mergeMeetingCopies(incoming, pending())).toBe(incoming);
    });
});

describe('reconcileFetchedMeetings', () => {
    it('returns the fresh list untouched on the very first fetch', () => {
        const fresh = [done()];
        expect(reconcileFetchedMeetings([], fresh)).toBe(fresh);
    });

    it('stops a refetch from reverting a finished card to its processing state', () => {
        // This is the flip-flop: the 3s poll returns the still-lagging Supabase
        // mirror row seconds after local SQLite already produced the real title.
        const previous = [done({ id: 'm1' })];
        const fresh = [pending({ id: 'm1' })];

        const [row] = reconcileFetchedMeetings(previous, fresh);

        expect(row.title).toBe('Discovery call with Acme');
        expect(isMeetingProcessing(row)).toBe(false);
    });

    it('returns fresh by reference when no row needed repairing', () => {
        const fresh = [done({ id: 'm1' })];
        expect(reconcileFetchedMeetings([done({ id: 'm1' })], fresh)).toBe(fresh);
    });

    it('carries the optimistic card across a fetch that cannot contain it yet', () => {
        const optimistic = pending({ id: OPTIMISTIC_LIVE_ID, date: ago(1_000) });
        const result = reconcileFetchedMeetings([optimistic], [done({ id: 'older' })]);

        expect(result.map((m) => m.id)).toEqual([OPTIMISTIC_LIVE_ID, 'older']);
    });

    it('retires the optimistic card once main commits the real processing row', () => {
        const optimistic = pending({ id: OPTIMISTIC_LIVE_ID, date: ago(1_000) });
        const result = reconcileFetchedMeetings([optimistic], [pending({ id: 'real' })]);

        expect(result.map((m) => m.id)).toEqual(['real']);
    });

    it('ages the optimistic card out so a crashed finalization cannot strand it', () => {
        const stranded = pending({
            id: OPTIMISTIC_LIVE_ID,
            date: ago(OPTIMISTIC_MAX_AGE_MS + 1_000),
        });
        expect(reconcileFetchedMeetings([stranded], [done({ id: 'other' })])).toEqual([
            expect.objectContaining({ id: 'other' }),
        ]);
    });

    it('keeps the merged list newest-first when it carries a card over', () => {
        // Still inside the age window, but a newer meeting exists — the union is
        // sorted rather than blindly prepended.
        const optimistic = pending({ id: OPTIMISTIC_LIVE_ID, date: ago(90_000) });
        const result = reconcileFetchedMeetings([optimistic], [done({ id: 'newer', date: ago(1_000) })]);

        expect(result.map((m) => m.id)).toEqual(['newer', OPTIMISTIC_LIVE_ID]);
    });
});

describe('id helpers and sorting', () => {
    it('recognises renderer-invented ids only', () => {
        expect(isOptimisticId(OPTIMISTIC_LIVE_ID)).toBe(true);
        expect(isOptimisticId('4f0c1e2a-real-uuid')).toBe(false);
    });

    it('byNewestFirst sorts descending by date', () => {
        const rows = [
            done({ id: 'old', date: ago(120_000) }),
            done({ id: 'new', date: ago(1_000) }),
        ];
        expect([...rows].sort(byNewestFirst).map((m) => m.id)).toEqual(['new', 'old']);
    });
});

describe('formatDuration', () => {
    it('renders m:ss under an hour and h:mm:ss above it', () => {
        expect(formatDuration(65_000)).toBe('1:05');
        expect(formatDuration(3_725_000)).toBe('1:02:05');
    });

    it('treats a missing duration as zero rather than NaN', () => {
        expect(formatDuration(undefined)).toBe('0:00');
        expect(formatDuration(null)).toBe('0:00');
    });
});
