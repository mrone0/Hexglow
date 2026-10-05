# 海萤 · Hexglow

> **AGPL-3.0-only 开源项目。开源不是放弃版权。** 商用允许，但分发及修改版网络服务必须依法履行对应的开源、许可与声明义务；禁止违反许可的闭源分发及冒充官方。请先阅读 [开源许可与使用声明](OPEN_SOURCE.md) 和 [完整许可证](LICENSE)。

**让每一次选择，都有微光指引。** 面向 Windows 的本地海克斯大乱斗决策辅助原型。Tauri 2 + Rust + React/TypeScript + SQLite。

知识工坊编辑是真实文件操作；界面不再提供演示/模拟对局入口，布局以真实数据与截图验收。

### OKF 知识工坊

左侧“知识工坊” → 类型下拉（英雄/海克斯） → 选择文档 → 编辑或导入 MD → 校验 → 保存并生效。海克斯可新建/删除；英雄后端禁止删除。现有身份不可改，文件格式为 `champions/ahri.md` 或 `augments/custom-example.md`（小写字母/数字/连字符），禁止路径逃逸与 Windows 保留名称。

只有一份生效文档，保存直接覆盖，最多保留3份备份。首次知识命令初始化，而非每次启动加载全库；升级不覆盖已有目录。Index自动更新，Concept ID由路径确定。详细必填字段、章节和接口见 [OKF Profile](knowledge-seed/README.md)。**种子仅含阿狸、盖伦和一个虚构海克斯模板；均未核验，不是完整资料库。**

分析时精确匹配英雄/候选/已选海克斯，沿一层文档链接补充，最多16份/64KiB，缺失和版本警告展示在依据区域。整篇优先；整篇超出 64 KiB 预算时按章节裁剪（英雄保留海克斯搭配/基础机制等，海克斯保留完整效果/相关交互等，自定义章节排最后），依据区域与证据会标注 `path#章节` 并提示裁剪。完整英雄目录、自动知识修订尚未完成。

## 已实现的使用流程

1. 在已运行 LoL 的 Windows 电脑打开 Hexglow，即刻发现客户端，无需手动开始连接。
2. 本地 PowerShell/CIM 查找 LeagueClientUx 的本地端口和凭据；凭据仅在 Rust 内存使用。非默认安装目录不影响进程发现；权限或发现失败时可在设置中填写 lockfile 绝对路径。
3. 对局中每3秒检查LCU/Live；无游戏时退避到8–15秒、页面隐藏时15秒；Windows进程发现缓存无客户端15秒/成功30秒。请求不重叠，错误自动重试，单个 HTTP 最长 2 秒，一轮总预算 11 秒。是轮询，不宣称 WebSocket 长连接。
4. 大厅/选人/载入/对局/结算在界面显示。即使启动工具时已在游戏内，也会独立尝试 Live API，不依赖先看到大厅。
5. 进入游戏后自动展示当前英雄与简要阵容，首页以海克斯推荐为核心；对局内截屏 OCR 自动读取候选（识别到 ≥2 条才写入推荐），读不到时才需补充本轮候选名称和完整效果。对局进行中他人海克斯不可得，按未知处理；对局结束后由本地结算接口自动补录双方海克斯。未识别项保持未知，推荐会声明信息不全。手动纠正、采集控制、证据和复盘放在折叠的高级区域。
6. 配置 Jev 官方或 OpenAI 兼容第三方/本地模型，勾选发送数据确认后点击分析。当前英雄、双方阵容/海克斯、OKF文档与相关历史组成结构化状态，模型按四项因素自报置信度，加权后与本地规则先验按 70/30 融合成 0-100 相对契合度，并列出因子明细、依据引用与缺文档提示；模型不自动操作游戏。局内悬浮侧栏只用本地规则排序，明确标注「本地规则 · 非 AI」。
7. 对局持续保存快照；结束阶段自动保存。有可靠、可归属的 API 结果才标记胜负，断线不判负。手动结果独立标记为 manual。
8. 记录实际选择、赛后观察，点击生成复盘；最近 5 份复盘作为以后提示参考，不自动训练模型权重。

工具关闭后停止采集，没有安装开机自启或系统服务。分析过程中暂停新轮询，最长可能错过 45 秒内的短暂信号；赛果拿不到时保持未知，不伪造。历史查看暂时暂停采集，返回实时视图保留当前活动会话。

