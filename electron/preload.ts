import { contextBridge, ipcRenderer } from "electron"
import { LiveAnalysisData } from "../src/types"
import { CalendarEvent } from "services/CalendarManager"

// Types for the exposed Electron API
interface ElectronAPI {
  updateContentDimensions: (dimensions: {
    width: number
    height: number
  }) => Promise<void>
  getGpuPerformanceStatus: () => Promise<{ isLowPowerGpu: boolean; raw: Record<string, string> | null }>
  getRecognitionLanguages: () => Promise<Record<string, any>>
  getScreenshots: () => Promise<Array<{ path: string; preview: string }>>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onScreenshotAttached: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onCaptureAndProcess: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onSolutionsReady: (callback: (solutions: string) => void) => () => void
  onResetView: (callback: () => void) => () => void
  onSolutionStart: (callback: () => void) => () => void
  onDebugStart: (callback: () => void) => () => void
  onDebugSuccess: (callback: (data: any) => void) => () => void
  onSolutionError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onProblemExtracted: (callback: (data: any) => void) => () => void
  onSolutionSuccess: (callback: (data: any) => void) => () => void

  onUnauthorized: (callback: () => void) => () => void
  onDebugError: (callback: (error: string) => void) => () => void
  takeScreenshot: () => Promise<void>
  takeSelectiveScreenshot: () => Promise<{ path: string; preview: string; cancelled?: boolean }>
  moveWindowLeft: () => Promise<void>
  moveWindowRight: () => Promise<void>
  moveWindowUp: () => Promise<void>
  moveWindowDown: () => Promise<void>
  windowMinimize: () => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>

  analyzeImageFile: (path: string) => Promise<void>
  quitApp: () => Promise<void>

  // LLM Model Management
  getCurrentLlmConfig: () => Promise<{ provider: "ollama" | "gemini"; model: string; isOllama: boolean }>
  getAvailableOllamaModels: () => Promise<string[]>
  switchToOllama: (model?: string, url?: string) => Promise<{ success: boolean; error?: string }>
  switchToGemini: (apiKey?: string, modelId?: string) => Promise<{ success: boolean; error?: string }>
  testLlmConnection: (provider: 'gemini' | 'groq' | 'openai' | 'claude', apiKey?: string) => Promise<{ success: boolean; error?: string }>
  selectServiceAccount: () => Promise<{ success: boolean; path?: string; cancelled?: boolean; error?: string }>

  // API Key Management
  setGeminiApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setGroqApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setOpenaiApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setClaudeApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  getStoredCredentials: () => Promise<{ hasGeminiKey: boolean; hasGroqKey: boolean; hasOpenaiKey: boolean; hasClaudeKey: boolean; googleServiceAccountPath: string | null; sttProvider: string; hasSttGroqKey: boolean; hasSttOpenaiKey: boolean; hasDeepgramKey: boolean; hasElevenLabsKey: boolean; hasAzureKey: boolean; azureRegion: string; hasIbmWatsonKey: boolean; ibmWatsonRegion: string; hasSonioxKey: boolean; }>

