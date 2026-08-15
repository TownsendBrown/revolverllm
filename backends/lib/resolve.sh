#!/bin/sh
# Print TSV: llama-server-bin <tab> libdir <tab> pack-id
# Linux CUDA packs only. Darwin exits 1 (Metal is mac/).
set -e

BACKENDS_LIB_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$BACKENDS_LIB_DIR/../.." && pwd)"
CATALOG="${CATALOG:-$REPO_ROOT/backends/catalog.json}"
HOME_DIR="${HOME:-/root}"

if [ "$(uname -s)" = "Darwin" ]; then
  exit 1
fi

host_caps() {
  if [ -n "${REVOLVER_COMPUTE_CAPS:-}" ]; then
    printf '%s\n' "$REVOLVER_COMPUTE_CAPS"
    return 0
  fi
  nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null \
    | awk -F. '{ if (NF>=2) printf "%s%s\n", $1, $2; else if ($1+0>0) print $1 }' \
    | tr '\n' ',' | sed 's/,$//'
}

CAPS="$(host_caps || true)"
PACK_ROOTS="${REVOLVER_BACKENDS_DIR:-}:$REPO_ROOT/backends/dist:$HOME_DIR/.revolver/backends"
export CATALOG CAPS PACK_ROOTS
export FORCE="${REVOLVER_BACKEND_PACK:-}"

node -e '
  const fs = require("fs");
  const path = require("path");
  const cat = require(process.env.CATALOG);
  const caps = (process.env.CAPS || "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  const force = process.env.FORCE || "";
  const roots = (process.env.PACK_ROOTS || "").split(":").filter(Boolean);
  function isExec(p) {
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); }
    catch { return false; }
  }
  const installed = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const dir = path.join(root, name);
      const manPath = path.join(dir, "manifest.json");
      let spec = (cat.packs || []).find((p) => p.id === name);
      if (fs.existsSync(manPath)) {
        try { spec = { ...spec, ...JSON.parse(fs.readFileSync(manPath, "utf8")) }; }
        catch { /* ignore */ }
      }
      if (!spec || spec.os === "darwin") continue;
      const bin = path.join(dir, spec.binary || "bin/llama-server");
      if (!isExec(bin)) continue;
      installed.push({ spec, dir, bin, lib: path.join(dir, spec.libDir || "lib") });
    }
  }
  function matches(pack) {
    const list = pack.matchComputeCaps || [];
    if (!caps.length) return false;
    return caps.some((c) => list.includes(c));
  }
  let pick = null;
  if (force) pick = installed.find((p) => p.spec.id === force);
  if (!pick) {
    const hits = installed.filter((p) => matches(p.spec));
    hits.sort((a, b) => (a.spec.matchComputeCaps || []).length - (b.spec.matchComputeCaps || []).length);
    pick = hits[0] || null;
  }
  if (!pick && installed.length === 1) pick = installed[0];
  if (!pick) process.exit(1);
  process.stdout.write(pick.bin + "\t" + pick.lib + "\t" + pick.spec.id + "\n");
'
