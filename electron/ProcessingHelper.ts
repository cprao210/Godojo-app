// ProcessingHelper.ts

import { AppState } from "./main"
import { LLMHelper } from "./LLMHelper"
import { CredentialsManager } from "./services/CredentialsManager"
import { app } from "electron"
// import dotenv from "dotenv" // Removed static import

if (!app.isPackaged) {
  require("dotenv").config()
}

const isDev = process.env.NODE_ENV === "development"
const isDevTest = process.env.IS_DEV_TEST === "true"
const MOCK_API_WAIT_TIME = Number(process.env.MOCK_API_WAIT_TIME) || 500

export class ProcessingHelper {
  private appState: AppState
  private llmHelper: LLMHelper
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

  constructor(appState: AppState) {
    this.appState = appState

    // Check if user wants to use Ollama
    const useOllama = process.env.USE_OLLAMA === "true"
    const ollamaModel = process.env.OLLAMA_MODEL // Don't set default here, let LLMHelper auto-detect
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434"

    if (useOllama) {
      // console.log("[ProcessingHelper] Initializing with Ollama")
      this.llmHelper = new LLMHelper(undefined, true, ollamaModel, ollamaUrl)
    } else {
      // Try environment first (for development)
      let apiKey = process.env.GEMINI_API_KEY
      let groqApiKey = process.env.GROQ_API_KEY
      let openaiApiKey = process.env.OPENAI_API_KEY
      let claudeApiKey = process.env.CLAUDE_API_KEY

      // Allow initializing without key (will be loaded in loadStoredCredentials or via Settings)
      if (!apiKey) {
        console.warn("[ProcessingHelper] GEMINI_API_KEY not found in env. Will try CredentialsManager after ready.")
      }

      this.llmHelper = new LLMHelper(apiKey, false, undefined, undefined, groqApiKey, openaiApiKey, claudeApiKey)
    }
  }

  /**
   * Push the currently-resolved LLM keys into the live clients.
   *
   * The provider clients (GoogleGenAI/Groq/OpenAI/Anthropic) capture their key at
   * construction, and this helper is built once at boot — before sign-in, so
   * before any backend fallback key exists. Anything that changes key resolution
   * (fallback fetch, a Settings save, an account switch) must call this or the
   * app keeps using whatever was resolvable at startup, which on macOS is often
   * nothing. Only providers whose key actually changed are rebuilt.
   *
   * Returns the providers that were re-pushed.
   */
  public syncLlmKeysFromCredentials(
    trigger: string,
    options: { reinitializeEngine?: boolean } = {}
  ): Array<'gemini' | 'groq' | 'openai' | 'claude'> {
    const { reinitializeEngine = true } = options;
    const credManager = CredentialsManager.getInstance();
    const applied = this.llmHelper.getAppliedKeys();

    const resolved = {
      gemini: credManager.getGeminiApiKey() ?? null,
      groq: credManager.getGroqApiKey() ?? null,
      openai: credManager.getOpenaiApiKey() ?? null,
      claude: credManager.getClaudeApiKey() ?? null,
    };

    const changed: Array<'gemini' | 'groq' | 'openai' | 'claude'> = [];
    const targets: Array<{ name: 'gemini' | 'groq' | 'openai' | 'claude'; apply: (key: string) => void }> = [
      { name: 'gemini', apply: k => this.llmHelper.setApiKey(k) },
      { name: 'groq', apply: k => this.llmHelper.setGroqApiKey(k) },
      { name: 'openai', apply: k => this.llmHelper.setOpenaiApiKey(k) },
      { name: 'claude', apply: k => this.llmHelper.setClaudeApiKey(k) },
    ];

    for (const target of targets) {
      const next = resolved[target.name];
      const current = applied[target.name];
      if (next && next !== current) {
        target.apply(next);
        changed.push(target.name);
      } else if (!next && current) {
        // The user removed their key and no default covers this provider.
        this.llmHelper.clearProviderKey(target.name);
        changed.push(target.name);
      }
    }

    if (changed.length === 0) return changed;

    console.log(`[ProcessingHelper] LLM keys re-synced (${trigger}): ${changed.join(', ')}`);

    if (reinitializeEngine) {
      // Rebuild the per-mode wrappers so in-flight modes see the new clients.
      this.appState.getIntelligenceManager().initializeLLMs();
    }

    // Embeddings hold their own client, keyed on openai/gemini.
    if (changed.includes('openai') || changed.includes('gemini')) {
      const ragManager = this.appState.getRAGManager();
      if (ragManager) {
        ragManager.initializeEmbeddings({
          openaiKey: resolved.openai || undefined,
          geminiKey: resolved.gemini || undefined,
        });
        ragManager.retryPendingEmbeddings().catch(console.error);
      }
    }

    // Model discovery needs the new keys too.
    this.llmHelper.initModelVersionManager().catch(err => {
      console.warn('[ProcessingHelper] ModelVersionManager re-init failed (non-critical):', err.message);
    });

    try {
      const { posthogMain } = require('./services/PostHogMainService');
      const sources = credManager.getKeySources();
      posthogMain.capture('api_keys_runtime_sync', {
        trigger,
        target: 'llm',
        changedProviders: changed,
        changedCount: changed.length,
        geminiSource: sources.gemini,
        groqSource: sources.groq,
        openaiSource: sources.openai,
        claudeSource: sources.claude,
      });
    } catch { /* telemetry must never break key loading */ }

    return changed;
  }

