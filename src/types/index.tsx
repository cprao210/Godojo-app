/**
 * Centralized type definitions for the application.
 *
 * Consolidated from types previously scattered across:
 *  - src/hooks/*
 *  - src/features/**
 *  - src/lib/**
 *  - src/types/index.tsx (original)
 *
 * NOTE ON RENAMES: several identically-named but structurally different
 * types existed in multiple source files (e.g. `Message`, `Meeting`,
 * `ChatState`, `CustomProvider`, `ModelOption`, `CategoryRowProps`,
 * `Objection`). These were renamed with a feature/component prefix below
 * to avoid collisions in this shared file. Each renamed type is grouped
 * under a "--- <original file path> ---" comment so you can trace it
 * back to its origin and update imports accordingly.
 *
 * SCOPE: frontend (src) types only. Electron-specific types are excluded:
 *  - `ElectronAPI` and the `Window.electronAPI` augmentation from
 *    src/app/electron.d.ts
 *  - `Window` global augmentations from src/app/vite-env.d.ts
 * These `declare global { interface Window { ... } }` / electron bridge
 * types must stay in their own ambient .d.ts / source files - moving them
 * here would break global merging and mixes electron/main concerns into
 * the frontend type layer.
 */

import type React from 'react';
import type { ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import type { LucideIcon, LucideProps } from 'lucide-react';
import type { InternalAxiosRequestConfig } from 'axios';
import type * as ToastPrimitive from '@radix-ui/react-toast';

// ============================================================
// Hook Types
// ============================================================

// --- src/hooks/useAppLifecycleListeners.ts ---
export interface OllamaPullState {
  status: "idle" | "downloading" | "complete" | "failed";
  percent: number;
  message: string;
}

export interface IncompatibleProviderWarning {
  count: number;
  oldProvider: string;
  newProvider: string;
}

export interface AppLifecycleState {
  hasProfile: boolean;
  isPremiumActive: boolean;
  setIsPremiumActive: (active: boolean) => void;
  /** Rising edge each time a meeting finishes processing — feeds `useAdCampaigns`'s post-meeting ad timer. */
  isProcessingMeeting: boolean;
  setIsProcessingMeeting: (processing: boolean) => void;
  lastMeetingEndTime: number | null;
  appStartTime: number;
  ollamaPull: OllamaPullState;
  incompatibleWarning: IncompatibleProviderWarning | null;
  dismissIncompatibleWarning: () => void;
  reindexIncompatibleMeetings: () => Promise<void>;
}

// --- src/hooks/useFirebaseAuth.ts ---
export interface FirebaseAuthState {
  authUser: FirebaseUser | null;
  authChecked: boolean;
  /** Signed up via email/password but hasn't clicked the verification link yet. */
  pendingVerificationUser: FirebaseUser | null;
  sessionExpiredMessage: string | null;
  setSessionExpiredMessage: (message: string | null) => void;
  /** Called by the EmailVerification screen once `user.reload()` confirms `emailVerified`. */
  completeEmailVerification: (verifiedUser: FirebaseUser) => void;
  signOut: () => void;
}

// --- src/hooks/useMeetingSession.ts ---
export interface MeetingSessionControls {
  handleStartMeeting: (calendarEvent?: any) => Promise<void>;
  handleEndMeeting: (meetingTypes?: ("discovery" | "demo" | "negotiation")[]) => Promise<void>;
  showPermissionTray: boolean;
  setShowPermissionTray: React.Dispatch<React.SetStateAction<boolean>>;
  proceedWithMeeting: () => void;
}

// --- src/hooks/useSystemAudioPermission.ts ---

/** Whether each capture permission is usable right now. */
export interface AudioPermissionState {
  microphone: boolean;
  systemAudio: boolean;
  screenCapture: boolean;
}

/**
 * An audio problem worth showing the user.
 *
 * `kind` decides the copy and which System Settings pane the action button
 * targets: a screen-recording denial points at the OS Privacy pane, while a
 * generic capture failure is cross-platform. Conflating them is how a Windows
 * user ends up reading macOS instructions with a button that hands the Windows
 * shell a URI scheme it cannot resolve.
 */
export interface SystemAudioWarning {
  kind: 'screen-recording-permission' | 'audio-capture-failure';
  message: string;
  channel?: 'system' | 'mic';
}

// --- src/features/common/AudioStatusTray.tsx ---
export interface AudioStatusTrayProps {
  /** Force the panel open — set when a meeting start was blocked. */
  isVisible?: boolean;
  onClose?: () => void;
  onAllGranted?: () => void;
}

export interface PermissionRowProps {
  icon: React.ReactNode;
  title: string;
  isGranted: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
}

/**
 * One channel (microphone / system audio) in the tray panel: permission state,
 * the device it resolves to, and a live level meter.
 */
export interface AudioChannelCardProps extends PermissionRowProps {
  /**
   * macOS tri-state, so "never asked" can be worded differently from "denied".
   * Windows and Linux report 'granted' for both channels — they have no
   * screen-capture gate and handle the mic at first use.
   */
  status?: 'granted' | 'denied' | 'not-determined' | 'restricted';
  /** Already-shaped 0–1 meter position. */
  level: number;
  /** Samples are arriving on this channel right now. */
  isLive: boolean;
  /** A user-initiated probe is running (no meeting). */
  isTesting: boolean;
  /** Resolved device label; null when the device list is unavailable. */
  deviceName?: string | null;
  /** The saved device preference has disappeared since it was set. */
  deviceMissing?: boolean;
  /** Per-channel failure text, e.g. the system-audio probe's error. */
  errorText?: string | null;
  /** Colour family for the meter, matching the dock's two-channel palette. */
  tone: 'mic' | 'system';
  /** Theme is passed down rather than re-resolved per row. */
  isLight: boolean;
}

/** Compact level meter shared by the collapsed tray bar and the panel cards. */
export interface AudioLevelMeterProps {
  /** Already-shaped 0–1 level. */
  level: number;
  isLive: boolean;
  tone: 'mic' | 'system';
  isLight: boolean;
  /** Renders the 4-bar variant for the 48px tray bar instead of a wide bar. */
  compact?: boolean;
  className?: string;
}

// --- src/features/common/SystemAudioPermissionBanner.tsx ---
export interface SystemAudioPermissionBannerProps {
  className?: string;
}

// --- src/hooks/useResolvedTheme.ts ---
export type ResolvedTheme = 'light' | 'dark';

// --- src/hooks/useShortcuts.ts ---
export interface ShortcutConfig {
  whatToAnswer: string[];
  autoAnswerMode: string[];
  clarify: string[];
  followUp: string[];
  dynamicAction4: string[];
  answer: string[];
  codeHint: string[];
  brainstorm: string[];
  shorten: string[];
  recap: string[];
  scrollUp: string[];
  scrollDown: string[];
  // Window Movement
  moveWindowUp: string[];
  moveWindowDown: string[];
  moveWindowLeft: string[];
  moveWindowRight: string[];
  // General
  toggleVisibility: string[];
  toggleMousePassthrough: string[];
  processScreenshots: string[];
  captureAndProcess: string[];
  resetCancel: string[];
  takeScreenshot: string[];
  selectiveScreenshot: string[];
}

// --- src/hooks/useTeamInvite.ts ---
export interface TeamInviteState {
  deepLinkInviteToken: string | null;
  clearDeepLinkInviteToken: () => void;
  inviteMismatchEmail: string | null;
  dismissInviteMismatch: () => void;
}

// --- src/hooks/useTenant.ts ---
export interface TenantState {
  tenantId: string | null;
  tenant: Tenant | null;
  /** True when the signed-in user owns the resolved tenant. */
  isAdmin: boolean;
}

// --- src/hooks/useWindowRoute.ts ---
export interface WindowRoute {
  isSettingsWindow: boolean;
  isLauncherWindow: boolean;
  isOverlayWindow: boolean;
  isModelSelectorWindow: boolean;
  isCropperWindow: boolean;
  /** No `?window=` param, or an unrecognized one — treated as the launcher (dev-mode safety). */
  isDefault: boolean;
}

// ============================================================
// Domain / API / Feature Types
// ============================================================

// --- src/features/calendar/ConnectCalendarButton.tsx ---
export type Provider = 'google' | 'zoom';

export interface EventLike {
  attendees?: Attendee[];
  organizer?: string;
  title?: string;
}

export type CalendarProvider = {
  id: Provider;
  label: string;
  subtitle: string;
  Icon: React.ElementType;
  iconBg: string;
  iconColor: string;
}

export interface ConnectCalendarButtonProps {
  onConnect?: () => void;
  onDisconnect?: () => void;
  className?: string;
}

// --- src/features/calendar/SalesBriefPanel.tsx ---
export interface CompanyIntel {
  companyName: string;
  website: string | null;
  foundedYear: number | null;
  companyAge: number | null;
  founders: string[] | null;
  headquarters: string | null;
  employeeCount: string | null;
  industry: string | null;
  revenue: string | null;
  valuation: string | null;
  fundingStage: string | null;
  latestFundingNews: string | null;
  investors: string[] | null;
  keyProducts: string[] | null;
  competitors: string[] | null;
  recentNews: Array<{ headline: string; date: string | null }> | null;
  leadershipChanges: Array<{ name: string; role: string; date: string | null }> | null;
  linkedinUrl: string | null;
  businessModel: string | null;
  geographicPresence: string[] | null;
  topCustomers: string[] | null;
  _newsSnippets?: Array<{ title: string; url: string; date: string | null }>;
}

// --- src/features/chat/api/chatApi.ts ---
export interface SourceRef {
  id: string;
  title: string;
}

export interface ChatSources {
  meetings: SourceRef[];
  assets: SourceRef[];
}

export interface RagAnswer {
  answer: string;
  sources: unknown[];
  confidence?: number;
}

export interface ChatStreamHandlers {
  /** Fired for every `token` frame — `chunk` is the incremental text to append. */
  onToken: (chunk: string) => void;
  /** Fired once for a `rag_answer` frame — the backend decided to return a
   * complete structured answer instead of streaming tokens. When this fires,
   * `onToken` will NOT fire for this response — render `answer` directly as
   * the finished message rather than appending. */
  onRagAnswer?: (answer: RagAnswer) => void;
  /** Fired once, usually before the first token, with the retrieved chunk ids. */
  onSources?: (sources: ChatSources) => void;
  /** Fired once, only on a brand-new chat (session_id was null in the
   * request) — the backend just created the session. Store this id and send
   * it as `session_id` on every subsequent turn in this conversation. */
  onSessionCreated?: (sessionId: string) => void;
  /** Fired when the backend auto-generates/updates the session's title from
   * the first message (3-4 words) — update the sidebar entry for this
   * session_id in place. */
  onTitleUpdated?: (title: string) => void;
  /** Fired for each `status` frame — backend progress updates ("connected",
   * "searching", "generating", ...) sent before/while the answer is being
   * produced. Use to show the person what's happening instead of a static
   * "thinking" indicator. Raw status string is passed through; map it to a
   * label with `statusLabel()` below. */
  onStatus?: (status: string) => void;
  /** Fired right before an automatic retry attempt, after a transient
   * failure (network error, 5xx, 429) that happened before any content
   * streamed back. `attempt` is 1-indexed. Never fires once tokens/an
   * answer have started rendering — a partial answer is never retried,
   * since re-sending would duplicate or garble what's already shown. */
  onRetry?: (attempt: number, maxAttempts: number) => void;
  /** Fired once per response, after the final token, with the backend's
   * interaction_id for this turn. Only emitted on `/chat/live` — collect
   * these across the call and POST them to `chatApi.linkMeetingInteractions`
   * once the call ends and a real meeting_id exists. */
  onInteractionId?: (interactionId: number) => void;
  /** Fired once the stream has fully closed (after the `done` frame). */
  onDone?: () => void;
  onError: (error: string) => void;
}

export type ChatRole = "user" | "assistant";

export interface ChatHistoryTurn {
  role: ChatRole;
  content: string;
  // Raw shape from GET /chat/sessions/:id/messages — a flat list, unlike the
  // grouped { meetings, assets } shape ChatSources/SourcesDisplay expect (that
  // grouping only happens for the live `source_ids` stream frame, in
  // chatApi.ts). Only present on assistant turns that answered from RAG
  // context, and can be missing/empty even then — never assume it's there.
  sources?: { id: string; title: string; type: string }[];
}

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface LiveTranscriptSegment {
  text: string;
  speaker: string;
  timestamp: number;
  meeting_id: string;
  chunk_index: number;
}

export interface StreamHandle {
  /** Cancel the in-flight request — call on overlay close / component unmount. */
  abort: () => void;
}

// --- src/features/chat/components/GlobalChatOverlay.tsx ---
export interface GlobalChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  sources?: ChatSources;
}

