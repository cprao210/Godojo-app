// electron/db/SupabaseClient.ts
//
// Singleton Supabase client wired for Firebase third-party authentication.
//
// Flow:
//   1. Project URL + anon key come from CredentialsManager (or env vars during
//      development). The anon key alone gives NO read/write access — every
//      table is protected by RLS keyed off auth.jwt() -> 'sub'.
//   2. The renderer signs the user in via Firebase and forwards the resulting
//      ID token to main via the `auth:set-id-token` IPC, which calls
//      AuthManager.setSession(). The ID token rotates ~hourly via the
//      renderer's onIdTokenChanged callback (no main-side refresh logic).
//   3. supabase-js v2 calls the `accessToken` async callback before every
//      request; we return the current Firebase ID token from AuthManager so
//      Supabase verifies it against Firebase's JWKS and applies RLS as that
//      uid.
//
// IMPORTANT: never ship a service-role key in the desktop bundle. The anon
// key + RLS is the security boundary.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { AuthManager } from '../services/AuthManager';
import { CredentialsManager } from '../services/CredentialsManager';

export class SupabaseClientManager {
    private static _client: SupabaseClient | null = null;
    private static _url: string | null = null;
    private static _anonKey: string | null = null;

    /**
     * Configure (or reconfigure) the singleton client.
     * Safe to call multiple times — only recreates if URL/key changed.
     */
    static configure(url: string, anonKey: string): void {
        if (!url || !anonKey) return;
        if (url === this._url && anonKey === this._anonKey && this._client) return;

        this._url = url;
        this._anonKey = anonKey;

        // The `accessToken` option (supabase-js v2.43+) is called before every
        // request — perfect for token-per-request strategies like Firebase.
        // We disable supabase-js's own auth machinery (persistSession, etc.)
        // since Firebase owns the session lifecycle in the renderer.
        //
        // Electron's main process runs in Node — which prior to Node 22 has no
        // global WebSocket. @supabase/realtime-js >= 2.11 fails fast unless we
        // hand it a transport, so we pass the `ws` package. (We don't actually
        // use realtime today, but the client constructor still instantiates it.)
        this._client = createClient(url, anonKey, {
            auth: { persistSession: false, autoRefreshToken: false },
            accessToken: async () => AuthManager.getInstance().getIdToken() ?? '',
            realtime: { transport: WebSocket as any },
        } as any);

        console.log('[SupabaseClient] Client configured for:', url);
    }

    /**
     * Initialize from persisted credentials. Called once on app boot.
     */
    static init(): void {
        // 1. CredentialsManager (set via the Settings UI)
        try {
            const creds = CredentialsManager.getInstance().getSupabaseCredentials();
            if (creds) {
                this.configure(creds.url, creds.anonKey);
                return;
            }
        } catch (_) {
            // CredentialsManager not initialized yet — fall through to env vars
        }

        // 2. Env vars (development convenience)
        const envUrl = process.env.SUPABASE_URL;
        const envKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
        if (envUrl && envKey) this.configure(envUrl, envKey);
    }

    /**
     * Return the active client, or null if not yet configured.
     */
    static getClient(): SupabaseClient | null {
        if (!this._client) this.init(); // lazy init for first access
        return this._client;
    }

    /**
     * True iff the project is configured AND a Firebase user is signed in.
     * The mirror service uses this to decide whether to attempt network writes
     * (otherwise items just sit in the local outbox).
     */
    static isConfigured(): boolean {
        return this._client !== null && AuthManager.getInstance().isSignedIn();
    }

    /** True iff the project URL/anonKey are set, regardless of sign-in state. */
    static hasCredentials(): boolean {
        return this._client !== null;
    }

    /** Wipe stored credentials and destroy the client (e.g. uninstall sync). */
    static reset(): void {
        this._client = null;
        this._url = null;
        this._anonKey = null;
    }

    /** Current Firebase uid for callers that need to stamp `user_id` on rows. */
    static getCurrentUserId(): string | null {
        return AuthManager.getInstance().getUid();
    }
}

