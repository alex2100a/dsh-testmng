# tmsync

**tmsync** 是 DeepSeek Harness（DSH）插件：把测试管理平台的需求、用例、计划、缺陷、报告同步成本地工作区文件；DSH 模型直接编辑文件，工作台显示本地与平台的状态差异。

> 当前为 **v0.2.3**：本地编辑秒级可见（SSE + fs.watch）、DSH 版本兼容门、缓存上限/诊断、DSH Plugins 配置卡、PR/Release CI。v0.2.2 的状态/配置/推送正确性保持不变。

## 环境

- DSH `>=0.2.1 <0.3.0`（已测 `0.2.2-rc.1` / `0.2.2-rc.3`）；`0.2.1-rc.*` 低于下界，`0.3.0-rc.*` 在范围内但未测
- Node `^22.19.0 || >=24.0.0`
- 测试管理平台 MCP（TestCaseGen 基线 96 工具）

## 安装

> 发布给其他用户使用 tarball 安装；`link:` 仅用于本机开发。
> 只支持 `web` profile；工作台 API 仅 loopback，请在每台机器本地安装和使用。
> 完整步骤见 [安装与升级指南](docs/guide/02-用户安装与升级.md)。

```powershell
# tarball（绝对路径或 URL；URL 必须以 .tgz 结尾，不能带 query）
dsh plugin --profile web add "https://files.example.com/tmsync/v0.2.3/tmsync-0.2.3.tgz"
# 或：dsh plugin --profile web add "D:\release\tmsync\v0.2.3\tmsync-0.2.3.tgz"
# 重启 dsh web
```

侧边栏出现「测试资产」；新建会话出现「测试资产工作区」（preset `tmsync`）。

### 开发安装（源码 link）

```powershell
dsh plugin --profile web add "link:D:\path\to\tmsync-repo"
# 重启 dsh web
```

## 配置

1. 打开侧边栏「测试资产」→「配置」。
2. 填平台 Web 地址、MCP 地址、PAT。
3. 「测试连接」→「保存」。
4. 选择项目 →「关联目录」→ 选择本地工作区根目录。
5. 点「拉取」把平台资产落盘。

配置存于 `~/.dsh/tmsync/config.json`（0600）；PAT 不写入工作区/日志。

## 工作台

- 顶栏：项目选择、五类资产/配置 tabs、平台同步状态 chip、刷新、发起会话、`⋯` 溢出菜单。
- `⋯`：从平台拉取、推送到平台、创建本地检查点、配置。
- 顶栏不显示内部 `public_id`；它只在配置页、详情“信息”和项目下拉 tooltip 中。
- 左侧：本地目录树 + 平台状态（✓ 一致、M 本地修改、A 本地新增、D 本地删除、↓ 平台更新、+ 平台新增、! 冲突、? 无效）。
- 中间：内容/差异/信息；右侧：平台同步、本地版本（Git）、最近操作。
- 实时更新：`fs.watch` 监听受管目录 + SSE 推送；本地编辑通常 1 秒内显示 `M`，不额外请求平台。SSE 断开/禁用时保留 60 秒轮询。
- 平台变化没有 webhook，仍按 `statusTtlMs`（默认 300s）或手动刷新/拉取更新。
- 「发起会话」：创建/复用 DSH Workspace（cwd = 本地工作区），打开 `tmsync` 会话。
- 工作台不聊天；对话在 DSH 原生会话。
- 性能：一次同步操作复用 MCP 会话（`workbench.concurrency`，默认 2）；status/拉取/推送有界并行。

## 性能（v0.1.1）

实测（真实平台项目 10，8 条资产）：

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 首次拉取并落盘 | 2340 ms | 726 ms |
| status refresh | 957 ms | ~320 ms |
| pull dry-run | 775 ms | ~330 ms |

说明：平台 MCP 当前对并发请求近似串行，2 个会话最划算；可通过 `~/.dsh/tmsync/config.json` 的 `workbench.concurrency` 调整（1–8）。

## Agent 工具（v0.2.3）

