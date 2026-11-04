# Installs Audiveris (free, offline sheet-music recognition) for Jazz Charts on Windows.
#
# Run from the server folder:   npm.cmd run install-audiveris:windows
#
# 1. Installs Audiveris with winget, unless it is already installed.
#    (The installer includes its own Java, so nothing else is needed.)
# 2. Downloads the English OCR data into server\vendor\tessdata. Without it,
#    Audiveris can't read chord symbols or titles. The server finds it there.

$ErrorActionPreference = "Stop"
$ServerDir = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $ServerDir "vendor"

function Find-Audiveris {
  $candidates = @(
    (Join-Path $Vendor "audiveris\Audiveris.exe"),
    (Join-Path $env:ProgramFiles "Audiveris\Audiveris.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Audiveris\Audiveris.exe"),
    (Join-Path $env:USERPROFILE "scoop\apps\audiveris\current\Audiveris.exe")
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

$exe = Find-Audiveris
if ($exe) {
  Write-Host "Audiveris is already installed: $exe"
} else {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Installing Audiveris with winget (a Windows prompt may ask for permission)..."
    winget install --exact --name Audiveris --source winget --accept-package-agreements --accept-source-agreements
    $exe = Find-Audiveris
  }
  if (-not $exe) {
    Write-Host ""
    Write-Host "Couldn't install Audiveris automatically." -ForegroundColor Yellow
    Write-Host "Download the Windows installer (.msi) from:"
    Write-Host "  https://github.com/Audiveris/audiveris/releases/latest"
    Write-Host "Install it with the default options, then run this script again."
    Write-Host "If you installed it somewhere unusual, set AUDIVERIS_BIN to the full path of Audiveris.exe."
    exit 1
  }
  Write-Host "Installed: $exe"
}

$tess = Join-Path $Vendor "tessdata"
New-Item -ItemType Directory -Force -Path $tess | Out-Null
$eng = Join-Path $tess "eng.traineddata"
if (Test-Path $eng) {
  Write-Host "OCR data already present: $eng"
} else {
  Write-Host "Downloading English OCR data (about 23 MB)..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = "SilentlyContinue"   # makes Invoke-WebRequest much faster on PowerShell 5
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/eng.traineddata" -OutFile $eng
  Write-Host "Saved: $eng"
}

Write-Host ""
Write-Host "Done. Restart the server (npm.cmd run dev). The page should list 'audiveris' as available." -ForegroundColor Green
