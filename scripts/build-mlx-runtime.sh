#!/usr/bin/env bash
# Build a self-contained MLX runtime archive for Revolver (macOS arm64, macOS 14+ floor).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${ROOT}/build/mlx-runtime-build"
OUT_DIR="${ROOT}/build/mlx-runtime"
ARCHIVE_NAME="revolver-mlx-runtime-1.0.0-mac14-arm64.tar.gz"
ARCHIVE_PATH="${ROOT}/build/${ARCHIVE_NAME}"

MLX_ENGINE_REPO="https://github.com/lmstudio-ai/mlx-engine.git"
MLX_ENGINE_COMMIT="ec2f585ae8a48cf9ffe09baf469d76be317db288"

PYTHON_TAG="20260414"
PYTHON_ASSET="cpython-3.11.15+20260414-aarch64-apple-darwin-install_only_stripped.tar.gz"
PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_TAG}/${PYTHON_ASSET//+/%2B}"

log() { printf '[build-mlx-runtime] %s\n' "$*"; }
warn() { printf '[build-mlx-runtime] WARN: %s\n' "$*" >&2; }

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  warn "Expected darwin/arm64 host; continuing anyway."
fi

rm -rf "${BUILD_DIR}" "${OUT_DIR}"
mkdir -p "${BUILD_DIR}" "${OUT_DIR}"

PYTHON_STAGING="${BUILD_DIR}/python-src"
mkdir -p "${PYTHON_STAGING}"
PYTHON_ARCHIVE="${PYTHON_STAGING}/${PYTHON_ASSET}"

if [[ ! -f "${PYTHON_ARCHIVE}" ]]; then
  log "Downloading ${PYTHON_ASSET}"
  curl -fsSL -o "${PYTHON_ARCHIVE}" "${PYTHON_URL}"
fi

log "Extracting standalone Python"
tar -xzf "${PYTHON_ARCHIVE}" -C "${PYTHON_STAGING}"
cp -R "${PYTHON_STAGING}/python" "${OUT_DIR}/python"

PYTHON_BIN="${OUT_DIR}/python/bin/python3"
SITE_PACKAGES="$("${PYTHON_BIN}" -c 'import site; print(site.getsitepackages()[0])')"

log "Bootstrapping pip"
"${PYTHON_BIN}" -m ensurepip --upgrade
"${PYTHON_BIN}" -m pip install --upgrade pip wheel setuptools

MLX_ENGINE_DIR="${BUILD_DIR}/mlx-engine"
if [[ ! -d "${MLX_ENGINE_DIR}/.git" ]]; then
  git clone "${MLX_ENGINE_REPO}" "${MLX_ENGINE_DIR}"
fi
(
  cd "${MLX_ENGINE_DIR}"
  git fetch --depth 1 origin "${MLX_ENGINE_COMMIT}" || git fetch origin
  git checkout "${MLX_ENGINE_COMMIT}"
)

log "Installing mlx-engine dependencies into site-packages"
"${PYTHON_BIN}" -m pip install \
  --target "${SITE_PACKAGES}" \
  -r "${MLX_ENGINE_DIR}/requirements.txt"

log "Vendoring mlx_engine package"
rm -rf "${SITE_PACKAGES}/mlx_engine"
cp -R "${MLX_ENGINE_DIR}/mlx_engine" "${SITE_PACKAGES}/mlx_engine"

log "Installing revolver_mlx_server wrapper"
rm -rf "${SITE_PACKAGES}/revolver_mlx_server"
cp -R "${ROOT}/runtimes/mlx-server/revolver_mlx_server" "${SITE_PACKAGES}/revolver_mlx_server"

log "Smoke testing imports"
"${PYTHON_BIN}" -c "import mlx_engine; import revolver_mlx_server; import mlx; import mlx_lm"
"${PYTHON_BIN}" -m revolver_mlx_server --help >/dev/null

log "Creating archive ${ARCHIVE_NAME}"
rm -f "${ARCHIVE_PATH}"
tar -czf "${ARCHIVE_PATH}" -C "${OUT_DIR}" .

SHA256="$(shasum -a 256 "${ARCHIVE_PATH}" | awk '{print $1}')"
SIZE_BYTES="$(wc -c < "${ARCHIVE_PATH}" | tr -d ' ')"

cat <<EOF

Build complete:
  archive: ${ARCHIVE_PATH}
  sha256:  ${SHA256}
  size:    ${SIZE_BYTES} bytes

Catalog snippet (paste into runtimes/catalog.json mlxRuntime):
  "version": "1.0.0",
  "asset": "${ARCHIVE_NAME}",
  "url": "https://github.com/TownsendBrown/revolverllm/releases/download/runtimes-v1/${ARCHIVE_NAME}",
  "sha256": "${SHA256}",
  "sizeBytes": ${SIZE_BYTES},
  "unpackDir": ".",
  "minMacos": "14.0",
  "mlxEngineCommit": "${MLX_ENGINE_COMMIT}"

Upload with:
  gh release create runtimes-v1 --repo TownsendBrown/revolverllm \\
    "${ARCHIVE_PATH}" \\
    build/llama-b10453-bin-macos-arm64.tar.gz
EOF
