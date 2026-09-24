// Covers src/lib/bantMeddic — the accessors that decide WHAT a reader sees for
// a BANT/MEDDIC field, across both shapes of the backend contract.
//
// The current contract gives each criterion a `summary` (its assessment) and a
// LIST of evidence statements. Rows saved before that carry a single evidence
// string and no summary. Everything here must serve both, and the old-shape
// cases below are the guarantee that saved meetings keep rendering exactly as
// they did — they are not redundant with the new-shape ones.
//
// The backend returns `evidence` verbatim from the transcript and
// `evidence_clean` as its readable rendering. On a call held in another
// language the verbatim span is unreadable to the person looking at the panel,
// so every display surface takes the clean one — but it is optional (older
// saved rows, and the local upload analyser, never carry it), so the verbatim
// span has to remain the fallback rather than leaving the surface blank.

import { describe, expect, it } from 'vitest';
import {
    fieldDisplay,
    fieldEvidence,
    fieldEvidenceList,
    fieldSummary,
    fieldText,
    normalizeBant,
    normalizeMeddicc,
    toEvidenceList,
} from '@/lib/bantMeddic';

// Rows saved before summaries existed: evidence_clean is the readable card body.
describe('fieldText — pre-summary rows', () => {
    it('prefers the readable rendering when the backend sent one', () => {
        expect(fieldText({
            evidence: 'ठीक है, अब मुझे बताइए आपकी cost क्या है?',
            evidence_clean: 'Okay, tell me what your cost is?',
        })).toBe('Okay, tell me what your cost is?');
    });

    it('falls back to the verbatim span when there is no clean one', () => {
        expect(fieldText({ evidence: 'Budget of 200k approved' })).toBe('Budget of 200k approved');
        expect(fieldText({ evidence: 'raw only', evidence_clean: '' })).toBe('raw only');
        // Whitespace-only is not a rendering — an all-spaces clean value would
        // otherwise blank a field that does have evidence.
        expect(fieldText({ evidence: 'raw only', evidence_clean: '   ' })).toBe('raw only');
    });

    it('returns an empty string when there is nothing to show', () => {
        expect(fieldText({ evidence: '' })).toBe('');
        expect(fieldText({})).toBe('');
        expect(fieldText(undefined)).toBe('');
        expect(fieldText(null)).toBe('');
    });

    it('trims, so a surface never renders padding as content', () => {
        expect(fieldText({ evidence: '  spaced  ' })).toBe('spaced');
        expect(fieldText({ evidence: 'raw', evidence_clean: '  clean  ' })).toBe('clean');
    });
});

describe('normalizeBant / normalizeMeddicc', () => {
    it('carries the readable rendering into the canonical detail', () => {
        const bant = normalizeBant({
            budget: { status: 'partial', evidence: 'आपकी cost क्या है?', evidence_clean: 'What is your cost?' },
            authority: { status: 'missing', evidence: '' },
            need: { status: 'confirmed', evidence: 'dispatch is the headache' },
            timeline: { status: 'missing', evidence: '' },
        } as any);

        expect(bant?.budget).toEqual({ status: 'Partial', detail: 'What is your cost?' });
        // No clean rendering → the verbatim span, exactly as before.
        expect(bant?.need).toEqual({ status: 'Clear', detail: 'dispatch is the headache' });
        expect(bant?.authority).toEqual({ status: 'Missing', detail: '' });
    });

    it('does the same across the MEDDIC keys', () => {
        const meddic = normalizeMeddicc({
            metrics: { status: 'missing', evidence: '' },
            economic_buyer: { status: 'missing', evidence: '' },
            decision_criteria: { status: 'confirmed', evidence: 'employee ID अपने आप generate', evidence_clean: 'The system should generate the employee ID automatically.' },
            decision_process: { status: 'missing', evidence: '' },
            identify_pain: { status: 'missing', evidence: '' },
            champion: { status: 'missing', evidence: '' },
            competition: { status: 'confirmed', evidence: 'हम तो Excel पर काम कर रहे हैं', evidence_clean: 'We are working on Excel.' },
        } as any);

        expect(meddic?.decisionCriteria.detail).toBe('The system should generate the employee ID automatically.');
        expect(meddic?.competition.detail).toBe('We are working on Excel.');
    });
});


