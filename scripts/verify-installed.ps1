[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallDirectory,
    [string]$BuiltExecutable = ''
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$executable = Join-Path $InstallDirectory 'Hexglow.exe'
if ((Get-Item -LiteralPath $executable).VersionInfo.ProductVersion -ne $version) { throw 'Installed version mismatch.' }
$binary = [IO.File]::ReadAllBytes($executable)
$pe = [BitConverter]::ToInt32($binary, 0x3c)
if ([BitConverter]::ToUInt16($binary, $pe + 24 + 68) -ne 2) { throw 'Executable must use Windows GUI subsystem, not a console.' }
if ($BuiltExecutable) {
    $built = [IO.File]::ReadAllBytes($BuiltExecutable)
    # Tauri temporarily patches its bundle marker while packing NSIS, then
    # restores UNK in target/release. Normalize only that known marker in memory.
    $marker = [Text.Encoding]::ASCII.GetBytes('__TAURI_BUNDLE_TYPE_VAR_')
    function Normalize-BundleMarker([byte[]]$Bytes) {
        $text = [Text.Encoding]::ASCII.GetString($Bytes)
        $offset = $text.IndexOf('__TAURI_BUNDLE_TYPE_VAR_', [StringComparison]::Ordinal)
        if ($offset -lt 0 -or $text.IndexOf('__TAURI_BUNDLE_TYPE_VAR_', $offset + 1, [StringComparison]::Ordinal) -ge 0) { throw 'Expected one Tauri bundle marker.' }
        $start = $offset + $marker.Length
        $kind = [Text.Encoding]::ASCII.GetString($Bytes, $start, 3)
        if ($kind -notin @('NSS', 'UNK')) { throw "Unexpected bundle marker $kind" }
        [Array]::Copy([Text.Encoding]::ASCII.GetBytes('UNK'), 0, $Bytes, $start, 3)
    }
    Normalize-BundleMarker $binary
    Normalize-BundleMarker $built
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        if ([BitConverter]::ToString($sha.ComputeHash($binary)) -ne [BitConverter]::ToString($sha.ComputeHash($built))) { throw 'Installed binary differs from the built application.' }
    } finally { $sha.Dispose() }
}
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri/resources/ocr/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $manifest.files) {
    $path = Join-Path $InstallDirectory "resources/ocr/$($entry.name)"
    if ((Get-Item -LiteralPath $path).Length -ne $entry.size) { throw "Installed OCR size mismatch: $($entry.name)" }
    $stream = [IO.File]::OpenRead($path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $sha.Dispose() }
    if ($hash -ne $entry.sha256) { throw "Installed OCR hash mismatch: $($entry.name)" }
}
Write-Host "Installed Hexglow $version verified: GUI executable and all offline OCR resources."
