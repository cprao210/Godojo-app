#!/usr/bin/env bash
# GoDojo release publishing to Cloudflare R2 (S3-compatible API) + backend activation.
#
#   r2-release.sh upload-binaries    installers / zips / blockmaps -> R2 (NOT the update manifests)
#   r2-release.sh verify-binaries    S3 size check + public r2.dev HEAD for every uploaded file
#   r2-release.sh activate           tell the backend this release is now the active download
#   r2-release.sh upload-manifests   latest*.yml -> R2 LAST (this is what switches on auto-update)
#   r2-release.sh verify-manifests   public manifest == local manifest
#   r2-release.sh rollback           backend pointer + archived manifests for VERSION become live again
#
# Everything comes from the environment (GitHub Actions secrets / job outputs). Nothing here
# ever echoes a credential. Requires: aws-cli v2, curl, jq (all preinstalled on ubuntu-latest).
#
# Required env:
#   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME R2_PUBLIC_BASE_URL
#   CHANNEL (production|beta|test)   VERSION (1.5.0, no leading v)
#   ARTIFACTS_DIR (default: artifacts) containing mac-release/ win-release/ linux-release/
# activate / rollback also need: API_BASE_URL ADMIN_CRON_KEY  (rollback: PLATFORMS, default 'windows macos')
set -euo pipefail

: "${CHANNEL:?}" "${VERSION:?}" "${R2_BUCKET_NAME:?}" "${R2_ACCOUNT_ID:?}" "${R2_PUBLIC_BASE_URL:?}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-artifacts}"
PUBLIC="${R2_PUBLIC_BASE_URL%/}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?}"
export AWS_DEFAULT_REGION=auto
# aws-cli >= 2.23 adds CRC checksum headers that R2 rejects on some calls.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

# artifact dir -> R2 folder -> label used in logs
MAP=("mac-release:macos:macOS" "win-release:windows:Windows" "linux-release:linux:Linux")

log()  { echo "[r2-release] $*"; }
fail() { echo "::error::$*"; exit 1; }

s3()    { aws s3 "$@" --endpoint-url "$ENDPOINT" --only-show-errors; }
s3api() { aws s3api "$@" --endpoint-url "$ENDPOINT"; }

remote_size() { # <key> -> size in bytes, or empty when the object does not exist
  s3api head-object --bucket "$R2_BUCKET_NAME" --key "$1" --query ContentLength --output text 2>/dev/null || true
}

each_platform() { # calls: "$1" <dir> <r2folder> <label>   (only for platforms that were built)
  local cb="$1" entry dir folder label
  for entry in "${MAP[@]}"; do
    IFS=: read -r dir folder label <<<"$entry"
    [ -d "$ARTIFACTS_DIR/$dir" ] || continue
    "$cb" "$ARTIFACTS_DIR/$dir" "$folder" "$label"
  done
}

is_manifest() { [[ "$1" =~ ^latest.*\.yml$ ]]; }

# ── 1. binaries ──────────────────────────────────────────────────────────────
_upload_binaries() {
  local dir="$1" folder="$2" label="$3" f name key local_size remote
  log "Uploading $label artifacts to R2 (${CHANNEL}/${folder}/)"
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    is_manifest "$name" && continue
    key="${CHANNEL}/${folder}/${name}"
    local_size="$(stat -c%s "$f")"
    remote="$(remote_size "$key")"
    if [ -n "$remote" ]; then
      if [ "$remote" = "$local_size" ]; then
        log "  = $name already in R2 with the same size, skipping (safe re-run)"
        continue
      fi
      [ "${ALLOW_OVERWRITE:-false}" = "true" ] \
        || fail "$key already exists in R2 with a different size ($remote vs $local_size). Versioned files are immutable — bump the version, or re-run with ALLOW_OVERWRITE=true."
    fi
    # Versioned filenames never change once published, so let browsers/CDNs cache them forever.
    s3 cp "$f" "s3://${R2_BUCKET_NAME}/${key}" \
      --content-type application/octet-stream \
      --cache-control "public, max-age=31536000, immutable"
    log "  + $key ($local_size bytes)"
  done
}

