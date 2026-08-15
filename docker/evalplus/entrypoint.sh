#!/bin/bash
set -euo pipefail

export OPENAI_API_KEY="${OPENAI_API_KEY:-${OPENAI_KEY:-revolver}}"
export OPENAI_KEY="${OPENAI_KEY:-$OPENAI_API_KEY}"

: "${EVALPLUS_MODEL:?EVALPLUS_MODEL is required}"
: "${OPENAI_BASE_URL:?OPENAI_BASE_URL is required}"

echo "[evalplus] model=$EVALPLUS_MODEL dataset=${EVALPLUS_DATASET:-humaneval}" \
  "base_url=$OPENAI_BASE_URL mini=${EVALPLUS_MINI:-1}" \
  "max_new_tokens=${EVALPLUS_MAX_NEW_TOKENS:-4096}"

exec python /opt/revolver/run_evalplus.py