describe('toEvidenceList / fieldEvidenceList', () => {
    it('coerces either shape to a list', () => {
        expect(toEvidenceList(['a', 'b'])).toEqual(['a', 'b']);
        expect(toEvidenceList('a')).toEqual(['a']);
        expect(toEvidenceList('')).toEqual([]);
        expect(toEvidenceList([])).toEqual([]);
        expect(toEvidenceList(undefined)).toEqual([]);
    });

    it('trims and drops empty entries', () => {
        expect(toEvidenceList(['  a  ', '', '   ', 'b'])).toEqual(['a', 'b']);
        expect(toEvidenceList('  spaced  ')).toEqual(['spaced']);
    });

    it('survives a non-string element rather than taking the renderer down', () => {
        expect(toEvidenceList([1, null, 'b'] as any)).toEqual(['1', 'b']);
    });

    it('reads the verbatim spans, never the evidence_clean mirror', () => {
        // The backend's add_legacy_evidence_mirror copies `summary` into
        // evidence_clean for older builds. Treating it as evidence would show
        // the summary twice and hide the real spans.
        const field = {
            summary: 'Pricing was discussed at ₹60 per user for a 100-user trial.',
            evidence_clean: 'Pricing was discussed at ₹60 per user for a 100-user trial.',
            evidence: ['60 rupees per user per month', 'we will start with 100 users'],
        };
        expect(fieldEvidenceList(field)).toEqual(['60 rupees per user per month', 'we will start with 100 users']);
    });

    it('joins statements with a single space for the one-string readers', () => {
        expect(fieldEvidence({ evidence: ['One thing.', 'Another thing.'] }))
            .toBe('One thing. Another thing.');
        // Identity on a one-element list — which is what keeps every
        // pre-existing scalar expectation in this file true.
        expect(fieldEvidence({ evidence: ['only'] })).toBe('only');
    });
});

describe('fieldSummary / fieldText', () => {
    it('trims the summary and treats whitespace-only as absent', () => {
        expect(fieldSummary({ summary: '  Budget is unconfirmed.  ' })).toBe('Budget is unconfirmed.');
        expect(fieldSummary({ summary: '   ' })).toBe('');
        expect(fieldSummary({})).toBe('');
        expect(fieldSummary(undefined)).toBe('');
    });

    it('is the source of truth: the summary wins over the evidence', () => {
        expect(fieldText({
            summary: 'Pricing was discussed but no budget is approved.',
            evidence: ['₹60 per user per month.', 'A 100-user trial.'],
        })).toBe('Pricing was discussed but no budget is approved.');
    });

    it('falls back to the evidence on a row saved before summaries existed', () => {
        expect(fieldText({ evidence: 'we have 200k approved' })).toBe('we have 200k approved');
        expect(fieldText({ evidence: [] })).toBe('');
    });

    it('shows the summary even when the field carries no evidence', () => {
        expect(fieldText({ summary: 'Nothing was established here.', evidence: [] }))
            .toBe('Nothing was established here.');
    });
});

describe('toCanonicalField via normalizeBant', () => {
    it('puts the summary in detail', () => {
        const bant = normalizeBant({
            budget: {
                status: 'partial',
                summary: 'Pricing has been discussed, but no budget is approved.',
                evidence: ['₹60 per user per month.'],
            },
        } as any);
        expect(bant?.budget).toEqual({
            status: 'Partial',
            detail: 'Pricing has been discussed, but no budget is approved.',
        });
    });

    it('is byte-identical to the old behaviour on a pre-summary row', () => {
        const bant = normalizeBant({
            budget: { status: 'partial', evidence: 'आपकी cost क्या है?', evidence_clean: 'What is your cost?' },
        } as any);
        expect(bant?.budget).toEqual({ status: 'Partial', detail: 'What is your cost?' });
    });
});

describe('fieldDisplay', () => {
    it('new row: summary is the body, evidence goes behind the disclosure', () => {
        expect(fieldDisplay({ summary: 'Budget unconfirmed.', evidence: ['₹60 per user.'] })).toEqual({
            evidence: ['₹60 per user.'],
            body: 'Budget unconfirmed.',
            showDisclosure: true,
        });
    });

    it('OLD ROW GUARANTEE: one evidence span and no summary renders exactly as before', () => {
        const d = fieldDisplay({ evidence: 'we have 200k approved' });
        expect(d.body).toBe('we have 200k approved');
        // No disclosure — it would hide the only content the card has.
        expect(d.showDisclosure).toBe(false);
    });

    it('no summary (a guard dropped a span) -> spans are the body, no disclosure', () => {
        // The backend blanks `summary` whenever it drops a span the line may
        // have described; a disclosure would just repeat the body.
        const d = fieldDisplay({ evidence: ['one', 'two'], evidence_clean: 'one two' });
        expect(d.body).toBe('one two');
        expect(d.showDisclosure).toBe(false);
    });

    it('current backend payload: summary body, verbatim spans in the disclosure', () => {
        const d = fieldDisplay({
            summary: 'Adding sites needs multiple approvals.',
            evidence_clean: 'Adding sites needs multiple approvals.',
            evidence: ['every new site needs three approvals'],
        });
        expect(d.body).toBe('Adding sites needs multiple approvals.');
        expect(d.evidence).toEqual(['every new site needs three approvals']);
        expect(d.showDisclosure).toBe(true);
    });

    it('old non-English row: readable rendering as body, exactly as before', () => {
        const d = fieldDisplay({ evidence: 'आपकी cost क्या है?', evidence_clean: 'What is your cost?' });
        expect(d.body).toBe('What is your cost?');
        expect(d.showDisclosure).toBe(false);
    });

    it('no disclosure when there is no evidence at all', () => {
        expect(fieldDisplay({ summary: 'Nothing established.', evidence: [] }).showDisclosure).toBe(false);
        expect(fieldDisplay({}).showDisclosure).toBe(false);
        expect(fieldDisplay(undefined).body).toBe('');
    });
});