## 本地开发与 Windows 构建

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm tauri dev
```

需要 Node、pnpm、Rust；Windows 需要 MSVC C++ 工具链与 WebView2。依赖脚本默认不执行；若平台依赖缺失，先审查依赖，不应无差别批准构建脚本。

```sh
pnpm build
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml --locked
# 在 Windows 上生成 release 可执行文件与 NSIS 安装器（0.0.5）
# 已启用 createUpdaterArtifacts，构建必须先设置更新签名私钥，否则直接失败：
#   PowerShell: $env:TAURI_SIGNING_PRIVATE_KEY="$env:USERPROFILE\.tauri\hexglow.key"
#   bash:      export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/hexglow.key"
pnpm tauri build
# 显式指定打包格式时等价
pnpm tauri build --bundles nsis
```

当前版本 **0.0.5**，版本号需同步改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`。release 产物在 `src-tauri/target/release/Hexglow.exe` 与 `src-tauri/target/release/bundle/nsis/Hexglow_0.0.5_x64-setup.exe`。安装器为当前用户安装（不提权），含中/英文语言选择。版本号从 0.0.1 起算：`v0.0.1` = 首个版本，`v0.0.2` = 首次生产化，`v0.0.4` = 首个自动更新发布，`0.0.5` = 当前（修复 release 控制台窗口，`main.rs` 恢复 `windows_subsystem = "windows"`）。

