/**
 * Where the app sends people to download GoDojo, and where release NOTES come from.
 *
 * DOWNLOADS + AUTO-UPDATE: Cloudflare R2. The updater's feed URL is baked into
 * app-update.yml by CI (`electron-builder -c.publish.url=<R2>/<channel>/<os>`, see
 * .github/workflows/release.yml) and never lives in the app source. Manual downloads go
 * through the backend's stable redirect endpoints (`GET {API}/download/windows|macos`),
 * which 302 to the active production installer. The app therefore knows only the backend
 * URL — never an R2 URL, credential or bucket name.
 *
 * RELEASE NOTES ONLY: GitHub. CI still publishes a GitHub Release per version, but with NO
 * binaries attached — it exists so ReleaseNotesManager can show "What's new". It is not a
 * download source. package.json no longer has a GitHub `build.publish` entry.
 *
 * This module is compiled by both the renderer (vite) and the electron main process (tsc,
 * CommonJS), so it must stay free of `import.meta` and of anything DOM- or Node-only at
 * import time. Callers pass the API base in (the renderer uses `API_BASE` from
 * '@/lib/apiClient', which is `${VITE_API_BASE_URL}/api/v1`).
 */

/** GitHub repo that hosts release NOTES (not binaries). */
export const RELEASE_FEED = {
    owner: 'cprao210',
    repo: 'Godojo-app',
} as const;

export type DownloadPlatform = 'windows' | 'macos';

/** Public website — last-resort target when this OS has no download endpoint (e.g. Linux). */
const WEBSITE_URL = 'https://godojo.ai';

/** Best-effort OS detection that works in the renderer (no `process`) and in main. */
export function detectDownloadPlatform(): DownloadPlatform | null {
    const nodePlatform = typeof process !== 'undefined' ? process.platform : undefined;
    if (nodePlatform === 'darwin') return 'macos';
    if (nodePlatform === 'win32') return 'windows';
    if (nodePlatform === 'linux') return null;
    if (typeof navigator !== 'undefined') {
        const ua = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
        if (/mac/i.test(ua)) return 'macos';
        if (/win/i.test(ua)) return 'windows';
    }
    return null;
}

/** `${apiBase}/download/<platform>` — redirects to the active production installer. */
export function downloadUrl(apiBase: string, platform: DownloadPlatform, arch?: 'arm64' | 'x64'): string {
    const url = `${apiBase.replace(/\/+$/, '')}/download/${platform}`;
    return platform === 'macos' && arch ? `${url}?arch=${arch}` : url;
}

/** Manual "download the installer" link for this OS (name kept for existing call sites). */
export function releasesPageUrl(apiBase: string): string {
    const platform = detectDownloadPlatform();
    return platform ? downloadUrl(apiBase, platform) : WEBSITE_URL;
}

/**
 * The macOS DMG for this Mac's architecture. The backend redirects to whatever production
 * currently serves, which is the version being offered — so no version/filename is built here
 * and electron-builder's artifactName pattern is no longer duplicated in app code.
 */
export function macDmgDownloadUrl(apiBase: string, arch: 'arm64' | 'x64'): string {
    return downloadUrl(apiBase, 'macos', arch);
}