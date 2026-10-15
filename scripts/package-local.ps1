[CmdletBinding()]
param(
    [switch]$Offline,
    [ValidateRange(1, 8)][int]$BuildJobs = 2
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$originalLocation = Get-Location
$originalSigningKey = $env:TAURI_SIGNING_PRIVATE_KEY
$originalCi = $env:CI
$originalBuildJobs = $env:CARGO_BUILD_JOBS
$buildLock = $null
$packagingProcess = [Diagnostics.Process]::GetCurrentProcess()
$originalPriority = $packagingProcess.PriorityClass

function Get-PackageHash([string]$Path) {
    # Windows PowerShell may lack Microsoft.PowerShell.Utility/Get-FileHash.
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
try {
    Set-Location -LiteralPath $repoRoot
    # New compiler processes inherit below-normal priority on Windows.
    $packagingProcess.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
    foreach ($command in @('pnpm', 'node', 'cargo')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command is unavailable: $command" }
    }
    $releaseRoot = Join-Path $repoRoot 'release'
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    try {
        $buildLock = [IO.File]::Open((Join-Path $releaseRoot '.package-local.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch { throw 'Another local packaging task is running. Wait for it to finish.' }

    & (Join-Path $PSScriptRoot 'verify-release.ps1')
    $version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        $signingPath = Join-Path $env:USERPROFILE '.tauri/hexglow.key'
        if (-not (Test-Path -LiteralPath $signingPath -PathType Leaf)) {
            throw 'Updater signing key is missing. Set TAURI_SIGNING_PRIVATE_KEY or place the existing key at %USERPROFILE%\.tauri\hexglow.key. See docs/BUILDING_WINDOWS.md.'
        }
        $env:TAURI_SIGNING_PRIVATE_KEY = $signingPath
    }
    $env:CI = 'true'
    $env:CARGO_BUILD_JOBS = [string]$BuildJobs
    $buildStartedAt = [DateTime]::UtcNow
    $buildArguments = @('tauri', 'build', '--bundles', 'nsis', '--', '--locked')
    if ($Offline) { $buildArguments += '--offline' }
    & pnpm @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed. No new candidate was archived.' }

    $installerDirectory = Join-Path $repoRoot 'src-tauri/target/release/bundle/nsis'
    $installerName = "Hexglow_$($version)_x64-setup.exe"
    $installer = Get-Item -LiteralPath (Join-Path $installerDirectory $installerName)
    if ($installer.LastWriteTimeUtc -lt $buildStartedAt.AddSeconds(-2)) { throw 'Installer timestamp is older than this build; refusing to archive an old package.' }
    & (Join-Path $PSScriptRoot 'verify-release.ps1') -InstallerDir $installerDirectory
    Write-Host 'Checking the built application and offline OCR resources (not the installed app).'
    & (Join-Path $PSScriptRoot 'verify-installed.ps1') -InstallDirectory (Join-Path $repoRoot 'src-tauri/target/release')

    $chinaZone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
    $builtAt = [TimeZoneInfo]::ConvertTime([DateTimeOffset]::Now, $chinaZone)
    $candidateDirectory = Join-Path $releaseRoot ("candidates/{0}-{1}-local" -f $version, $builtAt.ToString('yyyyMMdd-HHmmss'))
    if (Test-Path -LiteralPath $candidateDirectory) { throw 'Candidate directory already exists; refusing to overwrite it.' }
    New-Item -ItemType Directory -Path $candidateDirectory | Out-Null
    Copy-Item -LiteralPath $installer.FullName -Destination $candidateDirectory
    Copy-Item -LiteralPath ($installer.FullName + '.sig') -Destination $candidateDirectory
    $candidate = Join-Path $candidateDirectory $installerName
    $installerHash = Get-PackageHash $candidate
    $signatureHash = Get-PackageHash ($candidate + '.sig')
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $candidateDirectory 'SHA256SUMS.txt'), "$installerHash  $installerName`n$signatureHash  $installerName.sig`n", $utf8)
    $buildInfo = @(
        "Hexglow $version - local build from the current working tree",
        "Packaged: $($builtAt.ToString('yyyy-MM-dd HH:mm:ss')) Asia/Shanghai",
        "Installer: $installerName",
        "Size: $($installer.Length) bytes",
        "SHA256: $installerHash",
        'Verified: version consistency, GUI executable, offline OCR resources, updater signature.',
        'This command builds and validates; it does not run the application test suite.',
        'Updater signing is separate from Windows Authenticode.',
        'Not installed, launched, tagged, pushed or published by this script.'
    ) -join "`n"
    [IO.File]::WriteAllText((Join-Path $candidateDirectory 'BUILD-INFO.txt'), $buildInfo + "`n", $utf8)
    Write-Host "`nInstaller ready: $candidate"
    Write-Host "SHA256: $installerHash"
} finally {
    if ($buildLock) { $buildLock.Dispose() }
    $packagingProcess.PriorityClass = $originalPriority
    $env:TAURI_SIGNING_PRIVATE_KEY = $originalSigningKey
    $env:CI = $originalCi
    $env:CARGO_BUILD_JOBS = $originalBuildJobs
    Set-Location -LiteralPath $originalLocation
}