自动更新（0.0.3 接入，0.0.4 起端到端可用，**已实测两轮 0.0.3 → 0.0.4 → 0.0.5 全通过**）：`tauri-plugin-updater` + `bundle.createUpdaterArtifacts`，构建额外产出同名 `.sig`（更新签名校验用，**不是** Authenticode 代码签名）；私钥在 `%USERPROFILE%\.tauri\hexglow.key`（无密码，绝不提交），CI/本地用 `scripts\make-latest-json.ps1` 生成 `latest.json`（UTF-8 无 BOM，带 BOM 会被 serde_json 拒绝）。设置页「04 应用更新」可检查并下载安装（Windows passive 模式，安装阶段应用自动退出，装完 NSIS 会自动重启应用）。端点 `https://github.com/mrone0/Hexglow/releases/latest/download/latest.json`；**仓库必须保持 public**（private 状态该地址 404）。推送 `v<版本>` tag 后 CI 自动构建、生成 `latest.json` 并创建 [Release](https://github.com/mrone0/Hexglow/releases)（tag 必须等于 `v<package.json 版本>`，否则 release job 失败；secret 必须在 run 启动前就存在）。CI 构建需要 secret `TAURI_SIGNING_PRIVATE_KEY`（及可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`），未配置时构建按设计失败。

GitHub Actions 配置见 [.github/workflows/windows.yml](.github/workflows/windows.yml)，只有 `windows-latest`，没有其他平台构建矩阵；推送与 tag 均会触发，签名构建 + tag 发布已实跑（结果见 [Actions](https://github.com/mrone0/Hexglow/actions) 与 [Releases](https://github.com/mrone0/Hexglow/releases)）。Windows 配置自动启用 NSIS；安装器未做 Authenticode 代码签名（更新签名的 `.sig` 是另一回事），可能触发 SmartScreen，不能宣称已获平台信任。WebView2 缺失时安装器会下载引导程序，严格离线电脑需预先安装 WebView2。

## 现在记录了哪些内容？

| 数据 | 保存方式 / 来源 |
|---|---|
| 本地会话 ID、创建/更新时间 | 应用生成；与 API 对局 ID 区分 |
| 对局 ID、LCU 阶段与会话 | 本地 API；没有 ID 时不猜测 |
| 双方阵容、英雄、装备 | Live API 解析字段 |
| 玩家等级/KDA/经济等原始可得字段 | 保留在 Live API 原始快照中，是否存在依版本而定 |
| 玩家海克斯、候选及完整效果 | 本人海克斯手动录入并确认；候选由截屏 OCR 自动识别后确认；对局进行中他人海克斯按未知处理，赛后由本地 EOG 接口自动补录双方海克斯并标 `augmentsConfirmed` |
| 推荐排名、因子明细、理由、风险、缺失信息 | 模型四项因素按置信度加权并与本地规则先验 70/30 融合，连同当时完整决策上下文保存 |
| 实际选择 | 用户确认的候选 ID |
| 阶段时间线 | 阶段/连接变化，最近 200 个条目 |
| 定期 Live 原始快照 | 每 ≥15 秒保存一份，最近 30 份，约 7.5 分钟窗口；不是录像或完整逐帧记录 |
| 胜负、来源、时间、依据 | `result.status/source/observedAt/evidence` |
| 赛后结算原始数据 | EOG 有明确且匹配的对局 ID 时保存 |
| 赛后观察和复盘 | 用户文字 + 模型 summary/lessons/caveats |

### 胜负判断

- `live-game-end`：Live API 的 GameEnd 事件明确给出 Win/Lose，且 activePlayer 能唯一匹配玩家；与 LCU 阶段/ID 冲突时舍弃该数据。
- `lcu-eog`：结算包含明确游戏 ID，当前召唤师能唯一匹配结算玩家，其队伍有明确胜负标记；若与当前游戏 ID 冲突则拒绝使用。
- `manual`：用户补充，不能覆盖已获得的自动结果证据。
- `unknown`：没捕获到结算、接口版本不兼容、证据不足或归属不明。客户端断开或工具退出绝不等于失败。

原始数据是否包含最终伤害、经济和击杀统计依接口实际返回；当前不虚构缺失字段。数据存储在应用数据目录的 `sessions.sqlite3`，UI“运行日志”页显示确切路径。0.0.2 起 identifier 为 `ai.hexglow.desktop`（替换占位 `com.local.lol-augment-assistant`，本机已有数据整目录复制到新路径，旧目录保留作备份；后续不得再改，除非同步做迁移）。档案界面每页 50 条轻量摘要（过滤掉 `players=0` 且没有可核对内容的空记录，只隐藏不删除），支持上一页/下一页、按需读取完整会话、删除整场对局或单条分析。删除分析会清除旧复盘，避免引用已删除判断。档案详情可「导出本局 JSON」、档案列表可「导出全部历史」，写入应用数据目录的 `exports/`（文件名含对局 ID 与时间戳，全部历史带 `exportedAt`/场次统计），无原生保存对话框，导出后界面显示完整路径。旧版本手填 outcome 不自动转成有证据的胜负。

## 视觉与日志

独立品牌：浅色珠光、青绿与薰衣草渐变、珊瑚色提示、分栏阵容与来源标签；原创海萤/水滴形 Logo 中心带海克斯六边形。包含对局洞察、对局档案、运行日志、本地设置四个视图，附 PNG/ICO 图标。

日志是脱敏 JSONL，记录连接/阶段变化及诊断错误，不记录令牌、命令行、玩家姓名、模型上下文。当前与上一份各最多512 KiB，合计最多1 MiB；单条含JSON转义及换行最多2 KiB，每进程每60秒最多尝试6次写入，重复及正常待机错误不刷盘。旧版超大日志在下一次实际写入时处理。诊断页只读取两文件合计最多64 KiB尾部、最多100条，只在打开或手动刷新时读取。日志不是对局数据仓库，含玩家信息的原始对局只进入 SQLite。运行日志页还有「识别命中率」面板：累计截屏识别次数、命中次数与命中率、命中时平均名字数，并区分真实截屏与开发样本 fixture，附最近一次时间与近 7 天逐日对比；计数存 `logs/ocr-stats.json`（首次读取从现有日志回填一次），日志轮转不会冲掉历史。

## 存储与内存预算

- 设置页可查看数据库空间/记录/采样数量，预算默认 128 MB，可设 32–2048 MB；原始采样保留默认 7 天，可设 1–365 天。
- 不再启动即进行重型维护；空闲时每 30 分钟检查维护，或用户在设置页手动执行：清过期采样、限制每局 30 份采样、超预算时优先剔除旧采样，再清理过期已结束会话的顶层原始快照。决策时的证据、选择和复盘不自动删除。只有可回收页至少4 MiB且占总页数至少25%才执行VACUUM，避免定期整库重写。
- 保存前按 UTF-8 逻辑字节与页开销估算预算；预算是写入保护而非严格物理文件上限，SQLite 日志/VACUUM 可能临时额外占用空间。核心记录超预算时拒绝保存，需手动删历史或调高预算。
- 单场序列化记录最多 8 MiB。界面每页 50 条轻量历史，完整记录按需读取；编辑1500ms防抖写入；同局未开始的保存合并为最新版，避免慢磁盘堆积快照。常规自动落盘由15秒改为60秒，阶段变化/结束仍及时保存；异常退出可能丢失最近约一分钟的未落盘采样。保存后不自动重新加载历史列表。
- 模型请求限 256 KiB 上下文、1 MiB 响应；历史参考由本地 `history_similarity` 命令在最近 200 条档案里挑 5 条（同英雄优先 → 候选/已选海克斯 Jaccard 相似度 → 时间倒序，认不出的文本不计入相似度），附相似度与重叠海克斯并截取有界摘要，当前必需事实超限则报错而非偷偷删除。
- 这不是固定进程 RSS 上限，也不是自动训练/多级经验库。推理进程的内存由模型服务管理，仍需 Windows 任务管理器实测。

## 自定义模型设置

提供 TypeSafe Jev / OpenAI兼容协议选择，后者支持用户第三方 HTTPS、Ollama / LM Studio 本机 HTTP。API Key 仅本次内存；地址/模型等非敏感设置持久化。连接测试读取模型列表，不代表已验证推理。Jev发送 state/questions，普通模型以相同四维问题返回JSON；两者置信度不同源，不可混为一谈。用户自行承担模型用量，不承诺免费。应用内有防重复与预算护栏：同一次分析在途时禁止重复点击，两次分析至少间隔 8 秒，每日分析上限默认 20 次（设置页可调 1–500，按本地日期重置，计数存 localStorage）；成功后显示今日次数、耗时与上下文 KiB（Rust 返回 `engine.inputBytes`），只统计次数与字节数，不估算金额。

## 本地模型与隐私

- Jev采用官方 `/v1/systemone`，默认版本 jev-1.13.0；默认地址为官方 `https://api.typesafe.ai/v1`，改填第三方地址需在设置中勾选「允许使用第三方地址」。普通模型使用 `/chat/completions`。关闭代理和重定向，不自动切换厂商。30秒请求超时。
- 普通模型可关闭 response_format 参数，但仍必须返回可校验JSON。Jev用于结构化评分，理由由模板展示，不冒充模型生成长文。
- 外发前去除原始Live/LCU/结算、玩家名称与对局ID，玩家替换为p1等；保留英雄、海克斯、相关知识及历史观察。自由文本仍可能含个人信息，用户需要检查并同意发送。
- 应用没有遥测、远程字体或云端回退。安装依赖/模型/WebView2 的准备阶段可能需要网络。
- 回环限制不能阻止外部模型服务转发到云端。严格离线需选真正本地推理服务，并通过防火墙限制其出站。
- SQLite 为普通本地文件，未额外加密；含玩家名称时注意共享和备份，设备可使用 BitLocker 保护。

## Riot 政策与已知限制

用户指定参考：[Riot 官方 League of Legends 开发者支持页](https://support-developer.riotgames.com/hc/en-us/articles/22698698001939-League-of-Legends)。后续已通过官方公开文章 JSON 接口取得正文：`https://support-developer.riotgames.com/api/v2/help_center/en-us/articles/22698698001939.json`。文档要求产品不替玩家消除决策，禁止展示海克斯/Arena 物品胜率，并要求注册与说明 LCU 使用；LCU 不受官方第三方支持。当前仅提供候选分析，不实现自动替选、不展示海克斯聚合胜率。上线前仍需核验具体产品用途，本地运行不等于自动合规，项目没有 Riot 背书。

仅只读本地 API，不读游戏内存、不自动点击、不绕过保护。LCU 路径属于版本敏感接口，已在 Windows 真实对局中验证：赛后结算接口可读回本局全部 10 人的英雄、阵营与海克斯并自动补进档案；对局进行中的他人海克斯仍不可得，按未知处理，需要时继续手动补充。

内置英雄/海克斯数据来自打包数据与知识种子（逐条标 `verified: false`，不冒充版本权威）；截屏 OCR、对局内可折叠侧栏与赛后补录均为本地实现，不自动选择、无后台守护服务、不训练模型权重、不提供响应延迟保证。游戏身份缺失且生命周期观察中断时无法绝对证明局次，采用保守切分；真实长期运行需继续验证。

长期运行稳定性、真实模型服务信息仍待完成；安装与更新链路已通过 QA 脚本（`scripts/qa-windows.ps1`）与两轮自动更新端到端验收。
