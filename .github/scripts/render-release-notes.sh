#!/usr/bin/env bash
# Renders .github/RELEASE_TEMPLATE.md into the GitHub release body.
#
#   __VERSION__    -> the app version (e.g. 1.0.6-test-4)
#   __CHANNEL__    -> production | beta | test
#   __DOWNLOADS__  -> download links built from the files this run actually built,
#                     pointing at <R2_PUBLIC_BASE_URL>/<channel>/<windows|macos|linux>/<file>
#                     (the exact keys r2-release.sh uploads). Platform-only tags
#                     (-mac / -windows / -linux) therefore only list that platform.
#
# Required env: CHANNEL VERSION R2_PUBLIC_BASE_URL
# Optional env: ARTIFACTS_DIR (default: artifacts), TEMPLATE, OUT
set -euo pipefail

: "${CHANNEL:?}" "${VERSION:?}" "${R2_PUBLIC_BASE_URL:?}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-artifacts}"
TEMPLATE="${TEMPLATE:-.github/RELEASE_TEMPLATE.md}"
OUT="${OUT:-release-notes.md}"
PUBLIC="${R2_PUBLIC_BASE_URL%/}"

url() { # <r2 folder> <file name> -> public URL (spaces encoded)
  echo "${PUBLIC}/${CHANNEL}/$1/${2// /%20}"
}

# Print "- **<label>:** [<file>](<url>)" for each file in <dir> matching <glob>.
links() { # <artifact dir> <r2 folder> <glob> <label>
  local dir="$ARTIFACTS_DIR/$1" folder="$2" glob="$3" label="$4" f name
  [ -d "$dir" ] || return 0
  for f in "$dir"/$glob; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    echo "- **${label}:** [${name}]($(url "$folder" "$name"))"
  done
}

case "$CHANNEL" in
  production) intro="Downloads for **GoDojo AI ${VERSION}**." ;;
  beta)       intro="⚠️ **Beta build** — for early testers, not for general customers. Downloads for **GoDojo AI ${VERSION}** (beta channel)." ;;
  *)          intro="⚠️ **Test build** — internal testing only. Downloads for **GoDojo AI ${VERSION}** (test channel)." ;;
esac

{
  echo "$intro"
  echo
  win="$(
    links win-release windows "GoDojo.AI-Setup-*.exe" "Installer (recommended)"
    for f in "$ARTIFACTS_DIR"/win-release/GoDojo.AI-*.exe; do
      [ -f "$f" ] || continue
      case "$(basename "$f")" in GoDojo.AI-Setup-*) continue ;; esac
      echo "- **Portable (no install):** [$(basename "$f")]($(url windows "$(basename "$f")"))"
    done
  )"
  if [ -n "$win" ]; then echo "### Windows (x64)"; echo "$win"; echo; fi

  mac="$(
    links mac-release macos "*-arm64.dmg" "Apple Silicon (M1–M4) — .dmg"
    links mac-release macos "*-x64.dmg"   "Intel — .dmg"
    links mac-release macos "*-arm64.zip" "Apple Silicon — .zip"
    links mac-release macos "*-x64.zip"   "Intel — .zip"
  )"
  if [ -n "$mac" ]; then echo "### macOS"; echo "$mac"; echo; fi

  linux="$(
    links linux-release linux "*.AppImage" "AppImage"
    links linux-release linux "*.deb"      "Debian/Ubuntu (.deb)"
  )"
  if [ -n "$linux" ]; then echo "### Linux (x64)"; echo "$linux"; echo; fi

  if [ -z "$win$mac$linux" ]; then
    echo "_No installers were found for this run._"
    echo
  fi

  if [ "$CHANNEL" = "production" ]; then
    echo "These links point at this exact version. Installed copies of GoDojo AI update themselves automatically."
  else
    echo "Installed copies on the **${CHANNEL}** channel update themselves from \`${PUBLIC}/${CHANNEL}/\`."
  fi
} > downloads.md

# Substitute placeholders. __DOWNLOADS__ must sit on its own line in the template.
awk -v dl=downloads.md '
  $0 == "__DOWNLOADS__" { while ((getline line < dl) > 0) print line; close(dl); next }
  { print }
' "$TEMPLATE" \
  | sed -e "s/__VERSION__/${VERSION}/g" -e "s/__CHANNEL__/${CHANNEL}/g" > "$OUT"

rm -f downloads.md
echo "[render-release-notes] wrote $OUT for $VERSION ($CHANNEL)"