_verify_binaries() {
  local dir="$1" folder="$2" label="$3" f name key local_size remote code i
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    is_manifest "$name" && continue
    key="${CHANNEL}/${folder}/${name}"
    local_size="$(stat -c%s "$f")"
    remote="$(remote_size "$key")"
    [ "$remote" = "$local_size" ] || fail "Verify failed: $key is '${remote:-missing}' in R2, expected $local_size bytes"
    code=000
    for i in 1 2 3 4 5; do
      code="$(curl -sS -o /dev/null -I -m 20 -w '%{http_code}' "${PUBLIC}/${key}" || true)"
      [ "$code" = "200" ] && break
      sleep 3
    done
    [ "$code" = "200" ] || fail "Verify failed: public URL for $key returned HTTP $code (is the bucket's r2.dev URL enabled?)"
  done
  log "$label objects verified (size in R2 + public URL)"
}

# ── 2. backend activation ────────────────────────────────────────────────────
_win_installer() { # installer the updater uses = `path:` in latest.yml (NSIS setup exe)
  local yml="$ARTIFACTS_DIR/win-release/latest.yml" name
  [ -f "$yml" ] || fail "latest.yml missing for Windows"
  name="$(grep -E '^path:' "$yml" | head -1 | sed -E 's/^path:[[:space:]]*//; s/[[:space:]]*$//')"
  [ -n "$name" ] && [ -f "$ARTIFACTS_DIR/win-release/$name" ] || fail "latest.yml path '$name' is not a file in win-release/"
  echo "$name"
}

activate() {
  : "${API_BASE_URL:?}" "${ADMIN_CRON_KEY:?}"
  local payload='{}' win="" mac_arm="GoDojo.AI-${VERSION}-arm64.dmg" mac_x64="GoDojo.AI-${VERSION}-x64.dmg"

  if [ -d "$ARTIFACTS_DIR/win-release" ]; then
    win="$(_win_installer)"
    payload="$(jq -c --arg c "$CHANNEL" --arg i "${CHANNEL}/windows/${win}" --arg m "${CHANNEL}/windows/latest.yml" \
      '.windows = {installer: $i, updateMetadata: $m}' <<<"$payload")"
  fi
  if [ -d "$ARTIFACTS_DIR/mac-release" ]; then
    [ -f "$ARTIFACTS_DIR/mac-release/$mac_arm" ] || fail "Missing $mac_arm in mac-release/"
    [ -f "$ARTIFACTS_DIR/mac-release/$mac_x64" ] || fail "Missing $mac_x64 in mac-release/"
    payload="$(jq -c --arg a "${CHANNEL}/macos/${mac_arm}" --arg x "${CHANNEL}/macos/${mac_x64}" --arg m "${CHANNEL}/macos/latest-mac.yml" \
      '.macos = {installer: $a, installers: {arm64: $a, x64: $x}, updateMetadata: $m}' <<<"$payload")"
  fi
  if [ -d "$ARTIFACTS_DIR/linux-release" ]; then
    local appimage
    appimage="$(cd "$ARTIFACTS_DIR/linux-release" && ls ./*.AppImage 2>/dev/null | head -1 | sed 's|^\./||')"
    [ -n "$appimage" ] || fail "No AppImage in linux-release/"
    payload="$(jq -c --arg i "${CHANNEL}/linux/${appimage}" --arg m "${CHANNEL}/linux/latest-linux.yml" \
      '.linux = {installer: $i, updateMetadata: $m}' <<<"$payload")"
  fi
  payload="$(jq -c --arg c "$CHANNEL" --arg v "$VERSION" '. + {channel: $c, version: $v}' <<<"$payload")"

  log "Updating ${CHANNEL} release metadata (version ${VERSION})"
  _backend POST "/api/v1/internal/releases" "$payload"
  log "Release metadata for ${CHANNEL} ${VERSION} is now active on the backend"
}

_backend() { # <METHOD> <path> <json body>
  local out code
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -m 30 --retry 3 --retry-all-errors --retry-delay 3 \
    -X "$1" "${API_BASE_URL%/}$2" \
    -H "admin-key: ${ADMIN_CRON_KEY}" -H 'Content-Type: application/json' -d "$3" || echo 000)"
  if [ "$code" != "200" ]; then
    echo "Backend response (HTTP $code):"; cat "$out" || true; echo
    rm -f "$out"
    fail "Backend rejected the release request (HTTP $code). R2 files are uploaded but this release is NOT active."
  fi
  cat "$out"; echo; rm -f "$out"
}

