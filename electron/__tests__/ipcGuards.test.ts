import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// Replicate the guard logic from both IPC handlers as a pure function
// so we can test it exhaustively without a live Electron runtime.
function simulateGuard(userDataDir: string, filePath: string): { allowed: boolean; resolved: string } {
  const resolved = path.resolve(filePath);
  const allowed = resolved.startsWith(userDataDir + path.sep);
  return { allowed, resolved };
}

const MOCK_USER_DATA_DIR = '/Users/testuser/Library/Application Support/natively';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const handlersSource = fs.readFileSync(path.join(PROJECT_ROOT, 'electron', 'ipcHandlers.ts'), 'utf8');

describe('IPC path-traversal guards — source inspection', () => {

  it('delete-screenshot handler contains userData path boundary check', () => {
    const idx = handlersSource.indexOf('"delete-screenshot"');
    expect(idx).toBeGreaterThan(-1);
    const slice = handlersSource.slice(idx, idx + 600);
    expect(slice).toContain('startsWith');
    expect(slice).toContain('path.sep');
    expect(slice).toContain('userData');
  });

  it('analyze-image-file handler contains userData path boundary check', () => {
    const idx = handlersSource.indexOf('"analyze-image-file"');
    expect(idx).toBeGreaterThan(-1);
    const slice = handlersSource.slice(idx, idx + 600);
    expect(slice).toContain('startsWith');
    expect(slice).toContain('path.sep');
    expect(slice).toContain('userData');
  });

  it('delete-screenshot handler rejects with a "not allowed" error', () => {
    const idx = handlersSource.indexOf('"delete-screenshot"');
    const slice = handlersSource.slice(idx, idx + 600);
    expect(slice.includes("'Path not allowed'") || slice.includes('"Path not allowed"') || slice.includes('not allowed')).toBe(true);
  });

  it('analyze-image-file handler rejects with a "not allowed" error', () => {
    const idx = handlersSource.indexOf('"analyze-image-file"');
    const slice = handlersSource.slice(idx, idx + 600);
    expect(slice.includes("'Path not allowed'") || slice.includes('"Path not allowed"') || slice.includes('not allowed')).toBe(true);
  });

});

describe('path-traversal guard logic: allows legitimate paths', () => {

  it('allows a file directly inside userData', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, path.join(MOCK_USER_DATA_DIR, 'screenshot.png'));
    expect(allowed).toBe(true);
  });

  it('allows a file in a subdirectory of userData', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, path.join(MOCK_USER_DATA_DIR, 'screenshots', 'img001.png'));
    expect(allowed).toBe(true);
  });

  it('allows a deeply nested path inside userData', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, path.join(MOCK_USER_DATA_DIR, 'a', 'b', 'c', 'file.png'));
    expect(allowed).toBe(true);
  });

});

describe('path-traversal guard logic: rejects adversarial paths', () => {

  it('rejects Unix-style path traversal (../../)', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, path.join(MOCK_USER_DATA_DIR, '..', '..', 'etc', 'passwd'));
    expect(allowed).toBe(false);
  });

  it('rejects direct path to /etc/passwd', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, '/etc/passwd');
    expect(allowed).toBe(false);
  });

  it('rejects path starting with userData string but in a sibling directory (no sep guard)', () => {
    // Attack: userData + "-evil" prefix matches startsWith(userData) but not startsWith(userData + sep)
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, path.join(MOCK_USER_DATA_DIR + '-evil', 'evil.png'));
    expect(allowed).toBe(false);
  });

  it('rejects absolute path to /tmp', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, '/tmp/malicious.sh');
    expect(allowed).toBe(false);
  });

  it('rejects absolute path to home directory', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, '/Users/testuser/.ssh/id_rsa');
    expect(allowed).toBe(false);
  });

  it('rejects path traversal with concatenated separators', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, MOCK_USER_DATA_DIR + '/../../../etc/hosts');
    expect(allowed).toBe(false);
  });

  it('rejects Windows-style traversal (simulated on Unix)', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, '..\\..\\windows\\system32\\evil.dll');
    expect(allowed).toBe(false);
  });

  it('rejects a path resolved to the parent of userData', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, path.resolve(MOCK_USER_DATA_DIR, '..', 'other-app', 'file.db'));
    expect(allowed).toBe(false);
  });

  it('rejects an empty string path (resolves to cwd)', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, '');
    expect(allowed).toBe(false);
  });

  it('rejects the userData directory itself (no filename)', () => {
    const { allowed } = simulateGuard(MOCK_USER_DATA_DIR, MOCK_USER_DATA_DIR);
    expect(allowed).toBe(false);
  });

});

describe('path-traversal guard consistency between handlers', () => {

  it('both handlers use the same path.resolve + startsWith + path.sep pattern', () => {
    const guardElements = ['path.resolve', 'startsWith', 'path.sep'];
    for (const channel of ['delete-screenshot', 'analyze-image-file']) {
      const idx = handlersSource.indexOf(`"${channel}"`);
      const slice = handlersSource.slice(idx, idx + 400);
      for (const el of guardElements) {
        expect(slice, `"${channel}" must contain "${el}"`).toContain(el);
      }
    }
  });

});
