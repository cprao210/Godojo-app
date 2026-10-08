/**
 * One-time localStorage key migration: `natively_*` → `godojo_*`.
 *
 * GoDojo started from the Natively codebase, and its renderer settings were
 * stored under `natively_` keys (theme cache, performance mode, ghost mode,
 * transcript visibility, signup phone per uid, …). They were renamed to
 * `godojo_`; this moves existing users' values across so nothing resets.
 *
 * It runs at IMPORT time, so each window entry (src/main.tsx,
 * src/meeting-popup/main.tsx) imports it FIRST — before any module that reads
 * localStorage while initialising. Idempotent: once no `natively_` keys are
 * left it does nothing. A value already present under the new key wins.
 * localStorage is per-origin, so every window origin migrates its own store.
 */

const OLD_PREFIX = 'natively_';
const NEW_PREFIX = 'godojo_';

/** Old keys that map to an existing key name instead of the prefix swap. */
const SPECIAL_TARGETS: Record<string, string> = {
    // Already renamed earlier (see useOverlayOpacity) — go straight to it.
    natively_overlay_opacity: 'gd_dock_opacity',
};

export function migrateLegacyStorageKeys(storage: Storage): number {
    let moved = 0;
    try {
        const keys: string[] = [];
        for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (k && k.startsWith(OLD_PREFIX)) keys.push(k);
        }
        for (const oldKey of keys) {
            const value = storage.getItem(oldKey);
            const newKey = SPECIAL_TARGETS[oldKey] ?? NEW_PREFIX + oldKey.slice(OLD_PREFIX.length);
            if (value !== null && storage.getItem(newKey) === null) storage.setItem(newKey, value);
            storage.removeItem(oldKey);
            moved++;
        }
    } catch {
        // Storage unavailable (private mode, quota) — settings fall back to defaults.
    }
    return moved;
}

if (typeof localStorage !== 'undefined') migrateLegacyStorageKeys(localStorage);
