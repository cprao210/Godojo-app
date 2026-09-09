/**
 * Single source of truth for the GitHub release feed outside package.json.
 *
 * package.json's "build.publish" is what electron-builder/electron-updater
 * actually read, and a JSON file cannot import code — so it stays hardcoded
 * there. Everything else that has to name the repo (release-notes fetching,
 * manual DMG download links, "open releases page" buttons) imports from this
 * module instead of repeating the owner/repo by hand. KEEP IN SYNC with
 * package.json "build.publish": moving to a different release repo means
 * updating both.
 */

export const RELEASE_FEED = {
    owner: 'cprao210',
    repo: 'Godojo-app',
} as const;

/** The releases page GitHub always redirects to the newest published release. */
export function releasesPageUrl(): string {
    return `https://github.com/${RELEASE_FEED.owner}/${RELEASE_FEED.repo}/releases/latest`;
}

/**
 * A macOS DMG asset name as produced by electron-builder. Must match
 * package.json mac.artifactName "${productName}-${version}-${arch}.${ext}"
 * for productName "GoDojo.AI" — the manual-install flow links directly to
 * this file, so if the artifact name pattern changes, change it here too.
 */
export function macDmgAssetName(version: string, arch: 'arm64' | 'x64'): string {
    const v = version.replace(/^v/, '');
    return `GoDojo.AI-${v}-${arch}.dmg`;
}

export function macDmgDownloadUrl(version: string, arch: 'arm64' | 'x64'): string {
    const v = version.replace(/^v/, '');
    return `https://github.com/${RELEASE_FEED.owner}/${RELEASE_FEED.repo}/releases/download/v${v}/${macDmgAssetName(v, arch)}`;
}
