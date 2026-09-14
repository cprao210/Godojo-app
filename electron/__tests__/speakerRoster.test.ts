import { describe, expect, it } from 'vitest';

import {
    buildSpeakerRoster,
    formatSpeakerRosterBlock,
    transcriptTurnLabel,
} from '../utils/speakerLabels';

// The roster is the common speaker-identity layer every LLM round-trip
// (summary, call analysis, scorecard) reads from, so uploads get named,
// role-correct participants and live diarized calls keep their existing
// REP/PROSPECT labelling.

describe('transcriptTurnLabel', () => {
    it('prefers the original displayName (uploaded transcripts)', () => {
        expect(transcriptTurnLabel({ speaker: 'user', text: 'x', displayName: 'Alex' }, null, false)).toBe('Alex');
        expect(transcriptTurnLabel({ speaker: 'client', text: 'x', displayName: 'Daniel' }, null, false)).toBe('Daniel');
    });

    it('falls back to resolved role names for live segments', () => {
        const names = { user: 'Nikhil', client: 'Morgan (Raksham)', clientDiarized: 'Raksham' };
        expect(transcriptTurnLabel({ speaker: 'user', text: 'x' }, names, false)).toBe('Nikhil');
        expect(transcriptTurnLabel({ speaker: 'client', text: 'x' }, names, false)).toBe('Morgan (Raksham)');
    });

    it('keeps the (Speaker n) suffix for live multi-voice diarization', () => {
        const names = { user: 'Nikhil', client: 'Them' };
        expect(transcriptTurnLabel({ speaker: 'client', text: 'x', speakerIndex: 1 }, names, true))
            .toBe('Them (Speaker 2)');
    });
});

describe('buildSpeakerRoster', () => {
    const UPLOAD = [
        { speaker: 'user', text: 'a', displayName: 'Alex' },
        { speaker: 'client', text: 'b', displayName: 'Daniel' },
        { speaker: 'user', text: 'c', displayName: 'Alex' },
        { speaker: 'client', text: 'd', displayName: 'Lara' },
    ];

    it('lists distinct speakers in first-appearance order', () => {
        expect(buildSpeakerRoster(UPLOAD, null, false)).toEqual([
            { label: 'Alex', role: 'user' },
            { label: 'Daniel', role: 'client' },
            { label: 'Lara', role: 'client' },
        ]);
    });

    it('excludes internal system/AI turns', () => {
        const roster = buildSpeakerRoster(
            [...UPLOAD, { speaker: 'assistant', text: 'x' }, { speaker: 'ai', text: 'y' }],
            null, false
        );
        expect(roster.map(r => r.label)).toEqual(['Alex', 'Daniel', 'Lara']);
    });
});

describe('formatSpeakerRosterBlock', () => {
    it('is empty for fewer than two speakers (nothing worth telling the model)', () => {
        expect(formatSpeakerRosterBlock([{ label: 'Alex', role: 'user' }])).toBe('');
        expect(formatSpeakerRosterBlock([])).toBe('');
    });

    it('names every participant with its role and orders user first as the rep', () => {
        const block = formatSpeakerRosterBlock([
            { label: 'Alex', role: 'user' },
            { label: 'Daniel', role: 'client' },
            { label: 'Lara', role: 'client' },
        ]);
        expect(block).toContain('"Alex" is the sales representative (microphone user / REP) — the first speaker in this transcript');
        expect(block).toContain('"Daniel" is a prospect / client-side speaker (PROSPECT)');
        expect(block).toContain('"Lara" is a prospect / client-side speaker (PROSPECT)');
        expect(block).toContain('Never write "the prospect" or "the salesperson" when a name above is known.');
    });
});
