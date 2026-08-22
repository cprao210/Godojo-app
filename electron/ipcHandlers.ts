// ipcHandlers.ts

import { app, ipcMain, shell, dialog, desktopCapturer, systemPreferences, BrowserWindow, screen, session } from "electron"
import { AppState } from "./main"
import { GEMINI_FLASH_MODEL } from "./IntelligenceManager"
import { DatabaseManager } from "./db/DatabaseManager"; // Import Database Manager
import { SupabaseReadService } from "./db/SupabaseReadService";
import { normalizeLiveAnalysisData } from "./summary/reconcile";
import * as path from "path";
import * as fs from "fs";
import { AudioDevices } from "./audio/AudioDevices";
import { detectTavilyIntent, extractAllowedCompaniesFromAttendees } from "./services/TavilyIntentDetector";
import { searchCompany, clearCompanyCache } from "./services/TavilyManager";

import { buildCompanyContextBlock } from './utils/salesBriefUtils';
import { RECOGNITION_LANGUAGES, AI_RESPONSE_LANGUAGES } from "./config/languages"
import { LiveAnalysisData } from "../src/types";
import {
  buildOwnCompanyBlockFromOrchestrator,
  hydrateOrchestratorFromContext,
} from './utils/companyKnowledge';
import { AuthManager } from './services/AuthManager';
import { PendingLiveChatStore } from './PendingLiveChatStore';
import { posthogMain } from './services/PostHogMainService';
import { tenantContext } from './services/TenantContext';

const BACKEND_URL = process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

function getAuthToken(): string | null {
  return AuthManager.getInstance().getIdToken();
}

