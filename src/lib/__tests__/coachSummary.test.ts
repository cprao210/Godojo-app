import { describe, expect, it } from 'vitest';

import { callInvolves, coachPromises, coachQuestionText, filledCoachQuestions, parseCoachHighlight, parseCoachNoteItem } from '@/lib/coachSummary';
import { hasGeneratedSummary } from '@/lib/meetingLifecycle';
import { isSummaryEmpty } from '@/hooks/useMeetingDetails';

// Schema compatibility: questionsToAsk is stored in two shapes — plain strings
// on old summaries, { question, gap? } objects on new ones — and the renderer
// must read both without rewriting stored data or throwing.

describe('coachQuestionText', () => {
    it('reads plain strings (old summaries) unchanged', () => {
        expect(coachQuestionText('Who will ultimately approve this purchase?')).toBe('Who will ultimately approve this purchase?');
    });

    it('reads structured questions (new summaries)', () => {
        expect(coachQuestionText({ question: 'What measurable outcome defines success?', gap: 'Metrics' }))
            .toBe('What measurable outcome defines success?');
        expect(coachQuestionText({ question: 'No gap on this one' })).toBe('No gap on this one');
    });

    it('tolerates junk without throwing', () => {
        expect(coachQuestionText(null)).toBe('');
        expect(coachQuestionText(undefined)).toBe('');
        expect(coachQuestionText({} as any)).toBe('');
    });
});

describe('filledCoachQuestions', () => {
    it('accepts both shapes and blanks', () => {
        expect(filledCoachQuestions(['Who signs?'])).toBe(true);
        expect(filledCoachQuestions([{ question: 'Who signs?' }])).toBe(true);
        expect(filledCoachQuestions([{ gap: 'Metrics' } as any])).toBe(false);
        expect(filledCoachQuestions([])).toBe(false);
        expect(filledCoachQuestions(undefined)).toBe(false);
    });
});

describe('callInvolves', () => {
    it('is true when the resolved coach call type matches', () => {
        expect(callInvolves('demo', { coachCallType: 'demo' } as any)).toBe(true);
        expect(callInvolves('negotiation', { coachCallType: 'negotiation' } as any)).toBe(true);
    });

    it('is false when nothing signals the type', () => {
        expect(callInvolves('demo', { coachCallType: 'discovery' } as any)).toBe(false);
        expect(callInvolves('negotiation', { coachCallType: 'demo' } as any, ['demo'])).toBe(false);
        expect(callInvolves('demo', null)).toBe(false);
        expect(callInvolves('negotiation', undefined)).toBe(false);
    });

    it('is true when the type is among the live-call selected types (mixed calls)', () => {
        expect(callInvolves('demo', { coachCallType: 'negotiation' } as any, ['discovery', 'demo'])).toBe(true);
        expect(callInvolves('negotiation', {} as any, ['demo', 'negotiation'])).toBe(true);
    });

    it('is true when the scorecard detected the type', () => {
        expect(callInvolves('demo', { scorecard: { detectedTypes: ['demo'] } } as any)).toBe(true);
        expect(callInvolves('negotiation', {} as any, undefined, ['discovery', 'negotiation'])).toBe(true);
    });

    it('matches case/whitespace variants and ignores junk', () => {
        expect(callInvolves('demo', {} as any, [' Demo '])).toBe(true);
        expect(callInvolves('negotiation', {} as any, ['NEGOTIATION'])).toBe(true);
        expect(callInvolves('demo', {} as any, ['demotion'])).toBe(false);
        expect(callInvolves('demo', {} as any, undefined as any, 'demo' as any)).toBe(false);
    });
});

describe('coachPromises', () => {
    it('uses the structured promises field when present', () => {
        expect(coachPromises({ promises: [{ text: 'Send the deck', owner: 'Me', dueDate: '2026-10-07' }, { text: '   ' }] }))
            .toEqual([{ text: 'Send the deck', owner: 'Me', dueDate: '2026-10-07' }]);
    });

    it('falls back to legacy action items for old meetings', () => {
        expect(coachPromises({ actionItems: ['Follow up with Rahul', ''] }))
            .toEqual([{ text: 'Follow up with Rahul' }]);
        expect(coachPromises({})).toEqual([]);
    });
});

describe('parseCoachNoteItem', () => {
    it('strips the framework prefix into the chip label', () => {
        expect(parseCoachNoteItem('MEDDICC Metrics: Anchored the 3-hour saving')).toEqual({
            label: 'Metrics',
            content: 'Anchored the 3-hour saving',
            quote: null,
            time: null,
        });
    });

    it('lifts a quoted suggestion into its own field', () => {
        const note = parseCoachNoteItem('Discovery Pain: Ask earlier: "What happens if this slips a quarter?"');
        expect(note?.label).toBe('Pain');
        expect(note?.content).toBe('Ask earlier');  // dangling separator before the quote is cleaned
        expect(note?.quote).toBe('What happens if this slips a quarter?');
    });

    it('drops placeholder junk and label-less noise', () => {
        expect(parseCoachNoteItem('BANT Budget: N/A')).toBeNull();
        expect(parseCoachNoteItem('—')).toBeNull();
        expect(parseCoachNoteItem('   ')).toBeNull();
    });

    it('passes plain items through with no label', () => {
        expect(parseCoachNoteItem('Strong rapport with the room')).toEqual({
            label: null,
            content: 'Strong rapport with the room',
            quote: null,
            time: null,
        });
    });
});