export type GlobalChatState = 'idle' | 'waiting_for_llm' | 'streaming_response' | 'error';

// --- src/features/common/ModelSelectorWindow.tsx ---
export interface ModelOption {
  id: string;
  name: string;
  type: 'cloud' | 'local' | 'custom' | 'ollama';
  provider?: string;
}

// --- src/features/common/TopSearchPill.tsx ---
export type PillState = 'idle' | 'focused' | 'typing' | 'results';

export interface TopSearchMeeting {
  id: string;
  title: string;
  date: string;
  summary?: string;
}

export interface SearchResult {
  id: string;
  type: 'meeting';
  title: string;
  subtitle?: string;
  meetingId: string;
}

// --- src/features/dashboard/components/AEDetailView.tsx ---
export interface AeSummary {
  userId: string;
  name: string;
  role: string;
  calls: number;
  score: number;
}

export interface DimensionScore {
  key: string;
  label: string;
  score: number;
  icon: LucideIcon;
  color: string; // hex, used for the arc segment + badge
  ring?: string; // hex, used for the connector-dot stroke (lighter tint of color)
}

export interface StrengthOrGap {
  title: string;
  description: string;
  tag: 'Strength' | 'Opportunity';
}

export interface RecentCall {
  meetingId: string;
  title: string;
  meta: string; // e.g. "Today · 10:30 AM · 45 min"
  highlight: string; // short green/teal label, e.g. "Economic Buyer"
  score: number;
}

// --- src/features/dashboard/components/ManagerDashboard.tsx ---
export interface ManagerDashboardObjection {
  label: string;
  count: number;
  latest: DashboardObjectionQuote[];
}

export interface RepEntry {
  userId: string;
  name: string;
  role: string;
  score: number;
}

