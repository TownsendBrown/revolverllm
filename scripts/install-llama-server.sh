#!/bin/sh
# Install a host llama-server for Electron native runtime (Linux).
# Prefers a Revolver CUDA pack (backends/dist or ~/.revolver/backends).
# macOS: use mac/scripts/install-llama-server.sh
set -e

HOME_DIR="${HOME:-/root}"
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEST_ROOT="${REVOLVER_LOCAL_ROOT:-$HOME_DIR/.revolver}/backends"
DEST_DIR="${REVOLVER_LLAMA_BIN_DIR:-$HOME_DIR/.local/bin}"
DEST="$DEST_DIR/llama-server"

if [ "$(uname -s)" = "Darwin" ]; then
  echo "On macOS install Metal llama-server via: mac/scripts/install-llama-server.sh" >&2
  exit 1
fi

is_exec() {
  [ -n "$1" ] && [ -x "$1" ] && [ -f "$1" ]
}

install_pack() {
  src="$1"
  id="$2"
  target="$DEST_ROOT/$id"
  mkdir -p "$DEST_ROOT"
  if [ -d "$target" ] && [ "$target" != "$src" ]; then
    rm -rf "$target"
  fi
  if [ "$target" != "$src" ]; then
    mkdir -p "$target"
    cp -a "$src/." "$target/"
  fi
  mkdir -p "$DEST_DIR"
  ln -sfn "$target/bin/llama-server" "$DEST"
  echo "Installed backend pack $id"
  echo "    $target"
  echo "    $DEST -> $target/bin/llama-server"
  "$DEST" --version 2>/dev/null || true
  echo
  echo "Next: npm run start:native"
}

# 1. Already-resolved pack (dist / previous install / extraResources).
if LINE="$("$REPO_ROOT/backends/lib/resolve.sh" 2>/dev/null)"; then
  BIN=$(printf '%s\n' "$LINE" | cut -f1)
  PACK=$(printf '%s\n' "$LINE" | cut -f3)
  SRC=$(CDPATH= cd -- "$(dirname -- "$BIN")/.." && pwd)
  if [ -n "$PACK" ] && [ -x "$BIN" ]; then
    install_pack "$SRC" "$PACK"
    exit 0
  fi
fi

# 2. Fresh build sitting in backends/dist (resolve.sh missed if nvidia-smi down).
for dir in "$REPO_ROOT/backends/dist"/*; do
  [ -d "$dir" ] || continue
  [ -f "$dir/manifest.json" ] || continue
  [ -x "$dir/bin/llama-server" ] || continue
  id=$(basename "$dir")
  echo "No GPU match; installing $id from dist."
  install_pack "$dir" "$id"
  exit 0
done

# 3. Dev fallback: PATH / LM Studio.
score_bin() {
  path="$1"
  case "$path" in
    *v100*|*volta*|*sm70*|*sm_70*) echo 40 ;;
    *nvidia-cuda*|*cuda*) echo 30 ;;
    *rocm*|*hip*) echo 20 ;;
    *vulkan*) echo 10 ;;
    *) echo 0 ;;
  esac
}

add_cand() {
  if is_exec "$1"; then
    printf '%s\t%s\n' "$(score_bin "$1")" "$1"
  fi
}

discover() {
  if is_exec "${LLAMA_SERVER_BIN:-}"; then
    add_cand "$LLAMA_SERVER_BIN"
  fi
  add_cand "$(command -v llama-server 2>/dev/null || true)"
  add_cand "$(command -v llama-server-cuda 2>/dev/null || true)"
  add_cand /usr/local/bin/llama-server
  add_cand /usr/bin/llama-server
  add_cand "$HOME_DIR/.local/bin/llama-server"
  for dir in \
    "$HOME_DIR/.lmstudio/extensions/backends" \
    "$HOME_DIR/.lmstudio/llmster"/*/".bundle/bin/extensions/backends"
  do
    [ -d "$dir" ] || continue
    find "$dir" -maxdepth 2 -type f -name llama-server 2>/dev/null | while read -r p; do
      add_cand "$p"
    done
  done
}

FOUND="$(discover | sort -nr | awk -F '\t' 'NF==2 { print $2; exit }')"
if [ -n "$FOUND" ]; then
  mkdir -p "$DEST_DIR"
  ln -sfn "$FOUND" "$DEST"
  echo "Linked $FOUND"
  echo "    -> $DEST  (not a Revolver pack — prefer ./backends/build.sh linux-cuda)"
  "$DEST" --version 2>/dev/null || true
  exit 0
fi

echo "No llama-server and no backend pack." >&2
echo >&2
echo "Build the CUDA pack:" >&2
echo "  ./backends/build.sh linux-cuda" >&2
echo "Then re-run: npm run install:llama-server" >&2
echo "Or set LLAMA_SERVER_BIN=/path/to/llama-server" >&2
exit 1
