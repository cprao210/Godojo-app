import { QueryClient, QueryCache, MutationCache } from "react-query";
import { ApiError, notifyInvalidSession } from "./apiClient";

/**
 * Routes HTTP auth failures (a terminal 401 from apiClient, surfaced through
 * React Query) into the same session-expired flow as the Firebase guard.
 *
 * Lives at module scope (not inside a component) because the QueryClient
 * itself is a module-scope singleton and can't close over React state — it
 * hands off via the apiClient bridge (notifyInvalidSession), which
 * `useFirebaseAuth` wires up to its own handleInvalidSession.
 */
function handleApiError(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
        notifyInvalidSession(error.code);
    }
}

export const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: handleApiError }),
    mutationCache: new MutationCache({ onError: handleApiError }),
    defaultOptions: {
        queries: {
            // react-query v3 defaults refetchOnWindowFocus to true. In a desktop
            // Electron app the window regains focus constantly — every time you
            // tab back from the Zoom/Meet window, toggle the overlay, or click
            // into the launcher — and each focus refetches EVERY stale query.
            // That's what floods the network tab with repeated "fetch all
            // meetings" (GET /meetings) calls. We already keep the list fresh
            // explicitly: the main process pushes a `meetings-updated` IPC event
            // on every lifecycle change (see MeetingPersistence.ts) which
            // invalidates ['meetings'], plus a manual refresh button and a 3s
            // poll while a meeting is still processing. So focus-triggered
            // refetching is pure redundant traffic here — turn it off globally.
            refetchOnWindowFocus: false,
        },
    },
});