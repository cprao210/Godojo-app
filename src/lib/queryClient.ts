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
});