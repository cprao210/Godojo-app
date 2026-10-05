/**
 * coachSummary.ts
 *
 * Read-side helpers for the coach-ready summary fields. questionsToAsk is the
 * one field stored in two shapes: summaries saved before the call-type-aware
 * generator persist plain strings, newer ones persist { question, gap? }
 * objects. Old stored strings are never rewritten — these helpers normalise
 * at read time so every consumer can treat both shapes the same.
 */

import type { CoachHighlight, CoachPromise, CoachQuestion } from '../types';

/** The displayable text of a questionsToAsk entry, regardless of stored shape. */
export function coachQuestionText(q: CoachQuestion | null | undefined): string {
    if (q === null || q === undefined) return '';
    return typeof q === 'string' ? q : (typeof q.question === 'string' ? q.question : '');
}

/** True when at least one questionsToAsk entry has non-blank text — the
 *  filled-ness check the Summary tab's empty-state logic needs, shape-agnostic. */
export function filledCoachQuestions(questions: readonly CoachQuestion[] | null | undefined): boolean {
    return Array.isArray(questions) && questions.some((q) => coachQuestionText(q).trim().length > 0);
}

/** True when any of the given type lists contains the call type (case/whitespace tolerant). */
function includesCallType(callType: string, list: unknown): boolean {
    const wanted = callType.trim().toLowerCase();
    return Array.isArray(list) && list.some((t) => String(t ?? '').trim().toLowerCase() === wanted);
}

/** Structural summary shape the call-type checks need. `scorecard` rides on
 *  MeetingDetailedSummary's index signature — summaries saved by older
 *  versions may or may not carry it. */
type CallTypeSummaryLike = { coachCallType?: unknown; scorecard?: { detectedTypes?: unknown } } | null | undefined;

/**
 * True when the call involved the given type — either as the resolved coach
 * call type, as one of the types the user selected during the live call, or
 * as one the scorecard detected. Not used by the single-type panels (they
 * check `summary.coachCallType === '…'` directly); kept for the upcoming
 * multi-meeting-type summary work.
 */
export function callInvolves(
    callType: string,
    summary: CallTypeSummaryLike,
    ...typeLists: unknown[]
): boolean {
    return includesCallType(callType, [summary?.coachCallType])
        || includesCallType(callType, summary?.scorecard?.detectedTypes)
        || typeLists.some((list) => includesCallType(callType, list));
}

/**
 * The promises checklist source: the structured promises field when present,
 * falling back to legacy action items (old meetings). Shared by the Game
 * Plan UI, the "Copy prep sheet" formatter and the PDF exporter so all three
 * agree on what counts as a promise.
 */
export function coachPromises(summary: { promises?: CoachPromise[]; actionItems?: string[] }): CoachPromise[] {
    if (summary.promises?.length) {
        return summary.promises.filter((p) => p?.text?.trim());
    }
    return (summary.actionItems ?? [])
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((text) => ({ text }));
}

/** A parsed salesCoachReview item, shared by Coach's notes UI/copy/PDF. */
export type ParsedCoachNote = {
    /** Conversation skill area ("Questioning") or legacy component ("Metrics"). */
    label: string | null;
    content: string;
    /** A quoted script lifted out of the content, if present. */
    quote: string | null;
    /** Leading transcript timecode on film-review items ("04:55"), when present. */
    time: string | null;
};

// Exact-match placeholder detection (same set the old Self-Analysis sections
// used) so junk like "N/A" or "Not discussed" never becomes a note card.
const PLACEHOLDER_NOTE_CONTENT = new Set([
    'n/a', 'na', 'none', 'none.', '-', '—', 'unknown', 'not discussed',
    'not mentioned', 'not applicable', 'nothing', 'nothing.',
]);

/**
 * Parses one "Label: content" salesCoachReview item: the label is the
 * conversation skill area ("Questioning", "Objection handling") on new
 * summaries, or a framework-prefixed component ("MEDDICC Metrics") on
 * legacy ones. Drops placeholder junk and lifts a quoted suggestion
 * ("…: "Say this"") into `quote`. Returns null when the item has no
 * displayable content.
 */
export function parseCoachNoteItem(item: string | null | undefined): ParsedCoachNote | null {
    if (typeof item !== 'string') return null;
    // Film-review items lead with the moment's timecode: "04:55 — ...".
    // Stripped BEFORE the label parse — the timecode's colon would otherwise
    // be mistaken for a "Label:" prefix.
    let time: string | null = null;
    const timeMatch = item.match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[\u2014\u2013-]\s*/);
    if (timeMatch) {
        time = timeMatch[1];
        item = item.slice(timeMatch[0].length);
    }
    // "Label: content" — label is short, anything past 30 chars is prose.
    const colonIndex = item.indexOf(':');
    const hasLabel = colonIndex > 0 && colonIndex < 30;
    const rawLabel = hasLabel ? item.substring(0, colonIndex).trim() : null;
    let content = (hasLabel ? item.substring(colonIndex + 1) : item).trim();

    // Chip label: new items carry a conversation skill area ("Questioning:",
    // "Objection handling:", "Discovery:"); legacy items carry framework-
    // prefixed components. Strip the framework prefix only when a component
    // name remains behind it — "Discovery" alone is a valid skill label.
    let label: string | null = null;
    if (rawLabel) {
        const stripped = rawLabel.replace(/^(MEDDIC{1,2}|BANT|DISCOVERY)\s*/i, '').trim();
        label = (stripped || rawLabel.trim()) || null;
    }

    const normalized = content.toLowerCase().replace(/[.!?]+$/, '').trim();
    if (!content || PLACEHOLDER_NOTE_CONTENT.has(normalized)) return null;

    let quote: string | null = null;
    // Curly (\u201C \u201D) or straight double quotes — escaped so editors and
    // shells can't mangle the literals.
    const match = content.match(/[\u201C"]([^\u201D"]{4,})[\u201D"]/);
    if (match && match.index !== undefined) {
        quote = match[1].trim();
        content = (content.slice(0, match.index) + content.slice(match.index + match[0].length))
            .replace(/\s{2,}/g, ' ')
            .replace(/[\s:—-]+$/, '')
            .trim();
    }

    return { label, content, quote, time };
}

/**
 * Parses a whatIDidRight entry in either shape: new summaries store film-
 * review highlight objects ({ time, skill, moment, why }) describing the
 * rep's own behavior; old summaries store "Label: content" strings (see
 * parseCoachNoteItem). Returns null for junk entries.
 */
export function parseCoachHighlight(item: string | CoachHighlight | null | undefined): ParsedCoachNote | null {
    if (item !== null && item !== undefined && typeof item === 'object') {
        const skill = typeof item.skill === 'string' && item.skill.trim() ? item.skill.trim() : null;
        const time = typeof item.time === 'string' && item.time.trim() ? item.time.trim() : null;
        const moment = typeof item.moment === 'string' ? item.moment.trim() : '';
        const why = typeof item.why === 'string' ? item.why.trim() : '';
        const content = [moment, why].filter(Boolean).join(' \u2014 ');
        if (!content) return null;
        return { label: skill, content, quote: null, time };
    }
    return parseCoachNoteItem(item);
}
