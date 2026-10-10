// PostHogMainService.ts
//
// Error reporting for the Electron MAIN process. posthog-js (the renderer's
// client, see src/lib/analytics/posthog.service.ts) does not run under
// Node — this is the separate posthog-node client for:
//   - process.on('uncaughtException' | 'unhandledRejection') in main.ts
//   - app.on('render-process-gone' | 'child-process-gone') renderer crashes
//   - errors relayed from the renderer via the 'log-error-to-main' IPC
//     channel (see ipcHandlers.ts), for parity with the old dead
//     electronAPI.logErrorToMain() call ErrorBoundary was already making.
//
// One client for the whole main process (unlike the renderer, which inits
// per-BrowserWindow) — there's only one main process.

import { PostHog } from 'posthog-node';
import { AuthManager } from './AuthManager';
import { tenantContext } from './TenantContext';

// NOTE: the key/host are read inside init(), NOT at module load. main.ts loads the runtime
// `.env` (dotenv) a few lines after its imports, and this module can be pulled in earlier by
// any importer (e.g. utils/llmUsageBus at the very top of main.ts). A module-level read would
// freeze an empty key forever and silently disable every main-process event.
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

// Fallback distinct_id when no user is signed in yet (e.g. a crash during
// startup/auth). Not persisted — just keeps events from being dropped.
const ANONYMOUS_DISTINCT_ID = 'main-process-anonymous';

class PostHogMainService {
    private static instance: PostHogMainService;
    private client: PostHog | null = null;
    private warnedDropped = false;

    private constructor() { }

    public static getInstance(): PostHogMainService {
        if (!PostHogMainService.instance) {
            PostHogMainService.instance = new PostHogMainService();
        }
        return PostHogMainService.instance;
    }

    public init(quiet = false): void {
        if (this.client) return;

        const key = process.env.VITE_POSTHOG_KEY ?? '';
        const host = process.env.VITE_POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
        if (!key) {
            if (!quiet) console.warn('[PostHogMain] VITE_POSTHOG_KEY not set — main-process error reporting disabled.');
            return;
        }

        try {
            this.client = new PostHog(key, {
                host,
                // Main process is short-lived-flush-wise compared to a
                // browser tab — flush eagerly rather than batching, so a
                // crash right after capture() doesn't lose the event.
                flushAt: 1,
                flushInterval: 0,
            });
            console.log('[PostHogMain] Initialized.');
        } catch (error) {
            console.warn('[PostHogMain] Initialization failed:', error);
        }
    }

    /**
     * Self-heal: if an event arrives before init() succeeded (env not loaded yet, or init never
     * ran on this path), try to init now; if there is still no client, say so ONCE instead of
     * dropping events silently.
     */
    private ensureClient(what: string): boolean {
        if (!this.client) this.init(true);
        if (this.client) return true;
        if (!this.warnedDropped) {
            this.warnedDropped = true;
            console.warn(`[PostHogMain] No client (VITE_POSTHOG_KEY missing) -- main-process events are being dropped, first: "${what}".`);
        }
        return false;
    }

    private currentDistinctId(): string {
        try {
            const uid = AuthManager.getInstance().getUid();
            if (uid) return uid;
        } catch {
            // AuthManager not ready yet — fall through to anonymous
        }
        return ANONYMOUS_DISTINCT_ID;
    }

    /**
     * Generic event capture for the main process (parity with
     * posthogAnalytics.trackEvent() in the renderer). Use for one-off
     * diagnostic/status events fired from main.ts, e.g.
     * 'env_fallback_keys_status'.
     */
    public capture(eventName: string, properties?: Record<string, any>): void {
        if (!this.ensureClient(eventName)) return;
        if (!this.client) return;

        try {
            const tenantId = tenantContext.get();
            this.client.capture({
                distinctId: this.currentDistinctId(),
                event: eventName,
                properties: {
                    process: 'main',
                    ...(tenantId ? { $groups: { tenant: tenantId } } : {}),
                    ...properties,
                },
            });
        } catch (captureError) {
            console.warn('[PostHogMain] Failed to capture event:', captureError);
        }
    }

    /**
     * Report an exception from the main process. `source` identifies where
     * it came from (e.g. "uncaughtException", "render-process-gone",
     * "renderer-error-boundary") so it's filterable in PostHog next to the
     * renderer-side $exception events.
     */
    public captureException(error: Error | unknown, source: string, extra?: Record<string, any>): void {
        if (!this.ensureClient(`exception:${source}`)) return;
        if (!this.client) return;

        try {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            const tenantId = tenantContext.get();
            this.client.captureException(normalizedError, this.currentDistinctId(), {
                process: 'main',
                source,
                ...(tenantId ? { $groups: { tenant: tenantId } } : {}),
                ...extra,
            });
        } catch (captureError) {
            console.warn('[PostHogMain] Failed to capture exception:', captureError);
        }
    }

    /** Call on app quit so buffered events aren't dropped. */
    public async shutdown(): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.shutdown();
        } catch (error) {
            console.warn('[PostHogMain] Shutdown failed:', error);
        }
    }
}

export const posthogMain = PostHogMainService.getInstance();