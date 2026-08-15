# Shared helpers for Linux CUDA backend packs. Sourced by pack build.sh.
# Expects: REPO_ROOT, PACK_ID, CATALOG

set -euo pipefail

catalog_json() {
  CATALOG="${CATALOG}" PACK_ID="${PACK_ID}" node -e '
    const cat = require(process.env.CATALOG);
    const id = process.env.PACK_ID;
    const pack = (cat.packs || []).find((p) => p.id === id);
    if (!pack) {
      console.error("unknown pack id: " + id);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      llamaCppRepo: cat.llamaCppRepo,
      llamaCppTag: process.env.LLAMA_CPP_REF || cat.llamaCppTag,
      ...pack,
    }));
  '
}

pack_field() {
  catalog_json | node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      const p = JSON.parse(raw);
      const v = p[process.argv[1]];
      if (v == null) process.exit(3);
      process.stdout.write(Array.isArray(v) ? v.join(",") : String(v));
    });
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
    echo "[backend] cloning llama.cpp ($tag) → $src"
    git clone --depth 1 --branch "$tag" "$repo" "$src"
  else
    echo "[backend] llama.cpp checkout $src"
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
  CATALOG="$CATALOG" PACK_ID="$PACK_ID" DEST="$dest" COMMIT="$commit" BUILT_AT="$built_at" node -e '
    const fs = require("fs");
    const path = require("path");
    const cat = require(process.env.CATALOG);
    const pack = (cat.packs || []).find((p) => p.id === process.env.PACK_ID);
    const manifest = {
      id: pack.id,
      label: pack.label,
      os: pack.os,
      cpuArch: pack.cpuArch,
      backend: pack.backend,
      cudaArchitectures: pack.cudaArchitectures,
      matchComputeCaps: pack.matchComputeCaps,
      expectSms: pack.expectSms,
      gpus: pack.gpus,
      llamaCppTag: process.env.LLAMA_CPP_REF || cat.llamaCppTag,
      llamaCppCommit: process.env.COMMIT,
      builtAt: process.env.BUILT_AT,
      binary: "bin/llama-server",
      libDir: "lib",
    };
    fs.writeFileSync(
      path.join(process.env.DEST, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  '
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
  find "$install_prefix" -type f \( -name 'libggml*.so*' -o -name 'libllama*.so*' -o -name 'libmtmd*.so*' \) \
    -exec cp -a {} "$dest/lib/" \;
  # Some layouts drop .so next to the binary.
  find "$(dirname "$server")" -maxdepth 1 -type f -name '*.so*' -exec cp -a {} "$dest/lib/" \; 2>/dev/null || true

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

  local ggml_native=ON
  if [ "${REVOLVER_BACKEND_DOCKER:-0}" = "1" ]; then
    ggml_native=OFF
  fi

  echo "[backend] pack=$PACK_ID"
  echo "[backend] llama.cpp=$(pack_field llamaCppTag)  src=$src"
  echo "[backend] nvcc=$nvcc_ver  cc=$cc_bin/$cxx_bin"
  echo "[backend] CMAKE_CUDA_ARCHITECTURES=$cuda_arch  GGML_NATIVE=$ggml_native"
  echo "[backend] build=$build_dir"

  rm -rf "$build_dir"
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
    -DBUILD_SHARED_LIBS=ON \
    -DGGML_CUDA=ON \
    -DGGML_NATIVE="$ggml_native" \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_TESTS=OFF

  cmake --build "$build_dir" --config Release -j"$jobs" --target llama-server
  cmake --install "$build_dir"

  # llama.cpp often leaves llama-server + .so in build/bin even when prefix/bin is thin.
  if [ -x "$build_dir/bin/llama-server" ] && [ ! -x "$install_dir/bin/llama-server" ]; then
    mkdir -p "$install_dir/bin" "$install_dir/lib"
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
    linux-cuda-sm70) script=/src/backends/linux/cuda-sm70/build.sh ;;
    linux-cuda-pascal) script=/src/backends/linux/cuda-pascal/build.sh ;;
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
    -v "$REPO_ROOT:/src" \
    -w /src \
    "$image" \
    "$script"
}
