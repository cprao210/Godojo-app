// One-time cleanup of the screenshot folders left behind by the removed
// screenshot / selective-screenshot tools (upstream interview feature).
//
// ScreenshotHelper wrote PNG captures to <userData>/screenshots and
// <userData>/extra_screenshots. Nothing reads or writes either folder any more,
// but existing installs still carry whatever was captured — screen contents
// the user never sees again. Deleting them is idempotent: once the folders are
// gone this is two cheap existence checks.

import fs from 'fs';
import path from 'path';

export const LEGACY_SCREENSHOT_DIRS = ['screenshots', 'extra_screenshots'] as const;

/** Removes the legacy screenshot folders under `userDataDir`. Returns how many were removed. */
export async function removeLegacyScreenshotDirs(userDataDir: string): Promise<number> {
    let removed = 0;
    for (const name of LEGACY_SCREENSHOT_DIRS) {
        const dir = path.join(userDataDir, name);
        try {
            if (!fs.existsSync(dir)) continue;
            await fs.promises.rm(dir, { recursive: true, force: true });
            removed++;
            console.log(`[LegacyCleanup] Removed old screenshot folder: ${name}`);
        } catch (e: any) {
            // Non-fatal: a locked file just means we try again next launch.
            console.warn(`[LegacyCleanup] Could not remove ${name}:`, e?.message ?? e);
        }
    }
    return removed;
}
