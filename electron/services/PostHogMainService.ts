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

const POSTHOG_KEY = process.env.VITE_POSTHOG_KEY ?? '';
const POSTHOG_HOST = process.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com';

// Fallback distinct_id when no user is signed in yet (e.g. a crash during
// startup/auth). Not persisted — just keeps events from being dropped.
const ANONYMOUS_DISTINCT_ID = 'main-process-anonymous';

class PostHogMainService {
    private static instance: PostHogMainService;
    private client: PostHog | null = null;

    private constructor() { }

    public static getInstance(): PostHogMainService {
        if (!PostHogMainService.instance) {
            PostHogMainService.instance = new PostHogMainService();
        }
        return PostHogMainService.instance;
    }

    public init(): void {
        if (this.client) return;

        if (!POSTHOG_KEY) {
            console.warn('[PostHogMain] VITE_POSTHOG_KEY not set — main-process error reporting disabled.');
            return;
        }

        try {
            this.client = new PostHog(POSTHOG_KEY, {
                host: POSTHOG_HOST,
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