export interface AeEntry {
  userId: string;
  name: string;
  role: string;
  calls: number;
  score: number;
}

// --- src/features/dashboard/types.ts ---
export type DashboardPeriod =
  | "last_1_day" | "last_5_days" | "last_week" | "last_2_weeks"
  | "last_30_days" | "last_quarter" | "last_year";

export interface DashboardActiveMember { user_id: string; name: string; email: string; image: string; role: string; status: string; joined_at: string; calls: number; avg_score: number; }

export interface DashboardRecentCall { meeting_id: string; user_id: string; title: string; start_time: number; duration_ms: number; }

export interface DashboardTrendPoint { label: string; avg_score: number; }

export interface DashboardObjectionQuote {
  quote: string;
  owner: string;
  status: string;
  type: string;
  meeting_title: string;
  meeting_id: string;
  meeting_date: string;
}

export interface DashboardObjection {
  category: string;
  count: number;
  latest: DashboardObjectionQuote[];
}

export interface DashboardPerformer { user_id: string; name: string; image: string | null; avg_score: number; call_count: number; }

export interface DashboardResponse {
  tenant_id: string;
  period: DashboardPeriod;
  period_start_ms: number;
  active_members_count: number;
  active_members: DashboardActiveMember[];
  total_calls: number;
  team_avg_score: number;
  recent_calls: DashboardRecentCall[];
  trend_mode: string;
  trend: DashboardTrendPoint[];
  top_objections: DashboardObjection[];
  total_objections: number;
  top_performers: DashboardPerformer[];
  lowest_performers: DashboardPerformer[];
}

// --- src/features/floating-dock/FloatingDock.tsx ---
export type ActivePanel = 'intelligence' | 'chat' | 'settings' | null;

export interface ChatMessage {
  id: string;
  role: 'user' | 'system' | 'client';
  text: string;
  isStreaming?: boolean;
  intent?: string;
}

// --- src/features/floating-dock/panels/FloatingChatPanel.tsx ---
export interface FloatingChatMessage {
  id: string;
  role: 'user' | 'system' | 'client';
  text: string;
  isStreaming?: boolean;
  intent?: string;
  ragAnswer?: { confidence: number; sourceCount: number };
  /** Latest backend status label ("Searching meetings…", etc.) while this
   * message is still streaming with no text yet. Cleared once the first
   * token/rag_answer arrives. */
  status?: string;
}

// --- src/features/live-analysis/types.ts ---
export interface BANTField {
  emoji: '✅' | '⚠️' | '❌' | '';
  status: 'confirmed' | 'partial' | 'missing' | '';
  evidence: string;
  suggested_question?: string;
}

export interface MEDDICField {
  emoji: '✅' | '⚠️' | '❌' | '';
  status: 'confirmed' | 'partial' | 'missing' | '';
  evidence: string;
  suggested_question?: string;
}

export interface Objection {
  type: 'customer_question' | 'ae_deferral';
  quote: string;
  owner: 'customer' | 'ae';
  status: 'open' | 'deferred';
  /** AI-suggested answer or rebuttal for this objection. Only populated for
  customer_question type. Empty string when not applicable. **/
  suggested_answer?: string;
  /** Stable content-derived id stamped at merge time. Never changes after first assignment. */
  id?: string;
  /** Semantic category id from the backend objection classifier (e.g. "pricing_too_high"). */
  category?: string;
  /** Human-readable form of `category`, safe to render directly. */
  category_label?: string;
  /** Classifier cosine similarity, 0–1. */
  confidence?: number;
  /** Classifier confidence fell below the review threshold. */
  needs_review?: boolean;
  /** Client-only: the objection-handler endpoint echoed this quote in `resolved`.
   *  Never sent as input — the client is the owner of this flag. */
  resolved?: boolean;
}

export interface Signal {
  quote: string;
  signal_type: string[];
  ask_now: string;
  intensity: 'high' | 'medium' | 'low';
  category: 'positive' | 'negative' | 'neutral';
  /** Stable content-derived id stamped at merge time. Never changes after first assignment. */
  id?: string;
}

export interface LiveAnalysisTurn {
  speaker: string;
  text: string;
}

export type DealTrigger =
  | 'pricing_objection'
  | 'discount_request'
  | 'competitor_comparison'
  | 'procurement_pressure'
  | 'budget_concern'
  | 'closing_signal';

export interface DealOptimizerAlert {
  trigger: DealTrigger;
  quote: string;
  /** One-line framing of what's happening */
  headline: string;
  /** 1–3 recommended moves, ordered by priority */
  moves: string[];
  /** Optional trade-off or value anchor the AE should use */
  anchor?: string;
  intensity: 'high' | 'medium' | 'low';
  /** Stable content-derived id stamped at merge time */
  id?: string;
}

export interface LiveAnalysisData {
  bant: {
    budget: BANTField;
    authority: BANTField;
    need: BANTField;
    timeline: BANTField;
  };
  meddic: {
    metrics: MEDDICField;
    economic_buyer: MEDDICField;
    decision_criteria: MEDDICField;
    decision_process: MEDDICField;
    identify_pain: MEDDICField;
    champion: MEDDICField;
    competition: MEDDICField;
  };
  objections: Objection[];
  signals: Signal[];
  dealOptimizer?: DealOptimizerAlert[];
}

// --- src/features/meetings/api/meetingsApi.ts ---
export interface MeetingAttendee {
  email: string;
  name?: string;
  self?: boolean;
}

export interface StartMeetingRequest {
  title?: string;
  attendees?: MeetingAttendee[];
  audio?: {
    input_device_id?: string | null;
    output_device_id?: string | null;
  };
  calendar_event_id?: string;
}

export interface StartMeetingResponse {
  success: boolean;
  meeting_id: string;
  started_at: number; // ms since epoch
}

export interface PauseMeetingResponse {
  success: boolean;
  paused_at?: number;
  already_paused?: boolean;
}

export interface ResumeMeetingResponse {
  success: boolean;
  resumed_at?: number;
  not_paused?: boolean;
}

export interface MeetingStateResponse {
  is_active: boolean;
  is_paused: boolean;
  meeting_id: string | null;
}

export type TranscriptSpeaker = "user" | "client" | "assistant" | "system";

export interface TranscriptSegmentInput {
  speaker: TranscriptSpeaker;
  text: string;
  timestamp: number; // ms since epoch
  final?: boolean;
  confidence?: number;
}

export interface SubmitTranscriptResponse {
  accepted?: number;
  dropped?: number;
  reason?: string;
}

export interface EndMeetingResponse {
  success: boolean;
  meeting_id: string;
  duration_ms: number;
}

export interface AiInteractionMetadata {
  rag_used?: boolean;
  asset_chunks?: number;
  meeting_chunks?: number;
  [key: string]: unknown;
}

export interface AiInteractionItem {
  id: number;
  type: string;
  timestamp: number;
  user_query: string;
  ai_response: string;
  metadata_json: AiInteractionMetadata;
}

export interface AiInteractionsResponse {
  meeting_id: string;
  items: AiInteractionItem[];
}

export interface ChunkMeetingResponse {
  meeting_id: string;
  duration_ms: number;
  ingested: boolean;
  is_processed: number;
}

