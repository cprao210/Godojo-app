
import { net } from "electron";
import { RELEASE_FEED } from "../../utils/updateFeed";

export interface ReleaseNoteSection {
    title: string;
    items: string[];
}

/** A downloadable file attached to a GitHub release (installer, DMG,
 *  AppImage…). `size` is bytes — the source for the UI's download-size chip. */
export interface ReleaseAsset {
    name: string;
    size: number;
}

export interface ParsedReleaseNotes {
    version: string;
    summary: string;
    sections: ReleaseNoteSection[];
    fullBody: string; // Fallback
    url: string;
    assets?: ReleaseAsset[];
    /** True when GitHub flags this release as a pre-release. Such releases
     *  must NEVER be announced to users (internal/platform testing only). */
    isPrerelease?: boolean;
    /** True for draft releases (normally invisible to the unauthenticated
     *  API — captured defensively in case an authenticated fetch returns one). */
    isDraft?: boolean;
}

export class ReleaseNotesManager {
    private static instance: ReleaseNotesManager;
    private cachedNotes: ParsedReleaseNotes | null = null;
    // Release repo lives in utils/updateFeed.ts (shared with the renderer's
    // manual-DMG links and release-page buttons) — keep in sync with
    // package.json "build.publish".
    private readonly repoOwner = RELEASE_FEED.owner;
    private readonly repoName = RELEASE_FEED.repo;

    private constructor() { }

    public static getInstance(): ReleaseNotesManager {
        if (!ReleaseNotesManager.instance) {
            ReleaseNotesManager.instance = new ReleaseNotesManager();
        }
        return ReleaseNotesManager.instance;
    }

