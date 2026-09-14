/**
 * verboseLog.ts
 * Module-level singleton flag for verbose/debug logging.
 * Import isVerboseLogging() anywhere in the electron main process to gate
 * diagnostic logs. The flag is toggled via AppState.setVerboseLogging() which
 * persists it through SettingsManager.
 *
 * The flag also crosses into the Rust native module (native-module/src/log_gate.rs).
 * Before that existed, "verbose logging off" only quieted the TypeScript side
 * while the native audio layer kept printing regardless — most visibly a
 * 2 lines/second AEC diagnostic for the whole length of every call. Forwarding
 * here rather than at the call sites means there is one switch, and it cannot
 * drift: every path that sets the JS flag sets the native one too.
 */

let _verbose = false;

export const isVerboseLogging = (): boolean => _verbose;

export const setVerboseLoggingFlag = (enabled: boolean): void => {
  _verbose = enabled;
  syncNativeVerboseLogging(enabled);
};

/**
 * Push the flag across the napi boundary.
 *
 * Required lazily and guarded on purpose. This module is imported from many
 * places (including contexts with no Electron `app`, such as unit tests), and
 * the export is missing from .node binaries built before the log gate landed —
 * neither case should be able to break a settings toggle.
 */
function syncNativeVerboseLogging(enabled: boolean): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadNativeModule } = require('./audio/nativeModuleLoader');
    loadNativeModule()?.setNativeVerboseLogging?.(enabled);
  } catch {
    // No native module in this context — the JS-side flag still applies.
  }
}
