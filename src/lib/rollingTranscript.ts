// The rolling transcript strip's display bound.
//
// The two rolling strings (`rollingTranscriptUser` / `rollingTranscriptClient`
// in useGodojoInterface) are appended to for the entire call. They feed
// FilmRollTranscript, which renders the whole string as one `whitespace-nowrap
// inline-block` node and then reads `el.scrollWidth` on every text change to
// tail it — a forced synchronous layout of a text run that grows all call, in
// both panels, including the one sitting behind `visibility: hidden`. That is
// the mechanism behind "the overlay gets worse the longer the call runs".
//
// The strip shows ~50-60 characters: it auto-scrolls to the tail and masks the
// head with a gradient, so anything further back is already invisible. Bounding
// the string is therefore invisible on screen and makes the layout cost O(1)
// instead of O(call length).
//
// The untruncated record of record is `liveTranscriptRef`, which is what live
// analysis, the objection watch and post-meeting persistence read — none of them
// touch these strings.

/** ~10x what the strip can actually show, so the tail is never starved. */
export const ROLLING_MAX_CHARS = 600;

/** Segment separator used by every rolling-transcript updater. */
export const ROLLING_SEPARATOR = '  ·  ';

/**
 * Trim a rolling transcript string to the display bound, cutting only at a
 * segment boundary.
 *
 * Cutting mid-segment would corrupt the updaters' pending-partial logic, which
 * locates the live tail with `lastIndexOf(ROLLING_SEPARATOR)` and rebuilds it.
 * A single segment longer than the bound (one very long uninterrupted final) is
 * therefore returned whole rather than sliced — it drains on the next segment.
 */
export function boundRolling(s: string): string {
    if (s.length <= ROLLING_MAX_CHARS) return s;
    const sepAt = s.indexOf(ROLLING_SEPARATOR, s.length - ROLLING_MAX_CHARS);
    return sepAt >= 0 ? s.slice(sepAt + ROLLING_SEPARATOR.length) : s;
}
