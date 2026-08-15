#!/bin/bash
set -euo pipefail

cd /opt/LiveCodeBench

export OPENAI_KEY="${OPENAI_KEY:-${OPENAI_API_KEY:-revolver}}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$OPENAI_KEY}"

echo "[livecodebench] model=${LCB_MODEL:-revolver-local} base_url=${OPENAI_BASE_URL:-}" \
  "release=${LCB_RELEASE_VERSION:-release_v1} n=${LCB_N:-1} full=${LCB_FULL:-0}" \
  "max_tokens=${LCB_MAX_TOKENS:-8000}"

# Patching, generation, evaluation and summary all happen in one process:
# LiveCodeBench keeps its model registry in memory.
exec python /opt/revolver/run_lcb.py
