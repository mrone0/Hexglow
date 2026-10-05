# Windows QA 自动化（可分段执行）
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\qa-windows.ps1                  # 只跑安全检查（preflight）
#   ... -Stage tests                     # tsc + 前端测试 + Rust 测试
#   ... -Stage install                   # 静默安装（会改本机，需 -Yes 或交互确认）
#   ... -Stage launch                    # 启动已安装副本并检查日志
#   ... -Stage readonly                  # 只读数据库容错检查
#   ... -Stage uninstall                 # 静默卸载并核对残留
#   ... -Stage clean-residue             # 清理 D:\hexglow 旧安装（必须 -Yes 或输入 YES）
#   ... -Stage all                       # 依次 tests/preflight/install/launch/readonly/uninstall（不含 clean-residue）
# 退出码 0 = 全部通过，1 = 有失败项。
[CmdletBinding()]
param(
    [ValidateSet('tests', 'preflight', 'install', 'launch', 'readonly', 'uninstall', 'clean-residue', 'all')]
    [string]$Stage = 'preflight',
    [string]$Installer,
    [string]$InstallDir,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$script:failures = 0
$script:infos = @()

function Step($name) { Write-Host "`n== $name ==" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ok   $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  info $msg" }
function Fail($msg) {
    $script:failures++
    Write-Host "  FAIL $msg" -ForegroundColor Red
}
function Confirm($prompt) {
    if ($Yes) { return $true }
    $answer = Read-Host "$prompt [yes/N]"
    return $answer -eq 'yes'
}
function Get-UninstallEntry {
    Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq 'Hexglow' } | Select-Object -First 1
}
function Read-JsonFile($path) { Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json }

function Assert-VersionConsistency {
    Step '版本与配置一致性'
    $pkg = Read-JsonFile (Join-Path $Repo 'package.json')
    $conf = Read-JsonFile (Join-Path $Repo 'src-tauri\tauri.conf.json')
    $windows = Read-JsonFile (Join-Path $Repo 'src-tauri\tauri.windows.conf.json')
    $toml = (Select-String -Path (Join-Path $Repo 'src-tauri\Cargo.toml') -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
    $lock = if ((Get-Content (Join-Path $Repo 'src-tauri\Cargo.lock') -Raw) -match 'name = "lol-augment-assistant"\s*version = "([^"]+)"') { $Matches[1] } else { $null }
    $version = $pkg.version
    $pairs = @(
        @('package.json', $pkg.version),
        @('tauri.conf.json.version', $conf.version),
        @('Cargo.toml', $toml),
        @('Cargo.lock', $lock)
    )
    foreach ($pair in $pairs) {
        if ($pair[1] -eq $version) { Ok "$($pair[0]) = $($pair[1])" } else { Fail "$($pair[0]) = $($pair[1])，期望 $version" }
    }
    if ($conf.identifier -eq 'ai.hexglow.desktop') { Ok "identifier = $($conf.identifier)" } else { Fail "identifier = $($conf.identifier)（已冻结，改名必须带数据迁移）" }
    if ($conf.bundle.active -and ($conf.bundle.targets -join ',') -eq 'nsis') { Ok 'bundle.active=true, targets=nsis' } else { Fail "bundle 配置异常：active=$($conf.bundle.active) targets=$($conf.bundle.targets)" }
    if ($windows.bundle.windows.nsis.installMode -eq 'currentUser') { Ok 'NSIS installMode=currentUser（无需管理员）' } else { Fail 'NSIS installMode 不是 currentUser' }
    foreach ($icon in $conf.bundle.icon) {
        if (Test-Path (Join-Path $Repo "src-tauri\$icon")) { Ok "图标存在 $icon" } else { Fail "图标缺失 $icon" }
    }
    if (Test-Path (Join-Path $Repo 'src-tauri\icons\icon.ico')) { Ok 'ICO 存在' } else { Fail 'ICO 缺失' }
    return $version
}

function Find-Installer($version) {
    if ($Installer) { return (Resolve-Path $Installer).Path }
    $dir = Join-Path $Repo 'src-tauri\target\release\bundle\nsis'
    $expected = Join-Path $dir "Hexglow_$($version)_x64-setup.exe"
    if (Test-Path $expected) { return $expected }
    $latest = Get-ChildItem $dir -Filter 'Hexglow_*_x64-setup.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) { return $latest.FullName }
    return $null
}

function Invoke-Tests {
    Step '测试与类型检查'
    Push-Location $Repo
    try {
        # PS 5.1 下原生命令的 stderr 会被 2>&1 转成错误记录并被 $ErrorActionPreference 中断，
        # 统一交给 cmd 合并，再按退出码判定。
        $out = cmd /c 'npx tsc -b 2>&1'
        if ($LASTEXITCODE -eq 0) { Ok 'tsc -b 干净' } else {
            Fail "tsc -b 退出码 $LASTEXITCODE"
            $out | Select-Object -Last 10 | ForEach-Object { Info "tsc: $_" }
        }
        $out = cmd /c 'pnpm test 2>&1'
        $out | Select-Object -Last 4 | ForEach-Object { Info "vitest: $_" }
        if ($LASTEXITCODE -eq 0) { Ok 'pnpm test 通过' } else { Fail "pnpm test 退出码 $LASTEXITCODE" }
        $out = cmd /c 'cargo test --manifest-path src-tauri\Cargo.toml 2>&1'
        $out | Select-String -Pattern 'test result' | ForEach-Object { Info "cargo: $($_.ToString().Trim())" }
        if ($LASTEXITCODE -eq 0) { Ok 'cargo test 通过' } else { Fail "cargo test 退出码 $LASTEXITCODE" }
    } finally { Pop-Location }
}

function Invoke-Preflight($version) {
    Step '安装器与产物'
    $installerPath = Find-Installer $version
    if (-not $installerPath) { Fail "找不到 NSIS 安装器（先跑 pnpm tauri build）"; return $null }
    $fileVersion = (Get-Item $installerPath).VersionInfo.FileVersion
    if ($fileVersion -eq $version) { Ok "安装器 $([IO.Path]::GetFileName($installerPath)) FileVersion=$fileVersion" } else { Fail "安装器 FileVersion=$fileVersion，期望 $version" }
    $exe = Join-Path $Repo 'src-tauri\target\release\Hexglow.exe'
    if (Test-Path $exe) {
        $exeVersion = (Get-Item $exe).VersionInfo.FileVersion
        if ($exeVersion -eq $version) { Ok "Hexglow.exe FileVersion=$exeVersion" } else { Fail "Hexglow.exe FileVersion=$exeVersion，期望 $version" }
    } else { Fail 'Hexglow.exe 不存在（release 未构建）' }
    foreach ($old in @('Hexglow_0.1.0_x64-setup.exe', 'Hexglow_0.2.0_x64-setup.exe')) {
        if (Test-Path (Join-Path $Repo "src-tauri\target\release\bundle\nsis\$old")) { Info "历史安装器仍在（可删）：$old" }
    }

    Step '注册表安装记录'
    $entry = Get-UninstallEntry
    if ($entry) {
        Info "DisplayName=$($entry.DisplayName) DisplayVersion=$($entry.DisplayVersion) InstallLocation=$($entry.InstallLocation)"
        $loc = ($entry.InstallLocation -replace '^"|"$', '')
        if ($loc -like 'D:\hexglow*') {
            Info '这是 9/25 的旧安装残留（可执行文件仍叫 lol-augment-assistant.exe），用 -Stage clean-residue 清理'
        }
        if ($entry.DisplayVersion -eq $version) { Ok '已安装版本与源码一致' } else { Fail "已安装 $($entry.DisplayVersion)，源码 $version（安装的是旧版本或未重装）" }
        if (Test-Path (Join-Path $loc 'Hexglow.exe')) { Ok "安装目录可执行文件存在 $loc" } else { Fail "安装目录缺 Hexglow.exe：$loc" }
    } else { Info '当前没有 Hexglow 安装记录（装机测试会新建）' }

    Step '数据目录'
    $dataDir = Join-Path $env:APPDATA 'ai.hexglow.desktop'
    if (-not (Test-Path $dataDir)) { Fail "数据目录缺失 $dataDir" } else {
        Ok "数据目录 $dataDir"
        $db = Join-Path $dataDir 'sessions.sqlite3'
        if (Test-Path $db) { Ok "sessions.sqlite3 $([math]::Round((Get-Item $db).Length/1KB)) KB" } else { Info 'sessions.sqlite3 尚未创建' }
        $champions = Join-Path $dataDir 'knowledge\champions'
        $augments = Join-Path $dataDir 'knowledge\augments'
        if ((Test-Path $champions) -or (Test-Path $augments)) {
            Ok "knowledge 文档 英雄 $((Get-ChildItem $champions -Recurse -File -ErrorAction SilentlyContinue).Count) 个 / 海克斯 $((Get-ChildItem $augments -Recurse -File -ErrorAction SilentlyContinue).Count) 个"
        } else { Info 'knowledge 目录尚未初始化' }
        $stats = Join-Path $dataDir 'logs\ocr-stats.json'
        if (Test-Path $stats) { Info 'ocr-stats.json 已存在' } else { Info 'ocr-stats.json 尚未生成（首次打开运行日志页会回填）' }
    }
    $oldData = Join-Path $env:APPDATA 'com.local.lol-augment-assistant'
    if (Test-Path $oldData) { Info "旧 identifier 数据目录仍在（备份，可保留）：$oldData" }

    Step '自动更新配置'
    $conf = Get-Content (Join-Path $Repo 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8
    if ($conf -match 'createUpdaterArtifacts' -and $conf -match '"updater"') { Ok 'tauri.conf.json 已启用 createUpdaterArtifacts 与 plugins.updater 端点' } else { Fail 'tauri.conf.json 缺少 createUpdaterArtifacts 或 plugins.updater' }
    $cap = Get-Content (Join-Path $Repo 'src-tauri\capabilities\default.json') -Raw -Encoding UTF8
    if ($cap -match 'updater:default') { Ok 'capabilities 已授予 updater:default' } else { Fail 'capabilities/default.json 缺少 updater:default' }
    $key = Join-Path $env:USERPROFILE '.tauri\hexglow.key'
    if (Test-Path $key) { Ok "更新签名私钥 $key（不入仓库）" } else { Info "未找到更新签名私钥 $key：pnpm tauri build 会按设计失败，需 TAURI_SIGNING_PRIVATE_KEY" }
    $latest = Join-Path $Repo 'src-tauri\target\release\bundle\nsis\latest.json'
    if (Test-Path $latest) { Info "latest.json 已生成：$latest（发布资产）" } else { Info 'latest.json 尚未生成（发布前跑 scripts\make-latest-json.ps1）' }
    return $installerPath
}

function Wait-Until($script, $timeoutSec, $what) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (& $script) { return $true }
        Start-Sleep -Seconds 1
    }
    Fail "等待超时（${timeoutSec}s）：$what"
    return $false
}

function Start-InstalledApp {
    $entry = Get-UninstallEntry
    if (-not $entry) { Fail '没有安装记录，先跑 install'; return $null }
    $loc = ($entry.InstallLocation -replace '^"|"$', '')
    $exe = Join-Path $loc 'Hexglow.exe'
    if (-not (Test-Path $exe)) { Fail "缺少 $exe"; return $null }
    return Start-Process $exe -PassThru
}

function Stop-InstalledApp($proc) {
    if (-not $proc) { return }
    if (-not $proc.HasExited) {
        $null = $proc.CloseMainWindow()
        if (-not (Wait-Until { $proc.HasExited } 10 '应用退出')) { Stop-Process -Id $proc.Id -Force }
    }
    Start-Sleep -Seconds 1
}

function Invoke-Install($version, $installerPath) {
    Step '静默安装'
    if (-not $installerPath) { Fail '没有安装器'; return }
    if (Get-Process -Name 'Hexglow' -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike '*\target\release\Hexglow.exe' }) {
        Fail '已有安装版 Hexglow 在运行，先退出'; return
    }
    $args = @('/S')
    if ($InstallDir) {
        if ($InstallDir -match '\s') { Fail '/D= 路径不能含空格'; return }
        $args += "/D=$InstallDir"
        Info "安装到非默认目录 $InstallDir"
    }
    Start-Process -FilePath $installerPath -ArgumentList $args -Wait
    $found = Wait-Until { (Get-UninstallEntry) -ne $null } 60 '注册表安装记录'
    if (-not $found) { return }
    $entry = Get-UninstallEntry
    if ($entry.DisplayVersion -eq $version) { Ok "注册表 DisplayVersion=$($entry.DisplayVersion)" } else { Fail "注册表 DisplayVersion=$($entry.DisplayVersion)，期望 $version" }
    $loc = ($entry.InstallLocation -replace '^"|"$', '')
    if ($InstallDir -and ($loc -ne $InstallDir)) { Fail "InstallLocation=$loc，期望 $InstallDir" } else { Ok "InstallLocation=$loc" }
    if (Test-Path (Join-Path $loc 'Hexglow.exe')) { Ok '已安装 Hexglow.exe' } else { Fail '安装目录缺 Hexglow.exe' }
    if (-not (Test-Path (Join-Path $env:APPDATA 'ai.hexglow.desktop'))) { Fail '安装后数据目录未创建' } else { Ok '数据目录存在' }
}

