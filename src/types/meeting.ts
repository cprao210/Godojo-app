// src/types/meeting.ts
//
// Canonical Meeting shape shared by the meetings UI (Launcher, MeetingDetails) and
// the HTTP data layer (meetingsApi / meetingMapping). Previously this interface was
// duplicated locally in Launcher.tsx and MeetingDetails.tsx; it now lives here so the
// list view, detail view, and the backend-row mapper all agree on one shape.
//
// Within `detailedSummary`, `actionItems` / `keyPoints` are always present (the mapper
// defaults them to []), matching what the meeting UI + PDF/email consumers expect.

import type { LiveAnalysisData } from "./liveAnalysis";

export interface MeetingTranscriptLine {
  speaker: string;
  displayName?: string;
  text: string;
  timestamp: number;
  final?: boolean;
  confidence?: number;
}

export interface MeetingUsageEntry {
  type: "assist" | "followup" | "chat" | "followup_questions";
  timestamp: number;
  question?: string;
  answer?: string;
  items?: string[];
}

export interface MeetingDetailedSummary {
  overview?: string;
  actionItems: string[];
  keyPoints: string[];
  actionItemsTitle?: string;
  keyPointsTitle?: string;

  leadName?: string;
  company?: string;

  liveAnalysis?: LiveAnalysisData;

  dealStatus?: {
    stage?: string;
    summary?: string;
  };
  bant?: {
    budget?: { status: string; detail: string };
    authority?: { status: string; detail: string };
    need?: { status: string; detail: string };
    timeline?: { status: string; detail: string };
  };
  meddicc?: {
    metrics?: { status: string; detail: string };
    economicBuyer?: { status: string; detail: string };
    decisionCriteria?: { status: string; detail: string };
    decisionProcess?: { status: string; detail: string };
    identifyPain?: { status: string; detail: string };
    champion?: { status: string; detail: string };
    competition?: { status: string; detail: string };
    gaps?: string[];
  };
  followUpEmail?: {
    subject?: string;
    sections?: {
      whatYouWillAchieveAfterTransformation?: string[];
      whatWeDiscussed?: string[];
      whatIsTheNeed?: string[];
      currentProcess?: string;
      scopeOfImprovement?: string[];
      howOurSolutionHelps?: string[];
      expectedBusinessImpact?: string[];
      nextSteps?: string[];
    };
    fullEmail?: string;
  };
  salesCoachReview?: {
    whatIDidRight?: string[];
    whatICouldHaveDoneBetter?: string[];
    whatIMissedCompletely?: string[];
  };
  nextCallPlaybook?: {
    openingRecap?: string;
    questionsToAsk?: string[];
    valueAndROI?: {
      quantitative?: string[];
      qualitative?: string[];
    };
  };

  // Tolerate extra summary keys (e.g. speakerNames) read via casts.
  [key: string]: any;
}

export interface Meeting {
  id: string;
  title: string;
  date: string;
  duration: string;
  durationMs?: number;
  summary: string;
  isProcessed?: boolean;
  calendarEventId?: string;
  source?: string;
  detailedSummary?: MeetingDetailedSummary;
  participants?: { email: string | null; name: string | null; oraganizer: boolean; self: boolean }[];
  transcript?: MeetingTranscriptLine[];
  usage?: MeetingUsageEntry[];

  // UI-only / compatibility fields (never sent by the backend).
  active?: boolean;
  time?: string;
}