| 工具 | 作用 |
|---|---|
| `tmsync_status` | 本地/平台状态汇总与变更列表（本地 fresh，平台快照） |
| `tmsync_show` | 单条本地/平台/基线/差异（含 links/planCases） |
| `tmsync_pull` | 拉取安全更新（默认 dry-run） |
| `tmsync_validate` | 结构/front matter/枚举/计划编排/legacy 校验 |
| `tmsync_push_plan` | 生成推送计划（需求/用例/计划/缺陷/链接/计划用例） |
| `tmsync_push` | 执行已确认计划（planId + confirm；partial 表示部分完成） |
| `tmsync_conflicts` | 列出/查看/解决冲突 |
| `tmsync_links` | 链接 status/refresh/adopt |
| `tmsync_plan_cases` | 刷新计划用例基线（全量分页） |
| `tmsync_rebase` | 以平台/基线为准重写本地（单实体/all；丢弃本地修改） |
| `tmsync_git_checkpoint` | 创建 Git 检查点（confirm:true，不 push） |

## 本地格式

- 顶层目录：`requirements/`、`cases/`、`plans/`、`defects/`、`reports/`。
- JSON front matter（YAML 1.2 兼容）+ Markdown；文件名 `<id>-<slug>.md`。
- 同步元数据在 `.tmsync/`，**不要编辑**。
- 需求/用例/计划/缺陷可编辑；报告只读；指派人/计划顺序只读。
- 用例 `## 关联需求` 使用平台数字 ID；空写 `—`。

## Git 检查点

- 工作台顶栏显示分支/dirty；「Git 检查点」按钮。
- 只允许**仓库根 == 工作区根**；不 init/push/tag；禁用 hooks/GPG。
- 内置排除 `.tmsync/` 与 tmsync dataDir；提交前展示文件列表。
- 无变更 no-op；不是仓库/根不匹配会明确报错。

## 已知限制（v0.2.3）

- 平台不支持需求/用例/计划/缺陷删除；计划归档用 `status=archived`。
- 缺陷指派人只读（无用户查询工具）；缺陷评论不拉取/不新增。
- 缺陷关联清空不支持（平台 null 被忽略）；本地会阻断。
- 计划用例顺序只读；删除计划用例会丢失执行历史。
- 平台链接变化不自动写本地；用 `tmsync_links adopt`。
- 旧工作区链接首次只增不删；计划用例缺失基线时先 refresh。
- legacy 内容（旧版压缩空行/`##` 截断）不会自动修复；用 `tmsync_rebase`（单实体/all），否则 planPush 会阻断。
- 推送结果 `partial:true` 表示部分完成；需查看 skipped/conflicts，不能当成全部成功。
- Git 检查点仍 `git add -A`，会加入工作区所有变更；选择性 add/敏感文件阻断留到 v0.3.0。
- 工作台 API 仅 loopback；报告只读。
- 远程平台变化不会实时推送（平台无 webhook）；多 DSH 实例监听同一工作区时事件不互通。
- 客户端壳仍是手写 `__ModuleLoader__`；v0.2.3 增加了运行时版本门和可选服务降级，但 DSH 升级后仍建议复跑 host smoke。
- DSH Plugins 配置卡只编辑实时/播报等安全偏好；平台地址、PAT、工作区绑定仍在工作台配置页。

## 发布

- 发布者：[打包与发布指南](docs/guide/01-打包与发布.md)
- PR：`.github/workflows/pr-checks.yml`（Ubuntu/Windows、Node 22.19/24、单测/链接/发布静态检查）。
- Tag：`.github/workflows/release.yml`（校验 tag == `package.json.version`，打包并创建 GitHub Release 附件）。
- `npm run release:check`：版本单一来源（`server/version.js`）、DSH 兼容矩阵、包名引用、打包白名单校验。
- `npm run release:pack`：生成 `dist/`（tgz、SHA256、`INSTALL.md`、`guide/`）。
- 发布包不包含 `scripts/`、`test/`、`docs/design/`、`.github/`。

## 开发

> 以下命令需在源码仓库运行；安装包不包含 `scripts/` 与 `test/`。

```powershell
npm run test:unit
npm run check:links
node scripts/realtime-smoke.js
node scripts/platform-probe.js --project-id 10 --out docs/design/v0.1/evidence/platform-probe.json
node scripts/v02-write-probe.js --out docs/design/v0.2.0/evidence/platform-facts-v0.2.json
```

设计文档：`docs/design/v0.2.3/`（含独立审核与复审）。