    public async fetchReleaseNotes(version: string, forceRefresh = false): Promise<ParsedReleaseNotes | null> {
        if (!forceRefresh && this.cachedNotes && this.cachedNotes.version === version) {
            console.log("[ReleaseNotesManager] Returning cached release notes for", version);
            return this.cachedNotes;
        }

        console.log(`[ReleaseNotesManager] Fetching release notes for ${version}...`);

        try {
            // We'll fetch the 'latest' release and check if it matches the version we are updating to.
            // If the update is not 'latest' (e.g. strict version), we might need to search specific tags,
            // but for now 'latest' is the standard flow for auto-updates.
            // However, to be safe and robust, let's try to fetch by tag if possible, or just latest.
            // GitHub API: GET /repos/{owner}/{repo}/releases/tags/{tag}
            // If version starts with 'v', use it, else add 'v'.
            // If version is 'latest', fetch from /releases/latest
            // Otherwise, fetch by tag
            let url = "";
            if (version === 'latest') {
                url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`;
            } else {
                const tag = version.startsWith('v') ? version : `v${version}`;
                url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/tags/${tag}`;
            }

            let response = await this.makeRequest(url);

            // /releases/latest 404s not only when no releases exist, but also
            // when every release is a PRERELEASE (the endpoint excludes them).
            // Fall back to the list endpoint — but only consider PRODUCTION
            // releases: prereleases and drafts are internal/test builds and
            // must never surface to users (see docs/TESTING-UPDATES.md).
            if (!response && version === 'latest') {
                console.log("[ReleaseNotesManager] releases/latest unavailable — falling back to the releases list (production releases only)");
                const listUrl = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases?per_page=30`;
                const listResponse = await this.makeRequest(listUrl);
                if (listResponse) {
                    try {
                        const releases = JSON.parse(listResponse);
                        const latest = Array.isArray(releases)
                            ? releases.find((r: any) => !r?.prerelease && !r?.draft)
                            : null;
                        if (latest && typeof latest === 'object') {
                            response = JSON.stringify(latest);
                        }
                    } catch (e) {
                        console.warn("[ReleaseNotesManager] Failed to parse releases list fallback:", e);
                    }
                }
            }

            if (!response) {
                console.warn("[ReleaseNotesManager] Failed to fetch release notes from API.");
                return null;
            }

            const data = JSON.parse(response);
            const body = data.body || "";
            const htmlUrl = data.html_url || "";
            const tagName = data.tag_name || version; // Use tag_name from API if available
            // Release assets carry their byte sizes — used to show the real
            // download size in the update modal (not the installed-app size).
            const assets: ReleaseAsset[] = Array.isArray(data.assets)
                ? data.assets.map((a: any) => ({ name: String(a?.name ?? ''), size: Number(a?.size ?? 0) })).filter((a: ReleaseAsset) => a.name && a.size > 0)
                : [];

            const parsed = this.parseReleaseNotes(body, tagName, htmlUrl);
            parsed.assets = assets;
            // Capture the release's publication state so the update-announce
            // gate in main.ts can refuse to announce test builds to users.
            parsed.isPrerelease = data.prerelease === true;
            parsed.isDraft = data.draft === true;
            this.cachedNotes = parsed;
            return parsed;

        } catch (error) {
            console.error("[ReleaseNotesManager] Error fetching release notes:", error);
            return null;
        }
    }

    private parseReleaseNotes(body: string, version: string, url: string): ParsedReleaseNotes {
        console.log(`[ReleaseNotesManager] Parsing body for ${version}. Length: ${body.length}`);
        const allowedHeaders = ['Summary', "What's New", "Improvements", "Fixes", "Technical"];
        const bulletSections = ["What's New", "Improvements", "Fixes", "Technical"];

        const sections: ReleaseNoteSection[] = [];
        let summary = "";

        // Normalize newlines
        const normalizedBody = body.replace(/\r\n/g, "\n");

        // Split by H2 headers (## )
        const rawSections = normalizedBody.split(/^## /m);

        for (const raw of rawSections) {
            const sectionText = raw.trim();
            if (!sectionText) continue;

            const lines = sectionText.split('\n');
            const title = lines[0].trim();

            // STRICTNESS: Only process allowed headers
            if (!allowedHeaders.includes(title)) {
                continue;
            }

            const contentLines = lines.slice(1);
            const content = contentLines.join('\n').trim();

            if (title === 'Summary') {
                // Summary: Capture text content (single line description)
                summary = content.replace(/\n/g, ' ').trim();
                console.log(`[ReleaseNotesManager] Found Summary: "${summary.substring(0, 50)}..."`);
            } else if (bulletSections.includes(title)) {
                // Bullet Sections: Capture ONLY lines starting with - or *
                const items: string[] = [];
                for (const line of contentLines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
                        items.push(trimmedLine.substring(2).trim());
                    }
                }

                if (items.length > 0) {
                    sections.push({ title, items });
                    console.log(`[ReleaseNotesManager] Found Section: "${title}" (${items.length} items)`);
                } else {
                    console.warn(`[ReleaseNotesManager] Section "${title}" found but no valid bullet points extracted.`);
                }
            }
        }

        return {
            version,
            summary,
            sections,
            fullBody: body, // Keep raw body for reference/logging
            url
        };
    }

    private makeRequest(url: string): Promise<string | null> {
        return new Promise((resolve) => {
            const request = net.request(url);

            request.on('response', (response) => {
                if (response.statusCode !== 200) {
                    console.warn(`[ReleaseNotesManager] HTTP ${response.statusCode} for ${url}`);
                    resolve(null);
                    return;
                }

                let data = '';
                response.on('data', (chunk) => {
                    data += chunk.toString();
                });

                response.on('end', () => {
                    resolve(data);
                });

                response.on('error', (err) => {
                    console.error("[ReleaseNotesManager] Stream error:", err);
                    resolve(null);
                });
            });

            request.on('error', (err) => {
                console.error("[ReleaseNotesManager] Request error:", err);
                resolve(null);
            });

            request.end();
        });
    }

    public getCachedNotes(): ParsedReleaseNotes | null {
        return this.cachedNotes;
    }
}
