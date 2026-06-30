#!/bin/sh
# Install a Metal-enabled llama-server on macOS (Homebrew).
set -e

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew required: https://brew.sh" >&2
  exit 1
fi

if command -v llama-server >/dev/null 2>&1; then
  echo "llama-server already installed: $(command -v llama-server)"
  llama-server --version 2>/dev/null || true
  exit 0
fi

echo "Installing llama.cpp (includes llama-server with Metal on Apple Silicon)..."
brew install llama.cpp

if command -v llama-server >/dev/null 2>&1; then
  echo "Installed: $(command -v llama-server)"
else
  echo "brew install finished but llama-server not on PATH." >&2
  echo "Try: brew link llama.cpp" >&2
  exit 1
fi
