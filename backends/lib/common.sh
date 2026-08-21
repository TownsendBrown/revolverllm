# Shared helpers for Linux CUDA backend packs. Sourced by pack build.sh.
# Expects: REPO_ROOT, PACK_ID, CATALOG

set -euo pipefail

catalog_json() {
  CATALOG="${CATALOG}" PACK_ID="${PACK_ID}" python3 - <<'PY'
import json, os, sys
cat = json.load(open(os.environ["CATALOG"]))
pid = os.environ["PACK_ID"]
pack = next((p for p in cat.get("packs") or [] if p.get("id") == pid), None)
if not pack:
    print("unknown pack id: " + pid, file=sys.stderr)
    sys.exit(1)
out = dict(pack)
out["llamaCppRepo"] = cat["llamaCppRepo"]
out["llamaCppTag"] = os.environ.get("LLAMA_CPP_REF") or cat["llamaCppTag"]
sys.stdout.write(json.dumps(out))
PY
}

pack_field() {
  catalog_json | python3 -c '
import json, sys
p = json.load(sys.stdin)
v = p.get(sys.argv[1])
if v is None:
    sys.exit(3)
sys.stdout.write(",".join(str(x) for x in v) if isinstance(v, list) else str(v))
' "$1"
}

pick_tool() {
  local t
  for t in "$@"; do
    if command -v "$t" >/dev/null 2>&1; then
      printf '%s\n' "$t"
      return 0
    fi
  done
  return 1
}