  /**
   * Load stored credentials from CredentialsManager
   * Should be called after app.whenReady() when CredentialsManager is initialized
   */
  public loadStoredCredentials(): void {
    const credManager = CredentialsManager.getInstance();

    const geminiKey = credManager.getGeminiApiKey();
    const openaiKey = credManager.getOpenaiApiKey();

    // Pushes every resolved key into the live clients (skips the engine re-init
    // below, since initializeLLMs() runs unconditionally on this path).
    this.syncLlmKeysFromCredentials('startup', { reinitializeEngine: false });

    // CRITICAL: Re-initialize IntelligenceManager now that keys are loaded
    // This fixes the issue where buttons don't work in production because of late key loading
    this.appState.getIntelligenceManager().initializeLLMs();

    // CRITICAL: Initialize RAGManager (Embeddings) with loaded keys
    // This fixes "RAG unavailable" in production where process.env is empty
    const ragManager = this.appState.getRAGManager();
    if (ragManager) {
      console.log("[ProcessingHelper] Initializing RAGManager embeddings with available keys");
      ragManager.initializeEmbeddings({
          openaiKey: openaiKey || undefined,
          geminiKey: geminiKey || undefined,
          // ollamaUrl is not fetched in CredentialsManager yet by default, but we pass these keys
      });

      // CRITICAL: Retry pending embeddings now that we have a key
      // This ensures any meetings that failed or were queued during startup get processed
      console.log("[ProcessingHelper] Retrying pending embeddings...");
      ragManager.retryPendingEmbeddings().catch(console.error);

      // CRITICAL: Ensure demo meeting has chunks
      ragManager.ensureDemoMeetingProcessed().catch(console.error);

      // CRITICAL: Cleanup stale queue items to prevent "Chunk not found" errors
      ragManager.cleanupStaleQueueItems();
    }

    // Initialize self-improving model version manager (background, non-blocking)
    this.llmHelper.initModelVersionManager().catch(err => {
      console.warn('[ProcessingHelper] ModelVersionManager initialization failed (non-critical):', err.message);
    });

    // NEW: Load Default Model Config
    const defaultModel = credManager.getDefaultModel();
    if (defaultModel) {
      console.log(`[ProcessingHelper] Loading stored Default Model: ${defaultModel}`);
      const customProviders = credManager.getCustomProviders();
      const curlProviders = credManager.getCurlProviders();
      const allProviders = [...(customProviders || []), ...(curlProviders || [])];
      this.llmHelper.setModel(defaultModel, allProviders);
    }

    // Load Languages
    const sttLanguage = credManager.getSttLanguage();
    const aiResponseLanguage = credManager.getAiResponseLanguage();
    
    if (sttLanguage) {
      this.llmHelper.setSttLanguage(sttLanguage);
    }
    
    if (aiResponseLanguage) {
      this.llmHelper.setAiResponseLanguage(aiResponseLanguage);
    }

    // One event describing which tier every key came from at boot.
    credManager.trackKeySourceSnapshot('startup');
  }

