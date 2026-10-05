# 生成 Tauri 更新器用的静态 latest.json（发布到 GitHub Release 时一起上传）
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\make-latest-json.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\make-latest-json.ps1 -Version 0.0.4 -Notes "修复 X"
# 依赖：先跑 pnpm tauri build（带 TAURI_SIGNING_PRIVATE_KEY），产物在 src-tauri\target\release\bundle\nsis\
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Notes = '',
    [string]$InstallerDir,
    [string]$OutFile,
    [string]$Repo = 'mrone0/Hexglow'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $Version = $pkg.version
}
if (-not $InstallerDir) { $InstallerDir = Join-Path $root 'src-tauri\target\release\bundle\nsis' }
$installer = Join-Path $InstallerDir "Hexglow_$($Version)_x64-setup.exe"
$sig = "$installer.sig"
if (-not (Test-Path $installer)) { throw "缺少安装器 $installer（先构建）" }
if (-not (Test-Path $sig)) { throw "缺少签名 $sig（构建时需要 TAURI_SIGNING_PRIVATE_KEY）" }
if (-not $OutFile) { $OutFile = Join-Path $InstallerDir 'latest.json' }

$signature = (Get-Content $sig -Raw).Trim()
if (-not $signature) { throw "签名文件为空 $sig" }
$platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
        signature = $signature
        url       = "https://github.com/$Repo/releases/download/v$Version/Hexglow_$($Version)_x64-setup.exe"
    }
}
$latest = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = $platforms
}
$latest | ConvertTo-Json -Depth 6 | Set-Content -Path $OutFile -Encoding UTF8
Write-Host "已生成 $OutFile"
Write-Host "发布约定：Release tag 用 v$Version，资产至少包含 Hexglow_$($Version)_x64-setup.exe 和 latest.json（本文件）；"
Write-Host "端点 https://github.com/$Repo/releases/latest/download/latest.json 指向最新 Release 的 latest.json。"
Write-Host "注意：仓库为 private 时该 URL 不带 token 会 404，需要公开仓库或改用公开静态托管。"
