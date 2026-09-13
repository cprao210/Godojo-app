import { describe, expect, it } from 'vitest';

import {
  hasMultipleClientSpeakers,
  resolveSpeakerDisplayName,
} from '../utils/speakerLabels';

// Rules under test (Settings → Audio, Deepgram diarization):
//   Scenario                       | client (1 voice)      | clientDiarized (2+ voices)
//   1 attendee, company resolvable | "Morgan (Raksham)"    | "Raksham · Speaker N"
//   1 attendee, no company         | "Morgan"              | "Other Party · Speaker N"
//   2+ attendees                   | "Other Party"         | "Other Party · Speaker N"
//   Manual rename                  | typed value           | typed value · Speaker N

const seg = (speaker: string, speakerIndex?: number) => ({ speaker, speakerIndex });

describe('hasMultipleClientSpeakers', () => {
  it('is false when no far-end segment carries an index', () => {
    expect(hasMultipleClientSpeakers([seg('user'), seg('client'), seg('client')])).toBe(false);
  });

  it('is false when the client stream stays on one index', () => {
    expect(hasMultipleClientSpeakers([seg('client', 0), seg('user'), seg('client', 0)])).toBe(false);
  });

  it('is true once two distinct far-end indices appear', () => {
    expect(hasMultipleClientSpeakers([seg('client', 0), seg('client', 1)])).toBe(true);
  });

  it('ignores user indices entirely (mic stream is never diarized)', () => {
    expect(hasMultipleClientSpeakers([seg('user', 0), seg('user', 1), seg('client')])).toBe(false);
  });
});

describe('resolveSpeakerDisplayName', () => {
  it('single voice → plain resolved client label, no suffix', () => {
    const names = { user: 'Nikhil', client: 'Morgan (Raksham)', clientDiarized: 'Raksham' };
    expect(resolveSpeakerDisplayName('client', 0, names, false)).toBe('Morgan (Raksham)');
    expect(resolveSpeakerDisplayName('user', undefined, names, false)).toBe('Nikhil');
  });

  it('2+ voices, company resolvable → company-only base + Speaker N', () => {
    const names = { user: 'Nikhil', client: 'Morgan (Raksham)', clientDiarized: 'Raksham' };
    expect(resolveSpeakerDisplayName('client', 0, names, true)).toBe('Raksham · Speaker 1');
    expect(resolveSpeakerDisplayName('client', 1, names, true)).toBe('Raksham · Speaker 2');
  });

  it('2+ voices, no company → Other Party base', () => {
    const names = { user: 'Nikhil', client: 'Morgan', clientDiarized: 'Other Party' };
    expect(resolveSpeakerDisplayName('client', 1, names, true)).toBe('Other Party · Speaker 2');
  });

  it('2+ attendees → both fields are Other Party, suffix still applies', () => {
    const names = { user: 'Nikhil', client: 'Other Party', clientDiarized: 'Other Party' };
    expect(resolveSpeakerDisplayName('client', 0, names, false)).toBe('Other Party');
    expect(resolveSpeakerDisplayName('client', 0, names, true)).toBe('Other Party · Speaker 1');
  });

  it('manual rename (client === clientDiarized) → typed value wins, suffix applies', () => {
    const names = { user: 'Nikhil', client: 'Alice', clientDiarized: 'Alice' };
    expect(resolveSpeakerDisplayName('client', 0, names, false)).toBe('Alice');
    expect(resolveSpeakerDisplayName('client', 1, names, true)).toBe('Alice · Speaker 2');
  });

  it('missing clientDiarized (legacy name map) → Other Party fallback', () => {
    const names = { user: 'Nikhil', client: 'Morgan (Raksham)' };
    expect(resolveSpeakerDisplayName('client', 0, names, true)).toBe('Other Party · Speaker 1');
  });

  it('index-less far-end segment never gets a suffix even when others are diarized', () => {
    const names = { user: 'Nikhil', client: 'Morgan', clientDiarized: 'Other Party' };
    expect(resolveSpeakerDisplayName('client', undefined, names, true)).toBe('Morgan');
  });

  it('interviewer shares the client rule', () => {
    const names = { user: 'Nikhil', client: 'Them', clientDiarized: 'Other Party' };
    expect(resolveSpeakerDisplayName('interviewer', 1, names, true)).toBe('Other Party · Speaker 2');
  });

  it('non-speaker roles return undefined (renderer falls back per role)', () => {
    expect(resolveSpeakerDisplayName('assistant', undefined, { user: 'U', client: 'C' }, true)).toBeUndefined();
  });
});