// --- src/features/meetings/components/FollowUpEmailModal.tsx ---
export interface FollowUpEmailMeeting {
  id: string;
  title: string;
  date: string;
  summary?: string;
  detailedSummary?: {
    overview?: string;
    actionItems: string[];
    keyPoints: string[];
    leadName?: string;
    company?: string;
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
  };
  transcript?: Array<{
    speaker: string;
    text: string;
    timestamp: number;
  }>;
  calendarEventId?: string;
  calendarEventMetadata?: any[];
}

// --- src/features/meetings/components/MeetingChatOverlay.tsx ---
export interface MeetingChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  sources?: ChatSources;
}

export interface MeetingContext {
  id?: string;  // Required for RAG queries
  title: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
  transcript?: Array<{ speaker: string; text: string; timestamp: number }>;
}

export type MeetingChatState = 'idle' | 'opening' | 'waiting_for_llm' | 'streaming_response' | 'error' | 'closing';

// --- src/features/meetings/components/MeetingDetails.tsx ---
export interface MeetingDetailsMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

// --- src/features/meetings/components/MeetingTimeline.tsx ---
export interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  link?: string;
  organizer?: string;
  attendees?: any[];
}

// --- src/features/meetings/components/NextMeetingCard.tsx ---
export interface Attendee {
  email?: string;
  displayName?: string;
  name?: string;
  self?: boolean;
  photoURL?: string;
}

export interface UpcomingMeeting {
  id?: string;
  title: string;
  startTime: string;
  endTime: string;
  link?: string;
  source?: string;
  attendees?: Attendee[];
  organizer?: string;
}

// --- src/features/meetings/meeting.ts ---
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
  calendarEventMetadata?: any[];
  source?: string;
  detailedSummary?: MeetingDetailedSummary;
  participants?: { email: string | null; name: string | null; oraganizer: boolean; self: boolean }[];
  transcript?: MeetingTranscriptLine[];
  usage?: MeetingUsageEntry[];

  // UI-only / compatibility fields (never sent by the backend).
  active?: boolean;
  time?: string;
}

// --- src/features/meetings/scoreCardTypes.ts ---
export type MeetingType = 'discovery' | 'demo' | 'negotiation';

export interface ScoredCategory {
  categoryName: string;
  key?: string;           // config key this row came from; kept so the score can be
                          // reconciled against live analysis after label edits
  score: number;          // 0–maxScore
  maxScore: number;
  weight: number;         // 0–100 (percentage weight of this category)
  reasoning: string;
  transcriptEvidence: string[];
  strengths: string[];
  improvementAreas: string[];
}

export interface MeetingScorecard {
  meetingType: MeetingType;
  overallScore: number;          // 0–100 weighted
  confidenceScore: number;       // 0–100, how confident LLM is this type applies
  detectedReason: string;        // Why this type was detected
  categoryBreakdown: ScoredCategory[];
  topStrengths: string[];
  coachingRecommendations: string[];
}

export interface MeetingScorecardResult {
  scorecards: MeetingScorecard[];
  overallWeightedScore: number;  // cross-type weighted average
  detectedTypes: MeetingType[];
}

export interface CategoryConfig {
  key: string;
  label: string;
  weight: number; // must sum to 100 per scorecard type
  checkpoints: string[];
}

export interface ScorecardConfig {
  meetingType: MeetingType;
  label: string;
  color: string;
  categories: CategoryConfig[];
}

export interface CustomCategoryConfig {
  key: string;
  label: string;
  weight: number;           // 0–100; all weights in a meeting type must sum to 100
  checkpoints: string[];    // one per line in the UI
  framework?: string;       // optional: "MEDDIC", "BANT", "SPIN", custom label, etc.
}

export interface CustomScorecardConfig {
  meetingType: MeetingType;
  enabled: boolean;         // if false, falls back to SCORECARD_CONFIGS defaults
  categories: CustomCategoryConfig[];
}

export interface ScoringCriteriaSettings {
  configs: CustomScorecardConfig[];   // one entry per meeting type
  updatedAt?: string;
}

// --- src/features/meetings/utils/pdfGenerator.ts ---
export interface PdfMeeting {
  id: string;
  title: string;
  date: string;
  duration: string;
  summary: string;
  detailedSummary?: {
    actionItems: string[];
    keyPoints: string[];
  };
  transcript?: Array<{
    speaker: string;
    text: string;
    timestamp: number;
  }>;
  usage?: Array<{
    type: 'assist' | 'followup' | 'chat' | 'followup_questions';
    timestamp: number;
    question?: string;
    answer?: string;
    items?: string[];
  }>;
}

// --- src/features/settings/components/AIProvidersSettings.tsx ---
export interface AIProviderCustomProvider {
  id: string;
  name: string;
  curlCommand: string;
  responsePath: string;
}

export interface AIProviderModelOption {
  id: string;
  name: string;
}

export interface AIProvidersSettingsTypes {
  tavilyApiKey: string;
  hasStoredTavilyKey: boolean;
  handleRemoveTavilyKey: () => Promise<void>;
  tavilySaving: boolean;
  tavilyError: string;
  handleAddTavilyKey: (e: any) => void;
  handleSaveTavilyKey: () => Promise<void>;
}

// --- src/features/settings/components/CompanyContextTab.tsx ---
export interface CompanyIdentity {
  name: string;
  website: string;
  industry: string;
}

export interface KnowledgeAsset {
  id: string;
  type: 'sales_deck' | 'product_specs' | 'case_studies' | 'custom';
  label: string;
  status: 'mapped' | 'processing' | 'need_update';
  lastUpdated?: string;
  filePath?: string;
}

// --- src/api/intelligenceApi.ts ---
// Shape returned by GET /intelligence/company-assets. Same underlying data as
// KnowledgeAsset, but tenant-scoped (via X-Tenant-Id, same OptionalTenant
// resolution as /company-context) and snake_case, straight from the backend —
// this is what lets a team member see the admin's uploaded docs, since the
// local Electron/SQLite asset list is per-device and never sees another
// user's uploads.
export interface BackendCompanyAsset {
  id: string;
  user_id: string;
  tenant_id: string | null;
  type: string;
  label: string;
  status: string;
  last_updated: string;
}


export interface TargetPersona {
  id: string;
  role: string;
  description: string;
}

export interface Competitor {
  id: string;
  name: string;
  moat: string;
  winRate: number;
}

export interface CompanyContextData {
  identity: CompanyIdentity;
  coreValueProposition: string;
  assets: KnowledgeAsset[];
  targetPersonas: TargetPersona[];
  competitors: Competitor[];
  dataCompleteness: number;
  completenessBreakdown: {
    hasIdentity: boolean;
    hasValueProp: boolean;
    hasAssets: boolean;
  };
}

// --- src/api/companyContextApi.ts ---
// Shapes returned/accepted by the FastAPI /company-context routes. Kept
// separate from CompanyContextData (the flattened camelCase shape the UI
// works with) since the backend is snake_case and singleton-vs-list shaped
// differently — mapping happens at the hook boundary (useCompanyContext).
export interface BackendCompanyContext {
  id: number;
  user_id: string;
  tenant_id: string | null;
  name: string | null;
  website: string | null;
  industry: string | null;
  persona_engine_enabled: number;
  core_value_proposition: string | null;
  updated_at: string;
  data_completeness: number;
}

