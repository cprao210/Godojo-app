// ============================================================================
// preload.ts — DEBUG CONSOLE ADDITIONS
//
// Paste these additions into the appropriate sections of your existing preload.ts
//
// 1. Add to the ElectronAPI interface
// 2. Add to the contextBridge.exposeInMainWorld("electronAPI", { ... }) object
// ============================================================================

// ────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Add to ElectronAPI interface
// ────────────────────────────────────────────────────────────────────────────
// (Place alongside the existing onDebugStart, onDebugSuccess, etc.)

/*
  // ── Debug Console (dev-only) ──
  debugGetBackendLogs: () => Promise<import('./src/lib/logger/types').LogEntry[]>;
  debugClearBackendLogs: () => Promise<void>;
  onBackendLogsPush: (
    callback: (entries: import('./src/lib/logger/types').LogEntry[]) => void
  ) => () => void;
*/

// ────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Add to contextBridge.exposeInMainWorld("electronAPI", { ... })
// ────────────────────────────────────────────────────────────────────────────
// Import DEBUG_IPC at the top of preload.ts:
//   import { DEBUG_IPC } from '../src/lib/logger/types';

/*
  // ── Debug Console (dev-only) ──
  debugGetBackendLogs: () =>
    ipcRenderer.invoke(DEBUG_IPC.BACKEND_LOGS_REQUEST),

  debugClearBackendLogs: () =>
    ipcRenderer.invoke(DEBUG_IPC.BACKEND_LOGS_CLEAR),

  onBackendLogsPush: (
    callback: (entries: import('../src/lib/logger/types').LogEntry[]) => void
  ) => {
    const subscription = (_event: Electron.IpcRendererEvent, entries: any[]) =>
      callback(entries);
    ipcRenderer.on(DEBUG_IPC.BACKEND_LOGS_PUSH, subscription);
    return () =>
      ipcRenderer.removeListener(DEBUG_IPC.BACKEND_LOGS_PUSH, subscription);
  },
*/

// ============================================================================
// Full drop-in preload additions (ready to copy-paste):
// ============================================================================

import { ipcRenderer } from 'electron';
import { DEBUG_IPC } from '../src/lib/logger/types';
import type { LogEntry } from '../src/lib/logger/types';

export const debugPreloadAdditions = {
    debugGetBackendLogs: (): Promise<LogEntry[]> =>
        ipcRenderer.invoke(DEBUG_IPC.BACKEND_LOGS_REQUEST),

    debugClearBackendLogs: (): Promise<void> =>
        ipcRenderer.invoke(DEBUG_IPC.BACKEND_LOGS_CLEAR),

    onBackendLogsPush: (callback: (entries: LogEntry[]) => void) => {
        const subscription = (_event: Electron.IpcRendererEvent, entries: LogEntry[]) =>
            callback(entries);
        ipcRenderer.on(DEBUG_IPC.BACKEND_LOGS_PUSH, subscription);
        return () =>
            ipcRenderer.removeListener(DEBUG_IPC.BACKEND_LOGS_PUSH, subscription);
    },
};