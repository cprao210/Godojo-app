// speakerLabels.ts
// Single source of truth for far-end speaker display labels when Deepgram
// diarization is enabled. The live broadcast (AppState._dispatchTranscript)
// and the post-call persistence stamping (MeetingPersistence) must produce
// byte-identical labels, or the Transcript tab after a call ends shows
// different names than the rep saw during the call.
//
// Rule (mirrors AppState._dispatchTranscript):
//   - user turns        → names.user
//   - client/interviewer
//     + 2+ distinct far-end indices seen → `${clientDiarized} · Speaker N`
//       (clientDiarized is the company-only / generic base set by
//        SessionTracker — "Raksham", "Other Party" — never a full name, so
//        "Morgan (Raksham) · Speaker 1" can't mis-attribute the person)
//     + otherwise       → names.client
//   - anything else     → undefined (renderer falls back per role)
//
// Manual rename sets client and clientDiarized to the same typed value
// (SessionTracker.updateSpeakerNames), so an explicit override wins in both
// single- and multi-voice scenarios.

export interface SpeakerNameMapLike {
  user: string;
  client: string;
  clientDiarized?: string;
}

export interface SpeakerLabelSegmentLike {
  speaker: string;
  speakerIndex?: number;
}

/** Diarized label marker — the one place the suffix format is defined. */
export const SPEAKER_SUFFIX_SEPARATOR = ' · Speaker ';

/**
 * True when 2+ distinct far-end speaker indices were recorded in the
 * transcript (Deepgram diarization found more than one client-side voice).
 * Matches the rule processAndSaveMeeting uses for LLM turn labels and
 * AppState._clientSpeakerIndicesSeen uses for live dispatch.
 */
export function hasMultipleClientSpeakers(segments: SpeakerLabelSegmentLike[]): boolean {
  const seen = new Set<number>();
  for (const s of segments) {
    if (s.speaker !== 'user' && s.speakerIndex !== undefined && s.speakerIndex !== null) {
      seen.add(s.speakerIndex);
      if (seen.size >= 2) return true;
    }
  }
  return false;
}

/**
 * Resolve the display name for one transcript segment. `speakerNames` is the
 * snapshot taken at stop time (or the session's current map on upload paths).
 */
export function resolveSpeakerDisplayName(
  speaker: string,
  speakerIndex: number | undefined | null,
  speakerNames: SpeakerNameMapLike,
  multiClientSpeakers: boolean
): string | undefined {
  if (speaker === 'user') return speakerNames.user;
  if (speaker === 'client' || speaker === 'interviewer') {
    if (multiClientSpeakers && speakerIndex !== undefined && speakerIndex !== null) {
      return `${speakerNames.clientDiarized || 'Other Party'}${SPEAKER_SUFFIX_SEPARATOR}${speakerIndex + 1}`;
    }
    return speakerNames.client;
  }
  return undefined;
}

// ── LLM turn labelling + speaker roster ─────────────────────────────────────
// Every LLM round-trip over a transcript (summary, title, call analysis,
// scorecard) must describe the SAME participants with the SAME names — and
// must know who is the sales person. One function produces a turn's label,
// one roster is derived from it and prepended to the transcript, so prompts
// can say "Daniel manages 40 trucks" instead of guessing at "the prospect".

export interface TranscriptTurnLike {
  speaker: string;
  text: string;
  displayName?: string;
  speakerIndex?: number;
}

/** The label used for one segment when serialising a transcript for the LLM. */
export function transcriptTurnLabel(
  t: TranscriptTurnLike,
  speakerNames: SpeakerNameMapLike | undefined | null,
  multiClientSpeakers: boolean
): string {
  // An explicit per-segment label (uploaded transcripts carry the original
  // speaker name) beats the resolved role names — live segments never carry
  // one, so their labelling is unchanged.
  if (t.displayName) return t.displayName;
  let role = t.speaker === 'user'
    ? (speakerNames?.user || 'REP')
    : (t.speaker === 'client' || t.speaker === 'interviewer')
      ? (speakerNames?.client || 'PROSPECT')
      : t.speaker;
  const idx = t.speakerIndex;
  if (t.speaker !== 'user' && multiClientSpeakers && idx !== undefined && idx !== null) {
    role = `${role} (Speaker ${idx + 1})`;
  }
  return role;
}

export interface SpeakerRosterEntry {
  label: string;
  role: 'user' | 'client';
}

const INTERNAL_SPEAKERS = new Set(['system', 'ai', 'assistant', 'model']);

/** Ordered, de-duplicated list of speakers in a transcript. */
export function buildSpeakerRoster(
  segments: TranscriptTurnLike[],
  speakerNames: SpeakerNameMapLike | undefined | null,
  multiClientSpeakers: boolean
): SpeakerRosterEntry[] {
  const seen = new Map<string, SpeakerRosterEntry>();
  for (const t of segments) {
    const speaker = (t.speaker || '').toLowerCase();
    if (INTERNAL_SPEAKERS.has(speaker)) continue;
    const label = transcriptTurnLabel(t, speakerNames, multiClientSpeakers);
    const key = `${t.speaker === 'user' ? 'user' : 'client'}::${label.toUpperCase()}`;
    if (!seen.has(key)) seen.set(key, { label, role: t.speaker === 'user' ? 'user' : 'client' });
  }
  return [...seen.values()];
}

/**
 * Preamble describing the participants and their roles, prepended to the
 * transcript sent to the summary/analysis/scorecard LLMs. Only emitted for
 * transcripts that carry real speaker names (uploads) — live calls keep their
 * existing REP/PROSPECT labelling untouched.
 */
export function formatSpeakerRosterBlock(roster: SpeakerRosterEntry[]): string {
  if (roster.length < 2) return '';
  const lines = roster.map(entry =>
    `- "${entry.label}" is ${entry.role === 'user'
      ? 'the sales representative (microphone user / REP) — the first speaker in this transcript'
      : 'a prospect / client-side speaker (PROSPECT)'}`
  );
  return [
    'SPEAKER IDENTITY MAP (authoritative — derived from transcript order):',
    ...lines,
    'Refer to people by these exact names in every output field (overview, keyPoints, actionItems, salesCoachReview, nextCallPlaybook, evidence quotes). Never write "the prospect" or "the salesperson" when a name above is known.',
    '',
  ].join('\n') + '\n';
}
