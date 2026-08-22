# Launch Electron with native llama-server (Windows).
# SKUs download from Config -> Manage runtimes if not installed.
# Usage: scripts/start-electron-windows.ps1 [--dev]
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:REVOLVER_COMPOSE -ErrorAction SilentlyContinue
$env:REVOLVER_RUNTIME = "native"
if (-not $env:LLAMA_HOST) { $env:LLAMA_HOST = "127.0.0.1" }
if (-not $env:LLAMA_CONNECT_HOST) { $env:LLAMA_CONNECT_HOST = "127.0.0.1" }

Write-Host "[native] REVOLVER_RUNTIME=native (Docker not required for llama.cpp)"
if ($env:LLAMA_SERVER_BIN) {
  Write-Host "[native] llama-server: $($env:LLAMA_SERVER_BIN)"
}

if ($args[0] -eq "--dev") {
  npm run rebuild:native
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npx vite
  exit $LASTEXITCODE
}

npm run rebuild:native
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npx electron .
exit $LASTEXITCODE