describe('hasGeneratedSummary / isSummaryEmpty — dual question shapes', () => {
    it('structured questions count as generated content', () => {
        expect(hasGeneratedSummary({ nextCallPlaybook: { questionsToAsk: [{ question: 'Who signs?', gap: 'Economic Buyer' }] } })).toBe(true);
    });

    it('old string questions keep working', () => {
        expect(hasGeneratedSummary({ nextCallPlaybook: { questionsToAsk: ['Who signs?'] } })).toBe(true);
    });

    it('object questions never crash the empty-check (no s.trim is not a function)', () => {
        expect(() => isSummaryEmpty({ actionItems: [], keyPoints: [], nextCallPlaybook: { questionsToAsk: [{ question: 'Q', gap: 'G' }] } } as any)).not.toThrow();
        expect(isSummaryEmpty({ actionItems: [], keyPoints: [], nextCallPlaybook: { questionsToAsk: [{ question: 'Q', gap: 'G' }] } } as any)).toBe(false);
        expect(isSummaryEmpty({ actionItems: [], keyPoints: [] } as any)).toBe(true);
    });

    it('missing optional coach fields on old summaries cause no errors', () => {
        const oldSummary = {
            overview: 'The buyer is evaluating the solution.',
            actionItems: [],
            keyPoints: [],
            dealStatus: { stage: 'Proposal', summary: 'Reviewing.' },
            bant: {},
            meddicc: {},
            salesCoachReview: { whatIDidRight: [], whatICouldHaveDoneBetter: [], whatIMissedCompletely: [] },
            nextCallPlaybook: {
                openingRecap: '...',
                questionsToAsk: ['a', 'b'],
                valueAndROI: { quantitative: [], qualitative: [] },
            },
        };
        expect(() => {
            hasGeneratedSummary(oldSummary as any);
            isSummaryEmpty(oldSummary as any);
        }).not.toThrow();
        expect(hasGeneratedSummary(oldSummary as any)).toBe(true);
        expect(isSummaryEmpty(oldSummary as any)).toBe(false);
    });
});

describe('parseCoachNoteItem — conversation skill labels', () => {
    it('treats conversation skill areas as chip labels', () => {
        const note = parseCoachNoteItem('Objection handling: Deflected the pricing pushback too fast — acknowledge it first: "That is a fair concern — most CFOs ask this."');
        expect(note?.label).toBe('Objection handling');
        expect(note?.quote).toBe('That is a fair concern — most CFOs ask this.');
    });

    it('does not strip "Discovery" when it IS the skill label', () => {
        expect(parseCoachNoteItem('Discovery: Scratched the surface on their current workflow')?.label).toBe('Discovery');
    });

    it('still strips legacy framework prefixes for old meetings', () => {
        expect(parseCoachNoteItem('MEDDICC Metrics: Quantified the saving at 3 hours a week')?.label).toBe('Metrics');
    });
});

describe('parseCoachNoteItem — film-review timecodes', () => {
    it('extracts a leading mm:ss timecode before the skill label', () => {
        const note = parseCoachNoteItem('04:55 — Questioning: caught the unprompted question and answered with a two-scenario plan');
        expect(note?.time).toBe('04:55');
        expect(note?.label).toBe('Questioning');
        expect(note?.content).toBe('caught the unprompted question and answered with a two-scenario plan');
    });

    it('supports hour-long calls (h:mm:ss) and hyphen separators', () => {
        expect(parseCoachNoteItem('1:02:10 - Listening: held silence after the price')?.time).toBe('1:02:10');
    });

    it('leaves legacy untimestamped items untouched (time null)', () => {
        expect(parseCoachNoteItem('Listening: let the buyer finish every answer')?.time).toBeNull();
    });

    it('does not mistake a time-like label for a timecode mid-sentence', () => {
        // No leading timecode — the whole item parses as label + content.
        expect(parseCoachNoteItem('Next steps: agreed a Saturday 5:00 follow-up')?.time).toBeNull();
    });
});

describe('parseCoachHighlight — film-review highlight objects', () => {
    it('parses a highlight object into the shared note shape', () => {
        const note = parseCoachHighlight({
            time: '08:26',
            skill: 'Listening',
            moment: 'let the buyer run uninterrupted through all three pain points',
            why: 'the volunteered context became the whole discovery',
        });
        expect(note).toEqual({
            label: 'Listening',
            content: 'let the buyer run uninterrupted through all three pain points — the volunteered context became the whole discovery',
            quote: null,
            time: '08:26',
        });
    });

    it('tolerates a missing time and missing skill', () => {
        const note = parseCoachHighlight({ skill: '', moment: 'held silence after price', why: 'the buyer spoke next' });
        expect(note?.time).toBeNull();
        expect(note?.label).toBeNull();
        expect(note?.content).toContain('held silence after price');
    });

    it('drops highlight objects with no moment and no why', () => {
        expect(parseCoachHighlight({ skill: 'Questioning', moment: '', why: '' })).toBeNull();
        expect(parseCoachHighlight({} as any)).toBeNull();
    });

    it('delegates legacy strings to parseCoachNoteItem', () => {
        expect(parseCoachHighlight('04:55 — Questioning: caught the unprompted question')?.time).toBe('04:55');
        expect(parseCoachHighlight(null)).toBeNull();
        expect(parseCoachHighlight(undefined)).toBeNull();
    });
});
