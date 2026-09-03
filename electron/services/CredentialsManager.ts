/**
 * CredentialsManager - Secure storage for API keys and service account paths
 * Uses Electron's safeStorage API for encryption at rest
 */

import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const BACKEND_URL = process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

// Machine-level identity file (shared across users on this machine). Holds ONLY
// the Firebase refresh token + last-known profile, so the app can restore a
// session on launch BEFORE any uid is known. Never holds API keys.
const IDENTITY_PATH = path.join(app.getPath('userData'), 'identity.enc');

// Per-user credentials file. Everything except the Firebase identity lives here,
// keyed by uid, so User A and User B on the same machine never share API keys.
function credentialsPathForUid(uid: string | null): string {
    const safe = (uid ?? 'anon').replace(/[^A-Za-z0-9_-]/g, '') || 'anon';
    return path.join(app.getPath('userData'), `credentials-${safe}.enc`);
}

/**
 * Every provider whose key follows the shared three-tier resolution chain:
 *   the user's own key  →  the backend fallback key  →  the bundled .env key
 * Adding a provider here is all it takes for it to get identical resolution,
 * source reporting and telemetry.
 */
export type ApiKeyProvider =
    | 'gemini' | 'groq' | 'openai' | 'claude'
    | 'deepgram' | 'tavily'
    | 'groq_stt' | 'openai_stt' | 'elevenlabs'
    | 'azure' | 'ibmwatson' | 'soniox';

/** Which tier the key actually in use came from. Reported to the UI and PostHog. */
export type ApiKeySource = 'user' | 'backend_fallback' | 'env_bundled' | 'none';

interface KeyResolutionRule {
    /** Field on StoredCredentials holding the user's own key. */
    field: keyof StoredCredentials;
    /** Key name under fallbackKeys, as returned by /api/v1/api-keys. Omit if the backend has no default. */
    fallback?: string;
    /** Bundled .env var names, tried in order. Omit if there is no env default. */
    env?: string[];
}

// Mirrors the precedence the getters have always had, provider by provider —
// including the gaps (openai/claude have no bundled env key; azure has an env
// key but no backend default; ibmwatson/soniox have neither).
const KEY_RESOLUTION: Record<ApiKeyProvider, KeyResolutionRule> = {
    gemini: { field: 'geminiApiKey', fallback: 'gemini', env: ['GEMINI_API_KEY'] },
    groq: { field: 'groqApiKey', fallback: 'groq', env: ['GROQ_API_KEY'] },
    openai: { field: 'openaiApiKey', fallback: 'openai' },
    claude: { field: 'claudeApiKey', fallback: 'claude' },
    deepgram: { field: 'deepgramApiKey', fallback: 'deepgram', env: ['DEEPGRAM_API_KEY'] },
    tavily: { field: 'tavilyApiKey', fallback: 'tavily', env: ['TAVILY_API_KEY'] },
    groq_stt: { field: 'groqSttApiKey', fallback: 'groq' },
    openai_stt: { field: 'openAiSttApiKey', fallback: 'openai' },
    elevenlabs: { field: 'elevenLabsApiKey', fallback: 'elevenlabs' },
    azure: { field: 'azureApiKey', env: ['AZURE_SPEECH_API_KEY', 'AZURE_SPEECH_KEY'] },
    ibmwatson: { field: 'ibmWatsonApiKey' },
    soniox: { field: 'sonioxApiKey' },
};

const ALL_KEY_PROVIDERS = Object.keys(KEY_RESOLUTION) as ApiKeyProvider[];

/** Providers the product treats as first-class; kept small so the startup rollup event stays readable. */
const CORE_KEY_PROVIDERS: ApiKeyProvider[] = ['gemini', 'groq', 'deepgram', 'tavily', 'openai', 'claude'];