export type BackendCompanyContextUpdate = Partial<
  Pick<BackendCompanyContext, "name" | "website" | "industry" | "persona_engine_enabled" | "core_value_proposition">
>;

export interface BackendPersona {
  id: string;
  user_id: string;
  tenant_id: string | null;
  role: string;
  description: string;
  sort_order: number;
}

export type BackendPersonaUpdate = Partial<Pick<BackendPersona, "role" | "description" | "sort_order">>;

export interface BackendCompetitor {
  id: string;
  user_id: string;
  tenant_id: string | null;
  name: string;
  moat: string;
  win_rate: number;
  sort_order: number;
}

export type BackendCompetitorUpdate = Partial<Pick<BackendCompetitor, "name" | "moat" | "win_rate" | "sort_order">>;


// --- src/features/settings/components/ProviderCard.tsx ---
export interface FetchedModel {
  id: string;
  label: string;
}

// --- src/features/settings/components/ScoringCriteriaTab.tsx ---
export interface MeetingTypeMeta {
  label: string;
  color: string;
  /** Background tint for the icon container — differs between light and dark */
  accentBg: (isLight: boolean) => string;
  /** Border for the icon container — differs between light and dark */
  accentBorder: (isLight: boolean) => string;
  description: string;
  /** Lucide icon component — rendered at size 18 inside the icon container */
  Icon: React.FC<{ size: number; color: string }>;
}

// --- src/features/settings/components/SettingsOverlay.tsx ---
export interface ProviderOption {
  id: string;
  label: string;
  badge?: string | null;
  recommended?: boolean;
  desc: string;
  color: string;
  icon: React.ReactNode;
}

// --- src/features/settings/components/UserProfileTab.tsx ---
export interface UserProfileData {
  displayName: string;
  email: string;
  phone: string;
  role: string;
  organization: string;
  location: string;
  website: string;
  bio: string;
  photoDataUrl: string | null; // base64 data URL stored locally
}

// --- src/features/tenant/components/UserProfileButton.tsx ---
export interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

// --- src/features/tenant/types.ts ---
export type TenantRole = "admin" | "member";

export type MemberStatus = "active" | "suspended";

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired" | "declined";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TenantMember {
  type: "team_member";
  id: string;
  tenant_id: string;
  user_id: string;
  role: TenantRole;
  status: MemberStatus;
  invited_by: string;
  joined_at: string;
  joined_via: string;
  // The member's own account info.
  user: {
    email: string;
    display_name: string;
  };
  // Info about whoever sent the invite that created this membership.
  invited_by_user: {
    email: string;
    display_name: string;
  } | null;
}

export interface PendingInvitationRow {
  type: "pending_invite";
  id: string;
  email: string;
  role: TenantRole;
  status: "invited";
  invited_at: string;
}

export type MemberOrInvitation = TenantMember | PendingInvitationRow;

export interface TenantMembersPage {
  data: MemberOrInvitation[];
  page: number;
  limit: number;
  total: number;
}

export interface TenantMembersQuery {
  search?: string;
  role?: TenantRole;
  page?: number;
  limit?: number;
}

export interface Invitation {
  id: string;
  tenant_id: string;
  email: string;
  role: TenantRole;
  token: string;
  status: InvitationStatus;
  invited_by?: string;
  expires_at: string;
  created_at: string;
  updated_at?: string;
}

export interface InvitationPreview {
  id: string;
  email: string;
  role: TenantRole;
  tenant_name: string;
  invited_by_name: string;
  expires_at: string;
}

export interface InvitationAcceptResult {
  invitation_status: "accepted";
  tenant_id: string;
  member_status: "active";
  tenant: Tenant & { role: TenantRole };
}

export interface InvitationDeclineResult {
  status: "declined";
}

export interface MyPendingInvitation {
  token: string;
  tenant_id: string;
  tenant_name: string;
  role: TenantRole;
  invited_by_name: string;
  expires_at: string;
}

export interface MemberDetailRadarScores {
  MEDDICC: number; BANT: number; Objections: number;
  Discovery: number; Closing: number; Signals: number;
}

export interface MemberDetailRecentCall {
  meeting_id: string; title: string; start_time: number; score: number; highlight: string;
}

export interface MemberDetailStrength { title: string; description: string; frequency: string; }

export interface MemberDetail {
  user_id: string; name: string; image: string | null; role: TenantRole;
  calls_total: number; avg_score: number; radar_scores: MemberDetailRadarScores;
  weakest_area: string | null; recent_calls: MemberDetailRecentCall[]; strengths: MemberDetailStrength[];
}

export interface MemberSuspended {
  id: string;
  tenant_id: string;
  user_id: string;
  role: "member";
  status: "suspended";
  invited_by: string;
  joined_at: string;
  user_email: string | null;
  user_display_name: string | null;
}

// --- src/features/ui/ModelSelector.tsx ---
export interface ModelSelectorCustomProvider {
  id: string;
  name: string;
  curlCommand: string;
}

// --- src/features/ui/toast.tsx ---
export type ToastMessage = {
  title: string
  description: string
  variant: ToastVariant
}

export type ToastVariant = "neutral" | "success" | "error"

// --- src/features/updates/UpdateModal.tsx ---
export interface ReleaseNoteSection {
  title: string;
  items: string[];
}

export interface ParsedReleaseNotes {
  version: string;
  summary: string;
  sections: ReleaseNoteSection[];
  fullBody?: string;
  url?: string;
}

// --- src/lib/apiClient.ts ---
export type RetryConfig = InternalAxiosRequestConfig & { _retry?: boolean };

// --- src/lib/curl-validator.ts ---
export interface CurlValidationResult {
  isValid: boolean;
  message?: string;
  json?: any;
}

// --- src/lib/overlayAppearance.ts ---
export type OverlayTheme = 'light' | 'dark';

export interface OverlayAppearance {
  shellStyle: React.CSSProperties;
  pillStyle: React.CSSProperties;
  transcriptStyle: React.CSSProperties;
  subtleStyle: React.CSSProperties;
  chipStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
  controlStyle: React.CSSProperties;
  iconStyle: React.CSSProperties;
  codeBlockStyle: React.CSSProperties;
  codeHeaderStyle: React.CSSProperties;
  dividerStyle: React.CSSProperties;
}

// --- src/pages/SignIn.tsx ---
export type FieldValuesType = {
  icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>;
  type: "text" | "tel" | "email" | "password";
  name: "email" | "password" | "displayName" | "phoneNumber";
  placeholder: string;
}

// --- src/types/index.tsx ---
export interface Screenshot {
  id: string
  path: string
  timestamp: number
  thumbnail: string // Base64 thumbnail
}

export interface Solution {
  problem_identifier_script: string;
  brainstorm_script: string;
  code: string;
  dry_run_script: string;
  time_complexity: string;
  space_complexity: string;
}

// ============================================================
// Component Props Types
// ============================================================

// --- src/features/calendar/SalesBriefPanel.tsx ---
export interface SalesBriefPanelProps {
  eventData: UpcomingMeeting;
  onClose: () => void;
}

// --- src/features/chat/components/FloatingChatButton.tsx ---
export interface FloatingChatButtonProps {
  isOpen: boolean;
  onClick: () => void;
  /** Optional label shown in the hover tooltip when closed. */
  label?: string;
}

