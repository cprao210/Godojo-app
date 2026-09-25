#!/usr/bin/env node
/**
 * dev-update-server.mjs — local update-feed server for testing the ENTIRE
 * Updates flow in `npm run dev` without publishing a real release.
 *
 * Generates a fixture release into dev-update-feed/ and serves it at
 * http://127.0.0.1:5178/ so electron-updater (unlocked in dev by
 * GODOJO_DEV_UPDATES=1 + dev-app-update.yml + forceDevUpdateConfig in main.ts)
 * can run the production path:
 *
 *   check → update-available (version 999.0.0 > any dev version, with the
 *         fixture's own release notes + size chip)
 *         → download with REAL byte totals — the installer stream is
 *           THROTTLED (default 1500 KB/s ≈ 8-9s for the 12.5MB fixture) so
 *           the progress bar is actually watchable; localhost would otherwise
 *           finish instantly
 *         → sha512 verification → update-downloaded
 *   install → deliberately refused with a clear message (dummy file)
 *
 * Usage:
 *   node scripts/dev-update-server.mjs [--regen] [--size-mb 12.5] [--throttle-kbps 1500]
 *   npm run dev:updates   (server + app together; see package.json)
 *
 * Full docs: docs/TESTING-UPDATES.md
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEED_DIR = path.join(__dirname, '..', 'dev-update-feed');
const PORT = Number(process.env.GODOJO_DEV_FEED_PORT || 5178);
const FIXTURE_VERSION = '999.0.0';
const INSTALLER_NAME = `GoDojo.AI-Setup-${FIXTURE_VERSION}.exe`;

function argValue(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const SIZE_MB = argValue('--size-mb', 12.5);
const THROTTLE_KBPS = argValue('--throttle-kbps', 1000);
const FORCE = process.argv.includes('--regen');

const MIME = {
    '.yml': 'text/yaml; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.exe': 'application/octet-stream',
    '.blockmap': 'application/octet-stream',
};

// The fixture's "What's new" — served as dev-feed-notes.json and rendered by
// the real modal/tab (same ParsedReleaseNotes shape the GitHub API path uses).
const FIXTURE_NOTES = {
    version: FIXTURE_VERSION,
    summary: 'This release adds meeting pagination and auto-start, rebuilds transcript upload with full analysis, and fixes several UI and audio issues.',
    sections: [
        {
            title: "What's New",
            items: [
                'Added a "Load more" button to load more meetings on the launcher screen',
                'Added a speaker sound test button in the bottom audio tray',
                'Added the Auto-start meeting feature',
                'Allowed image uploads in the upload section, with a progress bar',
                'Rebuilt the Upload Transcript feature with meeting score, analysis, and summary',
            ],
        },
        {
            title: 'Improvements',
            items: [
                'Reduced the default auto-refresh time in live analysis from 2 minutes to 1 minute',
                "Added pagination for an AE's meetings in their profile",
            ],
        },
        {
            title: 'Fixes',
            items: [
                'Fixed speaker diarization and added proper speaker labels',
                'Fixed UI issues in the Team Invitation modal',
                'Fixed UI alignment for all toggle buttons in the General tab of Settings',
                'Fixed overflow issues for chat responses',
                'Fixed an unnecessary "audio capture issue" toast notification appearing during live calls',
            ],
        },
    ],
};

function generateFixture() {
    mkdirSync(FEED_DIR, { recursive: true });
    const installerPath = path.join(FEED_DIR, INSTALLER_NAME);
    const targetBytes = Math.round(SIZE_MB * 1024 * 1024);
    let sha512;
    let size;

    if (!FORCE && existsSync(installerPath) && statSync(installerPath).size === targetBytes) {
        console.log(`[dev-feed] Fixture installer already exists (${INSTALLER_NAME}, ${SIZE_MB} MB) — use --regen to rebuild`);
        sha512 = createHash('sha512').update(readFileSync(installerPath)).digest('base64');
        size = targetBytes;
    } else {
        // Deterministic pseudo-random content: real byte volume so the
        // download's progress and timing behave like production, at zero
        // entropy cost.
        const CHUNK = 256 * 1024;
        const chunks = [];
        let seed = 0x5eed1234;
        const buf = Buffer.allocUnsafe(CHUNK);
        for (let i = 0; i < CHUNK; i++) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            buf[i] = seed & 0xff;
        }
        const hash = createHash('sha512');
        let written = 0;
        while (written < targetBytes) {
            const take = Math.min(CHUNK, targetBytes - written);
            hash.update(take === CHUNK ? buf : buf.subarray(0, take));
            chunks.push(Buffer.from(take === CHUNK ? buf : buf.subarray(0, take)));
            written += take;
        }
        writeFileSync(installerPath, Buffer.concat(chunks));
        sha512 = hash.digest('base64');
        size = written;
        console.log(`[dev-feed] Fixture generated: ${INSTALLER_NAME} (${(size / 1024 / 1024).toFixed(1)} MB, sha512 ok)`);
    }

    // Feed metadata — always rewritten (cheap) so notes/throttle edits land
    // without --regen. Minimal NSIS-shaped latest.yml (channel 'latest'):
    // `path`+`sha512` and files[0] both present, matching electron-builder.
    const yml = [
        `version: ${FIXTURE_VERSION}`,
        `files:`,
        `  - url: ${INSTALLER_NAME}`,
        `    sha512: ${sha512}`,
        `    size: ${size}`,
        `path: ${INSTALLER_NAME}`,
        `sha512: ${sha512}`,
        `releaseDate: '${new Date().toISOString()}'`,
        '',
    ].join('\n');
    writeFileSync(path.join(FEED_DIR, 'latest.yml'), yml);
    writeFileSync(
        path.join(FEED_DIR, 'dev-feed-meta.json'),
        JSON.stringify({ version: FIXTURE_VERSION, installerBytes: size, generatedAt: new Date().toISOString() }, null, 2),
    );
    writeFileSync(path.join(FEED_DIR, 'dev-feed-notes.json'), JSON.stringify(FIXTURE_NOTES, null, 2));
}

/** Paced file send: writes 64KB chunks on a timer so the client's progress
 *  bar advances over seconds instead of one instant burst. Small files
 *  (yml/json) bypass pacing — only the installer needs to look real. */
