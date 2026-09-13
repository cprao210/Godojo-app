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