pick_cuda_home() {
  local dir
  for dir in \
    "${CUDA_HOME:-}" \
    "${CUDA_PATH:-}" \
    /usr/local/cuda-12.4 \
    /usr/local/cuda-12.2 \
    /usr/local/cuda-12 \
    /usr/local/cuda-11.8 \
    /usr/local/cuda-11 \
    /usr/local/cuda
  do
    if [ -n "$dir" ] && [ -x "$dir/bin/nvcc" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done
  if command -v nvcc >/dev/null 2>&1; then
    dirname "$(dirname "$(command -v nvcc)")"
    return 0
  fi
  return 1
}

# CUDA 11.8 rejects gcc-15. Prefer the newest compiler the toolkit will accept.
pick_host_cc() {
  local nvcc_major="${1:-11}"
  local pairs
  if [ "$nvcc_major" -ge 12 ]; then
    pairs="gcc-13 g++-13 gcc-12 g++-12 gcc-11 g++-11 gcc g++"
  else
    pairs="gcc-11 g++-11 gcc-10 g++-10 gcc-12 g++-12"
  fi
  set -- $pairs
  while [ "$#" -ge 2 ]; do
    if command -v "$1" >/dev/null 2>&1 && command -v "$2" >/dev/null 2>&1; then
      printf '%s %s\n' "$1" "$2"
      return 0
    fi
    shift 2
  done
  return 1
}

nproc_jobs() {
  if command -v nproc >/dev/null 2>&1; then
    nproc
  else
    getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4
  fi
}

ensure_llama_src() {
  local repo tag src
  repo="$(pack_field llamaCppRepo)"
  tag="$(pack_field llamaCppTag)"
  src="${LLAMA_CPP_SRC:-$REPO_ROOT/backends/src/llama.cpp}"
  mkdir -p "$(dirname "$src")"
  if [ ! -d "$src/.git" ]; then
    echo "[backend] cloning llama.cpp ($tag) → $src" >&2
    git clone --depth 1 --branch "$tag" "$repo" "$src"
  else
    echo "[backend] llama.cpp checkout $src" >&2
    git -C "$src" fetch --tags --depth 1 origin "$tag"
    git -C "$src" checkout --force "$tag"
  fi
  printf '%s\n' "$src"
}

# Copy CUDA runtime libs referenced by the pack (not libcuda.so — that is the driver).
bundle_cuda_libs() {
  local pack_lib="$1"
  local bin
  mkdir -p "$pack_lib"
  find "$pack_lib" "$(dirname "$pack_lib")/bin" -maxdepth 1 -type f \( -name 'llama-server' -o -name '*.so*' \) 2>/dev/null \
    | while read -r bin; do
        [ -e "$bin" ] || continue
        ldd "$bin" 2>/dev/null | awk '
          /not found/ { next }
          /libcuda\.so/ { next }
          /ld-linux/ { next }
          /libc\.so/ { next }
          /libm\.so/ { next }
          /libdl\.so/ { next }
          /libpthread\.so/ { next }
          /librt\.so/ { next }
          /libgcc_s/ { next }
          /libstdc\+\+/ { next }
          /libgomp/ { next }
          /linux-vdso/ { next }
          /libcudart|libcublas|libcublasLt|libculibos|libnvrtc|libnvJitLink/ {
            for (i = 1; i <= NF; i++) if ($i ~ /^\//) print $i
          }
        '
      done | sort -u | while read -r lib; do
        [ -f "$lib" ] || continue
        cp -a "$lib" "$pack_lib/"
        # Also copy SONAME symlink target siblings (libcudart.so.11.0 → libcudart.so.11.8.x)
        base="$(basename "$lib")"
        dir="$(dirname "$lib")"
        case "$base" in
          *.so.*)
            prefix="${base%%.so.*}.so"
            for sib in "$dir/$prefix"*; do
              [ -e "$sib" ] || continue
              cp -a "$sib" "$pack_lib/" 2>/dev/null || true
            done
            ;;
        esac
      done
}

write_manifest() {
  local dest="$1"
  local commit="$2"
  local built_at
  built_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  CATALOG="$CATALOG" PACK_ID="$PACK_ID" DEST="$dest" COMMIT="$commit" BUILT_AT="$built_at" python3 - <<'PY'
import json, os
from pathlib import Path
cat = json.load(open(os.environ["CATALOG"]))
pack = next(p for p in cat.get("packs") or [] if p.get("id") == os.environ["PACK_ID"])
manifest = {
    "id": pack["id"],
    "label": pack["label"],
    "os": pack["os"],
    "cpuArch": pack["cpuArch"],
    "backend": pack["backend"],
    "cudaArchitectures": pack.get("cudaArchitectures"),
    "matchComputeCaps": pack.get("matchComputeCaps"),
    "expectSms": pack.get("expectSms"),
    "gpus": pack.get("gpus"),
    "llamaCppTag": os.environ.get("LLAMA_CPP_REF") or cat["llamaCppTag"],
    "llamaCppCommit": os.environ["COMMIT"],
    "builtAt": os.environ["BUILT_AT"],
    "binary": "bin/llama-server",
    "libDir": "lib",
}
Path(os.environ["DEST"], "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
PY
}

verify_sms() {
  local lib="$1"
  local expect
  expect="$(pack_field expectSms)"
  if [ ! -f "$lib" ]; then
    echo "[backend] missing $lib — cannot verify SASS targets" >&2
    return 1
  fi
  local found
  found="$(strings "$lib" | grep -E '\.target sm_[0-9]+' | sed 's/.*sm_/sm_/' | sort -u | tr '\n' ' ')"
  echo "[backend] CUDA SASS targets: $found"
  local sms sms_ok=1
  IFS=',' read -r -a sms <<< "$expect"
  local want
  for want in "${sms[@]}"; do
    want="${want// /}"
    [ -n "$want" ] || continue
    if ! printf '%s' "$found" | grep -q "$want"; then
      echo "[backend] expected $want in $lib" >&2
      sms_ok=0
    fi
  done
  [ "$sms_ok" = 1 ]
}

stage_pack() {
  local install_prefix="$1"
  local src="$2"
  local dest="${REPO_ROOT}/backends/dist/${PACK_ID}"
  rm -rf "$dest"
  mkdir -p "$dest/bin" "$dest/lib"

  local server=""
  if [ -x "$install_prefix/bin/llama-server" ]; then
    server="$install_prefix/bin/llama-server"
  elif [ -x "$install_prefix/llama-server" ]; then
    server="$install_prefix/llama-server"
  fi
  if [ -z "$server" ]; then
    echo "[backend] llama-server missing after install ($install_prefix)" >&2
    return 1
  fi
  cp -a "$server" "$dest/bin/llama-server"
  chmod +x "$dest/bin/llama-server"

  local so
  find "$install_prefix" \( -type f -o -type l \) \( -name 'libggml*.so*' -o -name 'libllama*.so*' -o -name 'libmtmd*.so*' \) \
    -exec cp -a {} "$dest/lib/" \;
  # Some layouts drop .so next to the binary.
  find "$(dirname "$server")" -maxdepth 1 \( -type f -o -type l \) -name '*.so*' -exec cp -a {} "$dest/lib/" \; 2>/dev/null || true

  bundle_cuda_libs "$dest/lib"

  if command -v patchelf >/dev/null 2>&1; then
    patchelf --set-rpath "\$ORIGIN/../lib:\$ORIGIN" "$dest/bin/llama-server" || true
    find "$dest/lib" -maxdepth 1 -type f -name '*.so*' -exec patchelf --set-rpath "\$ORIGIN" {} \; 2>/dev/null || true
  fi

  local commit
  commit="$(git -C "$src" rev-parse HEAD 2>/dev/null || echo unknown)"
  write_manifest "$dest" "$commit"

  local cuda_lib=""
  for so in "$dest/lib/libggml-cuda.so" "$dest/lib/libggml-cuda.so.0" "$dest/bin/libggml-cuda.so"; do
    if [ -f "$so" ]; then cuda_lib="$so"; break; fi
  done
  if [ -z "$cuda_lib" ]; then
    cuda_lib="$(find "$dest" -name 'libggml-cuda.so*' | head -n 1 || true)"
  fi
  verify_sms "$cuda_lib"

  echo "[backend] staged $dest"
  echo "[backend]   $($dest/bin/llama-server --version 2>/dev/null | head -n 1 || true)"
}

build_cuda_pack() {
  local src build_dir install_dir cuda_home nvcc_ver nvcc_major cc_pair
  local cuda_arch generator jobs
  src="$(ensure_llama_src)"
  cuda_arch="$(pack_field cudaArchitectures)"
  build_dir="${REPO_ROOT}/backends/build/${PACK_ID}"
  install_dir="${build_dir}/install"

  cuda_home="$(pick_cuda_home || true)"
  if [ -z "$cuda_home" ]; then
    echo "[backend] nvcc not found. Install CUDA toolkit or use: $0 --docker" >&2
    exit 1
  fi
  export PATH="$cuda_home/bin:$PATH"
  export CUDA_HOME="$cuda_home"
  # Devel images have no driver. Link against the toolkit stub (libcuda.so.1 comes from the host driver at runtime).
  if [ -d "$cuda_home/lib64/stubs" ]; then
    export LIBRARY_PATH="$cuda_home/lib64/stubs${LIBRARY_PATH:+:$LIBRARY_PATH}"
    if [ -f "$cuda_home/lib64/stubs/libcuda.so" ] && [ ! -e "$cuda_home/lib64/stubs/libcuda.so.1" ]; then
      ln -sf libcuda.so "$cuda_home/lib64/stubs/libcuda.so.1"
    fi
    echo "[backend] CUDA driver stubs $cuda_home/lib64/stubs"
  fi

  if ! command -v nvcc >/dev/null 2>&1; then
    echo "[backend] nvcc not on PATH after adding $cuda_home/bin" >&2
    exit 1
  fi
  if ! command -v cmake >/dev/null 2>&1; then
    echo "[backend] cmake required" >&2
    exit 1
  fi

  nvcc_ver="$(nvcc --version | sed -n 's/.*release \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1.\2/p' | head -n 1)"
  nvcc_major="${nvcc_ver%%.*}"
  nvcc_major="${nvcc_major:-11}"
  cc_pair="$(pick_host_cc "$nvcc_major" || true)"
  if [ -z "$cc_pair" ]; then
    echo "[backend] no CUDA-compatible gcc/g++ (need gcc-11 for CUDA 11.8)" >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  set -- $cc_pair
  local cc_bin="$1" cxx_bin="$2"

  generator="Unix Makefiles"
  if pick_tool ninja >/dev/null; then
    generator="Ninja"
  fi
  jobs="$(nproc_jobs)"

  local ggml_native="${GGML_NATIVE:-ON}"
  if [ "${REVOLVER_BACKEND_DOCKER:-0}" = "1" ]; then
    ggml_native=OFF
  fi

  echo "[backend] pack=$PACK_ID"
  echo "[backend] llama.cpp=$(pack_field llamaCppTag)  src=$src"
  echo "[backend] nvcc=$nvcc_ver  cc=$cc_bin/$cxx_bin"
  echo "[backend] CMAKE_CUDA_ARCHITECTURES=$cuda_arch  GGML_NATIVE=$ggml_native"
  echo "[backend] build=$build_dir"

  if [ "${REVOLVER_BACKEND_KEEP_BUILD:-0}" != "1" ]; then
    rm -rf "$build_dir"
  fi
  mkdir -p "$build_dir"

  cmake -S "$src" -B "$build_dir" -G "$generator" \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX="$install_dir" \
      -DCMAKE_C_COMPILER="$cc_bin" \
      -DCMAKE_CXX_COMPILER="$cxx_bin" \
      -DCMAKE_CUDA_COMPILER="$(command -v nvcc)" \
      -DCMAKE_CUDA_HOST_COMPILER="$cxx_bin" \
      -DCMAKE_CUDA_ARCHITECTURES="$cuda_arch" \
      -DCMAKE_INSTALL_RPATH='$ORIGIN/../lib;$ORIGIN' \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
      -DCMAKE_LIBRARY_PATH="$cuda_home/lib64/stubs" \
      -DCMAKE_EXE_LINKER_FLAGS="-L$cuda_home/lib64/stubs -Wl,-rpath-link,$cuda_home/lib64/stubs -lcuda" \
      -DCMAKE_SHARED_LINKER_FLAGS="-L$cuda_home/lib64/stubs -Wl,-rpath-link,$cuda_home/lib64/stubs -lcuda" \
      -DBUILD_SHARED_LIBS=ON \
      -DGGML_CUDA=ON \
      -DGGML_NATIVE="$ggml_native" \
      -DLLAMA_BUILD_SERVER=ON \
      -DLLAMA_BUILD_EXAMPLES=OFF \
      -DLLAMA_BUILD_TESTS=OFF

  cmake --build "$build_dir" --config Release -j"$jobs" --target llama-server

  mkdir -p "$install_dir/bin" "$install_dir/lib"
  if [ -x "$build_dir/bin/llama-server" ]; then
    cp -a "$build_dir/bin/llama-server" "$install_dir/bin/"
    find "$build_dir/bin" -maxdepth 1 -type f -name '*.so*' -exec cp -a {} "$install_dir/lib/" \;
  fi

  stage_pack "$install_dir" "$src"
}

run_docker_build() {
  local image="revolver-backend-builder"
  local dockerfile="$REPO_ROOT/backends/linux/Dockerfile"
  local script=""
  case "$PACK_ID" in
    linux-cuda) script=/src/backends/linux/cuda/build.sh ;;
    *)
      echo "[backend] no docker script for $PACK_ID" >&2
      exit 1
      ;;
  esac
  echo "[backend] docker build $image"
  docker build -t "$image" -f "$dockerfile" "$REPO_ROOT/backends"
  docker run --rm \
    -e PACK_ID="$PACK_ID" \
    -e LLAMA_CPP_REF="${LLAMA_CPP_REF:-}" \
    -e REVOLVER_BACKEND_DOCKER=1 \
    -e REVOLVER_BACKEND_KEEP_BUILD="${REVOLVER_BACKEND_KEEP_BUILD:-0}" \
    -v "$REPO_ROOT:/src" \
    -w /src \
    "$image" \
    bash -lc 'git config --global --add safe.directory /src; git config --global --add safe.directory /src/backends/src/llama.cpp; exec "$@"' \
    bash \
    "$script"
}
