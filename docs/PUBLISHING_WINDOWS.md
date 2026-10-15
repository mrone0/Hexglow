# Windows 发布

本地打包见 [BUILDING_WINDOWS](BUILDING_WINDOWS.md)。发布需要仓库中的 Windows 工作流和已有签名 secrets。

1. 同步四处版本号，完成本版验证，并将源码修改提交到 Git。
2. 更新 `docs/RELEASE_<版本>.md`：写 3–5 条用户能感知的变化，再写必要的安装说明。算法细节、参数和长验证记录放在专题文档中引用。
3. 本地运行 `pnpm package:local`。需要手动准备更新清单时，运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-latest-json.ps1`。
4. 为已经提交的本版源码创建、推送与版本一致的标签：

```powershell
$hexglowVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
git tag "v$hexglowVersion"
git push origin "v$hexglowVersion"
```

[Windows 工作流](../.github/workflows/windows.yml)验证标签与版本号、执行测试和签名构建，再发布安装器、`.sig`、`latest.json` 与 `SHA256SUMS.txt`。更新端点是仓库最新 Release 的 `latest.json`，需要公开可访问的附件。

已公开版本的附件保持不变，修复应使用新版本。私钥不提交到仓库；更新签名与 Windows Authenticode 代码签名是两回事。
