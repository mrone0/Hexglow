[CmdletBinding()]
param([string]$Tag = '', [string]$InstallerDir = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$config = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cargo = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri/Cargo.toml') -Raw -Encoding UTF8
$lock = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri/Cargo.lock') -Raw -Encoding UTF8
$cargoVersion = [regex]::Match($cargo, '(?m)^version = "([^"]+)"').Groups[1].Value
$lockVersion = [regex]::Match($lock, '(?m)^name = "lol-augment-assistant"\r?\nversion = "([^"]+)"').Groups[1].Value
$version = $package.version
if ($version -notmatch '^\d+\.\d+\.\d+$' -or $config.version -ne $version -or $cargoVersion -ne $version -or $lockVersion -ne $version) { throw 'Release versions must match in package.json, tauri.conf.json, Cargo.toml and Cargo.lock.' }
if ($Tag -and $Tag -ne "v$version") { throw "Tag $Tag does not match v$version" }
if ($config.app.macOSPrivateApi -eq $true) { throw 'This release must be Windows-only.' }
if ($config.bundle.resources.'resources/ocr/' -ne 'resources/ocr/') { throw 'Bundled OCR resource mapping is missing.' }
foreach ($required in @('src-tauri/icons/icon.ico', 'src-tauri/resources/ocr/NOTICE.txt', 'src-tauri/resources/ocr/LICENSE-APACHE-2.0.txt', 'LICENSE')) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $required) -PathType Leaf)) { throw "Missing release file: $required" }
}
& (Join-Path $PSScriptRoot 'prepare-ocr-models.ps1') -VerifyOnly
if ($InstallerDir) {
    $installer = Join-Path $InstallerDir "Hexglow_$($version)_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Missing installer $installer" }
    & node (Join-Path $PSScriptRoot 'verify-updater.mjs') $installer
    if ($LASTEXITCODE -ne 0) { throw 'Updater signature check failed.' }
}
Write-Host "Release preflight passed for $version."
