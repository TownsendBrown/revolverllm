# Package the Windows NSIS installer equivalent of the Linux AppImage:
# thin Electron control plane, native llama-server default, runtimes later.
# runtimes/catalog.json ships via the extraResources field in package.json -
# do not pass -c.extraResources on the CLI.
# Usage: scripts/pack-electron-windows.ps1 [dir]
# Output: release-win/
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$Target = $args[0]

if (-not (Test-Path "runtimes/catalog.json")) {
  throw "[windows] missing runtimes/catalog.json - the app cannot install runtimes without it"
}

Write-Host "[windows] packaging Electron (revolverRuntime=native -> release-win/)"

$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# Unsigned build. Skip cert discovery. Pre-seed winCodeSign so 7zip
# Darwin dylib symlinks do not fail without Developer Mode.
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

function Ensure-WinCodeSignCache {
  $cacheRoot = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
  $dest = Join-Path $cacheRoot "winCodeSign-2.6.0"
  $rcedit = Join-Path $dest "rcedit-x64.exe"
  if (Test-Path $rcedit) { return }
  $seven = Join-Path $RepoRoot "node_modules\7zip-bin\win\x64\7za.exe"
  if (-not (Test-Path $seven)) { return }
  New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
  $archive = Join-Path $cacheRoot "winCodeSign-2.6.0.7z"
  if (-not (Test-Path $archive)) {
    $url = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
    Write-Host "[windows] downloading winCodeSign cache"
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
  }
  $tmp = Join-Path $cacheRoot "seed-tmp"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  New-Item -ItemType Directory -Path $tmp | Out-Null
  & $seven x -snld -bd $archive "-o$tmp" | Out-Null
  $lib = Join-Path $tmp "darwin\10.12\lib"
  if (Test-Path $lib) {
    foreach ($n in @("libcrypto.dylib", "libssl.dylib")) {
      $p = Join-Path $lib $n
      if (-not (Test-Path $p)) { New-Item -ItemType File -Path $p | Out-Null }
    }
  }
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item $tmp $dest
}

Ensure-WinCodeSignCache

npm run rebuild:native
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Target -eq "dir") {
  npx electron-builder --win dir "-c.directories.output=release-win" "-c.extraMetadata.revolverRuntime=native"
} else {
  npx electron-builder --win "-c.directories.output=release-win" "-c.extraMetadata.revolverRuntime=native"
}
exit $LASTEXITCODE