function Invoke-Launch {
    Step '启动检查'
    $proc = Start-InstalledApp
    if (-not $proc) { return }
    $alive = Wait-Until { -not $proc.HasExited } 2 $null
    Start-Sleep -Seconds 6
    if ($proc.HasExited) { Fail "启动即退出，退出码 $($proc.ExitCode)" } else { Ok "进程存活 PID=$($proc.Id)" }
    $log = Join-Path $env:APPDATA 'ai.hexglow.desktop\logs\collector.jsonl'
    if (Test-Path $log) {
        $before = (Get-Item $log).LastWriteTime
        Start-Sleep -Seconds 3
        $after = (Get-Item $log).LastWriteTime
        if ($after -ge $before) { Ok "日志在写 $log" } else { Info '日志这段时间没有新条目（空闲时属正常）' }
    } else { Info '尚无 collector.jsonl（首次写入才会创建）' }
    Stop-InstalledApp $proc
    if ($proc.HasExited) { Ok '可正常退出' } else { Fail '无法退出' }
}

function Invoke-ReadOnly {
    Step '数据库只读容错'
    $db = Join-Path $env:APPDATA 'ai.hexglow.desktop\sessions.sqlite3'
    if (-not (Test-Path $db)) { Info '没有数据库，跳过'; return }
    $acl = Get-Acl $db
    try {
        Set-ItemProperty -Path $db -Name IsReadOnly -Value $true
        $proc = Start-InstalledApp
        if (-not $proc) { return }
        Start-Sleep -Seconds 8
        if ($proc.HasExited) { Fail "只读时应用崩溃，退出码 $($proc.ExitCode)" } else { Ok '只读状态下进程仍存活（保存应降级为错误提示，不应崩溃）' }
        Stop-InstalledApp $proc
    } finally {
        Set-ItemProperty -Path $db -Name IsReadOnly -Value $false
        Set-Acl -Path $db -AclObject $acl
        if (-not (Get-Item $db).IsReadOnly) { Ok '已恢复可写' } else { Fail '未能恢复数据库可写状态' }
    }
}