# ── 3. manifests (last: this is what auto-update reads) ──────────────────────
_upload_manifests() {
  local dir="$1" folder="$2" label="$3" f name
  for f in "$dir"/latest*.yml; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    grep -qE "^version:[[:space:]]*['\"]?${VERSION//./\\.}['\"]?[[:space:]]*$" "$f" \
      || fail "$name does not declare version $VERSION — refusing to publish a mismatched update feed"
    # Archived copy first (rollback source), then the live feed.
    s3 cp "$f" "s3://${R2_BUCKET_NAME}/${CHANNEL}/${folder}/archive/${VERSION}/${name}" \
      --content-type application/x-yaml --cache-control "public, max-age=31536000, immutable"
    s3 cp "$f" "s3://${R2_BUCKET_NAME}/${CHANNEL}/${folder}/${name}" \
      --content-type application/x-yaml --cache-control "no-cache, max-age=0"
    log "  + ${CHANNEL}/${folder}/${name} (auto-update feed for $label)"
  done
}

_verify_manifests() {
  local dir="$1" folder="$2" label="$3" f name tmp i ok
  tmp="$(mktemp)"
  for f in "$dir"/latest*.yml; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"; ok=0
    for i in 1 2 3 4 5; do
      curl -fsS -m 20 -H 'Cache-Control: no-cache' "${PUBLIC}/${CHANNEL}/${folder}/${name}" -o "$tmp" 2>/dev/null \
        && cmp -s "$tmp" "$f" && { ok=1; break; }
      sleep 3
    done
    [ "$ok" = 1 ] || fail "Public ${CHANNEL}/${folder}/${name} does not match the built manifest"
  done
  rm -f "$tmp"
  log "$label update feed verified"
}

# ── rollback: backend pointer + archived manifests, no rebuild ──────────────
_manifest_names() { case "$1" in windows) echo latest.yml;; macos) echo latest-mac.yml;; linux) echo latest-linux.yml;; esac; }

_check_archives() { # all-or-nothing: every archived manifest must exist before anything changes
  local p name
  for p in ${PLATFORMS:-windows macos}; do
    for name in $(_manifest_names "$p"); do
      [ -n "$(remote_size "${CHANNEL}/${p}/archive/${VERSION}/${name}")" ] \
        || fail "No archived manifest ${CHANNEL}/${p}/archive/${VERSION}/${name} — ${VERSION} was never published by this pipeline"
    done
  done
}

rollback() {
  : "${API_BASE_URL:?}" "${ADMIN_CRON_KEY:?}"
  local p name
  _check_archives
  for p in ${PLATFORMS:-windows macos}; do
    log "Rolling ${CHANNEL}/${p} download endpoint back to ${VERSION}"
    _backend POST "/api/v1/internal/releases/rollback" \
      "$(jq -nc --arg c "$CHANNEL" --arg p "$p" --arg v "$VERSION" '{channel:$c, platform:$p, version:$v}')"
  done
  for p in ${PLATFORMS:-windows macos}; do
    for name in $(_manifest_names "$p"); do
      s3 cp "s3://${R2_BUCKET_NAME}/${CHANNEL}/${p}/archive/${VERSION}/${name}" "s3://${R2_BUCKET_NAME}/${CHANNEL}/${p}/${name}" \
        --content-type application/x-yaml --cache-control "no-cache, max-age=0" --metadata-directive REPLACE
      log "  update feed ${CHANNEL}/${p}/${name} restored to ${VERSION}"
    done
  done
  log "Rollback to ${VERSION} complete (installers untouched)"
}

case "${1:-}" in
  upload-binaries)   each_platform _upload_binaries ;;
  verify-binaries)   each_platform _verify_binaries ;;
  activate)          activate ;;
  upload-manifests)  each_platform _upload_manifests ;;
  verify-manifests)  each_platform _verify_manifests ;;
  rollback)          rollback ;;
  *) echo "usage: $0 {upload-binaries|verify-binaries|activate|upload-manifests|verify-manifests|rollback}" >&2; exit 2 ;;
esac