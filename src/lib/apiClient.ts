// src/lib/apiClient.ts
//
// Shared HTTP client for the GoDojo FastAPI backend, built on a single axios
// instance. One module owns:
//   - the base URL (per-env via VITE_API_BASE_URL),
//   - attaching the Firebase ID token as a Bearer header (request interceptor),
//   - parsing the {"error":{code,message,details?}} envelope into a typed ApiError,
//   - refreshing the token once on a 401 and retrying (response interceptor),
//   - surfacing network/timeout failures as a 503 ApiError.
//
// The renderer already owns the Firebase user (src/lib/firebase.ts), so the token
// is read directly here — no IPC round-trip. `apiFetch` keeps its fetch-era
// signature so existing callers (meetingsApi, App.tsx) are unchanged.

import axios, {
  AxiosError,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
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

// Per-request config flag: set once a 401 has triggered a force-refresh retry,
// so the request interceptor force-refreshes the token and we never loop.
type RetryConfig = InternalAxiosRequestConfig & { _retry?: boolean };

const http = axios.create({
  baseURL: `${BASE}/api/v1`,
  // Bound every request (preserves the 60s ceiling the live-analysis IPC path had).
  timeout: 60_000,
  headers: { "Content-Type": "application/json" },
});

// Request: attach the Firebase ID token. Force-refresh only on the retry pass.
http.interceptors.request.use(async (config: RetryConfig) => {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new ApiError(401, "unauthorized", "Not signed in");
  const token = await user.getIdToken(Boolean(config._retry));
  config.headers.set("Authorization", `Bearer ${token}`);
  return config;
});

// Response: 401 → force-refresh + retry once; else map to a typed ApiError.
http.interceptors.response.use(
  (res) => res,
  async (error: unknown) => {
    // The request interceptor's "not signed in" ApiError lands here too — pass it through.
    if (error instanceof ApiError) throw error;

    const axiosError = error as AxiosError;
    const config = axiosError.config as RetryConfig | undefined;

    // Stale token → force-refresh once and retry the whole request.
    if (axiosError.response?.status === 401 && config && !config._retry) {
      config._retry = true;
      return http.request(config);
    }

    if (axiosError.response) {
      const body = axiosError.response.data as
        | { error?: { code?: string; message?: string; details?: unknown } }
        | undefined;
      const err = body?.error ?? {};
      throw new ApiError(
        axiosError.response.status,
        err.code ?? "error",
        err.message ?? axiosError.response.statusText,
        err.details,
      );
    }

    // Backend down / DNS / CSP-blocked / timeout never reaches an HTTP status —
    // surface it as the same 503 path the UI maps to "backend unavailable".
    throw new ApiError(503, "service_unavailable", "Backend unavailable", String(error));
  },
);

/**
 * Call `${BASE}/api/v1${path}`. Attaches the Bearer token, retries once with a
 * force-refreshed token on the first 401, and throws ApiError on any non-2xx
 * (or network failure → synthesized service_unavailable). 204 resolves to undefined.
 *
 * Keeps the fetch-era `(path, init)` signature: `init.body` is a pre-stringified
 * JSON string and is forwarded verbatim (axios sends strings as-is, no re-encoding).
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res: AxiosResponse<T> = await http.request<T>({
    url: path,
    method: (init.method ?? "GET") as string,
    data: init.body,
    headers: init.headers as Record<string, string> | undefined,
  });

  if (res.status === 204) return undefined as T;
  return res.data;
}
