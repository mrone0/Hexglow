[CmdletBinding()]
param(
    [switch]$VerifyOnly,
    [switch]$NoCache
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$modelDirectory = Join-Path $repoRoot 'src-tauri/resources/ocr'
$manifest = Get-Content -LiteralPath (Join-Path $modelDirectory 'manifest.json') -Raw | ConvertFrom-Json

function Test-ModelFile {
    param([string]$Path, $Entry)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -ne [long]$Entry.size) { return $false }
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')) -eq $Entry.sha256 }
    finally { $stream.Dispose(); $sha.Dispose() }
}

foreach ($entry in $manifest.files) {
    # The checked-in manifest must never be able to escape the resource directory.
    if ($entry.name -notmatch '^[a-z0-9_.-]+$' -or $entry.name -in @('.', '..')) {
        throw "Invalid OCR resource name: $($entry.name)"
    }
    $targetPath = Join-Path $modelDirectory $entry.name
    if (Test-ModelFile $targetPath $entry) {
        Write-Host "Verified $($entry.name)"
        continue
    }
    if ($VerifyOnly) {
        throw "Missing or invalid OCR resource $($entry.name). Run pnpm prepare:ocr before building."
    }

    # Reuse a developer's old cache only after hashing it. Installed apps never
    # consult this cache. This saves bandwidth without trusting sidecar hashes.
    $cachedPath = Join-Path (Join-Path $env:USERPROFILE '.oar') $entry.name
    if (-not $NoCache -and (Test-ModelFile $cachedPath $entry)) {
        Copy-Item -LiteralPath $cachedPath -Destination $targetPath -Force
        Write-Host "Prepared $($entry.name) from verified local cache"
        continue
    }

    $downloaded = $false
    $failures = @()
    foreach ($url in $entry.urls) {
        $temporaryPath = Join-Path $modelDirectory "$($entry.name).$([Guid]::NewGuid().ToString('N')).download"
        try {
            Write-Host "Downloading $($entry.name)"
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $temporaryPath -TimeoutSec 300
            if (-not (Test-ModelFile $temporaryPath $entry)) {
                throw 'Downloaded resource did not match the pinned size and SHA-256.'
            }
            Move-Item -LiteralPath $temporaryPath -Destination $targetPath -Force
            $downloaded = $true
            break
        } catch {
            $failures += $_.Exception.Message
        } finally {
            if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
                Remove-Item -LiteralPath $temporaryPath -Force
            }
        }
    }
    if (-not $downloaded) {
        throw "Unable to prepare OCR resource $($entry.name): $($failures -join ' | ')"
    }
    Write-Host "Prepared and verified $($entry.name)"
}

Write-Host 'All bundled OCR resources are ready. Runtime OCR requires no model downloads.'
