#!/usr/bin/env bash
# Installs Audiveris (offline OMR engine) into server/vendor/audiveris.
# Uses the official Ubuntu .deb from GitHub releases and extracts it locally
# (no root, no system install). The .deb bundles its own Java runtime
# (jpackage), so the system Java version does not matter for running it.
#
# Usage: scripts/install-audiveris.sh [version]   (default 5.11.0)
# Env:   AUDIVERIS_DEB_URL to override the download URL (e.g. a mirror or a
#        different Ubuntu flavour: ubuntu22.04 / ubuntu24.04).
set -euo pipefail

VERSION="${1:-5.11.0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$HERE/vendor"
DEST="$VENDOR/audiveris"

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" ]]; then
  echo "Only x86_64 Linux .deb builds are published; got $ARCH." >&2
  echo "Install Audiveris manually and set AUDIVERIS_BIN." >&2
  exit 1
fi

UBUNTU="ubuntu24.04"
# Read os-release in a subshell: sourcing it directly would clobber $VERSION.
OS_VER="$( (. /etc/os-release 2>/dev/null && echo "${ID:-}-${VERSION_ID:-}") || true)"
if [[ "$OS_VER" == "ubuntu-22.04" ]]; then UBUNTU="ubuntu22.04"; fi
URL="${AUDIVERIS_DEB_URL:-https://github.com/audiveris/audiveris/releases/download/${VERSION}/Audiveris-${VERSION}-${UBUNTU}-x86_64.deb}"

command -v dpkg-deb >/dev/null || { echo "dpkg-deb is required" >&2; exit 1; }

mkdir -p "$VENDOR"
TMP="$(mktemp -d "$VENDOR/.dl.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $URL"
curl -fsSL --retry 3 -o "$TMP/audiveris.deb" "$URL"

echo "Extracting"
dpkg-deb -x "$TMP/audiveris.deb" "$TMP/root"

# jpackage layout: /opt/audiveris/{bin/Audiveris,lib/...}
SRC="$(find "$TMP/root" -type f -path '*/bin/Audiveris' -printf '%h\n' | head -n1)"
if [[ -z "$SRC" ]]; then
  echo "Could not find bin/Audiveris inside the .deb" >&2
  find "$TMP/root" -maxdepth 4 >&2
  exit 1
fi
rm -rf "$DEST"
mv "$(dirname "$SRC")" "$DEST"
echo "$VERSION" > "$DEST/VERSION"

# OCR language data. Audiveris ships Tesseract but no languages; without them it
# recognizes no text at all (chord symbols, title). The server sets
# TESSDATA_PREFIX=vendor/audiveris/tessdata when running Audiveris.
TESS_LANGS="${AUDIVERIS_OCR_LANGS:-eng}"
mkdir -p "$DEST/tessdata"
for lang in $TESS_LANGS; do
  echo "Downloading OCR language: $lang"
  curl -fsSL --retry 3 -o "$DEST/tessdata/$lang.traineddata" \
    "https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/$lang.traineddata"
done

echo "Installed: $DEST/bin/Audiveris"
"$DEST/bin/Audiveris" -help >/dev/null 2>&1 && echo "Smoke test OK" || echo "Warning: '-help' returned non-zero (may still work in -batch mode)"