async function sendPaced(file, res) {
    const buf = readFileSync(file);
    if (THROTTLE_KBPS <= 0 || buf.length < 512 * 1024) {
        res.end(buf);
        return;
    }
    const CHUNK = 64 * 1024;
    const delayMs = Math.max(1, Math.round((CHUNK / 1024) / THROTTLE_KBPS * 1000));
    for (let off = 0; off < buf.length; off += CHUNK) {
        const ok = res.write(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
        if (!ok) await new Promise((r) => res.once('drain', r));
        await new Promise((r) => setTimeout(r, delayMs));
    }
    res.end();
}

const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'latest.yml';
    const file = path.join(FEED_DIR, name);
    if (!file.startsWith(FEED_DIR) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('not found');
        return;
    }
    const stat = statSync(file);
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
    });
    sendPaced(file, res).catch((e) => {
        console.error('[dev-feed] send failed:', e.message);
        res.destroy();
    });
});

generateFixture();
server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('──────────────────────────────────────────────────────────');
    console.log(`  Dev update feed serving ${FEED_DIR}`);
    console.log(`  → http://127.0.0.1:${PORT}/latest.yml`);
    console.log(`  Installer throttled to ${THROTTLE_KBPS} KB/s (${(12.5 * 1024 / THROTTLE_KBPS).toFixed(1)}s for the default fixture; --throttle-kbps 0 disables)`);
    console.log('');
    console.log('  All-in-one (server + app + override):');
    console.log('    npm run dev:updates');
    console.log('  Then: Settings → Updates → Check for Updates');
    console.log('──────────────────────────────────────────────────────────');
    console.log('');
});
