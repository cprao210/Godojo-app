import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./index.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key used to cache the last resolved theme for flash-free boot. */
const THEME_CACHE_KEY = "natively_resolved_theme";

// ---------------------------------------------------------------------------
// Pre-render DOM setup
//
// Everything in this section runs synchronously, before React renders, so
// that CSS attribute selectors (e.g. html[data-platform], html[data-theme])
// are correct on first paint with no flash.
// ---------------------------------------------------------------------------

/**
 * Tag <html> with the current OS platform so CSS can branch on it
 * (e.g. `html[data-platform="win32"] { ... }`).
 */
function applyPlatformAttribute(): void {
  const platform = window.electronAPI?.platform ?? process?.platform ?? "";
  document.documentElement.setAttribute("data-platform", platform);
}

/**
 * Tag <html> with the current window's identifier (e.g. "overlay"), read
 * from the `?window=` query param, so CSS can scope rules per window
 * (e.g. #root sizing differs between the main window and overlays).
 */
function applyWindowAttribute(): void {
  const windowParam = new URLSearchParams(window.location.search).get("window");
  if (windowParam) {
    document.documentElement.setAttribute("data-window", windowParam);
  }
}

/**
 * Apply the last-known theme from cache immediately, so useResolvedTheme()'s
 * initial useState read already sees the correct value and React never
 * renders a wrong-theme frame.
 */
function applyCachedTheme(): void {
  const cachedTheme = localStorage.getItem(THEME_CACHE_KEY) as "light" | "dark" | null;
  document.documentElement.setAttribute("data-theme", cachedTheme ?? "dark");
}

/**
 * Ask the main process for the authoritative resolved theme, apply it, and
 * keep the cache in sync. Also subscribes to future theme-change events
 * pushed from main (e.g. the user changes their OS theme).
 */
function syncThemeWithMainProcess(): void {
  if (!window.electronAPI?.getThemeMode) return;

  const persistTheme = (resolved: "light" | "dark") => {
    document.documentElement.setAttribute("data-theme", resolved);
    localStorage.setItem(THEME_CACHE_KEY, resolved);
  };

  window.electronAPI.getThemeMode().then(({ resolved }) => persistTheme(resolved));
  window.electronAPI?.onThemeChanged?.(({ resolved }) => persistTheme(resolved));
}

/**
 * Boot the Firebase Auth bridge.
 *
 * This installs the onIdTokenChanged listener that forwards every fresh ID
 * token to main, and — if a refresh token is persisted — silently exchanges
 * it for a new ID token.
 *
 * Lazily imported so Firebase's SDK doesn't block initial paint.
 *
 * Runs once per renderer: in multi-window setups (launcher + overlay) each
 * window calls this independently, and both bridges simply forward the same
 * token to main, which is idempotent.
 */
async function bootFirebaseAuthBridge(): Promise<void> {
  try {
    const { getFirebaseAuth, trySilentRestore } = await import("./lib/firebase");
    getFirebaseAuth();
    void trySilentRestore();
  } catch (error) {
    console.warn("[main.tsx] Firebase bootstrap failed (non-fatal):", error);
  }
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

applyPlatformAttribute();
applyWindowAttribute();
applyCachedTheme();
syncThemeWithMainProcess();
void bootFirebaseAuthBridge();

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);