# Release Process & Update Channels

Installers and auto-update feeds are served from **Cloudflare R2** (public `r2.dev` URL today,
a custom domain later). GitHub Releases is **not** a download or update source any more — it only
carries the release notes shown in the update dialog.

```text
git tag vX.Y.Z ─▶ GitHub Actions ─▶ build (mac / win / linux)
                                       │
                                       ▼
                          validate ─▶ upload installers to R2 ─▶ verify (S3 size + public URL)
                                       │
                                       ▼
                  POST /api/v1/internal/releases  (backend: this release is now the active download)
                                       │
                                       ▼
                  upload latest*.yml LAST ─▶ verify   (Electron auto-update now sees it)

User ─▶ https://sales-ai-backend-227692500877.us-central1.run.app/download/windows|macos ─▶ 302 ─▶ pub-XXXX.r2.dev/production/... (never proxied)
App  ─▶ pub-XXXX.r2.dev/production/<os>/latest*.yml ─▶ installer from R2
```

## Channels — decided by the tag

| Tag pushed            | Channel      | R2 prefix     | Reaches users? |
|-----------------------|--------------|---------------|----------------|
| `v1.5.0`              | `production` | `production/` | **Yes** — the only way |
| `v1.5.0-all`          | `test`       | `test/`       | No |
| `v1.5.0-windows` / `-mac` / `-linux` | `test` | `test/` | No (platform-specific test build) |
| `v1.6.0-beta.1`       | `beta`       | `beta/`       | Beta builds only |

Manual runs (Actions → *Release — Build & Publish* → Run workflow) pick the channel from a dropdown.
`production` requires `platform=all` and a plain `x.y.z` version; the workflow and the backend both
refuse anything else.

Each build's `app-update.yml` is generated at build time with the feed URL
`<R2_PUBLIC_BASE_URL>/<channel>/<os>`, so a test build only ever looks for updates in `test/`
and a production build only in `production/`. There is no runtime channel switching.

## Cutting a production release

```bash
git tag v1.5.0 && git push origin v1.5.0
```

Check the run's summary for the feed URLs. Then smoke-test:

```bash
curl -sI https://sales-ai-backend-227692500877.us-central1.run.app/download/windows | head -3     # 302, Location: .../production/windows/GoDojo.AI-Setup-1.5.0.exe
curl -sI "https://sales-ai-backend-227692500877.us-central1.run.app/download/macos?arch=arm64" | head -3
curl -s  https://pub-XXXX.r2.dev/production/windows/latest.yml | head -3
curl -s -H "admin-key: $ADMIN_CRON_KEY" "https://sales-ai-backend-227692500877.us-central1.run.app/api/v1/internal/releases/validate?probe=true"
```

If any step before "Activate release on the backend" fails, nothing is active and the previous
release keeps being served. If a step *after* it fails (feed upload), downloads already point at the
new version but auto-update still offers the old one — re-run the failed job (uploads are idempotent).

## Rolling back (no rebuild)

Push a rollback tag, exactly like you push a release tag:

```bash
git tag rollback-v1.5.0 && git push origin rollback-v1.5.0     # production, windows + macos
```

| Tag pushed                              | Channel      | Platforms rolled back  |
|-----------------------------------------|--------------|------------------------|
| `rollback-v1.5.0`                       | `production` | windows + macos        |
| `rollback-v1.5.0-windows` / `-mac` / `-linux` | `production` | that platform only |
| `rollback-v1.5.0-all`                   | `production` | windows + macos + linux |
| `rollback-test-v1.5.0[-<os>]`           | `test`       | same suffixes as above |
| `rollback-beta-v1.6.0-beta.1[-<os>]`    | `beta`       | same suffixes as above |

The version in the tag is the version to **make active again** (the last good one), not the bad one.
The tag starts with `rollback-` on purpose: release builds run on `v*.*.*`, so a rollback tag can
never start a build. Tag the latest commit of the default branch (the workflow runs from the
tagged commit). To repeat the same rollback later, delete the old tag first
(`git push origin :refs/tags/rollback-v1.5.0`). Bad input (unknown version, missing archive) fails
before anything is changed.

You can still do it by hand: Actions → **Rollback release** → version `1.5.0`, channel `production`,
platforms `windows macos`.

Either way it re-points `/download/*` at that version and restores the archived `latest*.yml` for the updater.
Installers are never deleted from R2. Installed apps are **not** downgraded (electron-updater never
downgrades) — ship a fixed, higher version for people already on the bad one.

## R2 layout

```text
godojo-releases/
  production/{windows,macos,linux}/
      GoDojo.AI-Setup-<v>.exe  GoDojo.AI-<v>.exe (portable)   latest.yml
      GoDojo.AI-<v>-arm64.dmg  GoDojo.AI-<v>-x64.dmg  *.zip  *.blockmap   latest-mac.yml
      GoDojo.AI-<v>.AppImage   latest-linux.yml
      archive/<v>/latest*.yml            <- rollback source, one per published version
  beta/…   test/…                        <- same shape, never referenced by production
```

## Secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | Purpose |
|--------|---------|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | S3-compatible upload (token scoped to the bucket, Object Read & Write) |
| `R2_PUBLIC_BASE_URL` | e.g. `https://pub-XXXX.r2.dev` — baked into the app's update feed URL and used for verification |
| `VITE_API_BASE_URL` | *(existing)* backend base URL, also used to activate releases |
| `ADMIN_CRON_KEY` | *(new)* same value as the backend's `ADMIN_CRON_KEY` — authenticates `POST /api/v1/internal/releases` |

The R2 keys exist only inside the publish job's steps. They are never written to `.env`, package.json
or the app bundle. The backend and the Electron app know only `R2_PUBLIC_BASE_URL`-derived public URLs.

## Platform behavior

- **Windows** — full auto-update (check → download → install), NSIS installer. The portable `.exe` can't self-update.
- **macOS** — builds are unsigned, so the update flow is semi-automatic: the DMG for this Mac's chip opens from `/download/macos?arch=…`.
- **Linux** — AppImage self-updates; `.deb` doesn't. Linux files are uploaded to R2 but have no stable `/download` link.

## Version numbering

`MAJOR.MINOR.PATCH[-PRERELEASE]` (semver). Filenames are versioned and immutable in R2: the upload
step refuses to overwrite an existing file with different bytes, so never re-tag an already-published
version — bump it.