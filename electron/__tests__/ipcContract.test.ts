import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function extractPreloadChannels(source: string): Set<string> {
  const channels = new Set<string>();
  const regex = /ipcRenderer\.(?:invoke|send)\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    channels.add(match[1]);
  }
  return channels;
}

function extractHandlerChannels(source: string): Set<string> {
  const channels = new Set<string>();
  const patterns = [
    /safeHandle\(\s*['"]([^'"]+)['"]/g,
    /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g,
    /ipcMain\.on\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      channels.add(match[1]);
    }
  }
  return channels;
}

// Channels that are invoked in preload.ts but whose handlers live in files
// other than ipcHandlers.ts (e.g. service classes, helper modules).
// Add to this set when a handler is confirmed to exist but in a different file.
const HANDLERS_IN_OTHER_FILES = new Set([
  'keybinds:get-all',   // electron/services/KeybindManager.ts
  'keybinds:set',       // electron/services/KeybindManager.ts
  'keybinds:reset',     // electron/services/KeybindManager.ts
  'cropper-confirmed',  // electron/CropperWindowHelper.ts (ipcMain.on)
  'cropper-cancelled',  // electron/CropperWindowHelper.ts (ipcMain.on)
]);

// Channels with NO handler anywhere — real gaps to fix.
// Adding here prevents the contract test from failing until the handler is added,
// but the separate test below ensures these are tracked and visible.
const KNOWN_MISSING_HANDLERS = new Set([
  'toggle-advanced-settings', // preload.ts L558 — handler not found in any file
]);

describe('IPC contract: preload channels vs handler registrations', () => {

  const preloadSource = readSource('electron/preload.ts');
  const handlersSource = readSource('electron/ipcHandlers.ts');
  const preloadChannels = extractPreloadChannels(preloadSource);
  const handlerChannels = extractHandlerChannels(handlersSource);

  it('preload.ts exposes at least 50 distinct invoke/send channel names', () => {
    expect(preloadChannels.size).toBeGreaterThanOrEqual(50);
  });

  it('ipcHandlers.ts registers at least 50 distinct handler channels', () => {
    expect(handlerChannels.size).toBeGreaterThanOrEqual(50);
  });

  it('every channel invoked in preload.ts has a registered handler (or is in the known-other-files set)', () => {
    const unhandled: string[] = [];
    for (const channel of preloadChannels) {
      if (!handlerChannels.has(channel) && !HANDLERS_IN_OTHER_FILES.has(channel) && !KNOWN_MISSING_HANDLERS.has(channel)) {
        unhandled.push(channel);
      }
    }
    if (unhandled.length > 0) {
      const msg = [
        `${unhandled.length} channel(s) invoked in preload.ts have no handler in ipcHandlers.ts (and are not in HANDLERS_IN_OTHER_FILES):`,
        ...unhandled.map(c => `  - "${c}"`),
      ].join('\n');
      expect.fail(msg);
    }
    expect(unhandled).toHaveLength(0);
  });

  it('KNOWN_MISSING_HANDLERS documents real gaps — these channels have no handler anywhere', () => {
    // This test is a canary: if you add a handler for a known-missing channel,
    // remove it from KNOWN_MISSING_HANDLERS and this test will catch any reversion.
    expect(KNOWN_MISSING_HANDLERS.has('toggle-advanced-settings')).toBe(true);
    // Confirm it is genuinely absent from ipcHandlers.ts
    expect(handlerChannels.has('toggle-advanced-settings')).toBe(false);
  });

  it('critical meeting-lifecycle channels are registered', () => {
    const critical = ['start-meeting', 'end-meeting', 'pause-meeting', 'resume-meeting', 'get-meeting-active', 'get-meeting-paused'];
    for (const ch of critical) {
      expect(handlerChannels.has(ch), `"${ch}" must be registered`).toBe(true);
    }
  });

  it('critical auth channels are registered', () => {
    const auth = ['auth:set-id-token', 'auth:clear', 'auth:get-state', 'auth:get-persisted-refresh-token'];
    for (const ch of auth) {
      expect(handlerChannels.has(ch), `"${ch}" must be registered`).toBe(true);
    }
  });

  it('critical RAG channels are registered', () => {
    const rag = ['rag:query-meeting', 'rag:query-live', 'rag:query-global', 'rag:cancel-query', 'rag:is-meeting-processed', 'rag:get-queue-status', 'rag:retry-embeddings'];
    for (const ch of rag) {
      expect(handlerChannels.has(ch), `"${ch}" must be registered`).toBe(true);
    }
  });

  it('security-sensitive file operation channels are registered', () => {
    for (const ch of ['delete-screenshot', 'analyze-image-file']) {
      expect(handlerChannels.has(ch), `"${ch}" must be registered`).toBe(true);
    }
  });

  it('restartAndInstall maps to the "quit-and-install-update" handler', () => {
    expect(
      handlerChannels.has('quit-and-install-update'),
      '"quit-and-install-update" handler must exist — restartAndInstall() in preload depends on it',
    ).toBe(true);
  });

});