export function initializeIpcHandlers(appState: AppState): void {
  const safeHandle = (channel: string, listener: (event: any, ...args: any[]) => Promise<any> | any) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, listener);
  };

  // Relays renderer-side errors (currently: ErrorBoundary.componentDidCatch,
  // see src/features/common/ErrorBoundary.tsx) into main-process error
  // tracking. The renderer already reports these to PostHog directly via
  // posthog-js — this channel exists so the SAME event is also visible from
  // main's perspective (which window/context it hit, main-process-side
  // correlation), and as a fallback in case the renderer crashes before its
  // own posthog-js capture() call completes.
  safeHandle('log-error-to-main', async (_event, payload: {
    type?: string;
    context?: string;
    message?: string;
    stack?: string;
    componentStack?: string;
  }) => {
    try {
      const error = new Error(payload?.message ?? 'Unknown renderer error');
      if (payload?.stack) error.stack = payload.stack;
      posthogMain.captureException(error, 'renderer-error-boundary', {
        rendererContext: payload?.context,
        componentStack: payload?.componentStack,
      });
      return { success: true };
    } catch (e: any) {
      console.error('[ipc] log-error-to-main failed:', e);
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  // --- NEW Test Helper ---
  safeHandle("test-release-fetch", async () => {
    try {
      console.log("[IPC] Manual Test Fetch triggered (forcing refresh)...");
      const { ReleaseNotesManager } = require('./update/ReleaseNotesManager');
      const notes = await ReleaseNotesManager.getInstance().fetchReleaseNotes('latest', true);

      if (notes) {
        console.log("[IPC] Notes fetched for:", notes.version);
        const info = {
          version: notes.version || 'latest',
          files: [] as any[],
          path: '',
          sha512: '',
          releaseName: notes.summary,
          releaseNotes: notes.fullBody,
          parsedNotes: notes
        };
        // Send to renderer
        appState.getMainWindow()?.webContents.send("update-available", info);
        return { success: true };
      }
      return { success: false, error: "No notes returned" };
    } catch (err: any) {
      console.error("[IPC] test-release-fetch failed:", err);
      return { success: false, error: err.message };
    }
  });

  safeHandle("license:activate", async (event, key: string) => {
    try {
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      return await LicenseManager.getInstance().activateLicense(key);
    } catch (err: any) {
      // Only show generic message if the premium module itself is missing.
      // activateLicense() returns {success:false, error} for all expected failures
      // (bad key, network error, etc.) — it should never throw in normal operation.
      console.error('[IPC] license:activate unexpected error:', err);
      return { success: false, error: 'Premium features not available in this build.' };
    }
  });
  safeHandle("license:check-premium", async () => {
    try {
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      return LicenseManager.getInstance().isPremium();
    } catch {
      return false;
    }
  });
  safeHandle("license:deactivate", async () => {
    try {
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      LicenseManager.getInstance().deactivate();
      // Auto-disable knowledge mode when license is removed
      try {
        const orchestrator = appState.getKnowledgeOrchestrator();
        if (orchestrator) {
          orchestrator.setKnowledgeMode(false);
          console.log('[IPC] Knowledge mode auto-disabled due to license deactivation');
        }
      } catch (e) { /* ignore */ }
    } catch { /* LicenseManager not available */ }
    return { success: true };
  });
  safeHandle("license:get-hardware-id", async () => {
    try {
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      return LicenseManager.getInstance().getHardwareId();
    } catch {
      return 'unavailable';
    }
  });

  safeHandle("get-recognition-languages", async () => {
    return RECOGNITION_LANGUAGES;
  });

  safeHandle("get-ai-response-languages", async () => {
    return AI_RESPONSE_LANGUAGES;
  });

  safeHandle("set-ai-response-language", async (_, language: string) => {
    // Validate: must be a non-empty string
    if (!language || typeof language !== 'string' || !language.trim()) {
      console.warn('[IPC] set-ai-response-language: invalid or empty language received, ignoring.');
      return { success: false, error: 'Invalid language value' };
    }
    const sanitizedLanguage = language.trim();
    const { CredentialsManager } = require('./services/CredentialsManager');
    // Persist to disk
    CredentialsManager.getInstance().setAiResponseLanguage(sanitizedLanguage);
    // Update live in-memory LLMHelper (same instance used by IntelligenceEngine)
    const llmHelper = appState.processingHelper?.getLLMHelper?.();
    if (llmHelper) {
      llmHelper.setAiResponseLanguage(sanitizedLanguage);
      console.log(`[IPC] AI response language updated to: ${sanitizedLanguage}`);
    } else {
      console.warn('[IPC] set-ai-response-language: processingHelper or LLMHelper not ready, language saved to disk only.');
    }
    return { success: true };
  });

  safeHandle("get-stt-language", async () => {
    const { CredentialsManager } = require('./services/CredentialsManager');
    return CredentialsManager.getInstance().getSttLanguage();
  });

  safeHandle("get-ai-response-language", async () => {
    const { CredentialsManager } = require('./services/CredentialsManager');
    return CredentialsManager.getInstance().getAiResponseLanguage();
  });
  safeHandle(
    "update-content-dimensions",
    async (event, { width, height }: { width: number; height: number }) => {
      if (!width || !height) return

      const senderWebContents = event.sender
      const settingsWin = appState.settingsWindowHelper.getSettingsWindow()
      const overlayWin = appState.getWindowHelper().getOverlayWindow()
      const launcherWin = appState.getWindowHelper().getLauncherWindow()

      if (settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents.id === senderWebContents.id) {
        appState.settingsWindowHelper.setWindowDimensions(settingsWin, width, height)
      } else if (
        overlayWin && !overlayWin.isDestroyed() && overlayWin.webContents.id === senderWebContents.id
      ) {
        // NativelyInterface logic - Resize ONLY the overlay window using dedicated method
        appState.getWindowHelper().setOverlayDimensions(width, height)
      } else if (
        launcherWin && !launcherWin.isDestroyed() && launcherWin.webContents.id === senderWebContents.id
      ) {
        // EC-05 fix: launcher window resize events were previously silently ignored.
        // Log them so that if the launcher ever sends this IPC it's visible in logs.
        console.log(`[IPC] update-content-dimensions: launcher window resize request ${width}x${height} (ignored — launcher has fixed dimensions)`);
      }
    }
  )

  safeHandle("set-window-mode", async (event, mode: 'launcher' | 'overlay', inactive?: boolean) => {
    appState.getWindowHelper().setWindowMode(mode, inactive);
    return { success: true };
  })


  safeHandle("delete-screenshot", async (event, filePath: string) => {
    // Guard: only allow deletion of files within the app's own userData directory
    const userDataDir = app.getPath('userData');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(userDataDir + path.sep)) {
      console.warn('[IPC] delete-screenshot: path outside userData rejected:', filePath);
      return { success: false, error: 'Path not allowed' };
    }
    return appState.deleteScreenshot(resolved);
  })

  safeHandle("take-screenshot", async () => {
    try {
      const screenshotPath = await appState.takeScreenshot()
      const preview = await appState.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      console.error("Error taking screenshot:", error)
      throw error
    }
  })

  safeHandle("take-selective-screenshot", async () => {
    try {
      const screenshotPath = await appState.takeSelectiveScreenshot()
      const preview = await appState.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      // EC-04 fix: cast unknown error to Error before accessing .message
      if ((error as Error).message === "Selection cancelled") {
        return { cancelled: true }
      }
      throw error
    }
  })

  safeHandle("get-screenshots", async () => {
    // console.log({ view: appState.getView() })
    try {
      let previews = []
      if (appState.getView() === "queue") {
        previews = await Promise.all(
          appState.getScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      } else {
        previews = await Promise.all(
          appState.getExtraScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      }
      // previews.forEach((preview: any) => console.log(preview.path))
      return previews
    } catch (error) {
      // console.error("Error getting screenshots:", error)
      throw error
    }
  })

  safeHandle("toggle-window", async () => {
    appState.toggleMainWindow()
  })

  safeHandle("show-window", async (event, inactive?: boolean) => {
    // Default show main window (Launcher usually)
    appState.showMainWindow(inactive)
  })

  safeHandle("hide-window", async () => {
    appState.hideMainWindow()
  })

  safeHandle("show-overlay", async () => {
    appState.getWindowHelper().showOverlay();
  })

  safeHandle("hide-overlay", async () => {
    appState.getWindowHelper().hideOverlay();
  })

  safeHandle("get-meeting-active", async () => {
    return appState.getIsMeetingActive();
  })

  safeHandle("reset-queues", async () => {
    try {
      appState.clearQueues()
      // console.log("Screenshot queues have been cleared.")
      return { success: true }
    } catch (error: any) {
      // console.error("Error resetting queues:", error)
      return { success: false, error: error.message }
    }
  })

  // Donation IPC Handlers
  safeHandle("get-donation-status", async () => {
    const { DonationManager } = require('./DonationManager');
    const manager = DonationManager.getInstance();
    return {
      shouldShow: manager.shouldShowToaster(),
      hasDonated: manager.getDonationState().hasDonated,
      lifetimeShows: manager.getDonationState().lifetimeShows
    };
  });

  safeHandle("mark-donation-toast-shown", async () => {
    const { DonationManager } = require('./DonationManager');
    DonationManager.getInstance().markAsShown();
    return { success: true };
  });

  safeHandle("set-donation-complete", async () => {
    const { DonationManager } = require('./DonationManager');
    DonationManager.getInstance().setHasDonated(true);
    return { success: true };
  });

  // Generate suggestion from transcript - Natively-style text-only reasoning
  safeHandle("generate-suggestion", async (event, context: string, lastQuestion: string) => {
    try {
      const suggestion = await appState.processingHelper.getLLMHelper().generateSuggestion(context, lastQuestion)
      return { suggestion }
    } catch (error: any) {
      // console.error("Error generating suggestion:", error)
      throw error
    }
  })

  safeHandle("finalize-mic-stt", async () => {
    appState.finalizeMicSTT();
  });

  // IPC handler for analyzing image from file path
  safeHandle("analyze-image-file", async (event, filePath: string) => {
    // Guard: only allow reading files within the app's own userData directory
    const userDataDir = app.getPath('userData');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(userDataDir + path.sep)) {
      console.warn('[IPC] analyze-image-file: path outside userData rejected:', filePath);
      throw new Error('Path not allowed');
    }
    try {
      const result = await appState.processingHelper.getLLMHelper().analyzeImageFiles([resolved])
      return result
    } catch (error: any) {
      throw error
    }
  })

  safeHandle("gemini-chat", async (event, message: string, imagePaths?: string[], context?: string, options?: { skipSystemPrompt?: boolean }) => {
    try {
      // Own-company context from orchestrator (seller perspective)
      const ownCompanyBlock = buildOwnCompanyBlockFromOrchestrator(appState.getKnowledgeOrchestrator());
      // Prospect intelligence from Tavily (prospect perspective) — unchanged
      const prospectBlock = buildCompanyContextBlock(appState.getCompanyIntel());
      // Combine: own context first (highest priority), then prospect, then caller-supplied context
      let enrichedContext = context ?? '';
      if (prospectBlock) enrichedContext = prospectBlock + (enrichedContext ? '\n\n' + enrichedContext : '');
      if (ownCompanyBlock) enrichedContext = ownCompanyBlock + (enrichedContext ? '\n\n' + enrichedContext : '');
      const result = await appState.processingHelper.getLLMHelper().chatWithGemini(message, imagePaths, enrichedContext, options?.skipSystemPrompt);

      console.log(`[IPC] gemini - chat response: `, result ? result.substring(0, 50) : "(empty)");
      console.log("(gemini-chat) ownCompanyBlock: ", ownCompanyBlock);
      console.log("(gemini-chat) prospectBlock: ", prospectBlock);

      // Don't process empty responses
      if (!result || result.trim().length === 0) {
        console.warn("[IPC] Empty response from LLM, not updating IntelligenceManager");
        throw new Error("Empty response from LLM");
      }

      // // Don't process empty responses
      // if (!result || result.trim().length === 0) {
      //   console.warn("[IPC] Empty response from LLM, not updating IntelligenceManager");
      //   return "I apologize, but I couldn't generate a response. Please try again.";
      // }

      // Sync with IntelligenceManager so Follow-Up/Recap work
      const intelligenceManager = appState.getIntelligenceManager();

      // 1. Add user question to context (as 'user')
      // CRITICAL: Skip refinement check to prevent auto-triggering follow-up logic
      // The user's manual question is a NEW input, not a refinement of previous answer.
      intelligenceManager.addTranscript({
        text: message,
        speaker: 'user',
        timestamp: Date.now(),
        final: true,
        source: 'chat'
      }, true);

      // 2. Add assistant response and set as last message
      console.log(`[IPC] Updating IntelligenceManager with assistant message...`);
      intelligenceManager.addAssistantMessage(result);
      console.log(`[IPC] Updated IntelligenceManager.Last message: `, intelligenceManager.getLastAssistantMessage()?.substring(0, 50));

      // Log Usage
      intelligenceManager.logUsage('chat', message, result);

      return result;
    } catch (error: any) {
      // console.error("Error in gemini-chat handler:", error);
      throw error;
    }
  });

  // Streaming IPC Handler
  // SECURITY FIX (P0-1): Monotonic stream ID prevents interleaved tokens from concurrent stream requests.
  // Each new invocation increments the ID; any in-flight iteration bails as soon as it detects
  // that a newer stream has taken over.
  let _chatStreamId = 0;

  /**
   * Per-session Tavily dedup cache for gemini-chat-stream.
   * Key: lowercased entity name → in-flight or resolved Promise.
   * Mirrors the tavilyCache on IntelligenceEngine so rapid duplicate chat
   * messages never fire a second Tavily request for the same entity.
   * Cleared when the intelligence session resets (see "reset-intelligence" handler).
   */
  let _tavilyAllowedCompanies: Set<string> = new Set();

  safeHandle("gemini-chat-stream", async (event, message: string, imagePaths?: string[], context?: string, options?: { skipSystemPrompt?: boolean }) => {
    try {
      console.log("[IPC] gemini-chat-stream started using LLMHelper.streamChat");
      const llmHelper = appState.processingHelper.getLLMHelper();

      // Claim a new stream ID — any prior stream will detect this and stop emitting.
      const myStreamId = ++_chatStreamId;

      // Update IntelligenceManager with USER message immediately
      const intelligenceManager = appState.getIntelligenceManager();
      intelligenceManager.addTranscript({
        text: message,
        speaker: 'user',
        timestamp: Date.now(),
        final: true,
        source: 'chat'
      }, true);

      let fullResponse = "";

      // Own-company context (seller) — injected when knowledge mode is OFF.
      // When knowledge mode is ON, LLMHelper.streamChat calls processQuestion()
      // which builds a richer block (identity + retrieved asset chunks) internally.
      // Injecting the metadata-only block here on top would duplicate identity info
      // and push asset chunks further from the question in the context window.
      try {
        const orchestrator = appState.getKnowledgeOrchestrator();
        const knowledgeModeOn = orchestrator?.isKnowledgeMode?.() ?? false;
        if (!knowledgeModeOn) {
          const ownCompanyBlock = buildOwnCompanyBlockFromOrchestrator(orchestrator);
          if (ownCompanyBlock) {
            context = context ? `${ownCompanyBlock}\n\n${context}` : ownCompanyBlock;
          }
        }
        // Prospect intelligence (Tavily) — always injected regardless of knowledge mode
        const prospectBlock = buildCompanyContextBlock(appState.getCompanyIntel());
        if (prospectBlock) {
          context = context ? `${prospectBlock}\n\n${context}` : prospectBlock;
        }
        console.log("gemini-chat-stream context block: ", context);
      } catch (ctxErr) {
        console.warn("[IPC] Failed to inject company context:", ctxErr);
      }

      // Context Injection for "Answer" button (100s rolling window)
      if (!context) {
        try {
          const fullSessionContext = intelligenceManager.getFullSessionContext();
          if (fullSessionContext && fullSessionContext.trim().length > 0) {
            context = fullSessionContext;
            console.log(`[IPC] Auto-injected full session transcript for chat (${context.length} chars)`);
          } else {
            const autoContext = intelligenceManager.getFormattedContext(300);
            if (autoContext && autoContext.trim().length > 0) {
              context = autoContext;
              console.log(`[IPC] Auto-injected 300s context fallback for chat (${context.length} chars)`);
            }
          }
        } catch (ctxErr) {
          console.warn("[IPC] Failed to auto-inject transcript context:", ctxErr);
        }
      }

      try {
        // ── Tavily enrichment ────────────────────────────────────────────────────
        // Run intent detection synchronously (<1 ms). If the message is asking
        // about an external company/product, fetch live data and append a compact
        // context block BEFORE handing off to the LLM. Existing transcript context
        // is preserved — Tavily data is only appended, never replacing it.
        // Deduped per session: same entity within a session reuses the cached result.
        try {
          const intentResult = detectTavilyIntent(message, _tavilyAllowedCompanies);
          if (intentResult.needsExternalSearch && intentResult.searchQuery && intentResult.entityName) {
            event.sender.send('tavily-searching', { entity: intentResult.entityName });
            const state = await searchCompany(intentResult.searchQuery, intentResult.entityName);
            event.sender.send('tavily-search-done', { entity: intentResult.entityName, status: state.status, fromCache: state.data?.fromCache ?? false });
            if ((state.status === 'success' || state.status === 'cached') && state.data) {
              const companyBlock = buildCompanyContextBlock(state.data);
              context = context ? `${context}\n\n${companyBlock}` : companyBlock;
            } else {
              console.warn(`[IPC] Tavily fallback for "${intentResult.entityName}": ${state.message}`);
            }
          } else {
            console.log(`[IPC] Tavily skipped: ${intentResult.reason}`);
          }
        } catch (tavilyErr: any) {
          // Never let Tavily failure block the response — log and continue
          console.warn('[IPC] Tavily enrichment failed, proceeding without:', tavilyErr.message);
        }
        // ── End Tavily enrichment ────────────────────────────────────────────────

        // Inject inferred company names so the LLM knows the allowed scope
        if (_tavilyAllowedCompanies.size > 0) {
          const _companyList = [..._tavilyAllowedCompanies].join(", ");
          const _participantNote =
            "\n\n--- MEETING PARTICIPANTS (inferred companies from professional email domains) ---\n" +
            `Companies represented in this meeting: ${_companyList}\n` +
            "You may answer questions about these companies using any external context provided.\n" +
            "--- END PARTICIPANT INFO ---";
          context = context ? `${context}${_participantNote}` : _participantNote;
        }

        // USE streamChat which handles routing
        const stream = llmHelper.streamChat(message, imagePaths, context, options?.skipSystemPrompt ? "" : undefined);

        for await (const token of stream) {
          // Bail if a newer stream has taken over (user triggered a new request)
          if (_chatStreamId !== myStreamId) {
            console.log(`[IPC] gemini-chat-stream ${myStreamId} superseded by ${_chatStreamId}, stopping.`);
            return null;
          }
          event.sender.send("gemini-stream-token", token);
          fullResponse += token;
        }

        // Final check: only send done if we are still the active stream
        if (_chatStreamId === myStreamId) {
          event.sender.send("gemini-stream-done");

          // Update IntelligenceManager with ASSISTANT message after completion
          if (fullResponse.trim().length > 0) {
            intelligenceManager.addAssistantMessage(fullResponse);
            // Log Usage for streaming chat
            intelligenceManager.logUsage('chat', message, fullResponse);
          }
        }

      } catch (streamError: any) {
        console.error("[IPC] Streaming error:", streamError);
        if (_chatStreamId === myStreamId) {
          event.sender.send("gemini-stream-error", streamError.message || "Unknown streaming error");
        }
      }

      return null; // Return null as data is sent via events

    } catch (error: any) {
      console.error("[IPC] Error in gemini-chat-stream setup:", error);
      throw error;
    }
  });

  safeHandle("update-live-analysis", async (event, data: LiveAnalysisData) => {
    console.log('[IPC] Received live analysis:', Object.keys(data));
    // Normalize at the boundary — this payload is whatever the remote backend
    // returned, and every downstream consumer (summary prompt, reconcile, the
    // Call Analysis tab) previously trusted it structurally.
    appState.setCurrentLiveAnalysis(normalizeLiveAnalysisData(data));
    return { success: true };
  });

  safeHandle("set-live-analysis-in-flight", async (event, inFlight: boolean) => {
    appState.setLiveAnalysisInFlight(inFlight);
    return { success: true };
  });

  safeHandle("quit-app", () => {
    app.quit()
  })

  // Reload bypassing cache — same as Cmd/Ctrl+Shift+R via the app menu's
  // { role: 'forceReload' } items already in WindowHelper.ts/KeybindManager.ts.
  safeHandle("hard-refresh", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.reloadIgnoringCache();
    return { success: true };
  });

  safeHandle("quit-and-install-update", async () => {
    try {
      console.log('[IPC] Quit and install update requested')
      await appState.quitAndInstallUpdate()
      return { success: true }
    } catch (err: any) {
      console.error('[IPC] quit-and-install-update failed:', err)
      return { success: false, error: err.message }
    }
  })

  safeHandle("delete-meeting", async (_, id: string) => {
    return DatabaseManager.getInstance().deleteMeeting(id);
  });

  safeHandle("check-for-updates", async () => {
    // Updates are a production-only feature — electron-updater has no signed/
    // published feed to check against in a dev build, so refuse up front
    // instead of letting it silently no-op or hit a manual fallback.
    if (!app.isPackaged) {
      console.log('[IPC] check-for-updates ignored: running unpackaged (development)')
      return { success: false, error: 'Updates are disabled in development builds' }
    }
    try {
      console.log('[IPC] Manual update check requested')
      await appState.checkForUpdates()
      return { success: true }
    } catch (err: any) {
      console.error('[IPC] check-for-updates failed:', err)
      return { success: false, error: err.message }
    }
  })

  safeHandle("download-update", async () => {
    if (!app.isPackaged) {
      console.log('[IPC] download-update ignored: running unpackaged (development)')
      return { success: false, error: 'Updates are disabled in development builds' }
    }
    try {
      console.log('[IPC] Download update requested')
      appState.downloadUpdate()
      return { success: true }
    } catch (err: any) {
      console.error('[IPC] download-update failed:', err)
      return { success: false, error: err.message }
    }
  })

  safeHandle("get-app-version", async () => {
    return app.getVersion()
  })

  // Opens a small allow-listed set of folders in Finder/Explorer (e.g. for the
  // macOS manual-update instructions: "Open Downloads", "Open Applications").
  // Intentionally a fixed key -> path map rather than taking an arbitrary path
  // from the renderer, so this can't be used to open/reveal anything else.
  safeHandle("open-known-folder", async (event, key: 'downloads' | 'applications') => {
    const target = key === 'downloads' ? app.getPath('downloads') : '/Applications';
    try {
      await shell.openPath(target);
    } catch (err) {
      console.warn(`[IPC] Failed to open folder "${key}":`, err);
    }
  });

  // Lets the renderer distinguish a production/packaged build from a local
  // dev run so it can hide/disable the Updates UI accordingly, without
  // relying on process.env.NODE_ENV (unreliable inside Electron).
  safeHandle("is-app-packaged", async () => {
    return app.isPackaged
  })

  // Window movement handlers
  safeHandle("move-window-left", async () => {
    appState.moveWindowLeft()
  })

  safeHandle("move-window-right", async () => {
    appState.moveWindowRight()
  })

  safeHandle("move-window-up", async () => {
    appState.moveWindowUp()
  })

  safeHandle("move-window-down", async () => {
    appState.moveWindowDown()
  })

  safeHandle("center-and-show-window", async () => {
    appState.centerAndShowWindow()
  })

  // Window Controls
  safeHandle("window-minimize", async () => {
    appState.getWindowHelper().minimizeWindow();
  });

  safeHandle("window-maximize", async () => {
    appState.getWindowHelper().maximizeWindow();
  });

  safeHandle("window-close", async () => {
    appState.getWindowHelper().closeWindow();
  });

  safeHandle("window-is-maximized", async () => {
    return appState.getWindowHelper().isMainWindowMaximized();
  });

  // Settings Window
  safeHandle("toggle-settings-window", (event, { x, y } = {}) => {
    appState.settingsWindowHelper.toggleWindow(x, y)
  })

  safeHandle("close-settings-window", () => {
    appState.settingsWindowHelper.closeWindow()
  })



  safeHandle("set-undetectable", async (_, state: boolean) => {
    appState.setUndetectable(state)
    return { success: true }
  })

  safeHandle("set-disguise", async (_, mode: 'terminal' | 'settings' | 'activity' | 'none') => {
    appState.setDisguise(mode)
    return { success: true }
  })

  safeHandle("get-undetectable", async () => {
    return appState.getUndetectable()
  })

  // Adapted from public PR #113 — verify premium interaction
  safeHandle("set-overlay-mouse-passthrough", async (_, enabled: boolean) => {
    appState.setOverlayMousePassthrough(enabled)
    return { success: true }
  })

  safeHandle("toggle-overlay-mouse-passthrough", async () => {
    const enabled = appState.toggleOverlayMousePassthrough()
    return { success: true, enabled }
  })

  safeHandle("get-overlay-mouse-passthrough", async () => {
    return appState.getOverlayMousePassthrough()
  })

  safeHandle("get-disguise", async () => {
    return appState.getDisguise()
  })

  safeHandle("set-open-at-login", async (_, openAtLogin: boolean) => {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: false,
      path: app.getPath('exe') // Explicitly point to executable for production reliability
    });
    return { success: true };
  });

  safeHandle("get-open-at-login", async () => {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  });

  safeHandle("get-verbose-logging", async () => {
    return appState.getVerboseLogging();
  });

  safeHandle("set-verbose-logging", async (_, enabled: boolean) => {
    appState.setVerboseLogging(enabled);
    return { success: true };
  });

  safeHandle("get-arch", async () => {
    return process.arch;
  });

  // LLM Model Management Handlers
  safeHandle("get-current-llm-config", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return {
        provider: llmHelper.getCurrentProvider(),
        model: llmHelper.getCurrentModel(),
        isOllama: llmHelper.isUsingOllama()
      };
    } catch (error: any) {
      // console.error("Error getting current LLM config:", error);
      throw error;
    }
  });

  safeHandle("get-available-ollama-models", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      const models = await llmHelper.getOllamaModels();
      return models;
    } catch (error: any) {
      // console.error("Error getting Ollama models:", error);
      throw error;
    }
  });

  safeHandle("switch-to-ollama", async (_, model?: string, url?: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToOllama(model, url);
      return { success: true };
    } catch (error: any) {
      // console.error("Error switching to Ollama:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("force-restart-ollama", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      const success = await llmHelper.forceRestartOllama();
      return { success };
    } catch (error: any) {
      console.error("Error force restarting Ollama:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle('restart-ollama', async () => {
    try {
      // First try to kill it if it's running
      await appState.processingHelper.getLLMHelper().forceRestartOllama();

      // The forceRestartOllama now calls OllamaManager.getInstance().init() internally
      // so we don't need to do it again here.

      return true;
    } catch (error: any) {
      console.error("[IPC restart-ollama] Failed to restart:", error);
      return false;
    }
  });

  safeHandle("ensure-ollama-running", async () => {
    try {
      const { OllamaManager } = require('./services/OllamaManager');
      await OllamaManager.getInstance().init();
      return { success: true };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  });

  safeHandle("switch-to-gemini", async (_, apiKey?: string, modelId?: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToGemini(apiKey, modelId);

      // Persist API key if provided
      if (apiKey) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        CredentialsManager.getInstance().setGeminiApiKey(apiKey);
      }

      return { success: true };
    } catch (error: any) {
      // console.error("Error switching to Gemini:", error);
      return { success: false, error: error.message };
    }
  });

  // Dedicated API key setters (for Settings UI Save buttons)
  safeHandle("set-gemini-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGeminiApiKey(apiKey);

      // Also update the LLMHelper immediately
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setApiKey(apiKey);

      // CQ-06 fix: cancel any in-flight LLM stream before swapping LLM clients.
      // Use resetEngine() (NOT reset()) so session transcript is preserved mid-meeting.
      // initializeLLMs() now also calls engine.reset() internally for double-safety.
      appState.getIntelligenceManager().resetEngine();
      // Re-init IntelligenceManager
      appState.getIntelligenceManager().initializeLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error saving Gemini API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-groq-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGroqApiKey(apiKey);

      // Also update the LLMHelper immediately
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setGroqApiKey(apiKey);

      // CQ-06 fix: cancel in-flight stream before re-init (engine only, not session)
      appState.getIntelligenceManager().resetEngine();
      // Re-init IntelligenceManager
      appState.getIntelligenceManager().initializeLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error saving Groq API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-openai-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setOpenaiApiKey(apiKey);

      // Also update the LLMHelper immediately
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setOpenaiApiKey(apiKey);

      // CQ-06 fix: cancel in-flight stream before re-init (engine only, not session)
      appState.getIntelligenceManager().resetEngine();
      // Re-init IntelligenceManager
      appState.getIntelligenceManager().initializeLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error saving OpenAI API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-claude-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setClaudeApiKey(apiKey);

      // Also update the LLMHelper immediately
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setClaudeApiKey(apiKey);

      // CQ-06 fix: cancel in-flight stream before re-init (engine only, not session)
      appState.getIntelligenceManager().resetEngine();
      // Re-init IntelligenceManager
      appState.getIntelligenceManager().initializeLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error saving Claude API key:", error);
      return { success: false, error: error.message };
    }
  });

  // Custom Provider Handlers
  safeHandle("get-custom-providers", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      // Merge new Curl Providers with legacy Custom Providers
      // New ones take precedence if IDs conflict (though unlikely as UUIDs)
      const curlProviders = cm.getCurlProviders();
      const legacyProviders = cm.getCustomProviders() || [];
      return [...curlProviders, ...legacyProviders];
    } catch (error: any) {
      console.error("Error getting custom providers:", error);
      return [];
    }
  });

  safeHandle("save-custom-provider", async (_, provider: unknown) => {
    try {
      // SECURITY FIX (P1-2): Validate provider payload shape before persisting.
      // Prevents malformed/malicious renderer data from polluting CredentialsManager.
      if (
        typeof provider !== 'object' || provider === null ||
        typeof (provider as any).id !== 'string' ||
        typeof (provider as any).name !== 'string' ||
        typeof (provider as any).curlCommand !== 'string'
      ) {
        console.error('[IPC] save-custom-provider: invalid payload shape', typeof provider);
        return { success: false, error: 'Invalid provider payload' };
      }

      const curlCmd: string = (provider as any).curlCommand;
      // Require {{TEXT}} so the app always has a defined injection point for the user prompt.
      // We do NOT require the string to start with 'curl' — curlCommand is a template field,
      // not necessarily a raw CLI string, and over-constraining it would break valid providers.
      if (!curlCmd.includes('{{TEXT}}')) {
        return { success: false, error: 'curlCommand must contain {{TEXT}} placeholder for the prompt' };
      }

      const { CredentialsManager } = require('./services/CredentialsManager');
      // Save as CurlProvider (supports responsePath)
      CredentialsManager.getInstance().saveCurlProvider(provider);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving custom provider:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("delete-custom-provider", async (_, id: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      // Try deleting from both storages to be safe
      CredentialsManager.getInstance().deleteCurlProvider(id);
      CredentialsManager.getInstance().deleteCustomProvider(id);
      return { success: true };
    } catch (error: any) {
      console.error("Error deleting custom provider:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("switch-to-custom-provider", async (_, providerId: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      // BUG-05 fix: providers may be in either the curl or legacy custom store —
      // merge both when looking up by id so neither store is silently ignored.
      const provider = [
        ...(cm.getCurlProviders() || []),
        ...(cm.getCustomProviders() || [])
      ].find((p: any) => p.id === providerId);

      if (!provider) {
        throw new Error("Provider not found");
      }

      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToCustom(provider);

      // Re-init IntelligenceManager (optional, but good for consistency)
      appState.getIntelligenceManager().initializeLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error switching to custom provider:", error);
      return { success: false, error: error.message };
    }
  });


  // cURL Provider Handlers
  safeHandle("get-curl-providers", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      return CredentialsManager.getInstance().getCurlProviders();
    } catch (error: any) {
      console.error("Error getting curl providers:", error);
      return [];
    }
  });

  safeHandle("save-curl-provider", async (_, provider: any) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().saveCurlProvider(provider);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving curl provider:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("delete-curl-provider", async (_, id: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().deleteCurlProvider(id);
      return { success: true };
    } catch (error: any) {
      console.error("Error deleting curl provider:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("switch-to-curl-provider", async (_, providerId: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const provider = CredentialsManager.getInstance().getCurlProviders().find((p: any) => p.id === providerId);

      if (!provider) {
        throw new Error("Provider not found");
      }

      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToCurl(provider);

      // Re-init IntelligenceManager (optional, but good for consistency)
      appState.getIntelligenceManager().initializeLLMs();

      return { success: true };
    } catch (error: any) {
      console.error("Error switching to curl provider:", error);
      return { success: false, error: error.message };
    }
  });

  // Get stored API keys (masked for UI display)
  safeHandle("get-stored-credentials", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const creds = CredentialsManager.getInstance().getAllCredentials();

      // Return masked versions for security (just indicate if set)
      const hasKey = (key?: string) => !!(key && key.trim().length > 0);

      return {
        hasGeminiKey: hasKey(creds.geminiApiKey || process.env.GEMINI_API_KEY),
        hasGroqKey: hasKey(creds.groqApiKey || process.env.GROQ_API_KEY),
        hasOpenaiKey: hasKey(creds.openaiApiKey),
        hasClaudeKey: hasKey(creds.claudeApiKey),
        googleServiceAccountPath: creds.googleServiceAccountPath || null,
        sttProvider: creds.sttProvider || 'deepgram',
        groqSttModel: creds.groqSttModel || 'whisper-large-v3-turbo',
        hasSttGroqKey: hasKey(creds.groqSttApiKey),
        hasSttOpenaiKey: hasKey(creds.openAiSttApiKey),
        hasDeepgramKey: hasKey(creds.deepgramApiKey || process.env.DEEPGRAM_API_KEY),
        hasElevenLabsKey: hasKey(creds.elevenLabsApiKey),
        hasAzureKey: hasKey(creds.azureApiKey),
        azureRegion: creds.azureRegion || 'eastus',
        hasIbmWatsonKey: hasKey(creds.ibmWatsonApiKey),
        ibmWatsonRegion: creds.ibmWatsonRegion || 'us-south',
        hasSonioxKey: hasKey(creds.sonioxApiKey),
        hasTavilyKey: hasKey(creds.tavilyApiKey || process.env.TAVILY_API_KEY),
        // Dynamic Model Discovery - preferred models
        geminiPreferredModel: creds.geminiPreferredModel || undefined,
        groqPreferredModel: creds.groqPreferredModel || undefined,
        openaiPreferredModel: creds.openaiPreferredModel || undefined,
        claudePreferredModel: creds.claudePreferredModel || undefined,
      };
    } catch (error: any) {
      return { hasGeminiKey: process.env.GEMINI_API_KEY !== null, hasGroqKey: process.env.GROQ_API_KEY !== null, hasOpenaiKey: false, hasClaudeKey: false, googleServiceAccountPath: null, sttProvider: 'deepgram', groqSttModel: 'whisper-large-v3-turbo', hasSttGroqKey: false, hasSttOpenaiKey: false, hasDeepgramKey: process.env.DEEPGRAM_API_KEY !== null, hasElevenLabsKey: false, hasAzureKey: false, azureRegion: 'southeastasia', hasIbmWatsonKey: false, ibmWatsonRegion: 'us-south', hasSonioxKey: false, hasTavilyKey: process.env.TAVILY_API_KEY !== null };
    }
  });

  // ==========================================
  // Dynamic Model Discovery Handlers
  // ==========================================

  safeHandle("fetch-provider-models", async (_, provider: 'gemini' | 'groq' | 'openai' | 'claude', apiKey: string) => {
    try {
      // Fall back to stored key if no key was explicitly provided
      let key = apiKey?.trim();
      if (!key) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const cm = CredentialsManager.getInstance();
        if (provider === 'gemini') key = cm.getGeminiApiKey();
        else if (provider === 'groq') key = cm.getGroqApiKey();
        else if (provider === 'openai') key = cm.getOpenaiApiKey();
        else if (provider === 'claude') key = cm.getClaudeApiKey();
      }

      if (!key) {
        return { success: false, error: 'No API key available. Please save a key first.' };
      }

      const { fetchProviderModels } = require('./utils/modelFetcher');
      const models = await fetchProviderModels(provider, key);
      return { success: true, models };
    } catch (error: any) {
      console.error(`[IPC] Failed to fetch ${provider} models:`, error);
      const msg = error?.response?.data?.error?.message || error.message || 'Failed to fetch models';
      return { success: false, error: msg };
    }
  });

  safeHandle("set-provider-preferred-model", async (_, provider: 'gemini' | 'groq' | 'openai' | 'claude', modelId: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setPreferredModel(provider, modelId);
    } catch (error: any) {
      console.error(`[IPC] Failed to set preferred model for ${provider}:`, error);
    }
  });

  // ==========================================
  // STT Provider Management Handlers
  // ==========================================

  safeHandle("set-stt-provider", async (_, provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox') => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setSttProvider(provider);

      // Reconfigure the audio pipeline to use the new STT provider
      await appState.reconfigureSttProvider();

      return { success: true };
    } catch (error: any) {
      console.error("Error setting STT provider:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-stt-provider", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      return CredentialsManager.getInstance().getSttProvider();
    } catch (error: any) {
      return 'google';
    }
  });

  // Deepgram diarization on the far-end (client) stream — paid streaming add-on.
  safeHandle("set-diarize-client-enabled", async (_, enabled: boolean) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setDiarizeClientEnabled(!!enabled);
      // Rebuild both STT instances so the client connection picks up diarize.
      await appState.reconfigureSttProvider();
      return { success: true };
    } catch (error: any) {
      console.error("Error setting client diarization:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-diarize-client-enabled", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      return CredentialsManager.getInstance().getDiarizeClientEnabled();
    } catch {
      return false;
    }
  });

  // Render non-English transcript finals into English before display/storage.
  safeHandle("set-translate-transcripts", async (_, enabled: boolean) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setTranslateTranscriptsToEnglish(!!enabled);
      // Rebuild STT so the running meeting picks the change up immediately.
      await appState.reconfigureSttProvider();
      return { success: true };
    } catch (error: any) {
      console.error("Error setting transcript translation:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-translate-transcripts", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      return CredentialsManager.getInstance().getTranslateTranscriptsToEnglish();
    } catch {
      return true;
    }
  });

  // Echo pipeline mode for the native audio gate ('legacy' | 'phase1' | 'full_duplex').
  safeHandle("set-echo-pipeline-mode", async (_, mode: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setEchoPipelineMode(mode);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-echo-pipeline-mode", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      return CredentialsManager.getInstance().getEchoPipelineMode();
    } catch {
      return 'full_duplex';
    }
  });

  // Echo pipeline telemetry (ERLE, gate state, mute ratio) for a debug panel.
  safeHandle("get-audio-pipeline-stats", async () => {
    try {
      const { loadNativeModule } = require('./audio/nativeModuleLoader');
      const native = loadNativeModule();
      if (!native?.getAudioPipelineStats) return null;
      return JSON.parse(native.getAudioPipelineStats());
    } catch (error: any) {
      console.error("Error reading audio pipeline stats:", error);
      return null;
    }
  });

  // Current default output route classification (headphones/speakers).
  safeHandle("get-output-route", async () => {
    try {
      const { loadNativeModule } = require('./audio/nativeModuleLoader');
      const native = loadNativeModule();
      if (!native?.getOutputRoute) return null;
      return native.getOutputRoute();
    } catch {
      return null;
    }
  });

  safeHandle("set-groq-stt-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGroqSttApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Groq STT API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-openai-stt-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setOpenAiSttApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving OpenAI STT API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-deepgram-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setDeepgramApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Deepgram API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-groq-stt-model", async (_, model: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGroqSttModel(model);

      // Reconfigure the audio pipeline to use the new model
      await appState.reconfigureSttProvider();

      return { success: true };
    } catch (error: any) {
      console.error("Error setting Groq STT model:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-elevenlabs-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setElevenLabsApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving ElevenLabs API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-azure-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setAzureApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Azure API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-azure-region", async (_, region: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setAzureRegion(region);

      // Reconfigure the pipeline since region changes the endpoint URL
      await appState.reconfigureSttProvider();

      return { success: true };
    } catch (error: any) {
      console.error("Error setting Azure region:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-ibmwatson-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setIbmWatsonApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving IBM Watson API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-soniox-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setSonioxApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Soniox API key:", error);
      return { success: false, error: error.message };
    }
  });

  // Helper to sanitize error messages (remove API key references)
  const sanitizeErrorMessage = (msg: string): string => {
    // Remove patterns like ": sk-***...***" or ": sdasdada***...dwwC"
    return msg.replace(/:\s*[a-zA-Z0-9*]+\*+[a-zA-Z0-9*]+\.?$/g, '').trim();
  };

  safeHandle("test-stt-connection", async (_, provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox', apiKey: string, region?: string) => {
    console.log(`[IPC] Received test - stt - connection request for provider: ${provider} `);
    try {
      if (provider === 'deepgram') {
        // Test Deepgram via WebSocket connection
        const WebSocket = require('ws');
        return await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const url = 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1';
          const ws = new WebSocket(url, {
            headers: { Authorization: `Token ${apiKey} ` },
          });

          const timeout = setTimeout(() => {
            ws.close();
            resolve({ success: false, error: 'Connection timed out' });
          }, 15000);

          ws.on('open', () => {
            clearTimeout(timeout);
            try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { }
            ws.close();
            resolve({ success: true });
          });

          ws.on('error', (err: any) => {
            clearTimeout(timeout);
            resolve({ success: false, error: err.message || 'Connection failed' });
          });
        });
      }

      if (provider === 'soniox') {
        // Test Soniox via WebSocket connection
        const WebSocket = require('ws');
        return await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');

          const timeout = setTimeout(() => {
            ws.close();
            resolve({ success: false, error: 'Connection timed out' });
          }, 15000);

          ws.on('open', () => {
            // Send a minimal config to validate the API key
            ws.send(JSON.stringify({
              api_key: apiKey,
              model: 'stt-rt-v4',
              audio_format: 'pcm_s16le',
              sample_rate: 16000,
              num_channels: 1,
            }));
          });

          ws.on('message', (msg: any) => {
            clearTimeout(timeout);
            try {
              const res = JSON.parse(msg.toString());
              if (res.error_code) {
                resolve({ success: false, error: `${res.error_code}: ${res.error_message}` });
              } else {
                resolve({ success: true });
              }
            } catch {
              resolve({ success: true });
            }
            ws.close();
          });

          ws.on('error', (err: any) => {
            clearTimeout(timeout);
            resolve({ success: false, error: err.message || 'Connection failed' });
          });
        });
      }

      const axios = require('axios');
      const FormData = require('form-data');

      // Generate a tiny silent WAV (0.5s of silence at 16kHz mono 16-bit)
      const numSamples = 8000;
      const pcmData = Buffer.alloc(numSamples * 2);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(1, 22);
      wavHeader.writeUInt32LE(16000, 24);
      wavHeader.writeUInt32LE(32000, 28);
      wavHeader.writeUInt16LE(2, 32);
      wavHeader.writeUInt16LE(16, 34);
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);
      const testWav = Buffer.concat([wavHeader, pcmData]);

      if (provider === 'elevenlabs') {
        // ElevenLabs: Use /v1/voices to validate the API key (minimal scope required).
        // Scoped keys may lack speech_to_text or user_read but still be usable once permissions are added.
        try {
          await axios.get('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': apiKey },
            timeout: 10000,
          });
        } catch (elErr: any) {
          const elStatus = elErr?.response?.data?.detail?.status;
          // If the error is "invalid_api_key", the key itself is wrong — fail.
          // Any other error (missing permission, etc.) means the key IS valid, just possibly scoped.
          if (elStatus === 'invalid_api_key') {
            throw elErr;
          }
          // Key is valid but scoped — pass with a warning
          console.log('[IPC] ElevenLabs key is valid but may have restricted scopes. Saving key.');
        }
      } else if (provider === 'azure') {
        // Azure: raw binary with subscription key
        const azureRegion = region || 'eastus';
        await axios.post(
          `https://${azureRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`,
          testWav,
          {
            headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'Content-Type': 'audio/wav' },
            timeout: 15000,
          }
        );
      } else if (provider === 'ibmwatson') {
        // IBM Watson: raw binary with Basic auth
        const ibmRegion = region || 'us-south';
        await axios.post(
          `https://api.${ibmRegion}.speech-to-text.watson.cloud.ibm.com/v1/recognize`,
          testWav,
          {
            headers: {
              Authorization: `Basic ${Buffer.from(`apikey:${apiKey}`).toString('base64')}`,
              'Content-Type': 'audio/wav',
            },
            timeout: 15000,
          }
        );
      } else {
        // Groq / OpenAI: multipart FormData
        const endpoint = provider === 'groq'
          ? 'https://api.groq.com/openai/v1/audio/transcriptions'
          : 'https://api.openai.com/v1/audio/transcriptions';
        const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

        const form = new FormData();
        form.append('file', testWav, { filename: 'test.wav', contentType: 'audio/wav' });
        form.append('model', model);

        await axios.post(endpoint, form, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...form.getHeaders(),
          },
          timeout: 15000,
        });
      }

      return { success: true };
    } catch (error: any) {
      const respData = error?.response?.data;
      const rawMsg = respData?.error?.message || respData?.detail?.message || respData?.message || error.message || 'Connection failed';
      const msg = sanitizeErrorMessage(rawMsg);
      console.error("STT connection test failed:", msg);
      return { success: false, error: msg };
    }
  });

  safeHandle("test-llm-connection", async (_, provider: 'gemini' | 'groq' | 'openai' | 'claude', apiKey?: string) => {
    console.log(`[IPC] Received test-llm-connection request for provider: ${provider}`);
    try {
      if (!apiKey || !apiKey.trim()) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const creds = CredentialsManager.getInstance();
        if (provider === 'gemini') apiKey = creds.getGeminiApiKey();
        else if (provider === 'groq') apiKey = creds.getGroqApiKey();
        else if (provider === 'openai') apiKey = creds.getOpenaiApiKey();
        else if (provider === 'claude') apiKey = creds.getClaudeApiKey();
      }

      if (!apiKey || !apiKey.trim()) {
        return { success: false, error: 'No API key provided' };
      }

      const axios = require('axios');
      let response;

      if (provider === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent`;
        response = await axios.post(url, {
          contents: [{ parts: [{ text: "Hello" }] }]
        }, {
          headers: { 'x-goog-api-key': apiKey },
          timeout: 15000
        });
      } else if (provider === 'groq') {
        response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: "Hello" }]
        }, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 15000
        });
      } else if (provider === 'openai') {
        response = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Hello" }]
        }, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 15000
        });
      } else if (provider === 'claude') {
        response = await axios.post('https://api.anthropic.com/v1/messages', {
          model: "claude-sonnet-4-6",
          max_tokens: 10,
          messages: [{ role: "user", content: "Hello" }]
        }, {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          timeout: 15000
        });
      }

      if (response && (response.status === 200 || response.status === 201)) {
        return { success: true };
      } else {
        return { success: false, error: 'Request failed with status ' + response?.status };
      }

    } catch (error: any) {
      console.error("LLM connection test failed:", error);
      const rawMsg = error?.response?.data?.error?.message || error?.response?.data?.message || (error.response?.data?.error?.type ? `${error.response.data.error.type}: ${error.response.data.error.message}` : error.message) || 'Connection failed';
      const msg = sanitizeErrorMessage(rawMsg);
      return { success: false, error: msg };
    }
  });

  safeHandle("get-groq-fast-text-mode", () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return { enabled: llmHelper.getGroqFastTextMode() };
    } catch (error: any) {
      return { enabled: false };
    }
  });

  // Set Groq Fast Text Mode
  safeHandle("set-groq-fast-text-mode", (_, enabled: boolean) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setGroqFastTextMode(enabled);

      // Broadcast to all windows
      BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('groq-fast-text-changed', enabled);
      });

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-model", async (_, modelId: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();

      // Get all providers (Curl + Custom)
      const curlProviders = cm.getCurlProviders();
      const legacyProviders = cm.getCustomProviders() || [];
      const allProviders = [...curlProviders, ...legacyProviders];

      llmHelper.setModel(modelId, allProviders);

      // Close the selector window if open
      appState.modelSelectorWindowHelper.hideWindow();

      // Broadcast to all windows so NativelyInterface can update its selector (session-only update)
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('model-changed', modelId);
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error("Error setting model:", error);
      return { success: false, error: error.message };
    }
  });

  // Persist default model (from Settings) + update runtime + broadcast to all windows
  safeHandle("set-default-model", async (_, modelId: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      cm.setDefaultModel(modelId);

      // Also update the runtime model
      const llmHelper = appState.processingHelper.getLLMHelper();
      const curlProviders = cm.getCurlProviders();
      const legacyProviders = cm.getCustomProviders() || [];
      const allProviders = [...curlProviders, ...legacyProviders];
      llmHelper.setModel(modelId, allProviders);

      // Close the selector window if open
      appState.modelSelectorWindowHelper.hideWindow();

      // Broadcast to all windows so NativelyInterface can update its selector
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('model-changed', modelId);
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error("Error setting default model:", error);
      return { success: false, error: error.message };
    }
  });

  // Read the persisted default model
  safeHandle("get-default-model", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      return { model: cm.getDefaultModel() };
    } catch (error: any) {
      console.error("Error getting default model:", error);
      return { model: 'gemini-3.1-flash-lite-preview' };
    }
  });

  // --- Model Selector Window IPC ---

  safeHandle("show-model-selector", (_, coords: { x: number; y: number }) => {
    appState.modelSelectorWindowHelper.showWindow(coords.x, coords.y);
  });

  safeHandle("hide-model-selector", () => {
    appState.modelSelectorWindowHelper.hideWindow();
  });

  safeHandle("toggle-model-selector", (_, coords: { x: number; y: number }) => {
    appState.modelSelectorWindowHelper.toggleWindow(coords.x, coords.y);
  });



  // Native Audio Service Handlers
  // Native Audio handlers removed as part of migration to driverless architecture
  safeHandle("native-audio-status", async () => {
    // Always return true or pseudo-status since it's "driverless"
    return { connected: true };
  });

  safeHandle("get-input-devices", async () => {
    return AudioDevices.getInputDevices();
  });

  safeHandle("get-output-devices", async () => {
    return AudioDevices.getOutputDevices();
  });

  safeHandle("start-audio-test", async (event, deviceId?: string) => {
    await appState.startAudioTest(deviceId);
    return { success: true };
  });

  safeHandle("stop-audio-test", async () => {
    appState.stopAudioTest();
    return { success: true };
  });

  safeHandle("set-recognition-language", async (_, key: string) => {
    appState.setRecognitionLanguage(key);
    return { success: true };
  });

  // ==========================================
  // Meeting Lifecycle Handlers
  // ==========================================

  safeHandle("start-meeting", async (event, metadata?: any) => {
    try {
      await appState.startMeeting(metadata);
      if (metadata?.attendees) {
        const selfEmail = metadata.attendees.find((a: any) => a.self)?.email;
        _tavilyAllowedCompanies = extractAllowedCompaniesFromAttendees(metadata.attendees, selfEmail);
      } else {
        _tavilyAllowedCompanies = new Set();
      }
      return { success: true };
    } catch (error: any) {
      console.error("Error starting meeting:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("end-meeting", async (_, payload?: { meetingTypes?: ('discovery' | 'demo' | 'negotiation')[], tenantId?: string | null }) => {
    try {
      const meetingId = await appState.endMeeting(payload?.meetingTypes, payload?.tenantId);
      return { success: true, meetingId };
    } catch (error: any) {
      console.error("Error ending meeting:", error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Pending Live-Chat Interaction Ids
  // ==========================================
  safeHandle("live-chat:save-pending-interactions", async (_, meetingId: string, interactionIds: number[]) => {
    try {
      PendingLiveChatStore.getInstance().save(meetingId, interactionIds);
      return { success: true };
    } catch (error: any) {
      console.error("Error saving pending live chat interactions:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("live-chat:get-pending-interactions", async (_, meetingId: string) => {
    try {
      return PendingLiveChatStore.getInstance().getPending(meetingId);
    } catch (error: any) {
      console.error("Error reading pending live chat interactions:", error);
      return [];
    }
  });

  safeHandle("live-chat:clear-pending-interactions", async (_, meetingId: string) => {
    try {
      PendingLiveChatStore.getInstance().clearPending(meetingId);
      return { success: true };
    } catch (error: any) {
      console.error("Error clearing pending live chat interactions:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("live-chat:get-all-pending-meeting-ids", async () => {
    try {
      return PendingLiveChatStore.getInstance().getAllPendingMeetingIds();
    } catch (error: any) {
      console.error("Error reading all pending live chat meeting ids:", error);
      return [];
    }
  });

  safeHandle("pause-meeting", async () => {
    try {
      appState.pauseMeeting();
      return { success: true };
    } catch (error: any) {
      console.error("Error pausing meeting:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("resume-meeting", async () => {
    try {
      await appState.resumeMeeting();
      return { success: true };
    } catch (error: any) {
      console.error("Error resuming meeting:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-meeting-paused", async () => {
    return appState.getIsMeetingPaused();
  });

  safeHandle("get-recent-meetings", async () => {
    if (SupabaseReadService.isAvailable()) {
      try {
        return await SupabaseReadService.getRecentMeetings(50);
      } catch (e) {
        console.warn('[ipc] get-recent-meetings: Supabase failed, falling back to SQLite:', e);
      }
    }
    return DatabaseManager.getInstance().getRecentMeetings(50);
  });

  // Add this handler
  safeHandle("get-display-name", async (_, role: 'user' | 'client' | 'assistant') => {
    const intelligenceManager = appState.getIntelligenceManager();
    return intelligenceManager.getDisplayNameForSpeaker(role);
  });

  safeHandle("get-meeting-details", async (event, id) => {
    if (SupabaseReadService.isAvailable()) {
      try {
        return await SupabaseReadService.getMeetingDetails(id);
      } catch (e) {
        console.warn('[ipc] get-meeting-details: Supabase failed, falling back to SQLite:', e);
      }
    }
    return DatabaseManager.getInstance().getMeetingDetails(id);
  });

  safeHandle("update-meeting-title", async (_, { id, title }: { id: string; title: string }) => {
    return DatabaseManager.getInstance().updateMeetingTitle(id, title);
  });

  safeHandle("update-meeting-summary", async (_, { id, updates }: { id: string; updates: any }) => {
    return DatabaseManager.getInstance().updateMeetingSummary(id, updates);
  });

  safeHandle("regenerate-meeting-summary", async (_, { id }: { id: string }) => {

    try {

      const success = await appState.getIntelligenceManager().regenerateSummary(id);
      if (success) {
        // Return the fresh meeting data so UI can update immediately.
        // Use the same Supabase-aware path as get-meeting-details so that the
        // scorecard (and all other fields) are populated correctly regardless of
        // whether Supabase or SQLite is the active read source.

        const updated = DatabaseManager.getInstance().getMeetingDetails(id);

        // let updated: any = null;
        // if (SupabaseReadService.isAvailable()) {
        //   try {
        //     updated = await SupabaseReadService.getMeetingDetails(id); // ← try Supabase first
        //   } catch (e) {
        //     console.warn('[ipcHandlers] regenerate-meeting-summary: Supabase fetch failed, falling back to SQLite:', e);
        //   }
        // }
        // if (!updated) {
        //   updated = DatabaseManager.getInstance().getMeetingDetails(id); // ← SQLite fallback
        // }
        return { success: true, meeting: updated };
      }
      return { success: false };
    } catch (e: any) {

      console.error('[ipcHandlers] regenerate-meeting-summary error:', e);
      return { success: false, error: e?.message || String(e) };

    }

  });

  safeHandle("update-speaker-names", async (_, names: { user: string; client: string }) => {
    const intelligenceManager = appState.getIntelligenceManager();
    // Need to add method to update speaker names in SessionTracker
    (intelligenceManager as any).updateSpeakerNames?.(names);

    // Broadcast to all windows
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('speaker-names-resolved', names);
      }
    });
    return { success: true };
  });

  safeHandle("upload-transcript", async (_, { text, title, meetingTypes }: { text: string; title?: string; meetingTypes?: ('discovery' | 'demo' | 'negotiation')[] }) => {
    try {
      const meetingId = await appState.getIntelligenceManager().uploadTranscript(text, title, meetingTypes);
      if (meetingId) return { success: true, meetingId };
      return { success: false, error: 'Transcript too short or could not be parsed' };
    } catch (e) {
      console.error('[ipcHandlers] upload-transcript error:', e);
      return { success: false, error: String(e) };
    }
  });

  safeHandle("get-speaker-names", async () => {
    return appState.getIntelligenceManager().getSpeakerNameMap?.()
      ?? { user: 'Me', client: 'Them' };
  });

  safeHandle("seed-demo", async () => {
    DatabaseManager.getInstance().seedDemoMeeting();

    // Ensure RAG embeddings exist for the demo meeting.
    // Use ensureDemoMeetingProcessed so we skip if already embedded
    // (avoids re-clearing 14 queue items on every app launch once processed).
    const ragManager = appState.getRAGManager();
    if (ragManager && ragManager.isReady()) {
      ragManager.ensureDemoMeetingProcessed().catch(console.error);
    }

    return { success: true };
  });

  safeHandle("flush-database", async () => {
    const result = DatabaseManager.getInstance().clearAllData();
    return { success: result };
  });

  safeHandle("open-external", async (event, url: string) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        await shell.openExternal(url);
      } else {
        console.warn(`[IPC] Blocked potentially unsafe open-external: ${url}`);
      }
    } catch {
      console.warn(`[IPC] Invalid URL in open-external: ${url}`);
    }
  });

  // ==========================================
  // Intelligence Mode Handlers
  // ==========================================

  // MODE 1: Assist (Passive observation)
  safeHandle("generate-assist", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const insight = await intelligenceManager.runAssistMode();
      return { insight };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 2: What Should I Say (Primary auto-answer)
  safeHandle("generate-what-to-say", async (_, question?: string, imagePaths?: string[]) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      // Question and imagePaths are now optional - IntelligenceManager infers from transcript
      const answer = await intelligenceManager.runWhatShouldISay(question, 0.8, imagePaths);
      return { answer, question: question || 'inferred from context' };
    } catch (error: any) {
      // Return graceful fallback instead of throwing
      return {
        question: question || 'unknown'
      };
    }
  });

  safeHandle("generate-what-am-i-missing", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const missingInfo = await intelligenceManager.runWhatAmIMissing();
      return { missingInfo };
    } catch (error: any) {
      throw error;
    }
  });

  safeHandle("generate-discovery", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const discoveryInfo = await intelligenceManager.runDiscovery();
      return { discoveryInfo };
    } catch (error: any) {
      throw error;
    }
  });

  safeHandle("generate-objection-handler", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const objectionInfo = await intelligenceManager.runObjectionHandler();
      return { objectionInfo };
    } catch (error: any) {
      throw error;
    }
  });

  safeHandle("generate-clarify", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const clarification = await intelligenceManager.runClarify();
      // If null returned without throwing, the engine already set mode to idle.
      // We must still ensure the frontend un-sticks — emit an error so onIntelligenceError fires.
      if (clarification === null) {
        const win = appState.getMainWindow();
        win?.webContents.send('intelligence-error', { error: 'Could not generate a clarifying question. Try again after some audio context is available.', mode: 'clarify' });
      }
      return { clarification };
    } catch (error: any) {
      throw error;
    }
  });

  safeHandle("generate-code-hint", async (_, imagePaths?: string[], problemStatement?: string) => {
    try {
      // If no explicit images were passed from the frontend, fall back to the
      // screenshot queue so the AI can always "see" the user's screen.
      const resolvedImagePaths: string[] =
        imagePaths && imagePaths.length > 0
          ? imagePaths
          : appState.getScreenshotQueue();

      console.log(`[IPC] generate-code-hint: using ${resolvedImagePaths.length} image(s) (${imagePaths?.length ? 'explicit' : 'queue fallback'})`);

      const intelligenceManager = appState.getIntelligenceManager();
      const hint = await intelligenceManager.runCodeHint(
        resolvedImagePaths.length > 0 ? resolvedImagePaths : undefined,
        problemStatement
      );
      return { hint };
    } catch (error: any) {
      throw error;
    }
  });

  safeHandle("generate-brainstorm", async (_, imagePaths?: string[], problemStatement?: string) => {
    try {
      // If no explicit images were passed from the frontend, fall back to the
      // screenshot queue so the AI can always "see" the user's screen.
      const resolvedImagePaths: string[] =
        imagePaths && imagePaths.length > 0
          ? imagePaths
          : appState.getScreenshotQueue();

      console.log(`[IPC] generate-brainstorm: using ${resolvedImagePaths.length} image(s) (${imagePaths?.length ? 'explicit' : 'queue fallback'})`);

      const intelligenceManager = appState.getIntelligenceManager();
      const script = await intelligenceManager.runBrainstorm(
        resolvedImagePaths.length > 0 ? resolvedImagePaths : undefined,
        problemStatement
      );
      return { script };
    } catch (error: any) {
      throw error;
    }
  });

  // Dynamic Action Button Mode (Recap vs Brainstorm)
  safeHandle("get-action-button-mode", () => {
    const { SettingsManager } = require('./services/SettingsManager');
    const sm = SettingsManager.getInstance();
    return sm.get('actionButtonMode') ?? 'recap';
  });

  safeHandle("set-action-button-mode", (_, mode: 'recap' | 'brainstorm') => {
    const { SettingsManager } = require('./services/SettingsManager');
    const sm = SettingsManager.getInstance();
    sm.set('actionButtonMode', mode);

    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('action-button-mode-changed', mode);
      }
    });

    return { success: true };
  });

  // MODE 3: Follow-Up (Refinement)
  safeHandle("generate-follow-up", async (_, intent: string, userRequest?: string) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const refined = await intelligenceManager.runFollowUp(intent, userRequest);
      return { refined, intent };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 4: Recap (Summary)
  safeHandle("generate-recap", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const summary = await intelligenceManager.runRecap();
      return { summary };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 6: Follow-Up Questions
  safeHandle("generate-follow-up-questions", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const questions = await intelligenceManager.runFollowUpQuestions();
      return { questions };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 5: Manual Answer (Fallback)
  safeHandle("submit-manual-question", async (_, question: string) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const answer = await intelligenceManager.runManualAnswer(question);
      return { answer, question };
    } catch (error: any) {
      throw error;
    }
  });

  // Get current intelligence context
  safeHandle("get-intelligence-context", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      return {
        context: intelligenceManager.getFormattedContext(),
        lastAssistantMessage: intelligenceManager.getLastAssistantMessage(),
        activeMode: intelligenceManager.getActiveMode()
      };
    } catch (error: any) {
      throw error;
    }
  });

  // Reset intelligence state
  safeHandle("reset-intelligence", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      intelligenceManager.reset();
      // Also clear the IPC-layer Tavily cache so a new session fetches fresh data
      clearCompanyCache();
      _tavilyAllowedCompanies = new Set();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });


  // Service Account Selection
  safeHandle("select-service-account", async () => {
    try {
      const result: any = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
      }

      const filePath = result.filePaths[0];

      // Update backend state immediately
      appState.updateGoogleCredentials(filePath);

      // Persist the path for future sessions
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGoogleServiceAccountPath(filePath);

      return { success: true, path: filePath };
    } catch (error: any) {
      console.error("Error selecting service account:", error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Theme System Handlers
  // ==========================================

  safeHandle("theme:get-mode", () => {
    const tm = appState.getThemeManager();
    return {
      mode: tm.getMode(),
      resolved: tm.getResolvedTheme()
    };
  });

  safeHandle("theme:set-mode", (_, mode: 'system' | 'light' | 'dark') => {
    appState.getThemeManager().setMode(mode);
    return { success: true };
  });

  // ==========================================
  // Calendar Integration Handlers
  // ==========================================

  safeHandle("calendar-connect", async () => {
    try {
      const { CalendarManager } = require('./services/CalendarManager');
      await CalendarManager.getInstance().startAuthFlow();
      return { success: true };
    } catch (error: any) {
      console.error("Calendar auth error:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("calendar-disconnect", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    await CalendarManager.getInstance().disconnect();
    return { success: true };
  });

  safeHandle("get-calendar-status", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    return CalendarManager.getInstance().getConnectionStatus();
  });

  safeHandle("get-upcoming-events", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    const { ZoomCalendarManager } = require('./services/ZoomCalendarManager');

    const [google, zoom] = await Promise.all([
      CalendarManager.getInstance().getUpcomingEvents(),
      ZoomCalendarManager.getInstance().getUpcomingEvents(),
    ]);

    return [...google, ...zoom].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );

  });

  safeHandle("calendar-refresh", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    await CalendarManager.getInstance().refreshState();
    return { success: true };
  });

  // ==========================================
  // Zoom Calendar Integration Handlers
  // ==========================================

  safeHandle("zoom-calendar-connect", async () => {
    try {
      const { ZoomCalendarManager } = require('./services/ZoomCalendarManager');
      await ZoomCalendarManager.getInstance().startAuthFlow();
      return { success: true };
    } catch (error) {
      console.error("Zoom Calendar auth error:", error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle("zoom-calendar-disconnect", async () => {
    const { ZoomCalendarManager } = require('./services/ZoomCalendarManager');
    await ZoomCalendarManager.getInstance().disconnect();
    return { success: true };
  });

  safeHandle("get-zoom-calendar-status", async () => {
    const { ZoomCalendarManager } = require('./services/ZoomCalendarManager');
    return ZoomCalendarManager.getInstance().getConnectionStatus();
  });

  safeHandle("get-zoom-upcoming-events", async () => {
    const { ZoomCalendarManager } = require('./services/ZoomCalendarManager');
    return ZoomCalendarManager.getInstance().getUpcomingEvents();
  });

  safeHandle("zoom-calendar-refresh", async () => {
    const { ZoomCalendarManager } = require('./services/ZoomCalendarManager');
    await ZoomCalendarManager.getInstance().refreshState();
    return { success: true };
  });


  // ==========================================
  // Sales Meeting Brief Handler (Streaming + Cached)
  // ==========================================

  const salesBriefCache = new Map<string, string>();
  let _salesBriefStreamId = 0;

  safeHandle("stream-sales-brief", async (event, eventData: any) => {
    try {
      const { SALES_MEETING_BRIEF_PROMPT, GROQ_SALES_MEETING_BRIEF_PROMPT } = require('./llm/prompts');
      const { buildSalesBriefContext } = require('./utils/salesBriefUtils');

      const eventId = eventData.id;

      // 1. Cache hit → instant return
      if (salesBriefCache.has(eventId)) {
        event.sender.send('sales-brief-stream-token', salesBriefCache.get(eventId)!);
        event.sender.send('sales-brief-stream-done');
        return { success: true, cached: true };
      }

      // 2. Build prompt
      const contextString = buildSalesBriefContext(eventData);
      const userMessage = `Generate a complete sales meeting brief for this meeting:\n\n${contextString}`;

      console.log("Sales Brief PRMOPT: ", userMessage);

      const llmHelper = appState.processingHelper.getLLMHelper();
      const myStreamId = ++_salesBriefStreamId;
      let fullResponse = '';

      // 3. Try streaming first (fastest path)
      try {
        const stream = llmHelper.streamChat(userMessage, undefined, undefined, SALES_MEETING_BRIEF_PROMPT, true);

        for await (const token of stream) {
          if (_salesBriefStreamId !== myStreamId) return null;
          event.sender.send('sales-brief-stream-token', token);
          fullResponse += token;
        }
      } catch (streamErr: any) {
        console.warn('[IPC] Sales brief stream failed, falling back to non-streaming:', streamErr.message);

        // 4. Fallback: chatWithGemini has full retry + provider rotation (handles 503)
        if (_salesBriefStreamId === myStreamId && !fullResponse) {
          const geminiPrompt = `${SALES_MEETING_BRIEF_PROMPT}\n\n${userMessage}`;
          const groqPrompt = `${GROQ_SALES_MEETING_BRIEF_PROMPT}\n\n${userMessage}`;
          const result = await llmHelper.chatWithGemini(geminiPrompt, undefined, undefined, true, groqPrompt);
          if (result && _salesBriefStreamId === myStreamId) {
            event.sender.send('sales-brief-stream-token', result);
            fullResponse = result;
          }
        }
      }

      if (_salesBriefStreamId === myStreamId) {
        event.sender.send('sales-brief-stream-done');
        if (fullResponse.trim()) salesBriefCache.set(eventId, fullResponse);
      }
      return { success: true };
    } catch (error: any) {
      console.error('[IPC] Error streaming sales brief:', error);
      event.sender.send('sales-brief-stream-error', error.message || 'Unknown error');
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Company Intelligence (Sales Brief v2)
  // ==========================================

  safeHandle("fetch-company-intel", async (_, payload: { companyName: string; domain?: string; forceRefresh?: boolean }) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      const tavilyApiKey = cm.getTavilyApiKey();

      if (!tavilyApiKey) {
        return { success: false, error: 'No Tavily API key configured. Add one in Settings → AI Providers.' };
      }

      const { companyName, domain, forceRefresh = false } = payload;

      // ── Persistence: return cached intel unless forceRefresh ─────────────
      const cacheKey = `company_intel:${(domain || companyName).toLowerCase()}`;
      const db = DatabaseManager.getInstance();
      if (!forceRefresh) {
        const cached = db.getAppState(cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            console.log(`[IPC] fetch-company-intel: returning cached intel for "${companyName}"`);
            return { success: true, intel: parsed, fromCache: true };
          } catch {
            // corrupt cache — fall through to fresh fetch
            db.deleteAppState(cacheKey);
          }
        }
      }

      // Run parallel Tavily searches for different intel categories
      const tavilySearch = async (query: string, maxResults = 4): Promise<any[]> => {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tavilyApiKey}` },
          body: JSON.stringify({
            query,
            max_results: maxResults,
            search_depth: 'advanced',   // advanced depth gives higher-quality, more specific results
            include_answer: true,
            include_domains: domain ? [domain] : [],  // bias results toward the known domain when available
          }),
        });
        if (!res.ok) throw new Error(`Tavily error: ${res.status}`);
        const data = await res.json() as any;
        return data.results || [];
      };

      // When a domain is known, anchor every query to it so same-name companies
      // from different industries cannot bleed into the results.
      const domainAnchor = domain ? `"${domain}"` : `"${companyName}"`;
      const nameAndDomain = domain ? `"${companyName}" ${domain}` : `"${companyName}"`;

      const linkedinSlug = domain ? domain.split('.')[0] : companyName.toLowerCase().replace(/\s+/g, '-');
      const linkedinQuery = `site:linkedin.com/company ${linkedinSlug} "${companyName}"`;

      const [overviewResults, fundingResults, newsResults, leadershipResults, competitorResults, linkedinResults] = await Promise.allSettled([
        tavilySearch(`${nameAndDomain} company overview founded headquarters employees industry`),
        tavilySearch(`${nameAndDomain} funding valuation investors series revenue`),
        tavilySearch(`${nameAndDomain} latest news announcements 2024 2025`, 5),
        tavilySearch(`${nameAndDomain} leadership CEO CRO CMO executive team`),
        tavilySearch(`${nameAndDomain} competitors alternative products market`, 5),
        tavilySearch(linkedinQuery, 2),
      ]);

      const extract = (r: PromiseSettledResult<any[]>) => r.status === 'fulfilled' ? r.value : [];

      // Extract the LinkedIn company URL from results if found
      const linkedinHits = extract(linkedinResults);
      const linkedinPageUrl = linkedinHits
        .map((r: any) => r.url as string)
        .find((u: string) => u?.includes('linkedin.com/company/')) || null;

      // Aggregate all snippets and pass to LLM for structured extraction
      const linkedinSnippets = extract(linkedinResults).map((r: any) => r.content || r.snippet || '').filter(Boolean);

      // Format each result as "[SOURCE: url]\ncontent" so the LLM can judge
      // whether a snippet actually refers to the target company.
      const formatResults = (results: any[]) =>
        results
          .filter((r: any) => (r.content || r.snippet || '').trim())
          .map((r: any) => `[SOURCE: ${r.url || 'unknown'}]\n${(r.content || r.snippet || '').trim()}`)
          .join('\n\n');

      const allSnippets = [
        '=== GENERAL OVERVIEW ===',
        formatResults(extract(overviewResults)),
        '=== FUNDING & FINANCIALS ===',
        formatResults(extract(fundingResults)),
        '=== RECENT NEWS ===',
        formatResults(extract(newsResults)),
        '=== LEADERSHIP ===',
        formatResults(extract(leadershipResults)),
        '=== COMPETITORS & MARKET ===',
        formatResults(extract(competitorResults)),
        ...(extract(linkedinResults).length
          ? ['=== LINKEDIN (authoritative for headcount, description, founding year) ===',
            formatResults(extract(linkedinResults))]
          : []),
      ].filter(Boolean).join('\n\n---\n\n');

      const llmHelper = appState.processingHelper.getLLMHelper();

      const extractionPrompt = `You are a company research analyst. Extract structured intelligence ONLY about the specific company identified below. Return ONLY a valid JSON object — no markdown, no explanation.

      TARGET COMPANY: ${companyName}${domain ? `\nTARGET WEBSITE/DOMAIN: ${domain}` : ''}
      
      CRITICAL DISAMBIGUATION RULES (read before processing):
      1. Many companies share similar names. Every data point you extract MUST be verifiable from a snippet whose [SOURCE] URL belongs to ${domain ? `"${domain}"` : `"${companyName}"`} or a known authority (LinkedIn, Crunchbase, Bloomberg, TechCrunch, Reuters, etc.) that explicitly mentions ${companyName}${domain ? ` or ${domain}` : ''}.
      2. If a snippet's source domain does not match and does not clearly reference the TARGET company by full name, IGNORE that snippet entirely — do not extract from it.
      3. For "competitors": list only companies that are described as direct competitors TO ${companyName} in the snippets. Do NOT list companies that merely appear in the same snippet by coincidence. If no competitors can be confirmed, return null.
      4. For "recentNews": include only headlines that are explicitly about ${companyName}${domain ? ` (${domain})` : ''}. If the same company name could refer to multiple organizations, only include news where the snippet's source URL or content confirms it is about the target. If unsure, exclude it — null is better than wrong data.
      5. Never infer or hallucinate. If a field cannot be directly confirmed from the provided snippets, set it to null.
      
      Web search snippets (each prefixed with its source URL):
      ${allSnippets.slice(0, 10000)}
      
      Return this exact JSON structure (use null for unknown fields, never omit a key):
      {
        "companyName": string,
        "website": string | null,
        "foundedYear": number | null,
        "companyAge": number | null,
        "founders": string[] | null,
        "headquarters": string | null,
        "employeeCount": string | null,
        "industry": string | null,
        "revenue": string | null,
        "valuation": string | null,
        "fundingStage": string | null,
        "latestFundingNews": string | null,
        "investors": string[] | null,
        "keyProducts": string[] | null,
        "competitors": string[] | null,
        "recentNews": [{ "headline": string, "date": string | null, "source": string | null }] | null,
        "leadershipChanges": [{ "name": string, "role": string, "date": string | null }] | null,
        "linkedinUrl": string | null,
        "businessModel": string | null,
        "geographicPresence": string[] | null,
        "topCustomers": string[] | null
      }
      
      ADDITIONAL RULES:
      - All string[] fields MUST be JSON arrays, never comma-separated strings
      - "recentNews[].source" should be the domain of the article URL (e.g. "techcrunch.com")
      - Use null for any field you cannot confirm from the snippets
      - Do not add keys beyond those listed above`;

      const raw = await llmHelper.chatWithGemini(extractionPrompt, undefined, undefined, false);
      if (!raw) return { success: false, error: 'LLM extraction failed' };

      // Safely parse JSON — strip markdown fences if present
      const clean = raw.replace(/```json|```/g, '').trim();
      let intel: any;
      try {
        intel = JSON.parse(clean);
      } catch {
        // Try extracting first {...} block
        const match = clean.match(/\{[\s\S]+\}/);
        if (match) intel = JSON.parse(match[0]);
        else return { success: false, error: 'Could not parse company intelligence' };
      }

      // Prefer the directly-found LinkedIn URL over whatever the LLM extracted
      if (linkedinPageUrl && (!intel.linkedinUrl || !intel.linkedinUrl.includes('linkedin.com/company/'))) {
        intel.linkedinUrl = linkedinPageUrl;
      }

      // Attach raw news snippets for the "Recent News" click-through
      intel._newsSnippets = extract(newsResults).slice(0, 3).map((r: any) => ({
        title: r.title,
        url: r.url,
        date: r.published_date || null,
      }));

      // Normalize string[] fields — the LLM occasionally returns a
      // comma-separated string despite the prompt instruction.  Defensively
      // coerce every known list field so the renderer never crashes on .map().
      const LIST_FIELDS = [
        'founders', 'investors', 'keyProducts', 'competitors',
        'geographicPresence', 'topCustomers',
      ] as const;

      for (const field of LIST_FIELDS) {
        const v = intel[field];
        if (v === null || v === undefined) {
          intel[field] = null;
        } else if (Array.isArray(v)) {
          // Filter nulls, trim whitespace
          intel[field] = v
            .filter((x: any) => typeof x === 'string' && x.trim())
            .map((x: string) => x.trim());
          if (intel[field].length === 0) intel[field] = null;
        } else if (typeof v === 'string' && v.trim()) {
          // Comma-separated fallback
          intel[field] = v.split(',').map((s: string) => s.trim()).filter(Boolean);
          if (intel[field].length === 0) intel[field] = null;
        } else {
          intel[field] = null;
        }
      }

      // Validate object-array fields — ensure shape is correct or null them
      if (intel.recentNews !== null && intel.recentNews !== undefined) {
        if (!Array.isArray(intel.recentNews) ||
          !intel.recentNews.every((n: any) => typeof n?.headline === 'string')) {
          intel.recentNews = null;
        }
      }
      if (intel.leadershipChanges !== null && intel.leadershipChanges !== undefined) {
        if (!Array.isArray(intel.leadershipChanges) ||
          !intel.leadershipChanges.every((n: any) => typeof n?.name === 'string' && typeof n?.role === 'string')) {
          intel.leadershipChanges = null;
        }
      }

      // Persist intel so re-opening doesn't re-fetch
      try {
        db.setAppState(cacheKey, JSON.stringify(intel));
        console.log(`[IPC] fetch-company-intel: cached intel for "${companyName}" (key: ${cacheKey})`);
      } catch (e) {
        console.warn('[IPC] fetch-company-intel: failed to cache intel:', e);
      }

      // Auto-store in appState so chat assistant can access it immediately without a separate set-company-intel call
      appState.setCompanyIntel(intel);
      console.log(`[IPC] fetch-company-intel: auto-stored intel in appState for "${companyName}"`);

      return { success: true, intel };
    } catch (error: any) {
      console.error('[IPC] fetch-company-intel error:', error);
      return { success: false, error: error.message || 'Unknown error' };
    }
  });

  // ==========================================
  // Company Context IPC Handlers
  // ==========================================

  safeHandle('company:getContext', async () => {
    try {
      // Supabase is the source of truth for this screen — the local SQLite
      // cache only ever syncs one-way (local -> Supabase), so it can't see
      // deletions/edits made directly against the cloud table. Read live
      // whenever we have a configured, signed-in client; fall back to the
      // local cache only when Supabase is unreachable (offline, etc.).
      if (SupabaseReadService.isAvailable()) {
        try {
          return await SupabaseReadService.getCompanyContext();
        } catch (supabaseErr) {
          console.warn('[IPC] company:getContext: Supabase read failed, falling back to local cache:', supabaseErr);
        }
      }
      // Fall back to local DB (source of truth for pre-migration/offline data)
      const dbCtx = DatabaseManager.getInstance().getCompanyContext();
      if (dbCtx) return dbCtx;
      const { SettingsManager } = require('./services/SettingsManager');
      return SettingsManager.getInstance().get('companyContext') ?? null;
    } catch (error: any) {
      return null;
    }
  });

  safeHandle('company:saveContext', async (_, data: any) => {
    try {
      const db = DatabaseManager.getInstance();

      // 1. Persist identity + value prop
      db.saveCompanyContext(data);

      // 2. Sync assets: upsert all in draft, delete removed
      const existing = db.getCompanyContext();
      const incomingAssetIds = new Set<string>((data.assets ?? []).map((a: any) => a.id));
      for (const a of (existing?.assets ?? [])) {
        if (!incomingAssetIds.has(a.id)) {
          db.deleteAssetFiles(a.id);      // clean up files + chunks
          db.deleteCompanyAsset(a.id);
        }
      }
      for (const asset of (data.assets ?? [])) {
        db.upsertCompanyAsset({ id: asset.id, type: asset.type, label: asset.label, status: 'processing' });

        // Only process file if this is a new upload (fileData present in draft)
        if (asset.fileData && asset.fileName && asset.mimeType) {
          const fileBuffer = Buffer.from(asset.fileData, 'base64');
          db.saveAssetFile(asset.id, asset.fileName, asset.mimeType, fileBuffer);

          // Chunk + embed synchronously (awaited) so the caller (handleSave) can
          // be certain the asset is actually indexed before it returns success.
          //
          // All supported types (pdf/doc/docx/ppt/pptx/csv/xlsx) now go through
          // the backend's /company-assets/upload endpoint: docx/pptx/xlsx/csv get
          // precise native text extraction there, PDFs/legacy doc/ppt fall back
          // to Document AI. This replaces the old split where non-PDF types were
          // extracted+embedded locally — one code path, one source of truth for
          // "is this asset actually indexed".
          try {
            const token = getAuthToken();
            if (!token) {
              db.upsertCompanyAsset({ id: asset.id, type: asset.type, label: asset.label, status: 'error' });
              console.error(`[IPC] company:saveContext — no auth token available for asset ${asset.id}`);
            } else {
              const form = new FormData();
              form.append('file', new Blob([fileBuffer], { type: asset.mimeType }), asset.fileName);
              form.append('asset_id', asset.id);
              form.append('label', asset.label);
              form.append('asset_type', asset.type);

              const resp = await fetch(`${BACKEND_URL}/api/v1/intelligence/company-assets/upload`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: form,
              });

              const result = await resp.json();
              console.log(`[IPC] company:saveContext — upload result for ${asset.id}:`, result);
              db.upsertCompanyAsset({
                id: asset.id, type: asset.type, label: asset.label,
                status: result.status === 'indexed' ? 'mapped' : 'error',
              });
            }
          } catch (uploadErr: any) {
            console.error(`[IPC] company:saveContext — upload failed for asset ${asset.id}:`, uploadErr.message);
            db.upsertCompanyAsset({ id: asset.id, type: asset.type, label: asset.label, status: 'error' });
          }


        } else {
          // Existing asset already in DB — just keep its current status
          // Re-upsert with 'mapped' since it was already processed before
          db.upsertCompanyAsset({ id: asset.id, type: asset.type, label: asset.label, status: 'mapped' });
        }
      }

      // 3. Sync targetPersonas (unchanged)
      const incomingPersonaIds = new Set<string>((data.targetPersonas ?? []).map((p: any) => p.id));
      for (const p of (existing?.targetPersonas ?? [])) {
        if (!incomingPersonaIds.has(p.id)) db.deleteCompanyPersona(p.id);
      }
      (data.targetPersonas ?? []).forEach((p: any, i: number) => db.upsertCompanyPersona(p, i));

      // 4. Sync competitors (unchanged)
      const incomingCompetitorIds = new Set<string>((data.competitors ?? []).map((c: any) => c.id));
      for (const c of (existing?.competitors ?? [])) {
        if (!incomingCompetitorIds.has(c.id)) db.deleteCompanyCompetitor(c.id);
      }
      (data.competitors ?? []).forEach((c: any, i: number) => db.upsertCompanyCompetitor(c, i));

      // 5. Mirror to SettingsManager (unchanged)
      const { SettingsManager } = require('./services/SettingsManager');
      SettingsManager.getInstance().set('companyContext', data);

      // 6. Synchronize the updated context into the KnowledgeOrchestrator.
      //    We re-read from DB so the orchestrator always sees the canonical persisted state
      //    (including any asset status changes written above).
      //    hydrateOrchestratorFromContext skips re-ingesting asset documents — those
      //    are linked separately via orchestrator.ingestDocument in company:uploadAsset.
      try {
        const orchestrator = appState.getKnowledgeOrchestrator();
        if (orchestrator) {
          const freshCtx = DatabaseManager.getInstance().getCompanyContext();
          hydrateOrchestratorFromContext(orchestrator, freshCtx);
          console.log('[IPC] company:saveContext — orchestrator synchronized');
        }
      } catch (orchErr: any) {
        console.warn('[IPC] company:saveContext — orchestrator sync failed (non-fatal):', orchErr.message);
      }

      // 7. Wait for the just-queued deletes/upserts to actually reach
      //    Supabase before returning. company:getContext now reads Supabase
      //    as the source of truth (see earlier fix), so if we returned
      //    success while the delete was still sitting in the async mirror
      //    outbox, switching tabs right after Save would re-fetch the old
      //    row from Supabase and the "deleted" asset would pop back in.
      try {
        const { SupabaseMirrorService } = require('./db/SupabaseMirrorService');
        await SupabaseMirrorService.getInstance().flush();
      } catch (flushErr: any) {
        console.warn('[IPC] company:saveContext — mirror flush failed (non-fatal, will retry in background):', flushErr.message);
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('company:selectFile', async (event) => {
    try {
      // On macOS, an unparented dialog isn't attached as a sheet to any
      // window, which is what causes it to appear "stuck" — not properly
      // dismissing/returning focus to the Settings window after a file is
      // chosen. Passing the owning BrowserWindow fixes that.
      const win = BrowserWindow.fromWebContents(event.sender);
      const result: any = await dialog.showOpenDialog(win!, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'csv', 'xlsx'] }
        ]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true };
      }
      // const fp: string = result.filePaths[0];
      // const { statSync } = require('fs');
      // const { basename } = require('path');
      // const stat = statSync(fp);
      // return { success: true, filePath: fp, fileName: basename(fp), fileSize: stat.size };

      const files = result.filePaths.map((filePath: string) => {
        const stat = fs.statSync(filePath);
        return { filePath, fileName: path.basename(filePath), fileSize: stat.size };
      });
      return { cancelled: false, files };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('company:uploadAsset', async (_, type: string, filePath: string) => {
    try {
      const fs = require('fs');
      const path = require('path');

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File not found. Please re-select the file.' };
      }

      const fileData: Buffer = fs.readFileSync(filePath);
      const fileName: string = path.basename(filePath);
      const ext = path.extname(fileName).toLowerCase().slice(1);
      const MIME_MAP: Record<string, string> = {
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        csv: 'text/csv',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
      const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';

      const LABEL_MAP: Record<string, string> = {
        sales_deck: 'Sales Deck',
        product_specs: 'Product Specs',
        case_studies: 'Case Studies',
        custom: 'Custom Asset',
      };

      const asset = {
        id: `${type}-${Date.now()}`,
        type,
        label: LABEL_MAP[type] ?? type,
        status: 'pending',           // not 'mapped' yet — saved on commit
        lastUpdated: new Date().toISOString(),
        // Hold file in draft as base64 — never touches DB here
        fileData: fileData.toString('base64'),
        fileName,
        mimeType,
      };

      // NOTE: No DB write here. File lives in frontend draft until
      // user clicks "Save Intelligence Base" → company:saveContext.
      return { success: true, asset };
    } catch (error: any) {
      console.error('[IPC] company:uploadAsset error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle('company:deleteAsset', async (_, assetId: string) => {
    try {
      // Purge backend (Supabase vectors + cached chat answers) first — if this
      // fails we keep the local copy so the user can retry, instead of silently
      // leaving orphaned vectors that chat/live-analysis RAG can still surface.
      const token = getAuthToken();
      if (token) {
        try {
          const resp = await fetch(
            `${BACKEND_URL}/api/v1/intelligence/company-assets/${encodeURIComponent(assetId)}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
          );
          if (!resp.ok && resp.status !== 404) {
            // 404 is fine — asset was never uploaded to backend (e.g. local-only
            // asset that errored before reaching /upload). Anything else, surface it.
            const body = await resp.text();
            throw new Error(`Backend delete failed (${resp.status}): ${body}`);
          }
        } catch (backendErr: any) {
          console.error('[IPC] company:deleteAsset — backend delete failed:', backendErr.message);
          return { success: false, error: backendErr.message || 'Failed to delete from server' };
        }
      } else {
        console.warn('[IPC] company:deleteAsset — no auth token, skipping backend delete (local-only cleanup)');
      }
      DatabaseManager.getInstance().deleteAssetFiles(assetId);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('company:syncAsset', async (_assetId: string) => {
    // NOTE: No DB write here. The frontend updates the asset status in draft.
    // The updated status is committed to DB when the user clicks "Save Intelligence Base".
    return { success: true, status: 'mapped' };
  });

  safeHandle('company:setPersonaEngine', async (_enabled: boolean) => {
    // NOTE: No DB write here. The toggle updates the frontend draft only.
    // Committed to DB on "Save Intelligence Base" via company:saveContext.
    return { success: true };
  });

  safeHandle('company:getCompleteness', async () => {
    try {
      const { SettingsManager } = require('./services/SettingsManager');
      const sm = SettingsManager.getInstance();
      const ctx = sm.get('companyContext');
      if (!ctx) return 0;
      const checks = [
        !!(ctx.identity?.name && ctx.identity?.industry),
        (ctx.coreValueProposition ?? '').trim().length > 20,
        (ctx.assets ?? []).some((a: any) => a.status === 'mapped'),
        !!ctx.identity?.personaEngineEnabled,
      ];
      return Math.round((checks.filter(Boolean).length / 4) * 100);
    } catch {
      return 0;
    }
  });

  // ==========================================
  // Meeting Scorecard Handlers
  // ==========================================

  safeHandle('meeting:getScorecard', async (_event, meetingId: string) => {
    try {
      // Try Supabase first; fall back to local SQLite
      const { SupabaseClientManager } = require('./db/SupabaseClient');
      if (SupabaseClientManager.isConfigured()) {
        const client = SupabaseClientManager.getClient();
        const userId = SupabaseClientManager.getCurrentUserId();
        if (client && userId) {
          const { data: row, error } = await client
            .from('meeting_scorecards')
            .select('scorecard_json')
            .eq('user_id', userId)
            .eq('meeting_id', meetingId)
            .maybeSingle();
          if (!error && row) {
            const parsed = typeof row.scorecard_json === 'string'
              ? JSON.parse(row.scorecard_json)
              : row.scorecard_json;
            return { success: true, data: parsed };
          }
        }
      }
      // Fallback: local SQLite
      const data = DatabaseManager.getInstance().getMeetingScorecard(meetingId);
      return { success: true, data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  safeHandle('meeting:deleteScorecard', async (_event, meetingId: string) => {
    try {
      // Delete from local SQLite
      DatabaseManager.getInstance().deleteMeetingScorecard(meetingId);
      // Delete from Supabase (fire-and-forget via mirror)
      try {
        const { SupabaseMirrorService } = require('./db/SupabaseMirrorService');
        SupabaseMirrorService.getInstance().deleteRow('meeting_scorecards', 'meeting_id', meetingId);
      } catch (mirrorErr) {
        console.warn('[IPC] meeting:deleteScorecard Supabase mirror failed (non-fatal):', mirrorErr);
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ==========================================
  // Scoring Criteria Handlers
  // ==========================================
  safeHandle('scoring:getCriteria', async () => {
    try {
      const db = DatabaseManager.getInstance();
      return { success: true, data: db.getScoringCriteria() };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  safeHandle('scoring:saveCriteria', async (_event, criteriaData: any) => {
    try {
      const db = DatabaseManager.getInstance();
      db.saveScoringCriteria(criteriaData);
      // Mirror to Supabase
      try {
        const { SupabaseMirrorService } = require('./db/SupabaseMirrorService');
        SupabaseMirrorService.getInstance().upsertRow('scoring_criteria', {
          id: 1,
          config_json: JSON.stringify(criteriaData),
          updated_at: new Date().toISOString(),
        });
      } catch (mirrorErr) {
        console.warn('[IPC] scoring:saveCriteria Supabase mirror failed (non-fatal):', mirrorErr);
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  safeHandle('scoring:resetCriteria', async () => {
    try {
      const db = DatabaseManager.getInstance();
      db.resetScoringCriteria();
      // Mirror deletion to Supabase
      try {
        const { SupabaseMirrorService } = require('./db/SupabaseMirrorService');
        SupabaseMirrorService.getInstance().deleteRow('scoring_criteria', 'id', 1);
      } catch (mirrorErr) {
        console.warn('[IPC] scoring:resetCriteria Supabase mirror failed (non-fatal):', mirrorErr);
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ==========================================
  // Follow-up Email Handlers
  // ==========================================

  safeHandle("generate-followup-email", async (_, input: any) => {
    try {

      const { FOLLOWUP_EMAIL_PROMPT, GROQ_FOLLOWUP_EMAIL_PROMPT } = require('./llm/prompts');
      const { buildFollowUpEmailPromptInput } = require('./utils/emailUtils');

      const llmHelper = appState.processingHelper.getLLMHelper();

      // Build the context string from input
      const contextString = buildFollowUpEmailPromptInput(input);

      // Build prompts
      const ownCompanyBlock = buildOwnCompanyBlockFromOrchestrator(appState.getKnowledgeOrchestrator());
      const prospectBlock = buildCompanyContextBlock(appState.getCompanyIntel());
      let enrichedContext = contextString;
      if (prospectBlock) enrichedContext = `${prospectBlock}\n\n${enrichedContext}`;
      if (ownCompanyBlock) enrichedContext = `${ownCompanyBlock}\n\n${enrichedContext}`;
      const geminiPrompt = `${llmHelper.applyLanguageInstruction(FOLLOWUP_EMAIL_PROMPT)}\n\nMEETING DETAILS:\n${enrichedContext}`;
      const groqPrompt = `${llmHelper.applyLanguageInstruction(GROQ_FOLLOWUP_EMAIL_PROMPT)}\n\nMEETING DETAILS:\n${enrichedContext}`;

      console.log("=> generate follow-up email (geminiPrompt): ", geminiPrompt);
      console.log("=> generate follow-up email (groqPrompt): ", groqPrompt);

      // Use chatWithGemini with alternateGroqMessage for fallback
      try {
        const emailBody = await llmHelper.chatWithGemini(geminiPrompt, undefined, undefined, true, groqPrompt);
        if (!emailBody || !emailBody.trim()) {
          throw new Error('Empty response from Gemini/Groq for follow-up email');
        }
        posthogMain.capture('llm_generation_source', {
          task: 'followup_email',
          source: 'electron_native',
        });
        return emailBody;
      } catch (directError: any) {
        console.warn(`[IPC] generate-followup-email: direct Gemini/Groq failed (${directError.message}). Falling back to backend...`);
        const token = getAuthToken();
        if (!token) throw directError;

        const resp = await fetch(`${BACKEND_URL}/api/v1/llm/fallback/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            task: 'followup_email',
            context: enrichedContext,
            custom_prompt: FOLLOWUP_EMAIL_PROMPT,
          }),
        });
        if (!resp.ok) throw directError;
        const data = await resp.json();
        posthogMain.capture('llm_generation_source', {
          task: 'followup_email',
          source: 'backend_fallback',
          provider: data?.provider_order?.[0] ?? null,
        });
        return data.text;
      }
    } catch (error: any) {
      console.error("Error generating follow-up email:", error);
      throw error;
    }
  });

  safeHandle("extract-emails-from-transcript", async (_, transcript: Array<{ text: string }>) => {
    try {
      const { extractEmailsFromTranscript } = require('./utils/emailUtils');
      return extractEmailsFromTranscript(transcript);
    } catch (error: any) {
      console.error("Error extracting emails:", error);
      return [];
    }
  });

  safeHandle("set-company-intel", async (_, intel: Record<string, any> | null) => {
    try {
      appState.setCompanyIntel(intel);
      // Broadcast to all renderer windows so NativelyInterface can update its state
      const { BrowserWindow } = require('electron');
      BrowserWindow.getAllWindows().forEach((win: any) => {
        win.webContents.send('company-intel-updated', intel);
      });
      return { success: true };
    } catch (error: any) {
      console.error('[IPC] set-company-intel error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-calendar-attendees", async (_, eventId: string) => {
    try {
      const { CalendarManager } = require('./services/CalendarManager');
      const cm = CalendarManager.getInstance();

      // Try to get attendees from the event
      const events = await cm.getUpcomingEvents();
      const event = events?.find((e: any) => e.id === eventId);

      if (event && event.attendees) {
        return event.attendees.map((a: any) => ({
          email: a.email,
          name: a.displayName || a.email?.split('@')[0] || ''
        })).filter((a: any) => a.email);
      }

      return [];
    } catch (error: any) {
      console.error("Error getting calendar attendees:", error);
      return [];
    }
  });

  safeHandle("open-mailto", async (_, { to, subject, body }: { to: string; subject: string; body: string }) => {
    try {
      const { buildMailtoLink } = require('./utils/emailUtils');
      const mailtoUrl = buildMailtoLink(to, subject, body);
      await shell.openExternal(mailtoUrl);
      return { success: true };
    } catch (error: any) {
      console.error("Error opening mailto:", error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // RAG (Retrieval-Augmented Generation) Handlers
  // ==========================================

  // Store active query abort controllers for cancellation
  const activeRAGQueries = new Map<string, AbortController>();

  // Query meeting with RAG (meeting-scoped)
  safeHandle("rag:query-meeting", async (event, { meetingId, query }: { meetingId: string; query: string }) => {
    const ragManager = appState.getRAGManager();

    if (!ragManager || !ragManager.isReady()) {
      // Fallback to regular chat if RAG not available
      console.log("[RAG] Not ready, falling back to regular chat");
      return { fallback: true };
    }

    // For completed meetings, check if post-meeting RAG is processed.
    // For live meetings with JIT indexing, let RAGManager.queryMeeting() decide.
    if (!ragManager.isMeetingProcessed(meetingId) && !ragManager.isLiveIndexingActive(meetingId)) {
      console.log(`[RAG] Meeting ${meetingId} not processed and no JIT indexing, falling back to regular chat`);
      return { fallback: true };
    }

    const abortController = new AbortController();
    const queryKey = `meeting-${meetingId}`;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryMeeting(meetingId, query, abortController.signal);

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        event.sender.send("rag:stream-chunk", { meetingId, chunk });
      }

      event.sender.send("rag:stream-complete", { meetingId });
      return { success: true };

    } catch (error: any) {
      if (error.name !== 'AbortError') {
        const msg = error.message || "";
        // If specific RAG failures, return fallback to use transcript window
        if (msg.includes('NO_RELEVANT_CONTEXT') || msg.includes('NO_MEETING_EMBEDDINGS')) {
          console.log(`[RAG] Query failed with '${msg}', falling back to regular chat`);
          return { fallback: true };
        }

        console.error("[RAG] Query error:", error);
        event.sender.send("rag:stream-error", { meetingId, error: msg });
      }
      return { success: false, error: error.message };
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  // Query live meeting with JIT RAG
  safeHandle("rag:query-live", async (event, { query }: { query: string }) => {
    const ragManager = appState.getRAGManager();

    if (!ragManager || !ragManager.isReady()) {
      return { fallback: true };
    }

    // Check if JIT indexing is active and has chunks
    if (!ragManager.isLiveIndexingActive('live-meeting-current')) {
      return { fallback: true };
    }

    const abortController = new AbortController();
    const queryKey = `live-${Date.now()}`;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryMeeting('live-meeting-current', query, abortController.signal);

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        event.sender.send("rag:stream-chunk", { live: true, chunk });
      }

      event.sender.send("rag:stream-complete", { live: true });
      return { success: true };

    } catch (error: any) {
      if (error.name !== 'AbortError') {
        const msg = error.message || "";
        // If JIT RAG failed (no embeddings yet, no relevant context), fallback to regular chat
        if (msg.includes('NO_RELEVANT_CONTEXT') || msg.includes('NO_MEETING_EMBEDDINGS')) {
          console.log(`[RAG] JIT query failed with '${msg}', falling back to regular live chat`);
          return { fallback: true };
        }
        console.error("[RAG] Live query error:", error);
        event.sender.send("rag:stream-error", { live: true, error: msg });
      }
      return { success: false, error: error.message };
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  // Query global (cross-meeting search)
  safeHandle("rag:query-global", async (event, { query }: { query: string }) => {
    const ragManager = appState.getRAGManager();

    if (!ragManager || !ragManager.isReady()) {
      return { fallback: true };
    }

    const abortController = new AbortController();
    const queryKey = `global-${Date.now()}`;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryGlobal(query, abortController.signal);

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        event.sender.send("rag:stream-chunk", { global: true, chunk });
      }

      event.sender.send("rag:stream-complete", { global: true });
      return { success: true };

    } catch (error: any) {
      if (error.name !== 'AbortError') {
        event.sender.send("rag:stream-error", { global: true, error: error.message });
      }
      return { success: false, error: error.message };
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  // Cancel active RAG query
  safeHandle("rag:cancel-query", async (_, { meetingId, global }: { meetingId?: string; global?: boolean }) => {
    const queryKey = global ? 'global' : `meeting-${meetingId}`;

    // Cancel any matching key
    for (const [key, controller] of activeRAGQueries) {
      if (key.startsWith(queryKey) || (global && key.startsWith('global'))) {
        controller.abort();
        activeRAGQueries.delete(key);
      }
    }

    return { success: true };
  });

  // Check if meeting has RAG embeddings
  safeHandle('rag:is-meeting-processed', async (_, meetingId: string) => {
    try {
      const ragManager = appState.getRAGManager();
      if (!ragManager) throw new Error('RAGManager not initialized');
      return ragManager.isMeetingProcessed(meetingId);
    } catch (error: any) {
      console.error('[IPC rag:is-meeting-processed] Error:', error);
      return false;
    }
  });

  safeHandle('rag:reindex-incompatible-meetings', async () => {
    try {
      const ragManager = appState.getRAGManager();
      if (!ragManager) throw new Error('RAGManager not initialized');
      await ragManager.reindexIncompatibleMeetings();
      return { success: true };
    } catch (error: any) {
      console.error('[IPC rag:reindex-incompatible-meetings] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get RAG queue status
  safeHandle("rag:get-queue-status", async () => {
    const ragManager = appState.getRAGManager();
    if (!ragManager) return { pending: 0, processing: 0, completed: 0, failed: 0 };
    return ragManager.getQueueStatus();
  });

  // Retry pending embeddings
  safeHandle("rag:retry-embeddings", async () => {
    const ragManager = appState.getRAGManager();
    if (!ragManager) return { success: false };
    await ragManager.retryPendingEmbeddings();
    return { success: true };
  });

  // ==========================================
  // Profile Engine IPC Handlers
  // ==========================================

  safeHandle("profile:upload-resume", async (_, filePath: string) => {
    try {
      // Premium gate: require active license for profile features
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      if (!LicenseManager.getInstance().isPremium()) {
        return { success: false, error: 'Pro license required. Please activate a license key to use Profile Intelligence features.' };
      }
      console.log(`[IPC] profile:upload-resume called with: ${filePath}`);
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized. Please ensure API keys are configured.' };
      }
      const { DocType } = require('./premium/knowledge/types');
      const result = await orchestrator.ingestDocument(filePath, DocType.RESUME);
      return result;
    } catch (error: any) {
      console.error('[IPC] profile:upload-resume error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:get-status", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { hasProfile: false, profileMode: false };
      }
      // Map new KnowledgeStatus back to legacy UI shape temporarily
      const status = orchestrator.getStatus();
      return {
        hasProfile: status.hasResume,
        profileMode: status.activeMode,
        name: status.resumeSummary?.name,
        role: status.resumeSummary?.role,
        totalExperienceYears: status.resumeSummary?.totalExperienceYears
      };
    } catch (error: any) {
      return { hasProfile: false, profileMode: false };
    }
  });

  safeHandle("profile:get-mode", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { active: false };
      return { active: orchestrator.isKnowledgeMode() };
    } catch {
      return { active: false };
    }
  });

  safeHandle("profile:set-mode", async (_, enabled: boolean) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      orchestrator.setKnowledgeMode(enabled);
      // Persist so the toggle survives app restarts
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setKnowledgeModeActive(enabled);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:delete", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      const { DocType } = require('./premium/knowledge/types');
      orchestrator.deleteDocumentsByType(DocType.RESUME);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:get-profile", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return null;
      return orchestrator.getProfileData();
    } catch (error: any) {
      return null;
    }
  });

  safeHandle("profile:select-file", async () => {
    try {
      const result: any = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'Resume Files', extensions: ['pdf', 'docx', 'txt'] }
        ]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true };
      }

      return { success: true, filePath: result.filePaths[0] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // JD & Research IPC Handlers
  // ==========================================

  safeHandle("profile:upload-jd", async (_, filePath: string) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized. Please ensure API keys are configured.' };
      }
      const { DocType } = require('./premium/knowledge/types');
      const result = await orchestrator.ingestDocument(filePath, DocType.JD);
      return result;
    } catch (error: any) {
      console.error('[IPC] profile:upload-jd error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:delete-jd", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      const { DocType } = require('./premium/knowledge/types');
      orchestrator.deleteDocumentsByType(DocType.JD);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:research-company", async (_, companyName: string) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      const engine = orchestrator.getCompanyResearchEngine();

      // Wire Tavily Search provider if key is configured
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      const tavilyApiKey = cm.getTavilyApiKey();
      if (tavilyApiKey) {
        const { TavilySearchProvider } = require('./premium/knowledge/TavilySearchProvider');
        engine.setSearchProvider(new TavilySearchProvider(tavilyApiKey));
      }

      // Build full JD context so the dossier is tailored to the exact role
      const profileData = orchestrator.getProfileData();
      const activeJD = profileData?.activeJD;
      const jdCtx = activeJD ? {
        title: activeJD.title,
        location: activeJD.location,
        level: activeJD.level,
        technologies: activeJD.technologies,
        requirements: activeJD.requirements,
        keywords: activeJD.keywords,
        compensation_hint: activeJD.compensation_hint,
        min_years_experience: activeJD.min_years_experience,
      } : {};
      const dossier = await engine.researchCompany(companyName, jdCtx, true);
      return { success: true, dossier };
    } catch (error: any) {
      console.error('[IPC] profile:research-company error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:generate-negotiation", async (_, force: boolean = false) => {
    try {

      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      const status = orchestrator.getStatus();
      if (!status.hasResume) {
        return { success: false, error: 'No resume loaded' };
      }

      // Use cache unless force-regenerating
      let script = force ? null : orchestrator.getNegotiationScript();
      if (!script) {
        script = await orchestrator.generateNegotiationScriptOnDemand();
      }
      if (!script) {
        return { success: false, error: 'Could not generate negotiation script. Ensure a resume and job description are uploaded.' };
      }
      return { success: true, script };
    } catch (error: any) {
      console.error('[IPC] profile:generate-negotiation error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:get-negotiation-state", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false, error: 'Engine not ready' };
      const tracker = orchestrator.getNegotiationTracker();
      return {
        success: true,
        state: tracker.getState(),
        isActive: tracker.isActive(),
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:reset-negotiation", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false };
      orchestrator.resetNegotiationSession();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Tavily Search API Credentials
  // ==========================================

  safeHandle("set-tavily-api-key", async (_, apiKey: string) => {
    try {
      if (apiKey && !apiKey.startsWith('tvly-')) {
        return { success: false, error: 'Invalid Tavily API key. Keys must start with "tvly-".' };
      }
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setTavilyApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Overlay Opacity (Stealth Mode)
  // ==========================================

  safeHandle("set-overlay-opacity", async (_, opacity: number) => {
    // Clamp to valid range
    const clamped = Math.min(1.0, Math.max(0.35, opacity));
    // Broadcast to all renderer windows so the overlay picks it up in real-time
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('overlay-opacity-changed', clamped);
      }
    });
    return;
  });

  // ==========================================
  // Firebase Auth bridge
  // (Renderer owns the Firebase Web SDK and pushes the live ID token here.)
  // ==========================================

  // Wire AuthManager events → broadcast to renderers (one-time per process).
  try {
    const { AuthManager } = require('./services/AuthManager');
    const am = AuthManager.getInstance();
    const broadcast = () => {
      const snap = am.snapshot();
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('auth:state-changed', snap);
      });
    };
    am.on('signed-in', broadcast);
    am.on('signed-out', broadcast);
    am.on('auth-changed', broadcast);
  } catch (e) {
    console.warn('[ipc] AuthManager event wiring failed:', e);
  }

  // ==========================================
  // Tenant ID bridge (cross-window)
  // ==========================================
  // The current tenant is resolved once, in the main/launcher window, via
  // tenantsApi.listMine() (needs the Firebase token owned by that window's
  // renderer). The overlay window — where "End Meeting" actually lives — is
  // a *separate* renderer process with its own React tree and its own
  // (always-null) local state, so it can never see that value on its own.
  // We cache the resolved tenantId here in the main process and broadcast it
  // to every window, the same way auth:state-changed already works.
  let currentTenantId: string | null = null;

  safeHandle('tenant:set-current', async (_, tenantId: string | null) => {
    currentTenantId = tenantId ?? null;
    tenantContext.set(currentTenantId);
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) win.webContents.send('tenant:state-changed', currentTenantId);
    });
    return { success: true };
  });

  safeHandle('tenant:get-current', async () => tenantContext.get());

  safeHandle('auth:set-id-token', async (_, session: {
    idToken: string;
    refreshToken: string;
    uid: string;
    email?: string | null;
    displayName?: string | null;
    photoURL?: string | null;
    expiresAt: number;
  }) => {
    try {
      if (!session?.idToken || !session?.uid) {
        return { success: false, error: 'idToken and uid required' };
      }
      const { AuthManager } = require('./services/AuthManager');
      AuthManager.getInstance().setSession(session);
      return { success: true };
    } catch (error: any) {
      console.error('[ipc] auth:set-id-token failed:', error);
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  safeHandle('auth:clear', async () => {
    try {
      const { AuthManager } = require('./services/AuthManager');
      AuthManager.getInstance().clearSession();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  safeHandle('auth:get-state', async () => {
    try {
      const { AuthManager } = require('./services/AuthManager');
      return AuthManager.getInstance().snapshot();
    } catch (_) {
      return { signedIn: false };
    }
  });

  safeHandle('auth:get-persisted-refresh-token', async () => {
    try {
      const { AuthManager } = require('./services/AuthManager');
      const persisted = AuthManager.getInstance().getPersistedIdentity();
      return {
        refreshToken: persisted?.refreshToken ?? null,
        uid: persisted?.uid ?? null
      };
    } catch (_) {
      return { refreshToken: null, uid: null };
    }
  });

  // ==========================================
  // Supabase mirror config & status
  // ==========================================

  safeHandle('supabase:set-credentials', async (_, args: { url: string; anonKey: string }) => {
    try {
      if (!args?.url || !args?.anonKey) {
        return { success: false, error: 'url and anonKey required' };
      }
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setSupabaseCredentials(args.url, args.anonKey);
      const { SupabaseClientManager } = require('./db/SupabaseClient');
      SupabaseClientManager.configure(args.url, args.anonKey);
      return { success: true };
    } catch (error: any) {
      console.error('[ipc] supabase:set-credentials failed:', error);
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  safeHandle('supabase:get-mirror-status', async () => {
    try {
      const { SupabaseMirrorService } = require('./db/SupabaseMirrorService');
      const { SupabaseClientManager } = require('./db/SupabaseClient');
      const mirror = SupabaseMirrorService.getInstance();
      const status = typeof mirror.getStatus === 'function'
        ? mirror.getStatus()
        : { outboxLength: 0, lastSyncAt: null, lastError: null };
      return {
        configured: SupabaseClientManager.hasCredentials?.() ?? false,
        signedIn: !!SupabaseClientManager.getCurrentUserId?.(),
        outboxLength: status.outboxLength ?? 0,
        lastSyncAt: status.lastSyncAt ?? null,
        lastError: status.lastError ?? null
      };
    } catch (error: any) {
      return { configured: false, signedIn: false, outboxLength: 0, lastSyncAt: null, lastError: error?.message };
    }
  });

  // Force a fresh historical backfill. Clears the 'supabase_backfill_done'
  // checkpoint AND the per-table cursors, then re-runs SupabaseBackfill.run().
  // Useful for development / re-syncing after schema changes. No-op if the
  // mirror isn't configured or no user is signed in.
  safeHandle('supabase:force-backfill', async () => {
    try {
      const { SupabaseBackfill } = require('./db/SupabaseBackfill');
      const { DatabaseManager } = require('./db/DatabaseManager');
      const { SupabaseClientManager } = require('./db/SupabaseClient');
      if (!SupabaseClientManager.isConfigured?.()) {
        return { success: false, error: 'Supabase not configured or not signed in' };
      }
      const db = DatabaseManager.getInstance().getDb();
      if (!db) return { success: false, error: 'SQLite not ready' };

      // Wipe the "done" flag and all per-table cursors so backfill restarts.
      try {
        db.prepare("DELETE FROM app_state WHERE key = 'supabase_backfill_done'").run();
        db.prepare("DELETE FROM app_state WHERE key LIKE 'supabase_backfill_cursor_%'").run();
      } catch (e) {
        console.warn('[ipc] supabase:force-backfill — failed to clear checkpoints:', e);
      }

      // Fire-and-forget the run; UI can poll supabase:get-mirror-status.
      SupabaseBackfill.run(db).catch((err: any) => {
        console.warn('[ipc] supabase:force-backfill run error:', err);
      });
      return { success: true };
    } catch (error: any) {
      console.error('[ipc] supabase:force-backfill failed:', error);
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  // Fire-and-forget reconciliation pass: compares local SQLite rows against
  // their Supabase mirror and re-enqueues anything missing/divergent. Runs in
  // the background; the UI polls supabase:get-mirror-status for progress.
  safeHandle('supabase:sync-audit', async () => {
    try {
      const { SupabaseSyncAudit } = require('./db/SupabaseSyncAudit');
      const { DatabaseManager } = require('./db/DatabaseManager');
      const { SupabaseClientManager } = require('./db/SupabaseClient');
      if (!SupabaseClientManager.isConfigured?.()) {
        return { success: false, error: 'Supabase not configured or not signed in' };
      }
      const db = DatabaseManager.getInstance().getDb();
      if (!db) return { success: false, error: 'SQLite not ready' };

      // Fire-and-forget; UI can poll supabase:get-mirror-status.
      SupabaseSyncAudit.run(db).catch((err: any) => {
        console.warn('[ipc] supabase:sync-audit run error:', err);
      });
      return { success: true };
    } catch (error: any) {
      console.error('[ipc] supabase:sync-audit failed:', error);
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  // Shared by 'reset-app-data' and 'dev:wipe-local-account-data': deletes
  // this install's entire userData directory itself — credentials.enc,
  // settings.json, natively.db (+ its -wal/-shm files and Supabase mirror
  // queue), cached auth session, the persist:google-auth partition, and
  // the godojo-ai/godojo-ai-dev folder that contains them (depending on
  // isPackaged) — then relaunches. Electron recreates an empty userData
  // directory on the next launch, so the app comes back up exactly as it
  // would on a brand-new install: sign-in screen, no local data anywhere
  // on disk. Callers are responsible for confirming with the user *before*
  // calling this — it does not prompt itself.
  async function wipeLocalUserDataAndRelaunch(logPrefix: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Release the sqlite file handle before touching userData — on
      // Windows the delete below fails (or leaves natively.db behind)
      // if it's still open.
      try { DatabaseManager.getInstance().close(); } catch (e) {
        console.warn(`[ipc] ${logPrefix}: DatabaseManager.close() failed (continuing):`, e);
      }

      // Chromium's own HTTP disk cache (userData/Cache/Cache_Data/*) is held
      // open by this running process. On Windows an open handle blocks
      // unlink, so without this the rmSync below throws EPERM on those
      // cache files specifically. Clearing the session cache/storage first
      // makes Chromium release its handles before we delete the directory.
      //
      // The Google sign-in popup (see WindowHelper.ts) runs in its own
      // 'persist:google-auth' partition — a completely separate Chromium
      // session from defaultSession, with its own cookies/IndexedDB/cache
      // under userData/Partitions/google-auth. It needs the exact same
      // clear-before-delete treatment, or its open handles can either block
      // the wipe (Windows EPERM) or simply leave that stored Google auth
      // session behind.

      try {
        await session.defaultSession.clearCache();
        await session.defaultSession.clearStorageData();
      } catch (e) {
        console.warn(`[ipc] ${logPrefix}: clearing session cache failed (continuing):`, e);
      }

      try {
        const googleAuthSession = session.fromPartition('persist:google-auth');
        await googleAuthSession.clearCache();
        await googleAuthSession.clearStorageData();
      } catch (e) {
        console.warn(`[ipc] ${logPrefix}: clearing google-auth session failed (continuing):`, e);
      }

      const userDataPath = app.getPath('userData');
      // Guard against ever deleting something unexpected (e.g. if
      // userData somehow resolved to a root-ish path).
      if (!userDataPath || path.basename(userDataPath).indexOf('godojo-ai') !== 0) {
        throw new Error(`Refusing to wipe — unexpected userData path: ${userDataPath}`);
      }

      // Delete the ENTIRE userData directory — not just its contents — so
      // the godojo-ai/godojo-ai-dev folder itself is gone, not left behind
      // empty. Electron recreates this directory automatically the next
      // time the app calls app.getPath('userData') on relaunch, so removing
      // it outright here is safe.
      let lastDeleteError: unknown;
      let deleted = false;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          fs.rmSync(userDataPath, { recursive: true, force: true });
          deleted = true;
          break;
        } catch (e) {
          lastDeleteError = e;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      if (!deleted) {
        throw lastDeleteError instanceof Error ? lastDeleteError : new Error(String(lastDeleteError));
      }

      app.relaunch();
      app.exit(0);
      return { success: true };
    } catch (error: any) {
      console.error(`[ipc] ${logPrefix} failed:`, error);
      return { success: false, error: error?.message ?? String(error) };
    }
  }

  // "Reset app data" (Settings > General > Danger Zone). Native confirm
  // dialog lives here (not the renderer) so this can't be triggered by a
  // spoofed IPC call alone — it always requires an OS-level dialog click.
  safeHandle('reset-app-data', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const messageBoxOptions: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Cancel', 'Reset App Data'],
      defaultId: 0,
      cancelId: 0,
      title: 'Reset App Data',
      message: 'Reset all local app data?',
      detail:
        'This permanently deletes your local credentials, settings, and offline data on this device, and signs you out. This cannot be undone.\n\nThe app will restart automatically.',
    };
    const { response }: Electron.MessageBoxReturnValue = win
      ? await dialog.showMessageBox(win, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions);
    if (response !== 1) {
      return { success: false, cancelled: true };
    }
    return wipeLocalUserDataAndRelaunch('reset-app-data');
  });

  // DEV-ONLY: local-data half of "Delete My Account" (Settings > General >
  // Danger Zone). The renderer calls this *after* the Supabase rows +
  // Firebase Auth user have already been deleted server-side, so unlike
  // 'reset-app-data' this does NOT show its own confirm dialog — the
  // account deletion the user just confirmed is already irreversible by
  // the time this runs, and a second native prompt here would just leave
  // local data behind (stale natively.db, cached session) if they misread
  // it as a fresh, cancellable action. Reuses the exact same wipe path as
  // 'reset-app-data' so local state ends up identically clean.
  safeHandle('dev:wipe-local-account-data', async () => {
    return wipeLocalUserDataAndRelaunch('dev:wipe-local-account-data');
  });

  safeHandle('confirm-delete-account', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const messageBoxOptions: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Cancel', 'Delete My Account'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete My Account',
      message: 'Permanently delete your account?',
      detail:
        'This permanently deletes your account and all associated data from our servers, then clears everything stored on this device. This cannot be undone.\n\nThe app will restart automatically.',
    };
    const { response } = win
      ? await dialog.showMessageBox(win, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions);
    return { confirmed: response === 1 };
  });

}