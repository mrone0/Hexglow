# 生成 Tauri 更新器用的静态 latest.json（发布到 GitHub Release 时一起上传）
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\make-latest-json.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\make-latest-json.ps1 -Version 0.0.1 -Notes "修复 X"
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
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) {
    $Version = $pkg.version
}
if ($Version -ne $pkg.version) { throw 'Requested release version does not match package.json.' }
if (-not $InstallerDir) { $InstallerDir = Join-Path $root 'src-tauri\target\release\bundle\nsis' }
& (Join-Path $PSScriptRoot 'verify-release.ps1') -Tag "v$Version" -InstallerDir $InstallerDir
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
$json = $latest | ConvertTo-Json -Depth 6
# UTF-8 无 BOM：serde_json/reqwest 解析带 BOM 的响应会直接报错，更新检查失败
[IO.File]::WriteAllText($OutFile, $json + "`n", [Text.UTF8Encoding]::new($false))
$head = ([IO.File]::ReadAllBytes($OutFile)[0..2] -join ',')
if ($head -eq '239,187,191') { throw "latest.json 含 UTF-8 BOM，更新器会拒绝解析" }
$lines = foreach ($path in @($installer, $sig, $OutFile)) {
    $stream = [IO.File]::OpenRead($path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    "$hash  $([IO.Path]::GetFileName($path))"
}
$checksums = Join-Path (Split-Path -Parent $OutFile) 'SHA256SUMS.txt'
[IO.File]::WriteAllText($checksums, ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "已生成 $OutFile（UTF-8 无 BOM）"
Write-Host "发布约定：Release tag 用 v$Version，资产至少包含 Hexglow_$($Version)_x64-setup.exe 和 latest.json（本文件）；"
Write-Host "端点 https://github.com/$Repo/releases/latest/download/latest.json 指向最新 Release 的 latest.json。"
Write-Host "注意：仓库必须保持 public，private 状态该 URL 不带 token 会 404。推送 v<版本> tag 后 CI 会自动生成本文件并创建 Release。"
