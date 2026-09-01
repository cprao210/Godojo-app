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


    /**
     * Re-point at the given user's credentials file. Called on sign-in / restore /
     * account switch — mirrors DatabaseManager.switchUser so keys never leak
     * between accounts. The Firebase identity file is untouched (machine-level).
     */
    public switchUser(uid: string | null): void {
        const nextPath = credentialsPathForUid(uid);
        if (nextPath === this.credentialsPath) return; // already on this user's file
        console.log(`[CredentialsManager] Switching credentials: ${this.currentUid ?? 'anon'} -> ${uid ?? 'anon'}`);
        // Persist current user's creds before swapping (setters already auto-save,
        // but flush defensively), then scrub and load the target user's file.
        try { this.saveCredentials(); } catch { /* best-effort */ }
        this.credentials = {};
        this.clearFallbackKeys(); // backend fallback keys are per-user (fetched with their token)
        this.currentUid = uid;
        this.credentialsPath = nextPath;
        this.loadCredentials();
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

                        this.fallbackKeys[keyObj.provider.toLowerCase()] = decrypted;

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
    // =========================================================================

    public getGeminiApiKey(): string | undefined {
        return this.credentials.geminiApiKey || this.fallbackKeys['gemini'] || process.env.GEMINI_API_KEY;
    }

    public getGroqApiKey(): string | undefined {
        return this.credentials.groqApiKey || this.fallbackKeys['groq'] || process.env.GROQ_API_KEY;
    }

    public getOpenaiApiKey(): string | undefined {
        return this.credentials.openaiApiKey || this.fallbackKeys['openai'];
    }

    public getClaudeApiKey(): string | undefined {
        return this.credentials.claudeApiKey || this.fallbackKeys['claude'];
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
        return this.credentials.deepgramApiKey || this.fallbackKeys['deepgram'] || process.env.DEEPGRAM_API_KEY;
    }

    public getGroqSttApiKey(): string | undefined {
        return this.credentials.groqSttApiKey || this.fallbackKeys['groq'];
    }

    public getGroqSttModel(): string {
        return this.credentials.groqSttModel || 'whisper-large-v3-turbo';
    }

    public getOpenAiSttApiKey(): string | undefined {
        return this.credentials.openAiSttApiKey || this.fallbackKeys['openai'];
    }

    public getElevenLabsApiKey(): string | undefined {
        return this.credentials.elevenLabsApiKey || this.fallbackKeys['elevenlabs'];
    }

    public getAzureApiKey(): string | undefined {
        return this.credentials.azureApiKey || process.env.AZURE_SPEECH_API_KEY || process.env.AZURE_SPEECH_KEY;
    }

    public getAzureRegion(): string {
        return this.credentials.azureRegion || process.env.AZURE_SPEECH_REGION || 'southeastasia';
    }

    public getIbmWatsonApiKey(): string | undefined {
        return this.credentials.ibmWatsonApiKey;
    }

    public getIbmWatsonRegion(): string {
        return this.credentials.ibmWatsonRegion || 'us-south';
    }

    public getSonioxApiKey(): string | undefined {
        return this.credentials.sonioxApiKey;
    }

    public getTavilyApiKey(): string | undefined {
        return this.credentials.tavilyApiKey || this.fallbackKeys['tavily'] || process.env.TAVILY_API_KEY;
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

    public setGeminiApiKey(key: string): void {
        this.credentials.geminiApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Gemini API Key updated');
    }

    public setGroqApiKey(key: string): void {
        this.credentials.groqApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Groq API Key updated');
    }

    public setOpenaiApiKey(key: string): void {
        this.credentials.openaiApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] OpenAI API Key updated');
    }

    public setClaudeApiKey(key: string): void {
        this.credentials.claudeApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Claude API Key updated');
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
        this.credentials.deepgramApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Deepgram API Key updated');
    }

    public setGroqSttApiKey(key: string): void {
        this.credentials.groqSttApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Groq STT API Key updated');
    }

    public setOpenAiSttApiKey(key: string): void {
        this.credentials.openAiSttApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] OpenAI STT API Key updated');
    }

    public setGroqSttModel(model: string): void {
        this.credentials.groqSttModel = model;
        this.saveCredentials();
        console.log(`[CredentialsManager] Groq STT Model set to: ${model}`);
    }

    public setElevenLabsApiKey(key: string): void {
        this.credentials.elevenLabsApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] ElevenLabs API Key updated');
    }

    public setAzureApiKey(key: string): void {
        this.credentials.azureApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Azure API Key updated');
    }

    public setAzureRegion(region: string): void {
        this.credentials.azureRegion = region;
        this.saveCredentials();
        console.log(`[CredentialsManager] Azure Region set to: ${region}`);
    }

    public setIbmWatsonApiKey(key: string): void {
        this.credentials.ibmWatsonApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] IBM Watson API Key updated');
    }

    public setIbmWatsonRegion(region: string): void {
        this.credentials.ibmWatsonRegion = region;
        this.saveCredentials();
        console.log(`[CredentialsManager] IBM Watson Region set to: ${region}`);
    }

    public setSonioxApiKey(key: string): void {
        this.credentials.sonioxApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Soniox API Key updated');
    }

    public setTavilyApiKey(key: string): void {
        // Store undefined (not empty string) when removing, so hasKey() checks stay consistent
        this.credentials.tavilyApiKey = key.trim() || undefined;
        this.saveCredentials();
        console.log('[CredentialsManager] Tavily API Key updated');
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
        console.log('[CredentialsManager] Memory scrubbed');
    }

    // =========================================================================
    // Storage (Encrypted)
    // =========================================================================

    private saveIdentity(): void {
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
        } catch (e) {
            console.error('[CredentialsManager] Failed to save identity:', e);
        }
    }

    private loadIdentity(): void {
        try {
            if (fs.existsSync(IDENTITY_PATH) && safeStorage.isEncryptionAvailable()) {
                const decrypted = safeStorage.decryptString(fs.readFileSync(IDENTITY_PATH));
                const parsed = JSON.parse(decrypted);
                if (parsed && parsed.accounts) {
                    this.identityStore = parsed;
                } else if (parsed && parsed.firebaseUid) {
                    // migrate old single-identity format → accounts map
                    this.identityStore = {
                        lastUid: parsed.firebaseUid,
                        accounts: { [parsed.firebaseUid]: { ...parsed, updatedAt: Date.now() } },
                    };
                    this.saveIdentity();
                }
                return;
            }
            const plain = IDENTITY_PATH + '.json';
            if (fs.existsSync(plain)) {
                const parsed = JSON.parse(fs.readFileSync(plain, 'utf-8'));
                if (parsed && parsed.accounts) {
                    this.identityStore = parsed;
                } else if (parsed && parsed.firebaseUid) {
                    // migrate old single-identity format → accounts map
                    this.identityStore = {
                        lastUid: parsed.firebaseUid,
                        accounts: { [parsed.firebaseUid]: { ...parsed, updatedAt: Date.now() } },
                    };
                    this.saveIdentity();
                }
            }
        } catch (e) {
            console.error('[CredentialsManager] Failed to load identity:', e);
            this.identityStore = { accounts: {} };
        }
    }

    private saveCredentials(): void {
        try {
            if (!safeStorage.isEncryptionAvailable()) {
                console.warn('[CredentialsManager] Encryption not available, falling back to plaintext');
                // Fallback: save as plaintext (less secure, but functional)
                const plainPath = this.credentialsPath + '.json';
                const tmpPlain = plainPath + '.tmp';
                fs.writeFileSync(tmpPlain, JSON.stringify(this.credentials));
                fs.renameSync(tmpPlain, plainPath);
                return;
            }

            const data = JSON.stringify(this.credentials);
            const encrypted = safeStorage.encryptString(data);
            const tmpEnc = this.credentialsPath + '.tmp';
            fs.writeFileSync(tmpEnc, encrypted);
            fs.renameSync(tmpEnc, this.credentialsPath);
        } catch (error) {
            console.error('[CredentialsManager] Failed to save credentials:', error);
        }
    }

    private loadCredentials(): void {
        try {
            // Try encrypted file first
            if (fs.existsSync(this.credentialsPath)) {
                if (!safeStorage.isEncryptionAvailable()) {
                    console.warn('[CredentialsManager] Encryption not available for load');
                    return;
                }

                const encrypted = fs.readFileSync(this.credentialsPath);
                const decrypted = safeStorage.decryptString(encrypted);
                try {
                    const parsed = JSON.parse(decrypted);
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.credentials = parsed;
                        console.log('[CredentialsManager] Loaded encrypted credentials');
                    } else {
                        throw new Error('Decrypted credentials is not a valid object');
                    }
                } catch (parseError) {
                    console.error('[CredentialsManager] Failed to parse decrypted credentials — file may be corrupted. Starting fresh:', parseError);
                    this.credentials = {};
                }

                // Clean up any leftover plaintext fallback file to eliminate the data leak
                const plaintextPath = this.credentialsPath + '.json';
                if (fs.existsSync(plaintextPath)) {
                    try {
                        fs.unlinkSync(plaintextPath);
                        console.log('[CredentialsManager] Removed stale plaintext credential file');
                    } catch (cleanupErr) {
                        console.warn('[CredentialsManager] Could not remove stale plaintext file:', cleanupErr);
                    }
                }
                // If the user hasn't explicitly set a default model, rely on the bundled fallback
                if (!this.credentials.defaultModel) {
                    this.credentials.defaultModel = 'gemini-3.1-flash-lite-preview';
                }

                // Set default STT Provider if not set
                if (!this.credentials.sttProvider) {
                    this.credentials.sttProvider = 'deepgram';
                }

                return;
            }

            // Fallback: try plaintext file
            const plaintextPath = this.credentialsPath + '.json';
            if (fs.existsSync(plaintextPath)) {
                const data = fs.readFileSync(plaintextPath, 'utf-8');
                try {
                    const parsed = JSON.parse(data);
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.credentials = parsed;
                        console.log('[CredentialsManager] Loaded plaintext credentials');
                    } else {
                        throw new Error('Plaintext credentials is not a valid object');
                    }
                } catch (parseError) {
                    console.error('[CredentialsManager] Failed to parse plaintext credentials — file may be corrupted. Starting fresh:', parseError);
                    this.credentials = {};
                }

                // Apply defaults for missing fields
                if (!this.credentials.defaultModel) this.credentials.defaultModel = 'gemini-3.1-flash-lite-preview';
                if (!this.credentials.sttProvider) this.credentials.sttProvider = 'deepgram';

                return;
            }

            console.log('[CredentialsManager] No stored credentials found. Using defaults.');
            this.credentials = {
                defaultModel: 'gemini-3.1-flash-lite-preview',
                sttProvider: 'deepgram'
            };
        } catch (error) {
            console.error('[CredentialsManager] Failed to load credentials:', error);
            this.credentials = {};
        }
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
        console.log('[CredentialsManager] Current user credentials file deleted');
    }

    /** The current user's credentials file path (for external cleanup helpers). */
    public getCredentialsPath(): string {
        return this.credentialsPath;
    }

}
