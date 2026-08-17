#!/bin/sh
# Package the macOS DMG. Servers default to native (no Docker on the Mac host),
# and the app is ad-hoc signed because there is no Developer ID identity.
# runtimes/catalog.json ships via the "extraResources" field in package.json —
# passing it on the command line makes electron-builder read it as a file
# filter, which silently omits the catalog and breaks runtime install.
# Usage: scripts/pack-electron-macos.sh [dir]
# Output: release-mac/  (does not overwrite release/)
set -e
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_ROOT"

TARGET="${1:-}"

if [ ! -f runtimes/catalog.json ]; then
  echo "[macos] missing runtimes/catalog.json — the app cannot install runtimes without it" >&2
  exit 1
fi

echo "[macos] packaging Electron (revolverRuntime=native → release-mac/)"

EB_ARGS="-c.directories.output=release-mac"
EB_ARGS="$EB_ARGS -c.extraMetadata.revolverRuntime=native"
EB_ARGS="$EB_ARGS -c.afterPack=scripts/adhoc-sign.cjs"
EB_ARGS="$EB_ARGS -c.mac.identity=null"

npm run rebuild:native
npm run build

# shellcheck disable=SC2086
if [ "$TARGET" = "dir" ]; then
  exec npx electron-builder --mac dir $EB_ARGS
fi
exec npx electron-builder --mac $EB_ARGS -c.mac.target=dmg
