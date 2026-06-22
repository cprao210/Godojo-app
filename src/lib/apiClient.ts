// src/lib/apiClient.ts
//
// Shared HTTP client for the GoDojo FastAPI backend. One module owns:
//   - the base URL (per-env via VITE_API_BASE_URL),
//   - attaching the Firebase ID token as a Bearer header,
//   - parsing the {"error":{code,message,details?}} envelope into a typed ApiError,
//   - refreshing the token once on a 401 and retrying.
//
// The renderer already owns the Firebase user (src/lib/firebase.ts), so the token
// is read directly here — no IPC round-trip.

import { getFirebaseAuth } from "./firebase";

const BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:8000";

/** Typed error carrying the backend envelope's code + optional details. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Invalid-session bridge ──────────────────────────────────────────────────
// The QueryClient is constructed at module scope in App.tsx, so it can't close
// over React state. App.tsx registers a handler here; the QueryCache /
// MutationCache onError (and any direct caller) routes a terminal 401 through
// notifyInvalidSession so HTTP auth failures drive the SAME session-expired UX
// as the Firebase session guard (installSessionGuard).
let invalidSessionHandler: ((code?: string) => void) | null = null;

export function setInvalidSessionHandler(fn: ((code?: string) => void) | null): void {
  invalidSessionHandler = fn;
}

export function notifyInvalidSession(code?: string): void {
  invalidSessionHandler?.(code);
}

async function authHeader(forceRefresh = false): Promise<Record<string, string>> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new ApiError(401, "unauthorized", "Not signed in");
  const token = await user.getIdToken(forceRefresh);
  return { Authorization: `Bearer ${token}` };
}

/**
 * Fetch `${BASE}/api/v1${path}`. Attaches the Bearer token, retries once with a
 * force-refreshed token on the first 401, and throws ApiError on any non-2xx
 * (or network failure → synthesized service_unavailable). 204 resolves to undefined.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
        ...(await authHeader(retried)),
      },
    });
  } catch (e) {
    // Backend down / DNS / CSP-blocked fetch never reaches an HTTP status —
    // surface it as the same 503 path the UI maps to "backend unavailable".
    throw new ApiError(503, "service_unavailable", "Backend unavailable", String(e));
  }

  // Stale token → force-refresh once and retry the whole request.
  if (res.status === 401 && !retried) {
    return apiFetch<T>(path, init, true);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; details?: unknown } }
      | null;
    const err = body?.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? "error",
      err.message ?? res.statusText,
      err.details,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
