# 海萤 · Hexglow

Windows 海克斯大乱斗助手：自动识别候选，用你配置的模型结合英雄、装备和知识库给出推荐，并保存对局档案。

当前本地版本 **0.0.3** · [版本变化](docs/RELEASE_0.0.3.md) · [正式安装包](https://github.com/mrone0/Hexglow/releases)

## 快速使用

1. 启动 Hexglow 和 LoL，应用自动跟踪选人、对局与结算。
2. 在设置中配置模型和 API Key，授权后即可使用自动推荐；每轮最多分析 4 组候选。
3. 游戏位于前台时自动识别。侧栏显示评分和综合推荐；也可手动补充候选、发起分析。
4. 在“知识工坊”用表单维护英雄与海克斯资料，在“对局档案”查看或导出记录。

识别免费，模型服务可能收费。推荐质量取决于资料与模型，比较分不是胜率。详细用法见 [使用说明](docs/USER_GUIDE.md)。

## 安装与更新

从 [GitHub Releases](https://github.com/mrone0/Hexglow/releases) 下载完整安装包；已安装的用户也可在设置中检查新版本。覆盖安装前先“完全退出”，选择原目录，知识库、档案和设置会保留。

右上角 × 只隐藏到托盘。同版本本地修复包需手动覆盖安装。

## 本地打包

在 PowerShell 中运行：

```powershell
cd D:\code\hexglow
pnpm package:local
```

安装包自动保存到 `release/candidates/`，终端会输出完整路径。[环境、签名与选项](docs/BUILDING_WINDOWS.md) · [发布流程](docs/PUBLISHING_WINDOWS.md)

## 开发与资料

- [使用、知识库和隐私说明](docs/USER_GUIDE.md)
- [推荐算法与数据关联](docs/ALGORITHM_MATCHING.md)
- [OCR 性能、实测与边界](docs/OCR_PERFORMANCE.md)
- [知识文档格式](knowledge-seed/README.md)
- [Windows 构建检查](.github/workflows/windows.yml)

API Key 保存在 Windows 凭据管理器，对局档案保存在本机。应用不自动操作游戏。

**AGPL-3.0-only** · [开源使用声明](OPEN_SOURCE.md) · [完整许可](LICENSE)。本项目没有 Riot 背书；[Riot 开发者说明](https://support-developer.riotgames.com/hc/en-us/articles/22698698001939-League-of-Legends)。