  // STT Provider Management
  setSttProvider: (provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox') => Promise<{ success: boolean; error?: string }>
  getSttProvider: () => Promise<string>
  setGroqSttApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setOpenAiSttApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setDeepgramApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setElevenLabsApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setAzureApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setAzureRegion: (region: string) => Promise<{ success: boolean; error?: string }>
  setIbmWatsonApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setGroqSttModel: (model: string) => Promise<{ success: boolean; error?: string }>
  setSonioxApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  testSttConnection: (provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox', apiKey: string, region?: string) => Promise<{ success: boolean; error?: string }>

  // Native Audio Service Events
  onNativeAudioTranscript: (callback: (transcript: { speaker: string; text: string; final: boolean; retract?: boolean }) => void) => () => void
  onNativeAudioSuggestion: (callback: (suggestion: { context: string; lastQuestion: string; confidence: number }) => void) => () => void
  onNativeAudioConnected: (callback: () => void) => () => void
  onNativeAudioDisconnected: (callback: () => void) => () => void
  onMeetingAudioWarning: (callback: (message: string) => void) => () => void
  onMeetingAudioError: (callback: (message: string) => void) => () => void
  onSystemAudioPermissionDenied: (callback: (message: string) => void) => () => void
  onSystemAudioRecovered: (callback: () => void) => () => void
  onAudioCaptureFailed: (
    callback: (payload: {
      channel: 'system' | 'mic'
      message: string
      attempt: number
      maxAttempts: number
      terminal?: boolean
      stuck?: boolean
    }) => void,
  ) => () => void
  onSuggestionGenerated: (callback: (data: { question: string; suggestion: string; confidence: number }) => void) => () => void
  onSuggestionProcessingStart: (callback: () => void) => () => void
  onSuggestionError: (callback: (error: { error: string }) => void) => () => void
  generateSuggestion: (context: string, lastQuestion: string) => Promise<{ suggestion: string }>
  getInputDevices: () => Promise<Array<{ id: string; name: string }>>
  getOutputDevices: () => Promise<Array<{ id: string; name: string }>>
  getPlatform: () => string
  checkPermissions: () => Promise<{
    microphone: boolean
    systemAudio: boolean
    screenCapture: boolean
    microphoneStatus: 'granted' | 'denied' | 'not-determined' | 'restricted'
    screenStatus: 'granted' | 'denied' | 'not-determined' | 'restricted'
    platform: string
  }>
  requestPermission: (type: 'microphone' | 'screen') => Promise<boolean>
  openPermissionSettings: (pane?: 'microphone' | 'screen') => Promise<void>
  getSystemAudioPermissionWarning: () => Promise<string | null>
  repairTccPermissions: () => Promise<{
    ok: boolean
    bundleId?: string
    results?: Array<{ service: string; ok: boolean; output: string }>
    promptRelaunch?: boolean
    message: string
  }>
  setRecognitionLanguage: (key: string) => Promise<{ success: boolean; error?: string }>
  getAiResponseLanguages: () => Promise<Array<{ label: string; code: string }>>
  setAiResponseLanguage: (language: string) => Promise<{ success: boolean; error?: string }>
  getSttLanguage: () => Promise<string>
  getAiResponseLanguage: () => Promise<string>

  // Intelligence Mode IPC
  generateAssist: () => Promise<{ insight: string | null }>
  generateWhatToSay: (question?: string, imagePaths?: string[]) => Promise<{ answer: string | null; question?: string; error?: string }>
  generateFollowUp: (intent: string, userRequest?: string) => Promise<{ refined: string | null; intent: string }>
  generateRecap: () => Promise<{ summary: string | null }>
  submitManualQuestion: (question: string) => Promise<{ answer: string | null; question: string }>
  getIntelligenceContext: () => Promise<{ context: string; lastAssistantMessage: string | null; activeMode: string }>
  resetIntelligence: () => Promise<{ success: boolean; error?: string }>

  // WHAT AM I MISSING
  generateWhatAmIMissing: () => Promise<string | null>;
  onWhatAmIMissingToken: (callback: (data: { token: string }) => void) => () => void;
  onWhatAmIMissing: (callback: (data: { answer: string }) => void) => () => void;

  // DISCOVERY MODE
  generateDiscovery: () => Promise<string | null>;
  onDiscoveryToken: (callback: (data: { token: string }) => void) => () => void;
  onDiscovery: (callback: (data: { answer: string }) => void) => () => void;

  // OBJECTION HANDLER MODE
  generateObjectionHandler: () => Promise<string | null>;
  onObjectionHandlerToken: (callback: (data: { token: string }) => void) => () => void;
  onObjectionHandler: (callback: (data: { answer: string }) => void) => () => void;

  // Meeting Lifecycle
  startMeeting: (metadata?: any) => Promise<{ success: boolean; error?: string }>
  endMeeting: (meetingTypes?: ('discovery' | 'demo' | 'negotiation')[], tenantId?: string | null) => Promise<{ success: boolean; error?: string }>
  finalizeMicSTT: () => Promise<void>
  getRecentMeetings: () => Promise<Array<{ id: string; title: string; date: string; duration: string; summary: string; isProcessed?: boolean }>>
  getMeetingDetails: (id: string) => Promise<any>
  updateMeetingTitle: (id: string, title: string) => Promise<boolean>
  updateLiveAnalysis: (data: LiveAnalysisData) => Promise<{ success: boolean }>;
  setLiveAnalysisInFlight: (inFlight: boolean) => Promise<{ success: boolean }>;
  regenerateMeetingSummary: (id: string) => Promise<{ success: boolean; meeting?: any; error?: string }>
  uploadTranscript: (text: string, title?: string, meetingTypes?: ('discovery' | 'demo' | 'negotiation')[]) => Promise<{ success: boolean; meetingId?: string; error?: string }>
  updateMeetingSummary: (id: string, updates: { overview?: string, actionItems?: string[], keyPoints?: string[], actionItemsTitle?: string, keyPointsTitle?: string }) => Promise<boolean>
  onMeetingsUpdated: (callback: () => void) => () => void
  getDisplayName: (role: 'user' | 'client' | 'assistant') => Promise<string>;
  getSpeakerNames: () => Promise<{ user: string; client: string }>;

  // Intelligence Mode Events
  onIntelligenceAssistUpdate: (callback: (data: { insight: string }) => void) => () => void
  onIntelligenceSuggestedAnswer: (callback: (data: { answer: string; question: string; confidence: number }) => void) => () => void
  onIntelligenceRefinedAnswer: (callback: (data: { answer: string; intent: string }) => void) => () => void
  onIntelligenceRecap: (callback: (data: { summary: string }) => void) => () => void
  onIntelligenceClarify: (callback: (data: { clarification: string }) => void) => () => void
  onIntelligenceClarifyToken: (callback: (data: { token: string }) => void) => () => void
  onIntelligenceManualStarted: (callback: () => void) => () => void
  onIntelligenceManualResult: (callback: (data: { answer: string; question: string }) => void) => () => void
  onIntelligenceModeChanged: (callback: (data: { mode: string }) => void) => () => void
  onIntelligenceError: (callback: (data: { error: string; mode: string }) => void) => () => void

  // Model Management
  getDefaultModel: () => Promise<{ model: string }>
  setModel: (modelId: string) => Promise<{ success: boolean; error?: string }>
  setDefaultModel: (modelId: string) => Promise<{ success: boolean; error?: string }>
  toggleModelSelector: (coords: { x: number; y: number }) => Promise<void>
  forceRestartOllama: () => Promise<void>
  onSpeakerNamesResolved: (callback: (names: { user: string; client: string }) => void) => () => void;
  updateSpeakerNames: (names: { user: string; client: string }) => Promise<{ success: boolean }>,

  // Settings Window
  toggleSettingsWindow: (coords?: { x: number; y: number }) => Promise<void>

  // Team invite deep link (godojo://invite?token=...)
  onInviteDeepLink: (callback: (data: { token: string }) => void) => () => void

  // Groq Fast Text Mode
  getGroqFastTextMode: () => Promise<{ enabled: boolean }>
  setGroqFastTextMode: (enabled: boolean) => Promise<{ success: boolean; error?: string }>

  // Demo
  seedDemo: () => Promise<{ success: boolean }>

  // Custom Providers
  saveCustomProvider: (provider: any) => Promise<{ success: boolean; id?: string; error?: string }>
  getCustomProviders: () => Promise<any[]>
  deleteCustomProvider: (id: string) => Promise<{ success: boolean; error?: string }>

  // Follow-up Email
  generateFollowupEmail: (input: any) => Promise<string>
  extractEmailsFromTranscript: (transcript: Array<{ text: string }>) => Promise<string[]>
  getCalendarAttendees: (eventId: string) => Promise<Array<{ email: string; name: string }>>
  openMailto: (params: { to: string; subject: string; body: string }) => Promise<{ success: boolean; error?: string }>

  // Audio Test
  startAudioTest: (deviceId?: string) => Promise<{ success: boolean }>
  stopAudioTest: () => Promise<{ success: boolean }>
  onAudioTestLevel: (callback: (level: number) => void) => () => void
  // System-audio probe, emitted during the same startAudioTest lifecycle as the
  // mic meter above.
  onAudioTestSystemLevel: (callback: (level: number) => void) => () => void
  onAudioTestSystemError: (callback: (errorMessage: string) => void) => () => void

  // Database
  flushDatabase: () => Promise<{ success: boolean }>
  showWindow: () => Promise<void>
  hideWindow: () => Promise<void>
  showOverlay: () => Promise<void>
  hideOverlay: () => Promise<void>
  getMeetingActive: () => Promise<boolean>
  onMeetingStateChanged: (callback: (data: { isActive: boolean }) => void) => () => void
  getMeetingPaused: () => Promise<boolean>
  pauseMeeting: () => Promise<{ success: boolean; error?: string }>
  resumeMeeting: () => Promise<{ success: boolean; error?: string }>
  onMeetingPauseStateChanged: (callback: (data: { isPaused: boolean }) => void) => () => void
  onWindowMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void
  onEnsureExpanded: (callback: () => void) => () => void
  onToggleExpand: (callback: () => void) => () => void
  toggleAdvancedSettings: () => Promise<void>
  setOverlayMousePassthrough: (enabled: boolean) => Promise<{ success: boolean }>
  toggleOverlayMousePassthrough: () => Promise<{ success: boolean; enabled: boolean }>
  getOverlayMousePassthrough: () => Promise<boolean>
  onOverlayMousePassthroughChanged: (callback: (enabled: boolean) => void) => () => void

  // Streaming listeners
  streamGeminiChat: (message: string, imagePaths?: string[], context?: string, options?: { skipSystemPrompt?: boolean }) => Promise<void>
  onGeminiStreamToken: (callback: (token: string) => void) => () => void
  onGeminiStreamDone: (callback: () => void) => () => void
  onGeminiStreamError: (callback: (error: string) => void) => () => void

  chatWithGemini: (message: string, imagePaths?: string[], context?: string, skipSystemPrompt?: boolean) => Promise<string>

  onUndetectableChanged: (callback: (state: boolean) => void) => () => void
  onGroqFastTextChanged: (callback: (enabled: boolean) => void) => () => void
  onModelChanged: (callback: (modelId: string) => void) => () => void

  // Ollama
  onOllamaPullProgress: (callback: (data: { status: string; percent: number }) => void) => () => void
  onOllamaPullComplete: (callback: () => void) => () => void

  // Theme API
  getThemeMode: () => Promise<{ mode: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }>
  setThemeMode: (mode: 'system' | 'light' | 'dark') => Promise<void>
  onThemeChanged: (callback: (data: { mode: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }) => void) => () => void

  // Calendar
  calendarConnect: () => Promise<{ success: boolean; error?: string }>
  calendarDisconnect: () => Promise<{ success: boolean; error?: string }>
  getCalendarStatus: () => Promise<{ connected: boolean; email?: string }>
  getUpcomingEvents: () => Promise<Array<{ id: string; title: string; startTime: string; endTime: string; link?: string; source: 'google' }>>
  calendarRefresh: () => Promise<{ success: boolean; error?: string }>

  // Zoom Calendar
  zoomCalendarConnect: () => Promise<{ success: boolean; error?: string }>
  zoomCalendarDisconnect: () => Promise<{ success: boolean; error?: string }>
  getZoomCalendarStatus: () => Promise<{ connected: boolean }>
  getZoomUpcomingEvents: () => Promise<CalendarEvent[]>
  zoomCalendarRefresh: () => Promise<{ success: boolean }>

  // Auto-Update
  onUpdateAvailable: (callback: (info: any) => void) => () => void
  onUpdateDownloaded: (callback: (info: any) => void) => () => void
  onUpdateChecking: (callback: () => void) => () => void
  onUpdateNotAvailable: (callback: (info: any) => void) => () => void
  onUpdateError: (callback: (err: string) => void) => () => void
  onDownloadProgress: (callback: (progressObj: any) => void) => () => void
  restartAndInstall: () => Promise<void>
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  testReleaseFetch: () => Promise<{ success: boolean; error?: string }>
  getAppVersion: () => Promise<string>
  isAppPackaged: () => Promise<boolean>

  // RAG (Retrieval-Augmented Generation) API
  ragQueryMeeting: (meetingId: string, query: string) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>
  ragQueryLive: (query: string) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>
  ragQueryGlobal: (query: string) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>
  ragCancelQuery: (options: { meetingId?: string; global?: boolean }) => Promise<{ success: boolean }>
  ragIsMeetingProcessed: (meetingId: string) => Promise<boolean>
  ragGetQueueStatus: () => Promise<{ pending: number; processing: number; completed: number; failed: number }>
  ragRetryEmbeddings: () => Promise<{ success: boolean }>
  onRAGStreamChunk: (callback: (data: { meetingId?: string; global?: boolean; chunk: string }) => void) => () => void
  onRAGStreamComplete: (callback: (data: { meetingId?: string; global?: boolean }) => void) => () => void
  onRAGStreamError: (callback: (data: { meetingId?: string; global?: boolean; error: string }) => void) => () => void

  onTavilySearching: (callback: (data: { entity: string }) => void) => () => void
  onTavilySearchDone: (callback: (data: { entity: string | null; status: string; fromCache: boolean }) => void) => () => void
  onCompanyIntelUpdated: (callback: (intel: Record<string, any> | null) => void) => (() => void);

  // Keybind Management
  getKeybinds: () => Promise<Array<{ id: string; label: string; accelerator: string; isGlobal: boolean; defaultAccelerator: string }>>
  setKeybind: (id: string, accelerator: string) => Promise<boolean>
  resetKeybinds: () => Promise<Array<{ id: string; label: string; accelerator: string; isGlobal: boolean; defaultAccelerator: string }>>
  onKeybindsUpdate: (callback: (keybinds: Array<any>) => void) => () => void

  // Global shortcut events (stealth: fired even when window is not focused)
  onGlobalShortcut: (callback: (data: { action: string }) => void) => () => void

  // Donation API
  getDonationStatus: () => Promise<{ shouldShow: boolean; hasDonated: boolean; lifetimeShows: number }>;
  markDonationToastShown: () => Promise<{ success: boolean }>;
  setDonationComplete: () => Promise<{ success: boolean }>;

  // Profile Engine API
  profileUploadResume: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  profileGetStatus: () => Promise<{ hasProfile: boolean; profileMode: boolean; name?: string; role?: string; totalExperienceYears?: number }>;
  profileGetMode: () => Promise<{ active: boolean }>;
  profileSetMode: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  profileDelete: () => Promise<{ success: boolean; error?: string }>;
  profileGetProfile: () => Promise<any>;
  profileSelectFile: () => Promise<{ success?: boolean; cancelled?: boolean; filePath?: string; error?: string }>;

  // Company Context API
  companyGetContext: () => Promise<any>;
  companySaveContext: (data: any) => Promise<{ success: boolean; error?: string }>;
  companyUploadAsset: (type: string, filePath: string) => Promise<{
    success: boolean;
    asset?: {
      id: string;
      type: string;
      label: string;
      status: string;
      lastUpdated: string;
      fileData: string;       // base64 — held in frontend draft only
      fileName: string;
      mimeType: string;
    };
    error?: string;
  }>;
  companyDeleteAsset: (assetId: string) => Promise<{ success: boolean; error?: string }>;
  companySyncAsset: (assetId: string) => Promise<{ success: boolean; status?: string; error?: string }>;
  companySetPersonaEngine: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  companySelectFile: () => Promise<{ filePath?: string; fileName?: string; fileSize?: number; cancelled?: boolean; success?: boolean; error?: string }>;
  companyGetCompleteness: () => Promise<number>;

  // Scoring criteria
  meetingGetScorecard: (meetingId: string) => Promise<{ success: boolean; data?: any; error?: string }>;
  meetingDeleteScorecard: (meetingId: string) => Promise<{ success: boolean; error?: string }>;
  scoringGetCriteria: () => Promise<{ success: boolean; data?: any; error?: string }>;
  scoringSaveCriteria: (settings: any) => Promise<{ success: boolean; error?: string }>;
  scoringResetCriteria: () => Promise<{ success: boolean; error?: string }>;

  // JD & Research API
  profileUploadJD: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  profileDeleteJD: () => Promise<{ success: boolean; error?: string }>;
  profileResearchCompany: (companyName: string) => Promise<{ success: boolean; dossier?: any; error?: string }>;
  profileGenerateNegotiation: (force?: boolean) => Promise<{ success: boolean; script?: any; error?: string }>;
  profileGetNegotiationState: () => Promise<{ success: boolean; state?: any; isActive?: boolean; error?: string }>;
  profileResetNegotiation: () => Promise<{ success: boolean; error?: string }>;

  // Tavily Search API
  setTavilyApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>;
  setCompanyIntel: (intel: Record<string, any> | null) => Promise<{ success: boolean; error?: string }>;

  // Overlay Opacity (Stealth Mode)
  setOverlayOpacity: (opacity: number) => Promise<void>;
  onOverlayOpacityChanged: (callback: (opacity: number) => void) => () => void;

  // Verbose / Debug Logging
  getVerboseLogging: () => Promise<boolean>;
  setVerboseLogging: (enabled: boolean) => Promise<{ success: boolean }>;

  // Arch
  getArch: () => Promise<string>;

  // Cropper API
  cropperConfirmed: (bounds: Electron.Rectangle) => void;
  cropperCancelled: () => void;
  onResetCropper: (callback: (data: { hudPosition: { x: number; y: number } }) => void) => () => void;

  // ===== Firebase Auth (renderer owns the SDK; main holds the current ID token) =====
  authSetIdToken: (session: {
    idToken: string;
    refreshToken: string;
    uid: string;
    email?: string | null;
    displayName?: string | null;
    photoURL?: string | null;
    expiresAt: number;
  }) => Promise<{ success: boolean; error?: string }>;
  authClear: () => Promise<{ success: boolean }>;
  authGetState: () => Promise<{
    signedIn: boolean;
    uid?: string;
    email?: string | null;
    displayName?: string | null;
    photoURL?: string | null;
  }>;
  authGetPersistedRefreshToken: () => Promise<{ refreshToken: string | null; uid: string | null }>;
  onAuthStateChanged: (
    callback: (state: { signedIn: boolean; uid?: string; email?: string | null; displayName?: string | null; photoURL?: string | null }) => void
  ) => () => void;

  // ===== Supabase mirror config & status =====
  supabaseSetCredentials: (url: string, anonKey: string) => Promise<{ success: boolean; error?: string }>;
  supabaseGetMirrorStatus: () => Promise<{
    configured: boolean;
    signedIn: boolean;
    outboxLength: number;
    lastSyncAt: number | null;
    lastError?: string | null;
  }>;
  supabaseForceBackfill: () => Promise<{ success: boolean; error?: string }>;
  supabaseSyncAudit: () => Promise<{ success: boolean; error?: string }>;

  // Company Intelligence
  fetchCompanyIntel: (payload: { companyName: string; domain?: string; forceRefresh?: boolean }) => Promise<{ success: boolean; intel?: any; fromCache?: boolean; error?: string }>;

  // Platform
  platform: NodeJS.Platform;
}

export const PROCESSING_EVENTS = {
  //global states
  UNAUTHORIZED: "procesing-unauthorized",
  NO_SCREENSHOTS: "processing-no-screenshots",

  //states for generating the initial solution
  INITIAL_START: "initial-start",
  PROBLEM_EXTRACTED: "problem-extracted",
  SOLUTION_SUCCESS: "solution-success",
  INITIAL_SOLUTION_ERROR: "solution-error",

  //states for processing the debugging
  DEBUG_START: "debug-start",
  DEBUG_SUCCESS: "debug-success",
  DEBUG_ERROR: "debug-error"
} as const

// Expose the Electron API to the renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  updateContentDimensions: (dimensions: { width: number; height: number }) =>
    ipcRenderer.invoke("update-content-dimensions", dimensions),
  getGpuPerformanceStatus: () => ipcRenderer.invoke("get-gpu-performance-status"),
  getRecognitionLanguages: () => ipcRenderer.invoke("get-recognition-languages"),
  takeScreenshot: () => ipcRenderer.invoke("take-screenshot"),
  takeSelectiveScreenshot: () => ipcRenderer.invoke("take-selective-screenshot"),
  getScreenshots: () => ipcRenderer.invoke("get-screenshots"),
  deleteScreenshot: (path: string) =>
    ipcRenderer.invoke("delete-screenshot", path),
  logErrorToMain: (payload: {
    type?: string;
    context?: string;
    message?: string;
    stack?: string;
    componentStack?: string;
  }) => ipcRenderer.invoke("log-error-to-main", payload),

  // Settings > General > Danger Zone. Shows a native confirm dialog in
  // main, then wipes userData and relaunches. Resolves { success: false,
  // cancelled: true } if the user clicks Cancel on the native dialog.
  resetAppData: (): Promise<{ success: boolean; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke("reset-app-data"),

  confirmDeleteAccount: (): Promise<{ confirmed: boolean }> =>
    ipcRenderer.invoke("confirm-delete-account"),

  // DEV-ONLY: local half of "Delete My Account". No confirm dialog (the
  // caller has already confirmed and completed the server-side deletion) —
  // wipes natively.db + cached session/credentials and relaunches.
  wipeLocalAccountData: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("dev:wipe-local-account-data"),

  // Event listeners
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => {
    const subscription = (_: any, data: { path: string; preview: string }) =>
      callback(data)
    ipcRenderer.on("screenshot-taken", subscription)
    return () => {
      ipcRenderer.removeListener("screenshot-taken", subscription)
    }
  },
  onScreenshotAttached: (
    callback: (data: { path: string; preview: string }) => void
  ) => {
    const subscription = (_: any, data: { path: string; preview: string }) =>
      callback(data)
    ipcRenderer.on("screenshot-attached", subscription)
    return () => {
      ipcRenderer.removeListener("screenshot-attached", subscription)
    }
  },
  onCaptureAndProcess: (
    callback: (data: { path: string; preview: string }) => void
  ) => {
    const subscription = (_: any, data: { path: string; preview: string }) =>
      callback(data)
    ipcRenderer.on("capture-and-process", subscription)
    return () => {
      ipcRenderer.removeListener("capture-and-process", subscription)
    }
  },
  onSolutionsReady: (callback: (solutions: string) => void) => {
    const subscription = (_: any, solutions: string) => callback(solutions)
    ipcRenderer.on("solutions-ready", subscription)
    return () => {
      ipcRenderer.removeListener("solutions-ready", subscription)
    }
  },
  onResetView: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("reset-view", subscription)
    return () => {
      ipcRenderer.removeListener("reset-view", subscription)
    }
  },
  onSolutionStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.INITIAL_START, subscription)
    }
  },
  onDebugStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_START, subscription)
    }
  },

  onDebugSuccess: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("debug-success", subscription)
    return () => {
      ipcRenderer.removeListener("debug-success", subscription)
    }
  },
  onDebugError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    }
  },
  onSolutionError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        subscription
      )
    }
  },
  onProcessingNoScreenshots: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    }
  },

  onProblemExtracted: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.PROBLEM_EXTRACTED, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.PROBLEM_EXTRACTED,
        subscription
      )
    }
  },
  onSolutionSuccess: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.SOLUTION_SUCCESS, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.SOLUTION_SUCCESS,
        subscription
      )
    }
  },
  onUnauthorized: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    }
  },
  moveWindowLeft: () => ipcRenderer.invoke("move-window-left"),
  moveWindowRight: () => ipcRenderer.invoke("move-window-right"),
  moveWindowUp: () => ipcRenderer.invoke("move-window-up"),
  moveWindowDown: () => ipcRenderer.invoke("move-window-down"),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  updateSpeakerNames: (names: { user: string; client: string }) =>
    ipcRenderer.invoke("update-speaker-names", names),

  analyzeImageFile: (path: string) => ipcRenderer.invoke("analyze-image-file", path),
  quitApp: () => ipcRenderer.invoke("quit-app"),
  hardRefresh: (): Promise<{ success: boolean }> => ipcRenderer.invoke("hard-refresh"),
  toggleWindow: () => ipcRenderer.invoke("toggle-window"),
  showWindow: (inactive?: boolean) => ipcRenderer.invoke("show-window", inactive),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  showOverlay: () => ipcRenderer.invoke("show-overlay"),
  hideOverlay: () => ipcRenderer.invoke("hide-overlay"),
  getMeetingActive: () => ipcRenderer.invoke("get-meeting-active"),
  onSpeakerNamesResolved: (callback) => {
    const subscription = (_: any, names: any) => callback(names);
    ipcRenderer.on('speaker-names-resolved', subscription);
    return () => ipcRenderer.removeListener('speaker-names-resolved', subscription);
  },
  onMeetingStateChanged: (callback: (data: { isActive: boolean }) => void) => {
    const subscription = (_: any, data: { isActive: boolean }) => callback(data);
    ipcRenderer.on('meeting-state-changed', subscription);
    return () => { ipcRenderer.removeListener('meeting-state-changed', subscription); };
  },
  // Fired once, exactly when endMeeting() resolves the real meetingId for
  // the call that just ended — race-free alternative to inferring "the
  // current meeting" from getRecentMeetings()[0] (see main.ts#endMeeting).
  onLiveCallEnded: (callback: (data: { meetingId: string }) => void) => {
    const subscription = (_: any, data: { meetingId: string }) => callback(data);
    ipcRenderer.on('live-call-ended', subscription);
    return () => { ipcRenderer.removeListener('live-call-ended', subscription); };
  },
  onMeetingCompleted: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on('meeting-completed', subscription);
    return () => { ipcRenderer.removeListener('meeting-completed', subscription); };
  },
  savePendingLiveChatInteractions: (meetingId: string, interactionIds: number[]) =>
    ipcRenderer.invoke('live-chat:save-pending-interactions', meetingId, interactionIds),
  getPendingLiveChatInteractions: (meetingId: string): Promise<number[]> =>
    ipcRenderer.invoke('live-chat:get-pending-interactions', meetingId),
  clearPendingLiveChatInteractions: (meetingId: string) =>
    ipcRenderer.invoke('live-chat:clear-pending-interactions', meetingId),
  getAllPendingLiveChatMeetingIds: (): Promise<string[]> =>
    ipcRenderer.invoke('live-chat:get-all-pending-meeting-ids'),
  getMeetingPaused: () => ipcRenderer.invoke("get-meeting-paused"),
  pauseMeeting: () => ipcRenderer.invoke("pause-meeting"),
  resumeMeeting: () => ipcRenderer.invoke("resume-meeting"),
  onMeetingPauseStateChanged: (callback: (data: { isPaused: boolean }) => void) => {
    const subscription = (_event: any, data: { isPaused: boolean }) => callback(data);
    ipcRenderer.on('meeting-pause-state-changed', subscription);
    return () => { ipcRenderer.removeListener('meeting-pause-state-changed', subscription); };
  },
  onWindowMaximizedChanged: (callback: (isMaximized: boolean) => void) => {
    const subscription = (_: any, isMaximized: boolean) => callback(isMaximized);
    ipcRenderer.on('window-maximized-changed', subscription);
    return () => { ipcRenderer.removeListener('window-maximized-changed', subscription); };
  },
  onEnsureExpanded: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on('ensure-expanded', subscription);
    return () => { ipcRenderer.removeListener('ensure-expanded', subscription); };
  },
  toggleAdvancedSettings: () => ipcRenderer.invoke("toggle-advanced-settings"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  openKnownFolder: (key: 'downloads' | 'applications') => ipcRenderer.invoke("open-known-folder", key),
  setUndetectable: (state: boolean) => ipcRenderer.invoke("set-undetectable", state),
  getUndetectable: () => ipcRenderer.invoke("get-undetectable"),
  setOverlayMousePassthrough: (enabled: boolean) => ipcRenderer.invoke("set-overlay-mouse-passthrough", enabled),
  toggleOverlayMousePassthrough: () => ipcRenderer.invoke("toggle-overlay-mouse-passthrough"),
  getOverlayMousePassthrough: () => ipcRenderer.invoke("get-overlay-mouse-passthrough"),
  setOpenAtLogin: (open: boolean) => ipcRenderer.invoke("set-open-at-login", open),
  getOpenAtLogin: () => ipcRenderer.invoke("get-open-at-login"),
  setDisguise: (mode: 'terminal' | 'settings' | 'activity' | 'none') => ipcRenderer.invoke("set-disguise", mode),
  getDisguise: () => ipcRenderer.invoke("get-disguise"),
  onDisguiseChanged: (callback: (mode: 'terminal' | 'settings' | 'activity' | 'none') => void) => {
    const subscription = (_: any, mode: any) => callback(mode)
    ipcRenderer.on('disguise-changed', subscription)
    return () => {
      ipcRenderer.removeListener('disguise-changed', subscription)
    }
  },
  getDisplayName: (role: 'user' | 'client' | 'assistant') => ipcRenderer.invoke("get-display-name", role),
  getSpeakerNames: () => ipcRenderer.invoke("get-speaker-names"),

  onSettingsVisibilityChange: (callback: (isVisible: boolean) => void) => {
    const subscription = (_: any, isVisible: boolean) => callback(isVisible)
    ipcRenderer.on("settings-visibility-changed", subscription)
    return () => {
      ipcRenderer.removeListener("settings-visibility-changed", subscription)
    }
  },

  onToggleExpand: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("toggle-expand", subscription)
    return () => {
      ipcRenderer.removeListener("toggle-expand", subscription)
    }
  },

  // LLM Model Management
  getCurrentLlmConfig: () => ipcRenderer.invoke("get-current-llm-config"),
  getAvailableOllamaModels: () => ipcRenderer.invoke("get-available-ollama-models"),
  switchToOllama: (model?: string, url?: string) => ipcRenderer.invoke("switch-to-ollama", model, url),
  switchToGemini: (apiKey?: string, modelId?: string) => ipcRenderer.invoke("switch-to-gemini", apiKey, modelId),
  testLlmConnection: (provider: 'gemini' | 'groq' | 'openai' | 'claude', apiKey: string) => ipcRenderer.invoke("test-llm-connection", provider, apiKey),
  selectServiceAccount: () => ipcRenderer.invoke("select-service-account"),

  // API Key Management
  setGeminiApiKey: (apiKey: string) => ipcRenderer.invoke("set-gemini-api-key", apiKey),
  setGroqApiKey: (apiKey: string) => ipcRenderer.invoke("set-groq-api-key", apiKey),
  setOpenaiApiKey: (apiKey: string) => ipcRenderer.invoke("set-openai-api-key", apiKey),
  setClaudeApiKey: (apiKey: string) => ipcRenderer.invoke("set-claude-api-key", apiKey),
  getStoredCredentials: () => ipcRenderer.invoke("get-stored-credentials"),

  // STT Provider Management
  setSttProvider: (provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox') => ipcRenderer.invoke("set-stt-provider", provider),
  getSttProvider: () => ipcRenderer.invoke("get-stt-provider"),
  setGroqSttApiKey: (apiKey: string) => ipcRenderer.invoke("set-groq-stt-api-key", apiKey),
  setOpenAiSttApiKey: (apiKey: string) => ipcRenderer.invoke("set-openai-stt-api-key", apiKey),
  setDeepgramApiKey: (apiKey: string) => ipcRenderer.invoke("set-deepgram-api-key", apiKey),
  setElevenLabsApiKey: (apiKey: string) => ipcRenderer.invoke("set-elevenlabs-api-key", apiKey),
  setAzureApiKey: (apiKey: string) => ipcRenderer.invoke("set-azure-api-key", apiKey),
  setAzureRegion: (region: string) => ipcRenderer.invoke("set-azure-region", region),
  setIbmWatsonApiKey: (apiKey: string) => ipcRenderer.invoke("set-ibmwatson-api-key", apiKey),
  setGroqSttModel: (model: string) => ipcRenderer.invoke("set-groq-stt-model", model),
  setSonioxApiKey: (apiKey: string) => ipcRenderer.invoke("set-soniox-api-key", apiKey),
  testSttConnection: (provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox', apiKey: string, region?: string) => ipcRenderer.invoke("test-stt-connection", provider, apiKey, region),
  setDiarizeClientEnabled: (enabled: boolean) => ipcRenderer.invoke("set-diarize-client-enabled", enabled),
  getDiarizeClientEnabled: () => ipcRenderer.invoke("get-diarize-client-enabled"),
  setTranslateTranscripts: (enabled: boolean) => ipcRenderer.invoke("set-translate-transcripts", enabled),
  getTranslateTranscripts: () => ipcRenderer.invoke("get-translate-transcripts"),
  getAudioPipelineStats: () => ipcRenderer.invoke("get-audio-pipeline-stats"),
  getOutputRoute: () => ipcRenderer.invoke("get-output-route"),

  // Native Audio Service Events
  onNativeAudioTranscript: (callback: (transcript: { speaker: string; displayName?: string; text: string; timestamp?: number; final: boolean; confidence?: number; speakerIndex?: number; retract?: boolean }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("native-audio-transcript", subscription)
    return () => {
      ipcRenderer.removeListener("native-audio-transcript", subscription)
    }
  },
  onNativeAudioSuggestion: (callback: (suggestion: { context: string; lastQuestion: string; confidence: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("native-audio-suggestion", subscription)
    return () => {
      ipcRenderer.removeListener("native-audio-suggestion", subscription)
    }
  },
  onNativeAudioConnected: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("native-audio-connected", subscription)
    return () => {
      ipcRenderer.removeListener("native-audio-connected", subscription)
    }
  },
  onNativeAudioDisconnected: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("native-audio-disconnected", subscription)
    return () => {
      ipcRenderer.removeListener("native-audio-disconnected", subscription)
    }
  },
  onMeetingAudioWarning: (callback: (message: string) => void) => {
    const subscription = (_: any, message: string) => callback(message)
    ipcRenderer.on("meeting-audio-warning", subscription)
    return () => {
      ipcRenderer.removeListener("meeting-audio-warning", subscription)
    }
  },
  // Main broadcasts this from three sites but it was never bridged, so every
  // one of them was unreachable from the renderer.
  onMeetingAudioError: (callback: (message: string) => void) => {
    const subscription = (_: any, message: string) => callback(message)
    ipcRenderer.on("meeting-audio-error", subscription)
    return () => {
      ipcRenderer.removeListener("meeting-audio-error", subscription)
    }
  },
  onSystemAudioPermissionDenied: (callback: (message: string) => void) => {
    const subscription = (_: any, message: string) => callback(message)
    ipcRenderer.on("system-audio-permission-denied", subscription)
    return () => {
      ipcRenderer.removeListener("system-audio-permission-denied", subscription)
    }
  },
  onSystemAudioRecovered: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("system-audio-recovered", subscription)
    return () => {
      ipcRenderer.removeListener("system-audio-recovered", subscription)
    }
  },
  onAudioCaptureFailed: (
    callback: (payload: {
      channel: 'system' | 'mic'
      message: string
      attempt: number
      maxAttempts: number
      terminal?: boolean
      stuck?: boolean
    }) => void,
  ) => {
    const subscription = (_: any, payload: any) => callback(payload)
    ipcRenderer.on("audio-capture-failed", subscription)
    return () => {
      ipcRenderer.removeListener("audio-capture-failed", subscription)
    }
  },
  onSuggestionGenerated: (callback: (data: { question: string; suggestion: string; confidence: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("suggestion-generated", subscription)
    return () => {
      ipcRenderer.removeListener("suggestion-generated", subscription)
    }
  },
  onSuggestionProcessingStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("suggestion-processing-start", subscription)
    return () => {
      ipcRenderer.removeListener("suggestion-processing-start", subscription)
    }
  },
  onSuggestionError: (callback: (error: { error: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("suggestion-error", subscription)
    return () => {
      ipcRenderer.removeListener("suggestion-error", subscription)
    }
  },
  generateSuggestion: (context: string, lastQuestion: string) =>
    ipcRenderer.invoke("generate-suggestion", context, lastQuestion),

  getNativeAudioStatus: () => ipcRenderer.invoke("native-audio-status"),
  getInputDevices: () => ipcRenderer.invoke("get-input-devices"),
  getOutputDevices: () => ipcRenderer.invoke("get-output-devices"),
  getPlatform: () => process.platform,
  checkPermissions: () => ipcRenderer.invoke("check-permissions"),
  requestPermission: (type: 'microphone' | 'screen') => ipcRenderer.invoke("request-permission", type),
  openPermissionSettings: (pane?: 'microphone' | 'screen') => ipcRenderer.invoke("open-permission-settings", pane),
  getSystemAudioPermissionWarning: () => ipcRenderer.invoke("get-system-audio-permission-warning"),
  repairTccPermissions: () => ipcRenderer.invoke("repair-tcc-permissions"),
  setCompanyIntel: (intel: Record<string, any> | null) =>
    ipcRenderer.invoke('set-company-intel', intel),
  setRecognitionLanguage: (key: string) => ipcRenderer.invoke("set-recognition-language", key),
  getAiResponseLanguages: () => ipcRenderer.invoke("get-ai-response-languages"),
  setAiResponseLanguage: (language: string) => ipcRenderer.invoke("set-ai-response-language", language),
  getSttLanguage: () => ipcRenderer.invoke("get-stt-language"),
  getAiResponseLanguage: () => ipcRenderer.invoke("get-ai-response-language"),

  // Intelligence Mode IPC
  generateAssist: () => ipcRenderer.invoke("generate-assist"),
  generateWhatToSay: (question?: string, imagePaths?: string[]) => ipcRenderer.invoke("generate-what-to-say", question, imagePaths),
  generateWhatAmIMissing: () => ipcRenderer.invoke("generate-what-am-i-missing"), // WHAT AM I MISSING
  generateDiscovery: () => ipcRenderer.invoke("generate-discovery"), // DISCOVERY MODE
  generateObjectionHandler: () => ipcRenderer.invoke("generate-objection-handler"), // OBJECTION HANDLER MODE
  generateClarify: () => ipcRenderer.invoke("generate-clarify"),
  generateCodeHint: (imagePaths?: string[], problemStatement?: string) => ipcRenderer.invoke("generate-code-hint", imagePaths, problemStatement),
  generateBrainstorm: (imagePaths?: string[], problemStatement?: string) => ipcRenderer.invoke("generate-brainstorm", imagePaths, problemStatement),
  generateFollowUp: (intent: string, userRequest?: string) => ipcRenderer.invoke("generate-follow-up", intent, userRequest),
  generateFollowUpQuestions: () => ipcRenderer.invoke("generate-follow-up-questions"),
  generateRecap: () => ipcRenderer.invoke("generate-recap"),
  submitManualQuestion: (question: string) => ipcRenderer.invoke("submit-manual-question", question),
  getIntelligenceContext: () => ipcRenderer.invoke("get-intelligence-context"),
  resetIntelligence: () => ipcRenderer.invoke("reset-intelligence"),

  // Action Button Mode (Dynamic Recap / Brainstorm toggle)
  getActionButtonMode: () => ipcRenderer.invoke("get-action-button-mode"),
  setActionButtonMode: (mode: 'recap' | 'brainstorm') => ipcRenderer.invoke("set-action-button-mode", mode),
  onActionButtonModeChanged: (callback: (mode: 'recap' | 'brainstorm') => void) => {
    const subscription = (_: any, mode: 'recap' | 'brainstorm') => callback(mode);
    ipcRenderer.on('action-button-mode-changed', subscription);
    return () => { ipcRenderer.removeListener('action-button-mode-changed', subscription); };
  },

  // Meeting Lifecycle
  startMeeting: (metadata?: any) => ipcRenderer.invoke("start-meeting", metadata),
  endMeeting: (meetingTypes?: ('discovery' | 'demo' | 'negotiation')[], tenantId?: string | null) => ipcRenderer.invoke("end-meeting", { meetingTypes, tenantId }),
  finalizeMicSTT: () => ipcRenderer.invoke("finalize-mic-stt"),
  getRecentMeetings: () => ipcRenderer.invoke("get-recent-meetings"),
  getMeetingDetails: (id: string) => ipcRenderer.invoke("get-meeting-details", id),
  updateMeetingTitle: (id: string, title: string) => ipcRenderer.invoke("update-meeting-title", { id, title }),
  updateMeetingSummary: (id: string, updates: any) => ipcRenderer.invoke("update-meeting-summary", { id, updates }),
  regenerateMeetingSummary: (id: string) => ipcRenderer.invoke('regenerate-meeting-summary', { id }),
  uploadTranscript: (text: string, title?: string, meetingTypes?: ('discovery' | 'demo' | 'negotiation')[]) => ipcRenderer.invoke('upload-transcript', { text, title, meetingTypes }),
  deleteMeeting: (id: string) => ipcRenderer.invoke("delete-meeting", id),

  onMeetingsUpdated: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("meetings-updated", subscription)
    return () => {
      ipcRenderer.removeListener("meetings-updated", subscription)
    }
  },

  updateLiveAnalysis: (data: LiveAnalysisData) => ipcRenderer.invoke("update-live-analysis", data),
  setLiveAnalysisInFlight: (inFlight: boolean) => ipcRenderer.invoke("set-live-analysis-in-flight", inFlight),

  // Window Mode
  setWindowMode: (mode: 'launcher' | 'overlay', inactive?: boolean, freshMeetingStart?: boolean) =>
    ipcRenderer.invoke("set-window-mode", mode, inactive, freshMeetingStart),

  // Intelligence Mode Events
  onIntelligenceAssistUpdate: (callback: (data: { insight: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-assist-update", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-assist-update", subscription)
    }
  },
  onIntelligenceSuggestedAnswerToken: (callback: (data: { token: string; question: string; confidence: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-suggested-answer-token", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-suggested-answer-token", subscription)
    }
  },
  onIntelligenceSuggestedAnswer: (callback: (data: { answer: string; question: string; confidence: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-suggested-answer", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-suggested-answer", subscription)
    }
  },
  onIntelligenceRefinedAnswerToken: (callback: (data: { token: string; intent: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-refined-answer-token", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-refined-answer-token", subscription)
    }
  },
  onIntelligenceRefinedAnswer: (callback: (data: { answer: string; intent: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-refined-answer", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-refined-answer", subscription)
    }
  },
  onIntelligenceRecapToken: (callback: (data: { token: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-recap-token", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-recap-token", subscription)
    }
  },
  onIntelligenceRecap: (callback: (data: { summary: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-recap", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-recap", subscription)
    }
  },
  onIntelligenceClarifyToken: (callback: (data: { token: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-clarify-token", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-clarify-token", subscription)
    }
  },
  onIntelligenceClarify: (callback: (data: { clarification: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-clarify", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-clarify", subscription)
    }
  },
  onIntelligenceFollowUpQuestionsToken: (callback: (data: { token: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-follow-up-questions-token", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-follow-up-questions-token", subscription)
    }
  },
  onIntelligenceFollowUpQuestionsUpdate: (callback: (data: { questions: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-follow-up-questions-update", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-follow-up-questions-update", subscription)
    }
  },
  onIntelligenceManualStarted: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("intelligence-manual-started", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-manual-started", subscription)
    }
  },
  onIntelligenceManualResult: (callback: (data: { answer: string; question: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-manual-result", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-manual-result", subscription)
    }
  },
  onIntelligenceModeChanged: (callback: (data: { mode: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-mode-changed", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-mode-changed", subscription)
    }
  },
  onIntelligenceError: (callback: (data: { error: string; mode: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-error", subscription)
    return () => {
      ipcRenderer.removeListener("intelligence-error", subscription)
    }
  },
  onSessionReset: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("session-reset", subscription)
    return () => {
      ipcRenderer.removeListener("session-reset", subscription)
    }
  },


  // Streaming Chat
  streamGeminiChat: (message: string, imagePaths?: string[], context?: string, options?: { skipSystemPrompt?: boolean }) => ipcRenderer.invoke("gemini-chat-stream", message, imagePaths, context, options),

  chatWithGemini: (message: string, imagePaths?: string[], context?: string, skipSystemPrompt?: boolean) => ipcRenderer.invoke('gemini-chat', message, imagePaths, context, { skipSystemPrompt }),
  onGeminiStreamToken: (callback: (token: string) => void) => {
    const subscription = (_: any, token: string) => callback(token)
    ipcRenderer.on("gemini-stream-token", subscription)
    return () => {
      ipcRenderer.removeListener("gemini-stream-token", subscription)
    }
  },


  onGeminiStreamDone: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("gemini-stream-done", subscription)
    return () => {
      ipcRenderer.removeListener("gemini-stream-done", subscription)
    }
  },

  onGeminiStreamError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on("gemini-stream-error", subscription)
    return () => {
      ipcRenderer.removeListener("gemini-stream-error", subscription)
    }
  },

  // Model Management
  getDefaultModel: () => ipcRenderer.invoke('get-default-model'),
  setModel: (modelId: string) => ipcRenderer.invoke('set-model', modelId),
  setDefaultModel: (modelId: string) => ipcRenderer.invoke('set-default-model', modelId),
  toggleModelSelector: (coords: { x: number; y: number }) => ipcRenderer.invoke('toggle-model-selector', coords),
  forceRestartOllama: () => ipcRenderer.invoke('force-restart-ollama'),

  // Settings Window
  toggleSettingsWindow: (coords?: { x: number; y: number }) => ipcRenderer.invoke('toggle-settings-window', coords),

  // Team invite deep link
  onInviteDeepLink: (callback: (data: { token: string }) => void) => {
    const subscription = (_: any, data: { token: string }) => callback(data)
    ipcRenderer.on('invite-deep-link', subscription)
    return () => {
      ipcRenderer.removeListener('invite-deep-link', subscription)
    }
  },

  // Groq Fast Text Mode
  getGroqFastTextMode: () => ipcRenderer.invoke('get-groq-fast-text-mode'),
  setGroqFastTextMode: (enabled: boolean) => ipcRenderer.invoke('set-groq-fast-text-mode', enabled),

  // Demo
  seedDemo: () => ipcRenderer.invoke('seed-demo'),

  // Custom Providers
  saveCustomProvider: (provider: any) => ipcRenderer.invoke('save-custom-provider', provider),
  getCustomProviders: () => ipcRenderer.invoke('get-custom-providers'),
  deleteCustomProvider: (id: string) => ipcRenderer.invoke('delete-custom-provider', id),

  // Follow-up Email
  generateFollowupEmail: (input: any) => ipcRenderer.invoke('generate-followup-email', input),
  extractEmailsFromTranscript: (transcript: Array<{ text: string }>) => ipcRenderer.invoke('extract-emails-from-transcript', transcript),
  getCalendarAttendees: (eventId: string) => ipcRenderer.invoke('get-calendar-attendees', eventId),
  openMailto: (params: { to: string; subject: string; body: string }) => ipcRenderer.invoke('open-mailto', params),

  // Audio Test
  startAudioTest: (deviceId?: string) => ipcRenderer.invoke('start-audio-test', deviceId),
  stopAudioTest: () => ipcRenderer.invoke('stop-audio-test'),
  onAudioTestLevel: (callback: (level: number) => void) => {
    const subscription = (_: any, level: number) => callback(level)
    ipcRenderer.on('audio-test-level', subscription)
    return () => {
      ipcRenderer.removeListener('audio-test-level', subscription)
    }
  },
  onAudioTestSystemLevel: (callback: (level: number) => void) => {
    const subscription = (_: any, level: number) => callback(level)
    ipcRenderer.on('audio-test-system-level', subscription)
    return () => {
      ipcRenderer.removeListener('audio-test-system-level', subscription)
    }
  },
  onAudioTestSystemError: (callback: (errorMessage: string) => void) => {
    const subscription = (_: any, errorMessage: string) => callback(errorMessage)
    ipcRenderer.on('audio-test-system-error', subscription)
    return () => {
      ipcRenderer.removeListener('audio-test-system-error', subscription)
    }
  },

  // Database
  flushDatabase: () => ipcRenderer.invoke('flush-database'),



  onUndetectableChanged: (callback: (state: boolean) => void) => {
    const subscription = (_: any, state: boolean) => callback(state)
    ipcRenderer.on('undetectable-changed', subscription)
    return () => {
      ipcRenderer.removeListener('undetectable-changed', subscription)
    }
  },

  onOverlayMousePassthroughChanged: (callback: (enabled: boolean) => void) => {
    const subscription = (_: any, enabled: boolean) => callback(enabled)
    ipcRenderer.on('overlay-mouse-passthrough-changed', subscription)
    return () => {
      ipcRenderer.removeListener('overlay-mouse-passthrough-changed', subscription)
    }
  },

  onGroqFastTextChanged: (callback: (enabled: boolean) => void) => {
    const subscription = (_: any, enabled: boolean) => callback(enabled)
    ipcRenderer.on('groq-fast-text-changed', subscription)
    return () => {
      ipcRenderer.removeListener('groq-fast-text-changed', subscription)
    }
  },

  onModelChanged: (callback: (modelId: string) => void) => {
    const subscription = (_: any, modelId: string) => callback(modelId)
    ipcRenderer.on('model-changed', subscription)
    return () => {
      ipcRenderer.removeListener('model-changed', subscription)
    }
  },

  onOllamaPullProgress: (callback: (data: { status: string; percent: number }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('ollama:pull-progress', subscription)
    return () => {
      ipcRenderer.removeListener('ollama:pull-progress', subscription)
    }
  },

  onOllamaPullComplete: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on('ollama:pull-complete', subscription)
    return () => {
      ipcRenderer.removeListener('ollama:pull-complete', subscription)
    }
  },

  // Theme API
  getThemeMode: () => ipcRenderer.invoke('theme:get-mode'),
  setThemeMode: (mode: 'system' | 'light' | 'dark') => ipcRenderer.invoke('theme:set-mode', mode),
  onThemeChanged: (callback: (data: { mode: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('theme:changed', subscription)
    return () => {
      ipcRenderer.removeListener('theme:changed', subscription)
    }
  },

  // Calendar API
  calendarConnect: () => ipcRenderer.invoke('calendar-connect'),
  calendarDisconnect: () => ipcRenderer.invoke('calendar-disconnect'),
  getCalendarStatus: () => ipcRenderer.invoke('get-calendar-status'),
  getUpcomingEvents: () => ipcRenderer.invoke('get-upcoming-events'),
  calendarRefresh: () => ipcRenderer.invoke('calendar-refresh'),
  streamSalesBrief: (eventData: any) => ipcRenderer.invoke('stream-sales-brief', eventData),
  onSalesBriefStreamToken: (callback: (token: string) => void) => {
    const sub = (_event: any, token: string) => callback(token);
    ipcRenderer.on('sales-brief-stream-token', sub);
    return () => { ipcRenderer.removeListener('sales-brief-stream-token', sub); };
  },
  onSalesBriefStreamDone: (callback: () => void) => {
    const sub = () => callback();
    ipcRenderer.on('sales-brief-stream-done', sub);
    return () => { ipcRenderer.removeListener('sales-brief-stream-done', sub); };
  },
  onSalesBriefStreamError: (callback: (error: string) => void) => {
    const sub = (_event: any, error: string) => callback(error);
    ipcRenderer.on('sales-brief-stream-error', sub);
    return () => { ipcRenderer.removeListener('sales-brief-stream-error', sub); };
  },
  fetchCompanyIntel: (payload: { companyName: string; domain?: string; forceRefresh?: boolean }) =>
    ipcRenderer.invoke('fetch-company-intel', payload),

  // Zoom Calendar
  zoomCalendarConnect: () => ipcRenderer.invoke('zoom-calendar-connect'),
  zoomCalendarDisconnect: () => ipcRenderer.invoke('zoom-calendar-disconnect'),
  getZoomCalendarStatus: () => ipcRenderer.invoke('get-zoom-calendar-status'),
  getZoomUpcomingEvents: () => ipcRenderer.invoke('get-zoom-upcoming-events'),
  zoomCalendarRefresh: () => ipcRenderer.invoke('zoom-calendar-refresh'),

  // Auto-Update
  onUpdateAvailable: (callback: (info: any) => void) => {
    const subscription = (_: any, info: any) => callback(info)
    ipcRenderer.on("update-available", subscription)
    return () => {
      ipcRenderer.removeListener("update-available", subscription)
    }
  },
  onUpdateDownloaded: (callback: (info: any) => void) => {
    const subscription = (_: any, info: any) => callback(info)
    ipcRenderer.on("update-downloaded", subscription)
    return () => {
      ipcRenderer.removeListener("update-downloaded", subscription)
    }
  },
  onUpdateChecking: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("update-checking", subscription)
    return () => {
      ipcRenderer.removeListener("update-checking", subscription)
    }
  },
  onUpdateNotAvailable: (callback: (info: any) => void) => {
    const subscription = (_: any, info: any) => callback(info)
    ipcRenderer.on("update-not-available", subscription)
    return () => {
      ipcRenderer.removeListener("update-not-available", subscription)
    }
  },
  onUpdateError: (callback: (err: string) => void) => {
    const subscription = (_: any, err: string) => callback(err)
    ipcRenderer.on("update-error", subscription)
    return () => {
      ipcRenderer.removeListener("update-error", subscription)
    }
  },
  onDownloadProgress: (callback: (progressObj: any) => void) => {
    const subscription = (_: any, progressObj: any) => callback(progressObj)
    ipcRenderer.on("download-progress", subscription)
    return () => {
      ipcRenderer.removeListener("download-progress", subscription)
    }
  },
  restartAndInstall: () => ipcRenderer.invoke("quit-and-install-update"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  testReleaseFetch: () => ipcRenderer.invoke("test-release-fetch"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  isAppPackaged: () => ipcRenderer.invoke("is-app-packaged"),

  // Intelligence Mode - WHAT AM I MISSING
  onWhatAmIMissingToken: (callback: (data: { token: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-what-am-i-missing-token", subscription)
    return () => ipcRenderer.removeListener("intelligence-what-am-i-missing-token", subscription)
  },

  onWhatAmIMissing: (callback: (data: { answer: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-what-am-i-missing", subscription)
    return () => ipcRenderer.removeListener("intelligence-what-am-i-missing", subscription)
  },

  onDiscoveryToken: (callback) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-discovery-token", subscription)
    return () => ipcRenderer.removeListener("intelligence-discovery-token", subscription)
  },

  onDiscovery: (callback) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-discovery", subscription)
    return () => ipcRenderer.removeListener("intelligence-discovery", subscription)
  },

  onObjectionHandlerToken: (callback) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-objection-handler-token", subscription)
    return () => ipcRenderer.removeListener("intelligence-objection-handler-token", subscription)
  },

  onObjectionHandler: (callback) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("intelligence-objection-handler", subscription)
    return () => ipcRenderer.removeListener("intelligence-objection-handler", subscription)
  },

  // RAG API
  ragQueryMeeting: (meetingId: string, query: string) => ipcRenderer.invoke('rag:query-meeting', { meetingId, query }),
  ragQueryLive: (query: string) => ipcRenderer.invoke('rag:query-live', { query }),
  ragQueryGlobal: (query: string) => ipcRenderer.invoke('rag:query-global', { query }),
  ragCancelQuery: (options: { meetingId?: string; global?: boolean }) => ipcRenderer.invoke('rag:cancel-query', options),
  ragIsMeetingProcessed: (meetingId: string) => ipcRenderer.invoke('rag:is-meeting-processed', meetingId),
  ragGetQueueStatus: () => ipcRenderer.invoke('rag:get-queue-status'),
  ragRetryEmbeddings: () => ipcRenderer.invoke('rag:retry-embeddings'),

  onIncompatibleProviderWarning: (callback: (data: { count: number, oldProvider: string, newProvider: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('embedding:incompatible-provider-warning', subscription)
    return () => {
      ipcRenderer.removeListener('embedding:incompatible-provider-warning', subscription)
    }
  },
  reindexIncompatibleMeetings: () => ipcRenderer.invoke('rag:reindex-incompatible-meetings'),

  onRAGStreamChunk: (callback: (data: { meetingId?: string; global?: boolean; chunk: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('rag:stream-chunk', subscription)
    return () => {
      ipcRenderer.removeListener('rag:stream-chunk', subscription)
    }
  },
  onRAGStreamComplete: (callback: (data: { meetingId?: string; global?: boolean }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('rag:stream-complete', subscription)
    return () => {
      ipcRenderer.removeListener('rag:stream-complete', subscription)
    }
  },
  onRAGStreamError: (callback: (data: { meetingId?: string; global?: boolean; error: string }) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on('rag:stream-error', subscription)
    return () => {
      ipcRenderer.removeListener('rag:stream-error', subscription)
    }
  },

  onTavilySearching: (callback) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on('tavily-searching', subscription);
    return () => ipcRenderer.removeListener('tavily-searching', subscription);
  },
  onTavilySearchDone: (callback) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on('tavily-search-done', subscription);
    return () => ipcRenderer.removeListener('tavily-search-done', subscription);
  },

  // Add alongside similar onXxx listeners:
  onCompanyIntelUpdated: (callback: (intel: Record<string, any> | null) => void) => {
    const handler = (_: any, intel: Record<string, any> | null) => callback(intel);
    ipcRenderer.on('company-intel-updated', handler);
    return () => ipcRenderer.removeListener('company-intel-updated', handler);
  },

  // Keybind Management
  getKeybinds: () => ipcRenderer.invoke('keybinds:get-all'),
  setKeybind: (id: string, accelerator: string) => ipcRenderer.invoke('keybinds:set', id, accelerator),
  resetKeybinds: () => ipcRenderer.invoke('keybinds:reset'),
  onKeybindsUpdate: (callback: (keybinds: Array<any>) => void) => {
    const subscription = (_: any, keybinds: any) => callback(keybinds)
    ipcRenderer.on('keybinds:update', subscription)
    return () => {
      ipcRenderer.removeListener('keybinds:update', subscription)
    }
  },

  // Global shortcut listener — fired stealthily from main process without focusing the window
  onGlobalShortcut: (callback: (data: { action: string }) => void) => {
    const subscription = (_: any, data: { action: string }) => callback(data)
    ipcRenderer.on('global-shortcut', subscription)
    return () => {
      ipcRenderer.removeListener('global-shortcut', subscription)
    }
  },

  // Donation API
  getDonationStatus: () => ipcRenderer.invoke("get-donation-status"),
  markDonationToastShown: () => ipcRenderer.invoke("mark-donation-toast-shown"),
  setDonationComplete: () => ipcRenderer.invoke('set-donation-complete'),

  // Profile Engine API
  profileUploadResume: (filePath: string) => ipcRenderer.invoke('profile:upload-resume', filePath),
  profileGetStatus: () => ipcRenderer.invoke('profile:get-status'),
  profileGetMode: () => ipcRenderer.invoke('profile:get-mode'),
  profileSetMode: (enabled: boolean) => ipcRenderer.invoke('profile:set-mode', enabled),
  profileDelete: () => ipcRenderer.invoke('profile:delete'),
  profileGetProfile: () => ipcRenderer.invoke('profile:get-profile'),
  profileSelectFile: () => ipcRenderer.invoke('profile:select-file'),

  // JD & Research API
  profileUploadJD: (filePath: string) => ipcRenderer.invoke('profile:upload-jd', filePath),
  profileDeleteJD: () => ipcRenderer.invoke('profile:delete-jd'),
  profileResearchCompany: (companyName: string) => ipcRenderer.invoke('profile:research-company', companyName),
  profileGenerateNegotiation: (force?: boolean) => ipcRenderer.invoke('profile:generate-negotiation', force),
  profileGetNegotiationState: () => ipcRenderer.invoke('profile:get-negotiation-state'),
  profileResetNegotiation: () => ipcRenderer.invoke('profile:reset-negotiation'),

  // Company Context API
  companyGetContext: () => ipcRenderer.invoke('company:getContext'),
  companySaveContext: (data: any) => ipcRenderer.invoke('company:saveContext', data),
  companyUploadAsset: (type: string, filePath: string) => ipcRenderer.invoke('company:uploadAsset', type, filePath),
  companyDeleteAsset: (assetId: string) => ipcRenderer.invoke('company:deleteAsset', assetId),
  companySyncAsset: (assetId: string) => ipcRenderer.invoke('company:syncAsset', assetId),
  companySetPersonaEngine: (enabled: boolean) => ipcRenderer.invoke('company:setPersonaEngine', enabled),
  companySelectFile: () => ipcRenderer.invoke('company:selectFile'),
  companyGetCompleteness: () => ipcRenderer.invoke('company:getCompleteness'),

  // Scoring criteria
  meetingGetScorecard: (meetingId: string) => ipcRenderer.invoke('meeting:getScorecard', meetingId),
  meetingDeleteScorecard: (meetingId: string) => ipcRenderer.invoke('meeting:deleteScorecard', meetingId),
  scoringGetCriteria: () => ipcRenderer.invoke('scoring:getCriteria'),
  scoringSaveCriteria: (settings: any) => ipcRenderer.invoke('scoring:saveCriteria', settings),
  scoringResetCriteria: () => ipcRenderer.invoke('scoring:resetCriteria'),

  // Tavily Search API
  setTavilyApiKey: (apiKey: string) => ipcRenderer.invoke('set-tavily-api-key', apiKey),

  // Dynamic Model Discovery
  fetchProviderModels: (provider: 'gemini' | 'groq' | 'openai' | 'claude', apiKey: string) => ipcRenderer.invoke('fetch-provider-models', provider, apiKey),
  setProviderPreferredModel: (provider: 'gemini' | 'groq' | 'openai' | 'claude', modelId: string) => ipcRenderer.invoke('set-provider-preferred-model', provider, modelId),

  // License Management
  licenseActivate: (key: string) => ipcRenderer.invoke('license:activate', key),
  licenseCheckPremium: () => ipcRenderer.invoke('license:check-premium'),
  licenseDeactivate: () => ipcRenderer.invoke('license:deactivate'),
  licenseGetHardwareId: () => ipcRenderer.invoke('license:get-hardware-id'),

  // Overlay Opacity (Stealth Mode)
  setOverlayOpacity: (opacity: number) => ipcRenderer.invoke('set-overlay-opacity', opacity),
  onOverlayOpacityChanged: (callback: (opacity: number) => void) => {
    const subscription = (_: any, opacity: number) => callback(opacity)
    ipcRenderer.on('overlay-opacity-changed', subscription)
    return () => {
      ipcRenderer.removeListener('overlay-opacity-changed', subscription)
    }
  },

  // Verbose / Debug Logging
  getVerboseLogging: () => ipcRenderer.invoke('get-verbose-logging'),
  setVerboseLogging: (enabled: boolean) => ipcRenderer.invoke('set-verbose-logging', enabled),

  // Arch
  getArch: () => ipcRenderer.invoke('get-arch'),

  // Cropper API
  cropperConfirmed: (bounds: Electron.Rectangle) => ipcRenderer.send('cropper-confirmed', bounds),
  cropperCancelled: () => ipcRenderer.send('cropper-cancelled'),
  onResetCropper: (callback: (data: { hudPosition: { x: number; y: number } }) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: { hudPosition: { x: number; y: number } }) => callback(data)
    ipcRenderer.on('reset-cropper', subscription)
    return () => {
      ipcRenderer.removeListener('reset-cropper', subscription)
    }
  },

  // ===== Firebase Auth =====
  authSetIdToken: (session: { idToken: string; refreshToken: string; uid: string; email?: string | null; displayName?: string | null; photoURL?: string | null; expiresAt: number }) =>
    ipcRenderer.invoke('auth:set-id-token', session),
  authClear: () => ipcRenderer.invoke('auth:clear'),
  authGetState: () => ipcRenderer.invoke('auth:get-state'),
  authGetPersistedRefreshToken: () => ipcRenderer.invoke('auth:get-persisted-refresh-token'),
  onAuthStateChanged: (callback: (state: any) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, state: any) => callback(state)
    ipcRenderer.on('auth:state-changed', subscription)
    return () => {
      ipcRenderer.removeListener('auth:state-changed', subscription)
    }
  },

  onGoogleSignInPopupClosed: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on('google-signin-popup-closed', subscription)
    return () => {
      ipcRenderer.removeListener('google-signin-popup-closed', subscription)
    }
  },

  // ===== Tenant ID (cross-window) =====
  setCurrentTenantId: (tenantId: string | null) => ipcRenderer.invoke('tenant:set-current', tenantId),
  getCurrentTenantId: () => ipcRenderer.invoke('tenant:get-current'),
  onTenantStateChanged: (callback: (tenantId: string | null) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, tenantId: string | null) => callback(tenantId)
    ipcRenderer.on('tenant:state-changed', subscription)
    return () => {
      ipcRenderer.removeListener('tenant:state-changed', subscription)
    }
  },

  // ===== Supabase mirror =====
  supabaseSetCredentials: (url: string, anonKey: string) =>
    ipcRenderer.invoke('supabase:set-credentials', { url, anonKey }),
  supabaseGetMirrorStatus: () => ipcRenderer.invoke('supabase:get-mirror-status'),
  supabaseForceBackfill: () => ipcRenderer.invoke('supabase:force-backfill'),
  supabaseSyncAudit: () => ipcRenderer.invoke('supabase:sync-audit'),

  // Platform
  platform: process.platform,
} as ElectronAPI)