  public async processScreenshots(): Promise<void> {
    const mainWindow = this.appState.getMainWindow()
    if (!mainWindow) return

    const view = this.appState.getView()

    if (view === "queue") {
      const screenshotQueue = this.appState.getScreenshotHelper().getScreenshotQueue()
      if (screenshotQueue.length === 0) {
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
        return
      }



      const allPaths = this.appState.getScreenshotHelper().getScreenshotQueue();

      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_START)
      this.appState.setView("solutions")
      this.currentProcessingAbortController = new AbortController()
      try {
        // Generate the structured 4-phase rolling interview script
        const rollingScript = await this.llmHelper.generateRollingScript(allPaths);

        const problemInfo = {
          problem_statement: rollingScript.problem_identifier_script,
          input_format: { description: "Generated from screenshot", parameters: [] as any[] },
          output_format: { description: "Generated from screenshot", type: "string", subtype: "structured" },
          complexity: { time: rollingScript.time_complexity, space: rollingScript.space_complexity },
          test_cases: [] as any[],
          validation_type: "structured",
          difficulty: "custom"
        };
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.PROBLEM_EXTRACTED, problemInfo);
        this.appState.setProblemInfo(problemInfo);

        // Send the full structured solution so Solutions.tsx renders the 4 phases
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_SUCCESS, {
          solution: {
            problem_identifier_script: rollingScript.problem_identifier_script,
            brainstorm_script: rollingScript.brainstorm_script,
            code: rollingScript.code,
            dry_run_script: rollingScript.dry_run_script,
            time_complexity: rollingScript.time_complexity,
            space_complexity: rollingScript.space_complexity,
          }
        });
      } catch (error: any) {
        console.error("[ProcessingHelper] Rolling script generation failed:", error);
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, error.message)
      } finally {
        this.currentProcessingAbortController = null
      }
      return;

    } else {
      // Debug mode
      const extraScreenshotQueue = this.appState.getScreenshotHelper().getExtraScreenshotQueue()
      if (extraScreenshotQueue.length === 0) {
        // console.log("No extra screenshots to process")
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
        return
      }

      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.DEBUG_START)
      this.currentExtraProcessingAbortController = new AbortController()

      try {
        // Get problem info and current solution
        const problemInfo = this.appState.getProblemInfo()
        if (!problemInfo) {
          throw new Error("No problem info available")
        }

        // Get current solution from state
        const currentSolution = await this.llmHelper.generateSolution(problemInfo)
        const currentCode = currentSolution.solution.code

        // Debug the solution using vision model
        const debugResult = await this.llmHelper.debugSolutionWithImages(
          problemInfo,
          currentCode,
          extraScreenshotQueue
        )

        this.appState.setHasDebugged(true)
        mainWindow.webContents.send(
          this.appState.PROCESSING_EVENTS.DEBUG_SUCCESS,
          debugResult
        )

      } catch (error: any) {
        // console.error("Debug processing error:", error)
        mainWindow.webContents.send(
          this.appState.PROCESSING_EVENTS.DEBUG_ERROR,
          error.message
        )
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  public cancelOngoingRequests(): void {
    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
    }

    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
    }

    this.appState.setHasDebugged(false)
  }



  public getLLMHelper() {
    return this.llmHelper;
  }
}
