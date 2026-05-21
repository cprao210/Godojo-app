import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

const THEME_CACHE_KEY = 'natively_resolved_theme';

// Set platform attribute synchronously — before React renders — so CSS selectors
// like html[data-platform="win32"] work immediately without a flash on first paint.
document.documentElement.setAttribute(
  'data-platform',
  window.electronAPI?.platform ?? process?.platform ?? ''
);

// Step 1: Apply cached theme synchronously — before React renders.
// This ensures useResolvedTheme()'s initial useState read sees the correct value.
const cachedTheme = localStorage.getItem(THEME_CACHE_KEY) as 'light' | 'dark' | null;
document.documentElement.setAttribute('data-theme', cachedTheme ?? 'dark');

// Step 2: Confirm/correct from main process (authoritative) and keep cache in sync.
if (window.electronAPI?.getThemeMode) {
  window.electronAPI.getThemeMode().then(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem(THEME_CACHE_KEY, resolved);
  });

  window.electronAPI?.onThemeChanged?.(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem(THEME_CACHE_KEY, resolved);
  });
}

// Step 3: Boot Firebase Auth bridge. This installs the onIdTokenChanged listener
// that forwards every fresh ID token to main, and (if a refresh token is
// persisted) silently exchanges it for a new ID token. Runs once per renderer
// (multi-window: launcher + overlay each call this independently — both bridges
// will simply forward the same token to main, which is idempotent).
import('./lib/firebase').then(({ getFirebaseAuth, trySilentRestore }) => {
  try {
    getFirebaseAuth();
    void trySilentRestore();
  } catch (e) {
    console.warn('[main.tsx] Firebase bootstrap failed (non-fatal):', e);
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