// --- src/features/chat/components/GlobalChatOverlay.tsx ---
export interface GlobalChatOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  initialQuery?: string;
  /** Opens a different meeting's details — used when the person clicks a
   * single-source chip under an assistant answer. Omit to render the chip
   * as plain (non-clickable) text instead. */
  onOpenMeeting?: (meetingId: string) => void;
}

export interface ChatSessionSidebarProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoading: boolean;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  onDeleteSession: (sessionId: string) => void;
}

// --- src/features/common/AdCampaignToasters.tsx ---
export interface AdCampaignToastersProps {
  /** Only rendered on the launcher main view, with Settings closed. */
  visible: boolean;
  activeAd: unknown;
  dismissAd: () => void;
  onSetupProfile: () => void;
  onSetupJD: () => void;
  onUpgrade: () => void;
}

// --- src/features/common/EditableTextBlock.tsx ---
export interface EditableTextBlockProps {
  initialValue: string;
  onSave: (value: string) => void;
  tagName?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div';
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  onEnter?: () => void;
  autoFocus?: boolean;
}

// --- src/features/common/ErrorBoundary.tsx ---
export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional context label shown in logs and fallback UI (e.g. "Launcher", "Overlay"). */
  context?: string;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  componentStack: string;
}

// --- src/features/common/IncompatibleProviderBanner.tsx ---
export interface IncompatibleProviderBannerProps {
  warning: IncompatibleProviderWarning | null;
  /** Only show while the default/launcher window is the active one. */
  visible: boolean;
  onDismiss: () => void;
  onReindex: () => void;
}

// --- src/features/common/Launcher.tsx ---
export interface LauncherProps {
  onStartMeeting: (calendarEvent?: any) => void;
  onOpenSettings: (tab?: string) => void;
  onCloseSettings?: () => void;
  onOpenManagerDashboard?: () => void;
  onCloseManagerDashboard?: () => void;
  isManagerDashboardOpen?: boolean;
  isSettingsOpen?: boolean;
  onPageChange?: (isMain: boolean) => void;
  ollamaPullStatus?: 'idle' | 'downloading' | 'complete' | 'failed';
  ollamaPullPercent?: number;
  ollamaPullMessage?: string;
  authUser?: { displayName?: string | null; email?: string | null; photoURL?: string | null } | null;
  onSignOut?: () => void;
}

// --- src/features/common/GodojoInterface.tsx ---

export interface GodojoInterfaceMessage {
  id: string;
  role: 'user' | 'system' | 'client';
  text: string;
  isStreaming?: boolean;
  hasScreenshot?: boolean;
  screenshotPreview?: string;
  isCode?: boolean;
  intent?: string;
  isNegotiationCoaching?: boolean;
  negotiationCoachingData?: {
    tacticalNote: string;
    exactScript: string;
    showSilenceTimer: boolean;
    phase: string;
    theirOffer: number | null;
    yourTarget: number | null;
    currency: string;
  };
}

export interface GodojoInterfaceProps {
  onEndMeeting?: (meetingTypes?: ('discovery' | 'demo' | 'negotiation')[]) => void;
  overlayOpacity?: number;
}

// --- src/features/common/SupportToaster.tsx ---
export interface SupportToasterProps {
  className?: string;
}

// --- src/features/common/TopSearchPill.tsx ---
export interface TopSearchPillProps {
  meetings: Meeting[];
  onOpenMeeting: (meetingId: string) => void;
  onExpansionChange?: (isExpanded: boolean) => void;
}

// --- src/features/dashboard/components/AEDetailView.tsx ---
export interface DimensionGaugeProps {
  dimensions: DimensionScore[];
  overallScore: number;
  isLight: boolean;
  isAboveTeamAverage: boolean;
}

export interface AeDetailViewProps {
  ae: AeSummary | null;
  tenantId: string | null;
  onBack: () => void;
}

// --- src/features/dashboard/components/ManagerDashboard.tsx ---
export interface ObjectionType {
  label: string;
  count: number;
  latest: DashboardObjectionQuote[];
}

export interface StatCardProps {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string | number;
  cardCls: string;
}

export interface TeamScoreChartProps {
  data: { label: string; score: number }[];
  isLight: boolean;
}

export interface TopObjectionsListProps {
  objections: ObjectionType[];
  isLight: boolean;
  onSelect: (objection: ObjectionType) => void;
}

export interface RankedRepListProps {
  reps: RepEntry[];
  rankTheme: 'positive' | 'attention';
  isLight: boolean;
  onSelectRep?: (rep: RepEntry) => void;
}

export interface AllAEsTableProps {
  aes: AeEntry[];
  isLight: boolean;
  onSelectAe?: (ae: AeEntry) => void;
}

export interface SectionCardProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  headerRight?: React.ReactNode;
  cardCls: string;
  children: React.ReactNode;
}

export interface ManagerDashboardProps {
  isOpen: boolean;
  onClose: () => void;
}

// --- src/features/floating-dock/DockButton.tsx ---
export interface DockButtonProps {
  icon: React.ReactNode;
  tooltip: string;
  isActive: boolean;
  activeColor?: string;
  dangerColor?: boolean;
  showActiveDot?: boolean;
  frozen?: boolean;
  onClick: () => void;
  zIndex?: number;
  /** See usePerformanceMode.ts — drops the tooltip's backdrop-filter blur when true. */
  isPerformanceMode?: boolean;
}

// --- src/features/floating-dock/FloatingDock.tsx ---
export interface FloatingDockProps {
  // Meeting state
  isMeetingPaused: boolean;
  onPauseResume: () => void;
  onEndCall: (meetingTypes?: MeetingType[]) => void;

  // Feature states
  isUndetectable: boolean;
  onToggleGhost: () => void;

  // Chat panel props
  transcriptRef: React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>;
  rollingTranscriptUser: string;
  rollingTranscriptClient: string;
  isClientSpeaking: boolean;
  isUserSpeaking: boolean;
  showTranscript: boolean;
  onToggleTranscript: (v: boolean) => void;
  currentModel: string;
  onSelectModel: (m: string) => void;
  speakerNames: { user: string; client: string };

  // Settings
  shortcuts: ShortcutConfig;

  overlayPanelClass?: string;

  // Company intelligence from pre-call sales brief
  companyIntel?: Record<string, any> | null;

  // Calendar event(s) the current meeting was matched to, forwarded to
  // FloatingChatPanel so /chat/live has the same event context (attendees,
  // organizer, link, etc.) that gets persisted to meetings.calendar_event_metadata.
  calendarEventMetadata?: CalendarEvent[];

  // Explicit, single-shot native overlay-window resize (height, optional
  // width) for FloatingDock's own discrete size transitions — see the
  // "Window resize pipeline" note in useGodojoInterface.ts. Optional so
  // FloatingDock keeps working (via the ResizeObserver fallback) in any
  // context that doesn't wire this up (e.g. Storybook/tests).
  onRequestOverlayResize?: (height: number, width?: number) => void;

}

// --- src/features/floating-dock/panels/FloatingChatPanel.tsx ---

export interface Message {
  id: string;
  role: 'user' | 'system' | 'client';
  text: string;
  content?: string;
  isStreaming?: boolean;
  intent?: string;
  ragAnswer?: { confidence: number; sourceCount: number };
  /** Latest backend status label ("Searching meetings…", etc.) while this
   * message is still streaming with no text yet. Cleared once the first
   * token/rag_answer arrives. */
  status?: string;
}