function Invoke-Uninstall {
    Step '静默卸载'
    $entry = Get-UninstallEntry
    if (-not $entry) { Info '没有安装记录，跳过'; return }
    $unins = $entry.UninstallString -replace '^"|"$', ''
    if (-not (Test-Path $unins)) { Fail "卸载程序不存在：$unins"; return }
    Stop-InstalledApp (Get-Process -Name 'Hexglow' -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike '*\target\release\Hexglow.exe' })
    Start-Process -FilePath $unins -ArgumentList '/S' -Wait
    $gone = Wait-Until { (Get-UninstallEntry) -eq $null } 60 '注册表记录消失'
    if (-not $gone) { return }
    Ok '注册表记录已移除'
    $loc = ($entry.InstallLocation -replace '^"|"$', '')
    if (Test-Path (Join-Path $loc 'Hexglow.exe')) { Fail "残留可执行文件 $loc\Hexglow.exe" } else { Ok '安装目录已清理' }
    $dataDir = Join-Path $env:APPDATA 'ai.hexglow.desktop'
    if (Test-Path (Join-Path $dataDir 'sessions.sqlite3')) { Ok '对局数据保留（卸载不删数据）' } else { Info '卸载后没有对局数据（本机原本也没有）' }
}

function Invoke-CleanResidue {
    Step '清理旧安装残留'
    $oldDir = 'D:\hexglow'
    $entry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.InstallLocation -like "*$oldDir*" -or $_.UninstallString -like "*$oldDir*" } | Select-Object -First 1
    if (-not (Test-Path $oldDir) -and -not $entry) { Ok '没有旧安装残留'; return }
    Info "残留目录：$(if (Test-Path $oldDir) { $oldDir } else { '（已无）' })"
    if ($entry) { Info "残留注册表：DisplayName=$($entry.DisplayName) DisplayVersion=$($entry.DisplayVersion) UninstallString=$($entry.UninstallString)" }
    if (-not $Yes -and -not (Confirm "将运行旧卸载器并删除 $oldDir 与对应注册表记录（旧数据目录 $env:APPDATA\com.local.lol-augment-assistant 不动）") ) { Info '已取消'; return }
    if ($entry) {
        $unins = ($entry.UninstallString -replace '^"|"$', '')
        if (Test-Path $unins) { Start-Process -FilePath $unins -ArgumentList '/S' -Wait; Start-Sleep -Seconds 3; Info "旧卸载器已执行 $unins" }
    }
    # 卸载器可能没写干净，逐个键核对 InstallLocation/UninstallString 后再删，只碰旧安装那一条。
    Get-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {
        $_.GetSubKeyNames() | ForEach-Object {
            $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$_"
            $props = Get-ItemProperty $key -ErrorAction SilentlyContinue
            if ($props -and ($props.InstallLocation -like '*D:\hexglow*' -or $props.UninstallString -like '*D:\hexglow*')) {
                Remove-Item $key -Recurse -Force; Info "已删除注册表项 $_"
            }
        }
    }
    if (Test-Path $oldDir) {
        $leftovers = @(Get-ChildItem $oldDir -Force -Recurse -ErrorAction SilentlyContinue)
        try {
            Remove-Item $oldDir -Recurse -Force -ErrorAction Stop
            Ok "已删除 $oldDir"
        } catch {
            if ($leftovers.Count -eq 0) {
                # 目录已空但目录句柄仍被占用：常见于某个 shell/工具把该目录当工作目录。
                Info "目录已清空，但目录本身仍被进程占用，暂时无法删除 $oldDir（关闭占用它的程序后可手动删除）"
            } else {
                Fail "删除 $oldDir 失败：$($_.Exception.Message)"
            }
        }
    } else { Ok '旧目录已由卸载器移除' }
}

$version = Assert-VersionConsistency
$installerPath = $null

switch ($Stage) {
    'tests' { Invoke-Tests }
    'preflight' { $installerPath = Invoke-Preflight $version }
    'install' { $installerPath = Find-Installer $version; Invoke-Install $version $installerPath }
    'launch' { Invoke-Launch }
    'readonly' { Invoke-ReadOnly }
    'uninstall' { Invoke-Uninstall }
    'clean-residue' { Invoke-CleanResidue }
    'all' {
        Invoke-Tests
        $installerPath = Invoke-Preflight $version
        Invoke-Install $version $installerPath
        Invoke-Launch
        Invoke-ReadOnly
        Invoke-Uninstall
    }
}

Step '汇总'
if ($script:failures -eq 0) { Write-Host '  全部通过' -ForegroundColor Green; exit 0 }
Write-Host "  失败 $($script:failures) 项" -ForegroundColor Red; exit 1
