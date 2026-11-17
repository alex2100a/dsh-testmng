# tmsync 发布与安装指南

本目录面向两类读者：

- 发布者：[01-打包与发布.md](01-打包与发布.md)
- 最终用户：[02-用户安装与升级.md](02-用户安装与升级.md)

当前发布方式：**HTTP / 共享盘 tarball**，包名 `tmsync`，不发布到公网 npm。

## 快速开始（用户）

```powershell
dsh plugin --profile web add "https://files.example.com/tmsync/v0.2.3/tmsync-0.2.3.tgz"
# 重启 dsh web
```

也可以从 GUI 安装：侧边栏「插件」→「添加插件」→ 输入 tarball URL 或绝对路径。

## 必须知道的三件事

1. 只支持 `web` profile（`dsh web`）；Desktop / `tui` / `headless` 未验证。
2. 工作台 API 仅 loopback：请在每台机器本地安装，用 `http://127.0.0.1:<port>` 或 `http://localhost:<port>` 访问；不要部署成多人共享服务。
3. tarball 安装串必须是**绝对路径**，或以 `.tgz` / `.tar.gz` 结尾的 URL；URL 不能带 `?query`。

## 发布者快速命令

```powershell
npm run release:check
npm run release:pack
```

产物在 `dist/`：`tmsync-<version>.tgz`、SHA256、`INSTALL.md`、`guide/`。

- 发布包不包含 `scripts/`、`test/`、`docs/design/`。
- 同一版本不允许重复打包；请提升版本号。
- 详细流程见 [01-打包与发布.md](01-打包与发布.md)。
