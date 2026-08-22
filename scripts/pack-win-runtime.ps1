# Zip / hash a Windows llama.cpp SKU and print a runtimes/catalog.json snippet.
# Upload onto the existing TownsendBrown/revolverllm runtimes-v1 release
# (same bucket as Metal / MLX / Linux). Do not create a second release page.
#
# Usage:
#   scripts/pack-win-runtime.ps1 win-cuda
#   scripts/pack-win-runtime.ps1 win-vulkan [path-or-url]
#   scripts/pack-win-runtime.ps1 win-cpu [path-or-url]
#
# CUDA merges ggml win-cuda-12.4 zip + matching cudart zip so DLLs sit next
# to llama-server.exe. vulkan/cpu: pass a ggml zip, or omit to download.
# Host deps (not bundled): NVIDIA driver for CUDA; GPU Vulkan ICD for Vulkan.
param(
  [Parameter(Position = 0)]
  [string]$Id = "",
  [Parameter(Position = 1)]
  [string]$Src = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ReleaseTag = if ($env:RUNTIMES_RELEASE_TAG) { $env:RUNTIMES_RELEASE_TAG } else { "runtimes-v1" }
$Repo = if ($env:RUNTIMES_REPO) { $env:RUNTIMES_REPO } else { "TownsendBrown/revolverllm" }
$OutDir = Join-Path $Root "build"
$GgmlTag = if ($env:GGML_TAG) { $env:GGML_TAG } else { "b10453" }

function Log([string]$Msg) { Write-Host "[pack-win-runtime] $Msg" }

function Sha256File([string]$Path) {
  (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function SizeFile([string]$Path) {
  [int64](Get-Item -LiteralPath $Path).Length
}

function DownloadFile([string]$Url, [string]$Dest) {
  Log "downloading $Url"
  $dir = Split-Path -Parent $Dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}

function EnsureTar() {
  $tar = Get-Command tar -ErrorAction SilentlyContinue
  if (-not $tar) { throw "tar.exe not found (Windows 10+ required)" }
}

function ExtractZip([string]$Archive, [string]$Dest) {
  EnsureTar
  if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
  New-Item -ItemType Directory -Path $Dest | Out-Null
  & tar -xf $Archive -C $Dest
  if ($LASTEXITCODE -ne 0) { throw "tar extract failed: $Archive" }
}

function FindLlamaServer([string]$RootDir) {
  $hits = Get-ChildItem -Path $RootDir -Recurse -Filter "llama-server.exe" -ErrorAction SilentlyContinue
  if ($hits) { return $hits[0].FullName }
  return $null
}

function ZipDirContents([string]$SourceDir, [string]$DestZip) {
  EnsureTar
  if (Test-Path $DestZip) { Remove-Item -Force $DestZip }
  Push-Location $SourceDir
  try {
    & tar -a -cf $DestZip *
    if ($LASTEXITCODE -ne 0) { throw "tar zip failed: $DestZip" }
  } finally {
    Pop-Location
  }
}

if ($Id -notin @("win-cuda", "win-vulkan", "win-cpu")) {
  Write-Error "usage: pack-win-runtime.ps1 win-cuda|win-vulkan|win-cpu [source]"
  exit 1
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$Label = ""
$Backend = ""
$Unpack = "."
$Binary = "llama-server.exe"
$LibDir = "."
$Asset = ""
$GgmlUrl = ""
$CudartUrl = ""

switch ($Id) {
  "win-cuda" {
    $Asset = "win-cuda-${GgmlTag}.zip"
    $Label = "CUDA llama.cpp"
    $Backend = "cuda"
    $GgmlUrl = "https://github.com/ggml-org/llama.cpp/releases/download/${GgmlTag}/llama-${GgmlTag}-bin-win-cuda-12.4-x64.zip"
    $CudartUrl = "https://github.com/ggml-org/llama.cpp/releases/download/${GgmlTag}/cudart-llama-bin-win-cuda-12.4-x64.zip"
  }
  "win-vulkan" {
    $Asset = "llama-${GgmlTag}-bin-win-vulkan-x64.zip"
    $Label = "Vulkan llama.cpp"
    $Backend = "vulkan"
    $GgmlUrl = "https://github.com/ggml-org/llama.cpp/releases/download/${GgmlTag}/${Asset}"
  }
  "win-cpu" {
    $Asset = "llama-${GgmlTag}-bin-win-cpu-x64.zip"
    $Label = "CPU llama.cpp"
    $Backend = "cpu"
    $GgmlUrl = "https://github.com/ggml-org/llama.cpp/releases/download/${GgmlTag}/${Asset}"
  }
}

$ArchivePath = Join-Path $OutDir $Asset

if ($Id -eq "win-cuda") {
  $CudaZip = Join-Path $OutDir "llama-${GgmlTag}-bin-win-cuda-12.4-x64.zip"
  $CudartZip = Join-Path $OutDir "cudart-llama-bin-win-cuda-12.4-x64.zip"
  $Staging = Join-Path $OutDir "win-cuda-staging"
  $CudaExtract = Join-Path $Staging "cuda"
  $CudartExtract = Join-Path $Staging "cudart"
  $Merged = Join-Path $Staging "merged"

  if ($Src -and (Test-Path $Src)) {
    Log "using local CUDA zip $Src"
    Copy-Item -Force $Src $CudaZip
  } else {
    DownloadFile $GgmlUrl $CudaZip
  }
  DownloadFile $CudartUrl $CudartZip

  if (Test-Path $Staging) { Remove-Item -Recurse -Force $Staging }
  New-Item -ItemType Directory -Path $Staging | Out-Null
  ExtractZip $CudaZip $CudaExtract
  ExtractZip $CudartZip $CudartExtract

  $Bin = FindLlamaServer $CudaExtract
  if (-not $Bin) { throw "llama-server.exe not found in CUDA zip" }
  $BinDir = Split-Path -Parent $Bin

  if (Test-Path $Merged) { Remove-Item -Recurse -Force $Merged }
  New-Item -ItemType Directory -Path $Merged | Out-Null
  Copy-Item -Recurse -Force (Join-Path $BinDir "*") $Merged
  Get-ChildItem -Path $CudartExtract -Recurse -Include *.dll | ForEach-Object {
    Copy-Item -Force $_.FullName (Join-Path $Merged $_.Name)
  }
  if (-not (Test-Path (Join-Path $Merged "llama-server.exe"))) {
    throw "merged CUDA pack missing llama-server.exe"
  }

  Log "zipping merged CUDA pack -> $ArchivePath"
  ZipDirContents $Merged $ArchivePath
  Remove-Item -Recurse -Force $Staging
} elseif ($Src -and (Test-Path $Src)) {
  Log "copying $Src -> $ArchivePath"
  Copy-Item -Force $Src $ArchivePath
} elseif ($Src -and $Src.StartsWith("http")) {
  DownloadFile $Src $ArchivePath
} else {
  DownloadFile $GgmlUrl $ArchivePath
}

$Sha256 = Sha256File $ArchivePath
$SizeBytes = SizeFile $ArchivePath
$Url = "https://github.com/${Repo}/releases/download/${ReleaseTag}/${Asset}"

Write-Host ""
Write-Host "Archive:"
Write-Host "  $ArchivePath"
Write-Host "  sha256:  $Sha256"
Write-Host "  size:    $SizeBytes bytes"
Write-Host ""
Write-Host "Catalog snippet (paste into runtimes/catalog.json win.${Id}):"
Write-Host @"
    "${Id}": {
      "label": "${Label}",
      "backend": "${Backend}",
      "tag": "${GgmlTag}",
      "asset": "${Asset}",
      "url": "${Url}",
      "sha256": "${Sha256}",
      "sizeBytes": ${SizeBytes},
      "unpackDir": "${Unpack}",
      "binary": "${Binary}",
      "libDir": "${LibDir}"
    }
"@
Write-Host ""
Write-Host "Host deps (do not bundle): NVIDIA driver for CUDA SKU; GPU Vulkan ICD for Vulkan."
Write-Host ""
Write-Host "Upload with:"
Write-Host "  gh release upload ${ReleaseTag} --repo ${Repo} `"$ArchivePath`""
