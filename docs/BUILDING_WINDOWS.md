# Windows 本地打包

在 PowerShell 里执行：

```powershell
cd D:\code\hexglow
pnpm package:local
```

这是日常打包命令。脚本会读取仓库当前版本，检查四处版本号和 OCR 资源，构建前端与 Windows 安装器，验证更新签名和构建目录中的资源，再把安装包归档到一个新目录。完成后终端会直接显示安装包完整路径。

输出目录为 `release/candidates/<版本>-<北京时间年月日-时分秒>-local/`，包含：

- `Hexglow_<版本>_x64-setup.exe`：完整安装包。
- 同名 `.sig`：应用更新签名。
- `SHA256SUMS.txt`：文件哈希。
- `BUILD-INFO.txt`：本次打包说明。

旧的候选包会保留。该命令只负责构建、校验和归档，不安装、启动应用，不修改 Git 标签或推送 GitHub，也不运行完整测试。当前版本为 0.0.3；后续版本以 `package.json` 为准。

## 常用选项

只想快速验证本地改动、不生成安装器时，用 Release 直接构建：

```powershell
pnpm tauri build --no-bundle --ci -- --locked --offline
```

产物在 `src-tauri/target/release/Hexglow.exe`。运行目录还需带完整 `resources/ocr/`；替换已有本地程序前先“完全退出”并备份原 EXE，不删除用户数据。这个命令不会生成安装包或更新签名；不建议用 Debug 构建比较实战 OCR 性能。

依赖已经下载齐全时，可禁止 Cargo 获取网络依赖：

```powershell
pnpm package:local -Offline
```

脚本默认用 2 个 Rust 编译任务，并下调打包进程的 CPU 优先级，减少后台构建与游戏的资源争用；打包仍建议在对局空闲时进行。可按机器性能调整：

```powershell
pnpm package:local -BuildJobs 4
```

也可以直接执行脚本，无需从仓库目录启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\code\hexglow\scripts\package-local.ps1 -Offline
```

`-Offline` 限制 Cargo 构建依赖获取；首次安装工具链、下载 OCR 资源或准备 Tauri 打包工具时仍需联网。

## 第一次准备环境

需要 Node.js 22.13 或更新版本、pnpm 11、Rust、Windows MSVC C++ 工具链和 WebView2。安装依赖并准备随包 OCR 资源：

```powershell
cd D:\code\hexglow
pnpm install --frozen-lockfile --ignore-scripts
pnpm prepare:ocr
```

脚本优先使用已有的 `TAURI_SIGNING_PRIVATE_KEY`；没有配置时，自动使用当前用户目录下的 `.tauri\hexglow.key`，在本机即 `C:\Users\admin\.tauri\hexglow.key`。

换机器时，需要准备与应用更新公钥匹配的同一份签名私钥。也可以指定已有私钥文件的位置：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = 'D:\private\hexglow.key'
pnpm package:local
```

只有私钥设置了密码时，才需先配置密码；可用隐藏输入，避免把密码写进命令历史：

```powershell
$hexglowPassword = Read-Host '签名私钥密码' -AsSecureString
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $hexglowPassword).Password
pnpm package:local
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

此处是更新签名私钥，与设置页里的模型 API Key 无关。GitHub 的签名 secrets 不会自动同步到本机。私钥及密码不应写进仓库；脚本不会将它们写进打包说明。更新签名不等于 Windows Authenticode 代码签名。

## 修改版本、安装和发布

新版本需同步修改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 中的应用包版本，以及 `src-tauri/tauri.conf.json`。不一致时脚本会中止。

覆盖安装前，先从应用或托盘“完全退出” Hexglow，再运行归档目录里的安装包，选择原安装目录。保留应用数据目录即可沿用知识库、档案和设置。不要仅复制 `Hexglow.exe`，完整安装包还包含 OCR 资源。

同版本的本地修复包需要手动覆盖安装；自动更新不会把另一个 0.0.3 判为更新版本。对外发布前应完成验证并使用新版本号，参见 [Windows 发布流程](PUBLISHING_WINDOWS.md)。