export interface FloatingChatPanelProps {
  transcriptRef?: React.MutableRefObject<Array<{ speaker: string; displayName?: string; text: string; timestamp: number }>>;
  rollingTranscriptUser: string;
  rollingTranscriptClient: string;
  isClientSpeaking: boolean;
  isUserSpeaking: boolean;
  showTranscript: boolean;
  currentModel: string;
  onSelectModel: (m: string) => void;
  speakerNames: { user: string; client: string };
  // Lifted state — preserves history across panel switches
  isMeetingPaused: boolean;
  messages: Message[];
  onMessagesChange: (updater: Message[] | ((prev: Message[]) => Message[])) => void;
  /** Called with each turn's interaction_id as /chat/live responses complete.
   * Collected by the parent (useFloatingDock) across the whole call and sent
   * to chatApi.linkMeetingInteractions once the call ends. */
  onInteractionId?: (interactionId: number) => void;
  /** See usePerformanceMode.ts — drops backdrop-filter blur when true. */
  isPerformanceMode?: boolean;
  // Calendar event(s) matched to this meeting — forwarded to /chat/live
  // (chatApi.queryLive) alongside the transcript/history so the live
  // assistant has the same event context (attendees, organizer, link) that
  // gets persisted to meetings.calendar_event_metadata once the call ends.
  calendarEventMetadata?: CalendarEvent[];
}

// --- src/features/floating-dock/panels/FloatingIntelligencePanel.tsx ---
export interface FloatingIntelligencePanelProps {
  isMeetingPaused: boolean;
  // Analysis state is owned by FloatingDock and passed down — never lost on remount
  analysisData: LiveAnalysisData | null;
  analysisError: string | null;
  isOpen: boolean;
  isLoading: boolean;
  showTranscript: boolean;
  onRegenerate: () => void;      // Manual / forced refresh — timer is managed by FloatingDock
  autoRefreshInterval: number | null;
  onAutoRefreshIntervalChange: (interval: number | null) => void;
  isRefreshRun?: boolean;        // true = incremental refresh, false/undefined = first run
  rollingTranscriptUser: string;
  rollingTranscriptClient: string;
  isClientSpeaking: boolean;
  isUserSpeaking: boolean;
  speakerNames: { user: string; client: string };
  panelFirstOpenedAt: number | null; // timestamp when intelligence panel was first opened
  noAnalysisCaptured?: boolean; // true when the countdown ended without enough transcript to analyse
  isCountdownActive?: boolean; // true only while the single startup countdown cycle is still armed
                              // AND no analysis result has landed — the countdown must never be
                              // re-entered after the loading skeleton (see useFloatingDock)
  meetingTypes: MeetingType[];
  onMeetingTypesChange: (types: MeetingType[]) => void;
  /** See usePerformanceMode.ts — drops backdrop-filter blur when true. */
  isPerformanceMode?: boolean;
}

// --- src/features/floating-dock/panels/FloatingSettingsPanel.tsx ---
export interface AnimatedToggleProps {
  value: boolean;
  onChange: (v: boolean) => void;
  accentColor?: string;
}

export interface SettingRowProps {
  icon: React.ReactNode;
  label: string;
  iconColor?: string;
  children: React.ReactNode;
  divider?: boolean;
  emphasis?: boolean;
}

export interface FloatingSettingsPanelProps {
  showTranscript: boolean;
  onToggleTranscript: (v: boolean) => void;
  shortcuts: ShortcutConfig;
  currentModel: string;
  onSelectModel: (m: string) => void;
  dockOpacity: number;
  onDockOpacityChange: (val: number) => void;
  /** See usePerformanceMode.ts — drops backdrop-filter blur when true. */
  isPerformanceMode?: boolean;
  /** Current user preference ('auto' | 'on' | 'off') for the toggle row below. */
  performanceModePreference?: 'auto' | 'on' | 'off';
  onPerformanceModePreferenceChange?: (pref: 'auto' | 'on' | 'off') => void;
}

// --- src/features/live-analysis/components/LiveAnalysisContent.tsx ---
export interface SectionToggleProps {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  badgeColor?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  themed?: boolean;
  isLight?: boolean;
}

export interface FieldRowProps {
  label: string;
  field: { status: string; evidence: string; emoji?: string; suggested_question?: string };
  themed?: boolean;
  isLight?: boolean;
}

export interface LiveAnalysisContentProps {
  analysisData: LiveAnalysisData;
  aiInsight?: string;
  hideBar?: 'MEDDICC Details' | 'BANT Details' | 'Missing Details' | 'Buying Signals' | 'Objections' | 'AI Insights' | 'Deal Alert' | null;
  /** Pass true when rendered inside the Call Analysis tab (MeetingDetails).
   *  Enables full theme awareness (light/dark). Overlay callers omit this. */
  calledFromAnalysisTab?: boolean;
  /** When set (overlay context), renders only the active tab section — fully expanded, no accordion. */
  activeTab?: 'meddicc' | 'bant' | 'signals' | 'objections' | 'deal_optimizer';
}

// --- src/features/meetings/components/FollowUpEmailModal.tsx ---
export interface FollowUpEmailModalProps {
  isOpen: boolean;
  onClose: () => void;
  meeting: Meeting;
  isLight?: boolean;
}

// --- src/features/meetings/components/MeetingChatOverlay.tsx ---

export interface MeetingChatOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  meetingContext: MeetingContext;
  initialQuery?: { text: string; id: number } | null;
  messages: MeetingChatMessage[];
  onMessagesChange: React.Dispatch<React.SetStateAction<MeetingChatMessage[]>>;
  /** Opens a different meeting's details — used when the person clicks a
   * single-source chip under an assistant answer. Omit to render the chip
   * as plain (non-clickable) text instead. */
  onOpenMeeting?: (meetingId: string) => void;
}

// --- src/features/meetings/components/MeetingDetails.tsx ---
export interface MeetingDetailsProps {
  meeting: Meeting;
  // When rendered from a manager's AE-review flow (AEDetailView) rather
  // than the normal launcher meeting list. Only affects which page-view
  // name gets tracked — no other behavior differs.
  viewContext?: 'ae_review';
}

export interface DetailAnalysisAccordionProps {
  scorecard: MeetingScorecardResult;
  isLight: boolean;
}

// --- src/features/meetings/components/MeetingScoreCard.tsx ---
export interface RingProps { score: number; color: string; size?: number; strokeWidth?: number }

export interface ScoreCardCategoryRowProps {
  cat: ScoredCategory;
  accent: string;
  index: number;
  isLight: boolean;
}

export interface ScorecardCardProps {
  scorecard: MeetingScorecard;
  isLight: boolean;
  defaultOpen?: boolean; // kept for API compatibility, ignored
}

export interface MeetingScorecardPanelProps {
  result: MeetingScorecardResult | null | undefined;
  isLoading?: boolean;
  compact?: boolean;
}