/** Trim-and-drop-empty, so a key pasted with a trailing newline never reaches a provider. */
function normalizeKey(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export interface CustomProvider {
    id: string;
    name: string;
    curlCommand: string;
}

export interface CurlProvider {
    id: string;
    name: string;
    curlCommand: string;
    responsePath: string; // e.g. "choices[0].message.content"
}

export interface StoredCredentials {
    geminiApiKey?: string;
    groqApiKey?: string;
    openaiApiKey?: string;
    claudeApiKey?: string;
    googleServiceAccountPath?: string;
    customProviders?: CustomProvider[];
    curlProviders?: CurlProvider[];
    defaultModel?: string;
    // STT Provider settings
    sttProvider?: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox';
    groqSttApiKey?: string;
    groqSttModel?: string;
    openAiSttApiKey?: string;
    deepgramApiKey?: string;
    elevenLabsApiKey?: string;
    azureApiKey?: string;
    azureRegion?: string;
    ibmWatsonApiKey?: string;
    ibmWatsonRegion?: string;
    sonioxApiKey?: string;
    sttLanguage?: string;
    aiResponseLanguage?: string;
    // Tavily Search
    tavilyApiKey?: string;
    // Dynamic Model Discovery – preferred models per provider
    geminiPreferredModel?: string;
    groqPreferredModel?: string;
    openaiPreferredModel?: string;
    claudePreferredModel?: string;
    // Firebase Auth — refresh token + last-known profile fields
    // The short-lived ID token is NEVER persisted (1h expiry); the renderer
    // exchanges the refresh token for a fresh ID token on every launch.
    firebaseRefreshToken?: string;
    firebaseUid?: string;
    firebaseEmail?: string;
    firebaseDisplayName?: string;
    firebasePhotoURL?: string;
    // Supabase project credentials (URL is non-sensitive; anon key is public-by-design
    // but we keep both encrypted at rest to avoid casual exfiltration)
    supabaseUrl?: string;
    supabaseAnonKey?: string;
    // Knowledge Base
    knowledgeModeActive?: boolean;
    // Echo pipeline mode for the native audio gate ('legacy' | 'phase1' | 'full_duplex')
    echoPipelineMode?: string;
    // Deepgram streaming diarization on the system-audio (client) stream.
    // Default OFF: it is a paid streaming add-on (~$0.002/min on top of Nova-3).
    diarizeClientEnabled?: boolean;
    // Word-timestamp echo filter in the main process (free, inert without word data)
    echoWordFilterEnabled?: boolean;
    // Render non-English STT finals into English before display/storage.
    // Default ON: inert for Latin-script speech, so it only costs anything when
    // the speaker actually uses another language.
    translateTranscriptsToEnglish?: boolean;
    // Converged AEC alignment offsets per output route (keyed by route name).
    // Seeds the native echo canceller on the next meeting with the same route.
    echoAlignSeeds?: { [routeKey: string]: { seedMs: number; backend: string } };
}

export class CredentialsManager {
    private static instance: CredentialsManager;
    private credentials: StoredCredentials = {};
    private currentUid: string | null = null;
    private credentialsPath: string = credentialsPathForUid(null);

    // Firebase identity is stored separately (machine-level) so it survives across
    // user switches and is readable before a uid is known at launch.
    private identityStore: {
        lastUid?: string;
        accounts: {
            [uid: string]: {
                firebaseRefreshToken: string;
                firebaseUid: string;
                firebaseEmail?: string;
                firebaseDisplayName?: string;
                firebasePhotoURL?: string;
                updatedAt: number;
            };
        };
    } = { accounts: {} };


    private fallbackKeys: Record<string, string> = {};

    // ── Store health ────────────────────────────────────────────────────────
    // A credentials file we could not decrypt is "unknown", never "empty". On
    // macOS the safeStorage Keychain item is ACL-bound to the app's code
    // signature, and an unsigned/ad-hoc build gets a new signature on every
    // release — so decryptString() starts throwing on a file the previous build
    // wrote while isEncryptionAvailable() still reports true. Treating that as
    // "no credentials" is what silently wiped users' keys: the next background
    // save (echo-align seed, knowledge mode, STT provider) wrote {} over it.
    private loadState: 'ok' | 'failed' = 'ok';
    private loadFailureReason: string | null = null;
    private identityLoadFailed = false;
    /** False after a scrub or a failed load — memory no longer reflects the file. */
    private memoryTrusted = true;

    // Deduped so the hot getters (called per LLM/STT/Tavily request) emit one
    // event per provider+source per session instead of thousands.
    private resolutionEventsSent = new Set<string>();
    private lastKnownSources: Partial<Record<ApiKeyProvider, ApiKeySource>> = {};

    private constructor() {
        // Load on construction after app ready
    }

    public static getInstance(): CredentialsManager {
        if (!CredentialsManager.instance) {
            CredentialsManager.instance = new CredentialsManager();
        }
        return CredentialsManager.instance;
    }

    /**
     * Initialize - load credentials from disk
     * Must be called after app.whenReady()
     */
    public init(): void {
        this.loadIdentity();
        this.currentUid = this.identityStore.lastUid ?? null;
        this.credentialsPath = credentialsPathForUid(this.currentUid);
        this.loadCredentials();
    }

    // =========================================================================
    // Telemetry — where every key in use came from. Never sends a key value,
    // prefix or hash: presence, length and tier only.
    // =========================================================================

    private track(event: string, properties: Record<string, any> = {}): void {
        try {
            const { posthogMain } = require('./PostHogMainService');
            posthogMain.capture(event, {
                platform: process.platform,
                appVersion: app.getVersion(),
                isPackaged: app.isPackaged,
                scope: this.currentUid ? 'user' : 'anon',
                ...properties,
            });
        } catch {
            // Telemetry must never break credential handling.
        }
    }

    /** One `api_key_resolved` per provider+source per session, plus a `api_key_source_changed` on every flip. */
    private trackResolution(provider: ApiKeyProvider, source: ApiKeySource): void {
        const previous = this.lastKnownSources[provider];
        this.lastKnownSources[provider] = source;

        if (previous && previous !== source) {
            // 'resolution' = noticed while reading the key, so the cause was not a
            // save: a backend fetch landed, an account switch happened, or the
            // bundled env changed between launches.
            this.track('api_key_source_changed', { provider, fromSource: previous, toSource: source, reason: 'resolution' });
        }

        const dedupeKey = `${provider}:${source}`;
        if (this.resolutionEventsSent.has(dedupeKey)) return;
        this.resolutionEventsSent.add(dedupeKey);

        const rule = KEY_RESOLUTION[provider];
        this.track('api_key_resolved', {
            provider,
            source,
            hasUserKey: !!normalizeKey(this.credentials[rule.field]),
            hasBackendFallback: !!(rule.fallback && normalizeKey(this.fallbackKeys[rule.fallback])),
            hasEnvKey: (rule.env ?? []).some(name => !!normalizeKey(process.env[name])),
            credentialsLoadState: this.loadState,
        });
    }

    /** Fired at startup and after every re-sync: one event answering "where is each key coming from right now". */
    public trackKeySourceSnapshot(trigger: string): void {
        const sources = this.getKeySources();
        const counts = { user: 0, backend_fallback: 0, env_bundled: 0, none: 0 };
        for (const provider of ALL_KEY_PROVIDERS) counts[sources[provider]]++;

        const perProvider: Record<string, ApiKeySource> = {};
        for (const provider of CORE_KEY_PROVIDERS) perProvider[`${provider}Source`] = sources[provider];

        this.track('api_keys_snapshot', {
            trigger,
            ...perProvider,
            userKeyCount: counts.user,
            backendKeyCount: counts.backend_fallback,
            envKeyCount: counts.env_bundled,
            missingKeyCount: counts.none,
            backendFallbackCount: Object.keys(this.fallbackKeys).length,
            credentialsLoadState: this.loadState,
            identityLoadFailed: this.identityLoadFailed,
        });
    }

    // =========================================================================
    // Key resolution — the single source of truth for every provider
    // =========================================================================

    /** user's own key → backend fallback → bundled .env. Values are trimmed on read. */
    private resolveKey(provider: ApiKeyProvider): { value?: string; source: ApiKeySource } {
        const rule = KEY_RESOLUTION[provider];

        const userKey = normalizeKey(this.credentials[rule.field]);
        if (userKey) return { value: userKey, source: 'user' };

        const fallbackKey = rule.fallback ? normalizeKey(this.fallbackKeys[rule.fallback]) : undefined;
        if (fallbackKey) return { value: fallbackKey, source: 'backend_fallback' };

        for (const name of rule.env ?? []) {
            const envKey = normalizeKey(process.env[name]);
            if (envKey) return { value: envKey, source: 'env_bundled' };
        }

        return { source: 'none' };
    }

    /** The key to actually use for this provider. Records where it came from. */
    public getKey(provider: ApiKeyProvider): string | undefined {
        const { value, source } = this.resolveKey(provider);
        this.trackResolution(provider, source);
        return value;
    }

    /** Which tier this provider's key comes from, without emitting telemetry. */
    public getKeySource(provider: ApiKeyProvider): ApiKeySource {
        return this.resolveKey(provider).source;
    }

    public getKeySources(): Record<ApiKeyProvider, ApiKeySource> {
        const out = {} as Record<ApiKeyProvider, ApiKeySource>;
        for (const provider of ALL_KEY_PROVIDERS) out[provider] = this.resolveKey(provider).source;
        return out;
    }

    /** True only when the signed-in user has entered their own key for this provider. */
    public hasUserKey(provider: ApiKeyProvider): boolean {
        return !!normalizeKey(this.credentials[KEY_RESOLUTION[provider].field]);
    }

    /** Whether the credentials file failed to decrypt — the UI uses this to ask for re-entry. */
    public getStoreHealth(): { loadState: 'ok' | 'failed'; reason: string | null; identityLoadFailed: boolean } {
        return { loadState: this.loadState, reason: this.loadFailureReason, identityLoadFailed: this.identityLoadFailed };
    }


    /**
     * Re-point at the given user's credentials file. Called on sign-in / restore /
     * account switch — mirrors DatabaseManager.switchUser so keys never leak
     * between accounts. The Firebase identity file is untouched (machine-level).
     */
    public switchUser(uid: string | null): void {
        const nextPath = credentialsPathForUid(uid);
        if (nextPath === this.credentialsPath) return; // already on this user's file
        const fromScope = this.currentUid ? 'user' : 'anon';
        console.log(`[CredentialsManager] Switching credentials: ${this.currentUid ?? 'anon'} -> ${uid ?? 'anon'}`);

        // NOTE: deliberately no saveCredentials() here. Every setter already saves
        // on write, so there is nothing pending — and flushing on switch is how
        // one account's keys (or an emptied in-memory map after a failed load /
        // scrub) got written over another account's file.
        const orphanedAnonKeys = (fromScope === 'anon' && uid)
            ? ALL_KEY_PROVIDERS.filter(p => this.hasUserKey(p))
            : [];

        this.credentials = {};
        this.clearFallbackKeys(); // backend fallback keys are per-user (fetched with their token)
        this.currentUid = uid;
        this.credentialsPath = nextPath;
        // A fresh scope means a fresh resolution picture: re-emit sources for it.
        this.resolutionEventsSent.clear();
        this.lastKnownSources = {};
        this.loadCredentials();

        this.track('credentials_scope_switched', {
            fromScope,
            toScope: uid ? 'user' : 'anon',
            loadedKeyCount: ALL_KEY_PROVIDERS.filter(p => this.hasUserKey(p)).length,
        });

        // Keys typed while main thought nobody was signed in stay in credentials-anon.enc.
        // We do NOT migrate them (that would mix credentials between accounts), but we
        // do want to know how often it happens — it means loadIdentity() lost lastUid.
        if (orphanedAnonKeys.length > 0) {
            console.warn(`[CredentialsManager] ${orphanedAnonKeys.length} key(s) remain in the anonymous store after sign-in; user must re-enter them for this account.`);
            this.track('credentials_anon_keys_orphaned', {
                providers: orphanedAnonKeys,
                providerCount: orphanedAnonKeys.length,
            });
        }
    }

    public getCurrentUid(): string | null {
        return this.currentUid;
    }


    /**
     * Fetch encrypted fallback API keys from the backend and decrypt them in memory
     * securely using the local env passphrase.
     */
    public async fetchFallbackKeys(idToken: string): Promise<void> {
        const encryptionKey = process.env.API_ENCRYPTION_KEY;
        if (!encryptionKey) {
            console.warn('[CredentialsManager] API_ENCRYPTION_KEY not set, cannot decrypt fallback keys.');
            this.track('api_keys_fallback_fetch_failed', { reason: 'missing_encryption_key' });
            return;
        }

        try {
            const response = await fetch(`${BACKEND_URL}/api/v1/api-keys/`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${idToken}`
                }
            });

            if (!response.ok) {
                console.warn(`[CredentialsManager] Failed to fetch fallback keys: ${response.statusText}`);
                const { posthogMain } = require('./PostHogMainService');
                posthogMain.capture('api_keys_fallback_fetch_failed', {
                    status: response.status,
                    status_text: response.statusText
                });
                return;
            }

            const data = await response.json();
            if (data && Array.isArray(data.keys)) {
                // Derive 32-byte AES key using SHA-256
                const keyHash = crypto.createHash('sha256').update(encryptionKey).digest();

                for (const keyObj of data.keys) {
                    try {
                        const parsedStr = typeof keyObj.encrypted_key === 'string'
                            ? JSON.parse(keyObj.encrypted_key)
                            : keyObj.encrypted_key;

                        // Format from backend: {"iv": "base64", "data": "base64"}
                        const iv = Buffer.from(parsedStr.iv, 'base64');
                        const ciphertextWithTag = Buffer.from(parsedStr.data, 'base64');

                        // subtle crypto appends the 16-byte auth tag at the end of the ciphertext
                        const tagLength = 16;
                        const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - tagLength);
                        const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - tagLength);

                        const decipher = crypto.createDecipheriv('aes-256-gcm', keyHash, iv);
                        decipher.setAuthTag(authTag);

                        let decrypted = decipher.update(ciphertext, undefined, 'utf8');
                        decrypted += decipher.final('utf8');

                        const normalized = normalizeKey(decrypted);
                        if (!normalized) {
                            console.warn(`[CredentialsManager] Fallback key for ${keyObj.provider} decrypted to an empty value; ignoring.`);
                            const { posthogMain } = require('./PostHogMainService');
                            posthogMain.capture('api_keys_fallback_used', {
                                provider: keyObj.provider?.toLowerCase(),
                                status: 'empty_after_decrypt'
                            });
                            continue;
                        }

                        this.fallbackKeys[keyObj.provider.toLowerCase()] = normalized;

                        const { posthogMain } = require('./PostHogMainService');
                        posthogMain.capture('api_keys_fallback_used', {
                            provider: keyObj.provider.toLowerCase(),
                            status: 'success'
                        });
                    } catch (decErr) {
                        console.warn(`[CredentialsManager] Failed to decrypt fallback key for ${keyObj.provider}`);

                        const { posthogMain } = require('./PostHogMainService');
                        posthogMain.capture('api_keys_fallback_used', {
                            provider: keyObj.provider?.toLowerCase(),
                            status: 'decryption_failed',
                            error: decErr instanceof Error ? decErr.message : String(decErr)
                        });
                    }
                }
                console.log(`[CredentialsManager] Successfully loaded and decrypted ${Object.keys(this.fallbackKeys).length} fallback keys.`);
                this.trackKeySourceSnapshot('backend_fallback_fetched');
            }
        } catch (error) {
            console.error('[CredentialsManager] Error fetching fallback keys:', error);
            const { posthogMain } = require('./PostHogMainService');
            posthogMain.capture('api_keys_fallback_fetch_failed', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    public clearFallbackKeys(): void {
        this.fallbackKeys = {};
    }

    // =========================================================================
    // Getters
    //
    // Every API-key getter delegates to getKey(), so resolution order
    // (user key -> backend fallback -> bundled .env) and the telemetry that
    // reports which tier won are defined once, in KEY_RESOLUTION.
    // =========================================================================

    public getGeminiApiKey(): string | undefined {
        return this.getKey('gemini');
    }

    public getGroqApiKey(): string | undefined {
        return this.getKey('groq');
    }

    public getOpenaiApiKey(): string | undefined {
        return this.getKey('openai');
    }

    public getClaudeApiKey(): string | undefined {
        return this.getKey('claude');
    }

    public getGoogleServiceAccountPath(): string | undefined {
        return this.credentials.googleServiceAccountPath;
    }

    public getCustomProviders(): CustomProvider[] {
        return this.credentials.customProviders || [];
    }

    public getSttProvider(): 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox' {
        const envProvider = process.env.STT_PROVIDER as StoredCredentials['sttProvider'];
        return this.credentials.sttProvider || envProvider || 'deepgram';
    }

    public getDeepgramApiKey(): string | undefined {
        return this.getKey('deepgram');
    }

    public getGroqSttApiKey(): string | undefined {
        return this.getKey('groq_stt');
    }

    public getGroqSttModel(): string {
        return this.credentials.groqSttModel || 'whisper-large-v3-turbo';
    }

    public getOpenAiSttApiKey(): string | undefined {
        return this.getKey('openai_stt');
    }

    public getElevenLabsApiKey(): string | undefined {
        return this.getKey('elevenlabs');
    }

    public getAzureApiKey(): string | undefined {
        return this.getKey('azure');
    }

    public getAzureRegion(): string {
        return this.credentials.azureRegion || process.env.AZURE_SPEECH_REGION || 'southeastasia';
    }

    public getIbmWatsonApiKey(): string | undefined {
        return this.getKey('ibmwatson');
    }

    public getIbmWatsonRegion(): string {
        return this.credentials.ibmWatsonRegion || 'us-south';
    }

    public getSonioxApiKey(): string | undefined {
        return this.getKey('soniox');
    }

    public getTavilyApiKey(): string | undefined {
        return this.getKey('tavily');
    }

    public getSttLanguage(): string {
        return this.credentials.sttLanguage || 'multilingual';
    }

    public getAiResponseLanguage(): string {
        return this.credentials.aiResponseLanguage || 'English';
    }
    public getDefaultModel(): string {
        return this.credentials.defaultModel || 'gemini-3.1-flash-lite-preview';
    }

    public getAllCredentials(): StoredCredentials {
        return { ...this.credentials };
    }

    // =========================================================================
    // Setters (auto-save)
    // =========================================================================

    /**
     * Single write path for every user-supplied API key.
     *
     * - Trims, and stores `undefined` (never `""`) when the user clears a key, so
     *   "has a key" checks and the fallback chain agree. An empty string used to
     *   be stored verbatim, which read as "user has a key" and shadowed the
     *   backend/env default with a key that could never work.
     * - Emits `api_key_saved` with the key *length* only — never the value.
     */
    private setUserKey(provider: ApiKeyProvider, key: string, label: string): void {
        const field = KEY_RESOLUTION[provider].field;
        const previous = normalizeKey(this.credentials[field]);
        const normalized = normalizeKey(key);
        const sourceBefore = this.getKeySource(provider);

        (this.credentials as any)[field] = normalized;
        this.saveCredentials();

        const sourceAfter = this.getKeySource(provider);
        // Force the next getKey() to re-report: the winning tier just changed.
        this.resolutionEventsSent.delete(`${provider}:${sourceAfter}`);
        // A save is the most common cause of a tier flip, so emit the flip here
        // too — otherwise `api_key_source_changed` would only ever cover flips
        // the user did not cause (a backend fetch, an account switch) and would
        // be an incomplete answer to "when did this provider change tier".
        if (this.lastKnownSources[provider] && this.lastKnownSources[provider] !== sourceAfter) {
            this.track('api_key_source_changed', {
                provider,
                fromSource: this.lastKnownSources[provider],
                toSource: sourceAfter,
                reason: 'user_save',
            });
        }
        this.lastKnownSources[provider] = sourceAfter;

        this.track('api_key_saved', {
            provider,
            action: normalized ? (previous ? 'replaced' : 'added') : 'removed',
            keyLength: normalized?.length ?? 0,
            wasTrimmed: !!normalized && normalized !== key,
            sourceBefore,
            sourceAfter,
            fellBackToDefault: !normalized && sourceAfter !== 'none',
        });

        console.log(`[CredentialsManager] ${label} ${normalized ? 'updated' : 'cleared'} (now using: ${sourceAfter})`);
    }

    public setGeminiApiKey(key: string): void {
        this.setUserKey('gemini', key, 'Gemini API Key');
    }

    public setGroqApiKey(key: string): void {
        this.setUserKey('groq', key, 'Groq API Key');
    }

    public setOpenaiApiKey(key: string): void {
        this.setUserKey('openai', key, 'OpenAI API Key');
    }

    public setClaudeApiKey(key: string): void {
        this.setUserKey('claude', key, 'Claude API Key');
    }

    public setGoogleServiceAccountPath(filePath: string): void {
        this.credentials.googleServiceAccountPath = filePath;
        this.saveCredentials();
        console.log('[CredentialsManager] Google Service Account path updated');
    }

    public setSttProvider(provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox'): void {
        this.credentials.sttProvider = provider;
        this.saveCredentials();
        console.log(`[CredentialsManager] STT Provider set to: ${provider}`);
    }

    public setDeepgramApiKey(key: string): void {
        this.setUserKey('deepgram', key, 'Deepgram API Key');
    }

    public setGroqSttApiKey(key: string): void {
        this.setUserKey('groq_stt', key, 'Groq STT API Key');
    }

    public setOpenAiSttApiKey(key: string): void {
        this.setUserKey('openai_stt', key, 'OpenAI STT API Key');
    }

    public setGroqSttModel(model: string): void {
        this.credentials.groqSttModel = model;
        this.saveCredentials();
        console.log(`[CredentialsManager] Groq STT Model set to: ${model}`);
    }

    public setElevenLabsApiKey(key: string): void {
        this.setUserKey('elevenlabs', key, 'ElevenLabs API Key');
    }

    public setAzureApiKey(key: string): void {
        this.setUserKey('azure', key, 'Azure API Key');
    }

    public setAzureRegion(region: string): void {
        this.credentials.azureRegion = region;
        this.saveCredentials();
        console.log(`[CredentialsManager] Azure Region set to: ${region}`);
    }

    public setIbmWatsonApiKey(key: string): void {
        this.setUserKey('ibmwatson', key, 'IBM Watson API Key');
    }

    public setIbmWatsonRegion(region: string): void {
        this.credentials.ibmWatsonRegion = region;
        this.saveCredentials();
        console.log(`[CredentialsManager] IBM Watson Region set to: ${region}`);
    }

    public setSonioxApiKey(key: string): void {
        this.setUserKey('soniox', key, 'Soniox API Key');
    }

    public setTavilyApiKey(key: string): void {
        this.setUserKey('tavily', key, 'Tavily API Key');
    }

    public setSttLanguage(language: string): void {
        this.credentials.sttLanguage = language;
        this.saveCredentials();
        console.log(`[CredentialsManager] STT Language set to: ${language}`);
    }

    public setAiResponseLanguage(language: string): void {
        this.credentials.aiResponseLanguage = language;
        this.saveCredentials();
        console.log(`[CredentialsManager] AI Response Language set to: ${language}`);
    }

    public getKnowledgeModeActive(): boolean {
        return this.credentials.knowledgeModeActive ?? false;
    }

    public setKnowledgeModeActive(enabled: boolean): void {
        this.credentials.knowledgeModeActive = enabled;
        this.saveCredentials();
        console.log(`[CredentialsManager] Knowledge mode persisted: ${enabled}`);
    }

    /**
     * Echo pipeline mode for the native gate. Env var wins for field debugging.
     * Default full_duplex (Phase 2): delay-aligned AEC3 + convergence-tracked
     * soft gate — mic stays open during far-end speech once AEC3 converges.
     * 'phase1' (hard gate + headphone bypass) and 'legacy' remain as rollbacks.
     */
    public getEchoPipelineMode(): string {
        return process.env.NATIVELY_ECHO_MODE || this.credentials.echoPipelineMode || 'full_duplex';
    }

    public setEchoPipelineMode(mode: string): void {
        this.credentials.echoPipelineMode = mode;
        this.saveCredentials();
        console.log(`[CredentialsManager] Echo pipeline mode persisted: ${mode}`);
    }

    /** Deepgram diarization on the client (system-audio) stream. Default OFF — paid add-on. */
    public getDiarizeClientEnabled(): boolean {
        return this.credentials.diarizeClientEnabled ?? false;
    }

    public setDiarizeClientEnabled(enabled: boolean): void {
        this.credentials.diarizeClientEnabled = enabled;
        this.saveCredentials();
        console.log(`[CredentialsManager] Client diarization persisted: ${enabled}`);
    }

    /** Word-timestamp transcript echo filter. Default ON — free, inert without word data. */
    public getEchoWordFilterEnabled(): boolean {
        return this.credentials.echoWordFilterEnabled ?? true;
    }

    public setEchoWordFilterEnabled(enabled: boolean): void {
        this.credentials.echoWordFilterEnabled = enabled;
        this.saveCredentials();
        console.log(`[CredentialsManager] Echo word filter persisted: ${enabled}`);
    }

    /**
     * Translate non-English transcript finals into English. Default ON — the
     * translator skips Latin-script text without a network call, so this is a
     * no-op for English-only meetings.
     */
    public getTranslateTranscriptsToEnglish(): boolean {
        return this.credentials.translateTranscriptsToEnglish ?? true;
    }

    public setTranslateTranscriptsToEnglish(enabled: boolean): void {
        this.credentials.translateTranscriptsToEnglish = enabled;
        this.saveCredentials();
        console.log(`[CredentialsManager] Transcript translation persisted: ${enabled}`);
    }

    /** Persisted AEC alignment seed (SIGNED ms) for an output route, if any. */
    public getEchoAlignSeed(key: string): number | undefined {
        return this.credentials.echoAlignSeeds?.[key]?.seedMs;
    }

    public setEchoAlignSeed(key: string, seedMs: number, backend: string): void {
        if (!this.credentials.echoAlignSeeds) {
            this.credentials.echoAlignSeeds = {};
        }
        this.credentials.echoAlignSeeds[key] = { seedMs, backend };
        this.saveCredentials();
        console.log(`[CredentialsManager] Echo align seed persisted: route="${key}" seedMs=${seedMs} backend=${backend}`);
    }

    public setDefaultModel(model: string): void {
        this.credentials.defaultModel = model;
        this.saveCredentials();
        console.log(`[CredentialsManager] Default Model set to: ${model}`);
    }

    public getPreferredModel(provider: 'gemini' | 'groq' | 'openai' | 'claude'): string | undefined {
        const key = `${provider}PreferredModel` as keyof StoredCredentials;
        return this.credentials[key] as string | undefined;
    }

    public setPreferredModel(provider: 'gemini' | 'groq' | 'openai' | 'claude', modelId: string): void {
        const key = `${provider}PreferredModel` as keyof StoredCredentials;
        (this.credentials as any)[key] = modelId;
        this.saveCredentials();
        console.log(`[CredentialsManager] ${provider} preferred model set to: ${modelId}`);
    }

    public saveCustomProvider(provider: CustomProvider): void {
        if (!this.credentials.customProviders) {
            this.credentials.customProviders = [];
        }
        // Check if exists, update if so
        const index = this.credentials.customProviders.findIndex(p => p.id === provider.id);
        if (index !== -1) {
            this.credentials.customProviders[index] = provider;
        } else {
            this.credentials.customProviders.push(provider);
        }
        this.saveCredentials();
        console.log(`[CredentialsManager] Custom Provider '${provider.name}' saved`);
    }

    public deleteCustomProvider(id: string): void {
        if (!this.credentials.customProviders) return;
        this.credentials.customProviders = this.credentials.customProviders.filter(p => p.id !== id);
        this.saveCredentials();
        console.log(`[CredentialsManager] Custom Provider '${id}' deleted`);
    }

    public getCurlProviders(): CurlProvider[] {
        return this.credentials.curlProviders || [];
    }

    public saveCurlProvider(provider: CurlProvider): void {
        if (!this.credentials.curlProviders) {
            this.credentials.curlProviders = [];
        }
        const index = this.credentials.curlProviders.findIndex(p => p.id === provider.id);
        if (index !== -1) {
            this.credentials.curlProviders[index] = provider;
        } else {
            this.credentials.curlProviders.push(provider);
        }
        this.saveCredentials();
        console.log(`[CredentialsManager] Curl Provider '${provider.name}' saved`);
    }

    public deleteCurlProvider(id: string): void {
        if (!this.credentials.curlProviders) return;
        this.credentials.curlProviders = this.credentials.curlProviders.filter(p => p.id !== id);
        this.saveCredentials();
        console.log(`[CredentialsManager] Curl Provider '${id}' deleted`);
    }

    // =========================================================================
    // Firebase Identity
    // =========================================================================

    public setFirebaseIdentity(identity: {
        refreshToken: string; uid: string; email?: string; displayName?: string; photoURL?: string;
    }): void {
        this.identityStore.accounts[identity.uid] = {
            firebaseRefreshToken: identity.refreshToken,
            firebaseUid: identity.uid,
            firebaseEmail: identity.email,
            firebaseDisplayName: identity.displayName,
            firebasePhotoURL: identity.photoURL,
            updatedAt: Date.now(),
        };
        this.identityStore.lastUid = identity.uid;   // this account is now active
        this.saveIdentity();
    }

    // Backwards-compatible: returns the LAST-active account (used by launch restore)
    public getFirebaseIdentity(): { refreshToken: string; uid: string; email?: string; displayName?: string; photoURL?: string; } | null {

        const uid = this.identityStore.lastUid;
        const acct = uid ? this.identityStore.accounts[uid] : undefined;
        if (!acct?.firebaseRefreshToken) return null;
        return {
            refreshToken: acct.firebaseRefreshToken,
            uid: acct.firebaseUid,
            email: acct.firebaseEmail,
            displayName: acct.firebaseDisplayName,
            photoURL: acct.firebasePhotoURL,
        };
    }

    // NEW — list all known accounts for the switcher UI (no tokens leak to renderer)
    public listFirebaseAccounts(): Array<{
        uid: string; email?: string; displayName?: string; photoURL?: string; isActive: boolean;
    }> {
        return Object.values(this.identityStore.accounts)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(a => ({
                uid: a.firebaseUid,
                email: a.firebaseEmail,
                displayName: a.firebaseDisplayName,
                photoURL: a.firebasePhotoURL,
                isActive: a.firebaseUid === this.identityStore.lastUid,
            }));
    }

    // NEW — fetch one account's refresh token for a switch (main-process only)
    public getRefreshTokenForUid(uid: string): string | null {
        return this.identityStore.accounts[uid]?.firebaseRefreshToken ?? null;
    }

    // NEW — set which account is active without changing tokens
    public setActiveUid(uid: string): void {
        if (this.identityStore.accounts[uid]) {
            this.identityStore.lastUid = uid;
            this.saveIdentity();
        }
    }

    // Remove ONE account (used by sign-out / "remove from this device")
    public removeFirebaseAccount(uid: string): void {
        delete this.identityStore.accounts[uid];
        if (this.identityStore.lastUid === uid) this.identityStore.lastUid = undefined;
        this.saveIdentity();
    }

    public clearFirebaseIdentity(): void {
        // Full wipe (e.g. delete-account). Keep removeFirebaseAccount for single sign-out.
        this.identityStore = { accounts: {} };
        this.identityLoadFailed = false; // deliberate wipe — bypass the empty-state write guard
        this.saveIdentity();
    }

    // =========================================================================
    // Supabase Credentials
    // =========================================================================

    public setSupabaseCredentials(url: string, anonKey: string): void {
        this.credentials.supabaseUrl = url;
        this.credentials.supabaseAnonKey = anonKey;
        this.saveCredentials();
    }

    public getSupabaseCredentials(): { url: string; anonKey: string } | null {
        const url = this.credentials.supabaseUrl;
        const anonKey = this.credentials.supabaseAnonKey;
        if (!url || !anonKey) return null;
        return { url, anonKey };
    }

    public clearAll(): void {
        this.scrubMemory();
        if (fs.existsSync(this.credentialsPath)) {
            fs.unlinkSync(this.credentialsPath);
        }
        const plaintextPath = this.credentialsPath + '.json';
        if (fs.existsSync(plaintextPath)) {
            fs.unlinkSync(plaintextPath);
        }
        // Deliberate wipe — memory and disk agree, so unblock future writes.
        this.loadState = 'ok';
        this.loadFailureReason = null;
        this.memoryTrusted = true;
        this.applyDefaults();
        console.log('[CredentialsManager] All credentials cleared');
    }

    /**
     * Scrub all API keys from memory to minimize exposure window.
     * Called on app quit and credential clear.
     */
    public scrubMemory(): void {
        // Overwrite each string field with empty before discarding
        for (const key of Object.keys(this.credentials) as (keyof StoredCredentials)[]) {
            const val = this.credentials[key];
            if (typeof val === 'string') {
                (this.credentials as any)[key] = '';
            }
        }
        this.credentials = {};
        // In-memory state no longer mirrors the file. If the quit is aborted (a
        // window vetoes `close`) and something later saves, the write guard in
        // saveCredentials() stops this empty map from erasing the stored keys.
        this.memoryTrusted = false;
        this.resolutionEventsSent.clear();
        console.log('[CredentialsManager] Memory scrubbed');
    }

    // =========================================================================
    // Storage (Encrypted)
    // =========================================================================

    private saveIdentity(): void {
        // Never let an empty accounts map overwrite a populated file. When
        // loadIdentity() fails it resets identityStore to `{ accounts: {} }`; the
        // next setActiveUid()/removeFirebaseAccount() would then persist that
        // emptiness and drop every saved account. Losing `lastUid` is also what
        // makes init() open credentials-anon.enc for a signed-in user, so their
        // keys appear to have "reset" and anything they re-enter lands in the
        // anonymous store. clearFirebaseIdentity() clears the flag first, so a
        // deliberate wipe still goes through.
        if (this.identityLoadFailed && Object.keys(this.identityStore.accounts).length === 0) {
            console.warn('[CredentialsManager] Refusing to overwrite identity store: previous load failed and in-memory state is empty');
            this.track('credentials_store_write_blocked', { store: 'identity', reason: 'load_failed_empty_state' });
            return;
        }

        try {
            const data = JSON.stringify(this.identityStore);
            if (!safeStorage.isEncryptionAvailable()) {
                const plain = IDENTITY_PATH + '.json';
                const tmp = plain + '.tmp';
                fs.writeFileSync(tmp, data);
                fs.renameSync(tmp, plain);
                return;
            }
            const encrypted = safeStorage.encryptString(data);
            const tmp = IDENTITY_PATH + '.tmp';
            fs.writeFileSync(tmp, encrypted);
            fs.renameSync(tmp, IDENTITY_PATH);
            // The file now matches memory again.
            this.identityLoadFailed = false;
        } catch (e) {
            console.error('[CredentialsManager] Failed to save identity:', e);
            this.track('credentials_store_write_blocked', {
                store: 'identity',
                reason: 'write_error',
                errorName: e instanceof Error ? e.name : 'Unknown',
            });
        }
    }

    private loadIdentity(): void {
        const encExists = fs.existsSync(IDENTITY_PATH);
        const plainExists = fs.existsSync(IDENTITY_PATH + '.json');
        let result = 'empty';
        let errorName: string | null = null;
        this.identityLoadFailed = false;

        try {
            if (encExists && safeStorage.isEncryptionAvailable()) {
                const decrypted = safeStorage.decryptString(fs.readFileSync(IDENTITY_PATH));
                const parsed = JSON.parse(decrypted);
                if (parsed && parsed.accounts) {
                    this.identityStore = parsed;
                    result = 'loaded';
                } else if (parsed && parsed.firebaseUid) {
                    // migrate old single-identity format → accounts map
                    this.identityStore = {
                        lastUid: parsed.firebaseUid,
                        accounts: { [parsed.firebaseUid]: { ...parsed, updatedAt: Date.now() } },
                    };
                    this.saveIdentity();
                    result = 'migrated';
                } else {
                    result = 'unrecognized_shape';
                }
            } else if (encExists && !safeStorage.isEncryptionAvailable()) {
                // The file exists but we cannot read it — that is NOT "no accounts".
                this.identityLoadFailed = true;
                result = 'encryption_unavailable';
            } else {
                const plain = IDENTITY_PATH + '.json';
                if (plainExists) {
                    const parsed = JSON.parse(fs.readFileSync(plain, 'utf-8'));
                    if (parsed && parsed.accounts) {
                        this.identityStore = parsed;
                        result = 'loaded_plaintext';
                    } else if (parsed && parsed.firebaseUid) {
                        // migrate old single-identity format → accounts map
                        this.identityStore = {
                            lastUid: parsed.firebaseUid,
                            accounts: { [parsed.firebaseUid]: { ...parsed, updatedAt: Date.now() } },
                        };
                        this.saveIdentity();
                        result = 'migrated_plaintext';
                    } else {
                        result = 'unrecognized_shape';
                    }
                }
            }
        } catch (e) {
            console.error('[CredentialsManager] Failed to load identity:', e);
            this.identityStore = { accounts: {} };
            this.identityLoadFailed = true;
            errorName = e instanceof Error ? e.name : 'Unknown';
            result = 'read_failed';
        }

        this.track('identity_store_load', {
            result,
            errorName,
            fileExisted: encExists || plainExists,
            encryptionAvailable: safeStorage.isEncryptionAvailable(),
            accountCount: Object.keys(this.identityStore.accounts).length,
            hasLastUid: !!this.identityStore.lastUid,
        });
    }

    /**
     * True when nothing meaningful is stored — only the defaults applyDefaults()
     * puts in. Used to tell "user has no credentials" apart from "we lost them".
     */
    private isEffectivelyEmpty(): boolean {
        for (const [key, value] of Object.entries(this.credentials)) {
            if (key === 'defaultModel' || key === 'sttProvider') continue; // applied by applyDefaults()
            if (value === undefined || value === null) continue;
            if (typeof value === 'string') { if (value.trim().length > 0) return false; continue; }
            if (Array.isArray(value)) { if (value.length > 0) return false; continue; }
            if (typeof value === 'object') { if (Object.keys(value).length > 0) return false; continue; }
            return false; // booleans / numbers are real settings
        }
        return true;
    }

    /**
     * Decide whether this write is allowed to touch the credentials file.
     * Returns false to abort the write.
     */
    private prepareCredentialsWrite(): boolean {
        const plainPath = this.credentialsPath + '.json';
        const fileExists = fs.existsSync(this.credentialsPath) || fs.existsSync(plainPath);
        if (!fileExists) return true;

        // Guard 1 — the destructive case behind "my keys reset themselves".
        // If we could not read the file (macOS safeStorage can stop decrypting a
        // file an earlier build wrote) or memory was scrubbed for a quit that got
        // vetoed, then `{}` in memory means "unknown", not "empty". Any background
        // save (echo-align seed, knowledge mode, STT provider) would otherwise
        // write that emptiness over the user's real keys.
        if (this.isEffectivelyEmpty() && (!this.memoryTrusted || this.loadState === 'failed')) {
            console.warn('[CredentialsManager] Refusing to overwrite stored credentials with an empty set (memory is not authoritative)');
            this.track('credentials_store_write_blocked', {
                store: 'credentials',
                reason: this.loadState === 'failed' ? 'load_failed_empty_state' : 'memory_scrubbed',
                loadFailureReason: this.loadFailureReason,
            });
            return false;
        }

        // Guard 2 — a real mutation, but the file on disk is unreadable. Keep the
        // original bytes under .unreadable-<ts> so they stay recoverable (a signed
        // build, or a later Keychain unlock, can still decrypt them) instead of
        // overwriting them in place.
        if (this.loadState === 'failed') {
            const backup = `${this.credentialsPath}.unreadable-${Date.now()}`;
            try {
                if (fs.existsSync(this.credentialsPath)) fs.renameSync(this.credentialsPath, backup);
                console.warn(`[CredentialsManager] Unreadable credentials file moved aside: ${path.basename(backup)}`);
                this.track('credentials_store_recovered', {
                    store: 'credentials',
                    action: 'backed_up_unreadable_file',
                    loadFailureReason: this.loadFailureReason,
                });
            } catch (e) {
                console.warn('[CredentialsManager] Could not back up unreadable credentials file:', e);
            }
            this.loadState = 'ok';
            this.loadFailureReason = null;
        }
        return true;
    }

    private saveCredentials(): void {
        if (!this.prepareCredentialsWrite()) return;

        try {
            if (!safeStorage.isEncryptionAvailable()) {
                console.warn('[CredentialsManager] Encryption not available, falling back to plaintext');
                // Fallback: save as plaintext (less secure, but functional)
                const plainPath = this.credentialsPath + '.json';
                const tmpPlain = plainPath + '.tmp';
                fs.writeFileSync(tmpPlain, JSON.stringify(this.credentials));
                fs.renameSync(tmpPlain, plainPath);
                this.memoryTrusted = true;
                return;
            }

            const data = JSON.stringify(this.credentials);
            const encrypted = safeStorage.encryptString(data);
            const tmpEnc = this.credentialsPath + '.tmp';
            fs.writeFileSync(tmpEnc, encrypted);
            fs.renameSync(tmpEnc, this.credentialsPath);
            // File and memory agree again.
            this.memoryTrusted = true;
        } catch (error) {
            console.error('[CredentialsManager] Failed to save credentials:', error);
            this.track('credentials_store_write_blocked', {
                store: 'credentials',
                reason: 'write_error',
                errorName: error instanceof Error ? error.name : 'Unknown',
            });
        }
    }

    /**
     * Defaults are applied on EVERY load path, including the failure paths. The
     * old code applied them only on success, so a decrypt error left defaultModel
     * and sttProvider undefined until something happened to save them.
     */
    private applyDefaults(): void {
        if (!this.credentials.defaultModel) this.credentials.defaultModel = 'gemini-3.1-flash-lite-preview';
        if (!this.credentials.sttProvider) this.credentials.sttProvider = 'deepgram';
    }

    /** Drop a leftover plaintext file once the encrypted one has been read. */
    private cleanupStalePlaintextFile(): void {
        const plaintextPath = this.credentialsPath + '.json';
        if (!fs.existsSync(plaintextPath)) return;
        try {
            fs.unlinkSync(plaintextPath);
            console.log('[CredentialsManager] Removed stale plaintext credential file');
        } catch (cleanupErr) {
            console.warn('[CredentialsManager] Could not remove stale plaintext file:', cleanupErr);
        }
    }

    private loadCredentials(): void {
        const plaintextPath = this.credentialsPath + '.json';
        const encExists = fs.existsSync(this.credentialsPath);
        const plainExists = fs.existsSync(plaintextPath);
        let result = 'empty';
        let errorName: string | null = null;

        // Optimistic; the failure branches below flip these.
        this.credentials = {};
        this.loadState = 'ok';
        this.loadFailureReason = null;
        this.memoryTrusted = true;

        if (encExists && !safeStorage.isEncryptionAvailable()) {
            // The file exists and holds keys we cannot read right now. Reporting
            // that as "no credentials" is what allowed the next save to wipe it.
            console.warn('[CredentialsManager] Encryption unavailable — stored credentials cannot be read');
            this.loadState = 'failed';
            this.loadFailureReason = 'encryption_unavailable';
            this.memoryTrusted = false;
            result = 'encryption_unavailable';
        } else if (encExists) {
            try {
                const decrypted = safeStorage.decryptString(fs.readFileSync(this.credentialsPath));
                try {
                    const parsed = JSON.parse(decrypted);
                    if (typeof parsed !== 'object' || parsed === null) {
                        throw new Error('Decrypted credentials is not a valid object');
                    }
                    this.credentials = parsed;
                    result = 'loaded';
                    console.log('[CredentialsManager] Loaded encrypted credentials');
                } catch (parseError) {
                    // Decryptable but not valid JSON — the content really is
                    // corrupt, so starting fresh (and allowing saves) is correct.
                    console.error('[CredentialsManager] Failed to parse decrypted credentials — file may be corrupted. Starting fresh:', parseError);
                    result = 'parse_failed';
                    errorName = parseError instanceof Error ? parseError.name : 'Unknown';
                }
                // Clean up any leftover plaintext fallback file to eliminate the data leak
                this.cleanupStalePlaintextFile();
            } catch (decryptError) {
                // Cannot decrypt. On macOS this is the safeStorage/Keychain case:
                // the Keychain item's ACL is bound to the app's code signature, and
                // an unsigned build's signature changes on every release, so a file
                // the previous build wrote stops decrypting even though
                // isEncryptionAvailable() still returns true. The bytes are intact,
                // so mark the store unreadable and let the write guard protect them.
                console.error('[CredentialsManager] Failed to decrypt stored credentials:', decryptError);
                this.loadState = 'failed';
                this.loadFailureReason = 'decrypt_failed';
                this.memoryTrusted = false;
                result = 'decrypt_failed';
                errorName = decryptError instanceof Error ? decryptError.name : 'Unknown';
            }
        } else if (plainExists) {
            try {
                const parsed = JSON.parse(fs.readFileSync(plaintextPath, 'utf-8'));
                if (typeof parsed !== 'object' || parsed === null) {
                    throw new Error('Plaintext credentials is not a valid object');
                }
                this.credentials = parsed;
                result = 'loaded_plaintext';
                console.log('[CredentialsManager] Loaded plaintext credentials');
            } catch (readError) {
                console.error('[CredentialsManager] Failed to read plaintext credentials — file may be corrupted. Starting fresh:', readError);
                result = 'plaintext_read_failed';
                errorName = readError instanceof Error ? readError.name : 'Unknown';
            }
        } else {
            console.log('[CredentialsManager] No stored credentials found. Using defaults.');
        }
        this.applyDefaults();

        // The macOS diagnostic: one event per load saying whether the store came
        // back, and if not, exactly how it failed.
        this.track('credentials_store_load', {
            result,
            errorName,
            fileExisted: encExists || plainExists,
            encryptionAvailable: safeStorage.isEncryptionAvailable(),
            userKeyCount: ALL_KEY_PROVIDERS.filter(p => this.hasUserKey(p)).length,
            settingCount: Object.keys(this.credentials).length,
            loadState: this.loadState,
        });
    }

    /**
     * Delete ONLY the current user's credentials file (credentials-<uid>.enc
     * and any .json fallback). Does NOT touch other users' credential files
     * or the machine-level identity.enc.
     */
    public deleteCurrentUserCredentialsFile(): void {
        this.scrubMemory();
        for (const p of [this.credentialsPath, this.credentialsPath + '.json']) {
            try {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch (e) {
                console.warn('[CredentialsManager] Failed to delete credentials file:', p, e);
            }
        }
        // Deliberate wipe: memory (empty) and disk (gone) agree again, so later
        // writes must not be blocked by the post-scrub guard.
        this.loadState = 'ok';
        this.loadFailureReason = null;
        this.memoryTrusted = true;
        this.applyDefaults();
        console.log('[CredentialsManager] Current user credentials file deleted');
    }

    /** The current user's credentials file path (for external cleanup helpers). */
    public getCredentialsPath(): string {
        return this.credentialsPath;
    }

}
