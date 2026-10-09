import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeLegacyScreenshotDirs } from '../utils/legacyScreenshotCleanup';

describe('removeLegacyScreenshotDirs', () => {
    let userData: string;

    beforeEach(() => {
        userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-cleanup-'));
        vi.spyOn(console, 'log').mockImplementation(() => { });
    });
    afterEach(() => {
        fs.rmSync(userData, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('removes both screenshot folders and their contents', async () => {
        for (const d of ['screenshots', 'extra_screenshots']) {
            fs.mkdirSync(path.join(userData, d));
            fs.writeFileSync(path.join(userData, d, 'shot.png'), 'x');
        }
        expect(await removeLegacyScreenshotDirs(userData)).toBe(2);
        expect(fs.existsSync(path.join(userData, 'screenshots'))).toBe(false);
        expect(fs.existsSync(path.join(userData, 'extra_screenshots'))).toBe(false);
    });

    it('leaves everything else in userData alone', async () => {
        fs.writeFileSync(path.join(userData, 'godojo-anon.db'), 'db');
        fs.mkdirSync(path.join(userData, 'screenshots-keep'));
        fs.mkdirSync(path.join(userData, 'screenshots'));
        await removeLegacyScreenshotDirs(userData);
        expect(fs.existsSync(path.join(userData, 'godojo-anon.db'))).toBe(true);
        expect(fs.existsSync(path.join(userData, 'screenshots-keep'))).toBe(true);
    });

    it('is a no-op once the folders are gone', async () => {
        expect(await removeLegacyScreenshotDirs(userData)).toBe(0);
    });
});
