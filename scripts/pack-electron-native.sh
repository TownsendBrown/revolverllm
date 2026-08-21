#!/bin/sh
# Package the Linux AppImage equivalent of the macOS DMG: thin Electron
# control plane, native llama-server default, runtimes downloaded later.
# runtimes/catalog.json ships via the "extraResources" field in package.json —
# passing it on the command line makes electron-builder read it as a file
# filter, which silently omits the catalog and breaks runtime install.
# Do not bundle backends/dist or llama-server.
# Usage: scripts/pack-electron-native.sh [dir]
# Output: release-native/  (does not overwrite release/)
set -e
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_ROOT"

TARGET="${1:-}"

if [ ! -f runtimes/catalog.json ]; then
  echo "[native] missing runtimes/catalog.json — the app cannot install runtimes without it" >&2
  exit 1
fi

echo "[native] packaging Electron (revolverRuntime=native → release-native/)"

EB_ARGS="-c.directories.output=release-native"
EB_ARGS="$EB_ARGS -c.extraMetadata.revolverRuntime=native"

npm run rebuild:native
npm run build

# shellcheck disable=SC2086
if [ "$TARGET" = "dir" ]; then
  exec npx electron-builder --linux dir $EB_ARGS
fi
exec npx electron-builder --linux $EB_ARGS
