// legacyDbMigration.ts
//
// Per-user SQLite files were renamed from `natively-<uid>.db` (the codebase
// GoDojo started from) to `godojo-<uid>.db`. This moves an existing user's
// file — and its WAL/SHM sidecars — to the new name the first time it is
// opened, so meetings never appear to vanish after the update.

import fs from 'fs';
import path from 'path';

const NEW_PREFIX = 'godojo-';
const OLD_PREFIX = 'natively-';
// Sidecars first, main file LAST: if the process dies part-way, the next
// launch still sees the old main file and completes the move, and the WAL
// (uncommitted pages) never ends up separated from its database.
const SIDECARS = ['-wal', '-shm'];

/**
 * Given the NEW db path, migrate the legacy file if one exists and the new one
 * does not. Returns the path to open: the new path on success (or when there
 * is nothing to migrate), or the LEGACY path if the move failed, so the
 * caller keeps using the user's existing data in place. Never throws.
 */
export function migrateLegacyDbFile(newPath: string, log: (msg: string, err?: unknown) => void = console.warn): string {
    const dir = path.dirname(newPath);
    const base = path.basename(newPath);
    if (!base.startsWith(NEW_PREFIX)) return newPath;
    const legacyPath = path.join(dir, OLD_PREFIX + base.slice(NEW_PREFIX.length));

    try {
        if (fs.existsSync(newPath) || !fs.existsSync(legacyPath)) return newPath;
        for (const suffix of SIDECARS) {
            const from = legacyPath + suffix;
            if (fs.existsSync(from) && !fs.existsSync(newPath + suffix)) fs.renameSync(from, newPath + suffix);
        }
        fs.renameSync(legacyPath, newPath);
        log(`[DatabaseManager] Migrated ${path.basename(legacyPath)} -> ${base}`);
        return newPath;
    } catch (err) {
        log(`[DatabaseManager] Could not rename ${path.basename(legacyPath)}; using it in place`, err);
        // Put back any sidecar already moved so the legacy file is complete.
        for (const suffix of SIDECARS) {
            try {
                if (fs.existsSync(newPath + suffix) && !fs.existsSync(legacyPath + suffix) && !fs.existsSync(newPath)) {
                    fs.renameSync(newPath + suffix, legacyPath + suffix);
                }
            } catch { /* best-effort */ }
        }
        return fs.existsSync(legacyPath) ? legacyPath : newPath;
    }
}
