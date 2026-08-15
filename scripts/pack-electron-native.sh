#!/bin/sh
# Package Linux Electron builds that default new servers to native llama-server.
# Bundles backends/catalog.json and any staged backends/dist/<pack>/ into extraResources.
# Usage: scripts/pack-electron-native.sh [dir]
# Output: release-native/  (does not overwrite release/)
set -e
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_ROOT"

TARGET="${1:-}"

echo "[native] packaging Electron (revolverRuntime=native → release-native/)"

EB_ARGS="-c.directories.output=release-native"
EB_ARGS="$EB_ARGS -c.extraMetadata.revolverRuntime=native"
EB_ARGS="$EB_ARGS -c.extraResources[0].from=backends/catalog.json"
EB_ARGS="$EB_ARGS -c.extraResources[0].to=backends/catalog.json"

i=1
bundled=0
for man in backends/dist/*/manifest.json; do
  [ -f "$man" ] || continue
  dir=$(dirname "$man")
  id=$(basename "$dir")
  echo "[native] bundling backend pack $id"
  EB_ARGS="$EB_ARGS -c.extraResources[$i].from=$dir"
  EB_ARGS="$EB_ARGS -c.extraResources[$i].to=backends/$id"
  i=$((i + 1))
  bundled=1
done
if [ "$bundled" = 0 ]; then
  echo "[native] no backends/dist packs — app loads ~/.revolver/backends at run time"
fi

npm run rebuild:native
npm run build

# shellcheck disable=SC2086
if [ "$TARGET" = "dir" ]; then
  exec npx electron-builder --linux dir $EB_ARGS
fi
exec npx electron-builder --linux $EB_ARGS