// --- src/features/meetings/components/MeetingTimeline.tsx ---
export interface MeetingTimelineProps {
  events: CalendarEvent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// --- src/features/meetings/components/NextMeetingCard.tsx ---
export interface NextMeetingCardProps {
  meeting: UpcomingMeeting | null | undefined;
  isLight: boolean;
  getMeetingStartText: (startTime: string) => string;
  onStart: (meeting?: any) => void;
  onSalesBrief: (meeting: UpcomingMeeting) => void;
}

// --- src/features/onboarding/AboutSection.tsx ---
export interface AboutSectionProps { }

// --- src/features/settings/components/AIProvidersSettings.tsx ---
export interface ModelSelectProps {
  value: string;
  options: AIProviderModelOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}

// --- src/features/settings/components/CompanyContextTab.tsx ---
export interface CompanyContextTabProps {
  companyContext: CompanyContextData | null;
  setCompanyContext: (d: CompanyContextData | null) => void;
  companyLoading: boolean;
  setCompanyLoading: (v: boolean) => void;
  companySaving: boolean;
  setCompanySaving: (v: boolean) => void;
  companyError: string;
  setCompanyError: (v: string) => void;
  assetUploading: string | null;
  setAssetUploading: (id: string | null) => void;
  isPremium?: boolean;
  setIsPremiumModalOpen?: (v: boolean) => void;
  isLight: boolean;
  /**
   * True when the current user is on a team but is NOT that team's admin.
   * Team company context is admin-owned: members see the same data
   * (fetched automatically via the X-Tenant-Id header) but can't edit it.
   * Solo users (no team) are always false here — their own context is
   * always theirs to edit.
   */
  readOnly?: boolean;
}

export interface MeatballMenuProps {
  onEdit: () => void;
  onDelete: () => void;
  isLight: boolean;
  direction?: 'down' | 'up';
}

export interface PersonaModalProps {
  persona: TargetPersona | null; // null = add mode
  onSave: (p: TargetPersona) => void;
  onClose: () => void;
  isLight: boolean;
}

export interface CompetitorModalProps {
  competitor: Competitor | null; // null = add mode
  onSave: (c: Competitor) => void;
  onClose: () => void;
  isLight: boolean;
}

// --- src/features/settings/components/InvitationResponseModal.tsx ---
export interface InvitationResponseModalProps {
  invitation: MyPendingInvitation;
  isLight: boolean;
  onAccepted: (result: InvitationAcceptResult) => void;
  onDeclined: () => void;
  /** Called if the user dismisses without deciding (e.g. clicks the backdrop). */
  onDismiss: () => void;
}

// --- src/features/settings/components/ProviderCard.tsx ---
export interface ProviderCardProps {
  providerId: 'gemini' | 'groq' | 'openai' | 'claude';
  providerName: string;
  apiKey: string;
  preferredModel?: string;
  hasStoredKey: boolean;
  onKeyChange: (key: string) => void;
  onSaveKey: () => Promise<void>;
  onRemoveKey: () => void;
  onTestConnection: () => void;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testError?: string;
  savingStatus: boolean;
  savedStatus: boolean;
  keyPlaceholder: string;
  keyUrl: string;
  onPreferredModelChange?: (modelId: string) => void;
}

// --- src/features/settings/components/ScoringCriteriaTab.tsx ---
export interface CategoryModalProps {
  category: CustomCategoryConfig | null; // null = add mode
  accentColor: string;
  onSave: (cat: CustomCategoryConfig) => void;
  onClose: () => void;
  isLight: boolean;
}

export interface ScoringCategoryRowProps {
  category: CustomCategoryConfig;
  accent: string;
  totalCats: number;
  isLight: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export interface MeetingTypeSectionProps {
  config: CustomScorecardConfig;
  isLight: boolean;
  onChange: (updated: CustomScorecardConfig) => void;
}

// --- src/features/settings/components/SettingsOverlay.tsx ---
export interface CustomSelectProps {
  label: string;
  icon: React.ReactNode;
  value: string;
  options: MediaDeviceInfo[];
  onChange: (value: string) => void;
  placeholder?: string;
}

export interface ProviderSelectProps {
  value: string;
  options: ProviderOption[];
  onChange: (value: string) => void;
}

export interface SettingsOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: string;
  deepLinkInviteToken?: string | null;
  onDeepLinkTokenConsumed?: () => void;
  /** Current tenant, if the user is on a team — null/undefined for a solo user. */
  tenantId?: string | null;
  /** True only for the tenant's owner/admin. Irrelevant when tenantId is unset. */
  isAdmin?: boolean;
}

// --- src/features/settings/components/SettingsPopup.tsx ---
export interface CustomGhostProps {
  className?: string;
  fill?: string;
  stroke?: string;
  eyeColor?: string;
}

// --- src/features/settings/components/UserProfileTab.tsx ---
export interface UserProfileTabProps {
  isLight: boolean;
}

// --- src/features/settings/components/UserRolesPermissionsTab.tsx ---
export interface CreateTeamModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (teamName: string) => Promise<void>;
  isLight: boolean;
}

export interface RowActionsMenuProps {
  row: MemberOrInvitation;
  isLight: boolean;
  onResendInvite: () => void;
  onRemove: () => void;
  isOwner: boolean;
}

export interface InviteUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvite: (email: string, role: TenantRole) => Promise<void>;
  isLight: boolean;
}

export interface MembersTableProps {
  tenant: Tenant;
  isLight: boolean;
  isOwner: boolean;
}

export interface UserRolesPermissionsTabProps {
  /** Token from an `invite-deep-link` IPC event, if this render was triggered by one. */
  deepLinkInviteToken?: string | null;
  /** Lets the parent clear the token once we've consumed it (avoid re-triggering). */
  onDeepLinkTokenConsumed?: () => void;
}

// --- src/features/tenant/components/InviteAccountMismatchBanner.tsx ---
export interface InviteAccountMismatchBannerProps {
  invitedEmail: string;
  onDismiss: () => void;
}

// --- src/features/tenant/components/UserProfileButton.tsx ---
export interface UserProfileButtonProps {
  displayName?: string | null;
  email?: string | null;
  photoURL?: string | null;
  onSignOut: () => void;
}

// --- src/features/ui/KeyRecorder.tsx ---
export interface KeyRecorderProps {
  currentKeys: string[];
  onSave: (keys: string[]) => void;
  className?: string;
}

// --- src/features/ui/ModelSelector.tsx ---
export interface ModelSelectorProps {
  currentModel: string;
  onSelectModel: (model: string) => void;
}

export interface PortalDropdownProps {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: React.ReactNode;
}

export interface ModelOptionProps {
  name: string;
  desc: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}

// --- src/features/ui/toast.tsx ---
export interface ToastProps
  extends React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> {
  variant?: ToastVariant
}

// --- src/features/updates/UpdateModal.tsx ---
export interface UpdateModalProps {
  isOpen: boolean;
  updateInfo: any;
  parsedNotes: ParsedReleaseNotes | null;
  onDismiss: () => void;
  onInstall: () => void;
  onRemindLater?: () => void;
  downloadProgress: number;
  status: 'idle' | 'downloading' | 'ready' | 'error' | 'instructions';
  errorMessage?: string | null;
  instructionsArch?: 'arm64' | 'x64' | null;
}

// --- src/pages/EmailVerification.tsx ---
export interface EmailVerificationProps {
  user: FirebaseUser;
  onVerified: () => void;
}

// --- src/pages/SignIn.tsx ---
export interface SignInProps {
  onSignedIn?: () => void;
  bannerMessage?: string | null;
  onBannerDismiss?: () => void;
}