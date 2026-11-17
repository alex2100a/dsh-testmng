# Changelog

## v0.2.3 — 实时、兼容与可运维（2026-11-17）

### P0 实时失效（SSE + fs.watch）

- 新增 `server/events.js`：SSE hub，事件 id `instanceId:seq`、环形缓冲、`Last-Event-ID` 重放/`resync`、客户端上限与背压。
- 新增 `server/watcher.js`：监听 `requirements/cases/plans/defects/reports`，300ms 防抖、`pause/resume`、启动/运行错误回调。
- `/api/tmsync/api/events` 改为真正的 SSE 事件流；`pull/push/resolve/links/plan-cases/rebase/config/checkpoint` 完成后推送失效事件。
- 工作台：本地编辑秒级刷新；保持目录展开/选择/滚动；60s 轮询始终保留（SSE 只加速本地/操作后刷新）；SSE 断开/禁用时显示“轮询/实时已关闭”。
- 新增 `scripts/realtime-smoke.js`（本地 SSE 冒烟，实测 ~320ms）。

### P1 DSH 版本兼容门

- 新增 `server/compat.js`：运行时探测 DSH 版本、semver 子集、`supported/untested/incompatible/unknown` 四态；与 DSH `includePrerelease` 语义一致。
- `/info.compatibility`、宿主日志、工作台横幅、原生面板提示条。
- `lib/client.js` 顶层只硬依赖 `slots`；`locale/uiWorkspace/workspaces/layout` 可选；无 locale 时不传 `locale` option，避免 DSH renderer 抛错。
- 客户端壳对缺失服务返回明确错误，不再整体不加载。

### P2 缓存治理

- 新增 `server/bounded.js`：LRU + TTL（从写入时间）+ 条目/字节上限 + 逐出统计；不启定时器。
- `statusSnapshots/statusInflight/plans/projectRevisions/watchers/git/projectCache` 全部有界；`/info.cache` 暴露统计。
- `saveConfig/testConnection` 清理 MCP 工具缓存；`dispose()` 清空全部缓存并关闭 watcher。
- 前端 `pending` 有上限/TTL（目录选择 300s）；日志刷新 2s 节流。

### P3 DSH Plugins 配置卡

- `plugins.bundle.config` 注册 key `tmsync`：版本/DSH 兼容/数据目录/平台/PAT 状态/项目统计/实时与播报开关/打开工作台。
- 新增 `GET /api/tmsync/api/overview`；PAT 脱敏改为任意非空 token 一律 `****`。
- Agent 播报改为 profile `announceToAgent` 且文件 `workbench.announceToAgent`（配置损坏 fail-closed）。

### P4 CI 与发布

- `server/version.js` 成为版本单一来源；`check-release` 改读该文件，并校验 DSH 兼容矩阵。
- 新增 `.github/workflows/pr-checks.yml`（Ubuntu/Windows × Node 22.19/24）与 `release.yml`（tag 校验 + GitHub Release）。
- `check-release` 旧版本黑名单从当前版本推导并排除当前版本；发布机路径改 `TMSYNC_PUBLISHER_PATHS`。

### P5 收口

- 版本统一 0.2.3；README/guide/CHANGELOG 更新；新增 `docs/design/v0.2.3/` 设计与三轮评审、实施证据。

## v0.2.2 — 正确性与发布收口（2026-11-17）

### P0 — 状态与配置

- `service.status` 改为“本地永远 fresh + 平台快照 TTL 缓存”；快照命中不创建 MCP 会话，`remoteCheckedAt` 为快照时间。
- 全局 `statusEpoch` + in-flight，保存配置/pull/push 等失效快照；修复“编辑后 status 仍显示旧状态”。
- `writeConfig` 使用裸配置，`TMSYNC_*` 环境变量不再被写回 `config.json`；config 损坏时拒绝覆盖并保留 `.bak`。
- `readState`/`loadState` fail-closed：JSON 损坏/schema/entities 结构异常/曾 pull 后 state 缺失均明确报错；写入方不再写空 state；state 写 `.bak`。

### P1a — 创建语义与差异

- 新建需求/用例的非默认 status 在 create 后写回；`get_case` 空链接不会清空本地链接。
- 新建计划写回用例依赖（`plan-case-add` → `plan-case-deps`）；计划 create/update 不再用平台空/旧 caseRefs 覆盖本地编排。
- `CreatePartialError`：create 多步后处理失败携带 createdId/最佳已知远程实体，避免重复创建；`needsFollowup` 可重试。
- 用例通用 diff 排除 `requirementIds`/内部字段，消除假链接冲突。

### P1b — 内容保真与 legacy

- Markdown 正文行首 `##` 可逆转义；不再全局压缩连续空行；多行文本 canonical trim、标题单行化。
- 未知/重复章节产生 warnings，validate 报错、planPush 阻断；本地手写 `##` 不再静默丢内容。
- legacy 检测缓存 `.tmsync/cache/legacy.json`；`linksAdopt`/writer 不洗白；新增 `tmsync_rebase`（单实体/all），`planPush` 阻断 legacy。
- 工作区 README marker 升至 v3，v2/旧模板定向迁移，保留用户备注。

### P2 — 推送与 Git

- apply 按实体失败隔离，新增 `partial`/`skipped`/`applyConflicts`；链接失败直接修 `linksArmed/linksUnknown`。
- 计划用例部分失败不 `refreshPlan` 覆盖本地；`plan-case-partial`。
- `service.push` 先认领计划再执行，失败写 `push-failed` 审计；写操作 finally invalidate。
- Git：平台感知路径比较、清理 `GIT_DIR` 等环境变量；预 staged/选择性 add 留到 v0.3.0。

### P3 — Agent 与发布

- persona/技能/工具文案与 v0.2 行为一致；`tmsync_show` remote/base、conflicts 值+链接、输出上限、partial 展示。
- 版本统一 0.2.2（package/mcp/service/README/CHANGELOG/docs guide）；`release:check` 增加 service/docs guide 检查。
- 发布指南：`docs/guide/`；`npm run release:check` / `npm run release:pack`；产物在 `dist/`（tgz、SHA256、`INSTALL.md`、`guide/`）。
- 发布包 `files` 移除 `scripts/`、加入 `docs/guide`；`npm run check:links` 默认检查 `docs/guide`。
- 移除配置页「从 dsh-testcat 导入」按钮及对应 `POST /api/tmsync/config/import-testcat` 接口；平台连接信息改为手工填写。
- 工作区 README 与 `tmsync_status` 文本不再显示平台内部项目 ID（`prj_...`）。

## v0.2.1 — UI 顶栏信息架构（2026-11-17）

- 顶栏精简为：品牌 + 项目选择 + tabs + 平台同步 chip + 刷新 + 发起会话 + `⋯`。
- 移除主界面 `public_id`、`↑↓⚠A` 符号计数、`Git ...` 状态；`public_id` 仅保留在配置页/详情/tooltip。
- `⋯` 菜单：从平台拉取、推送到平台、创建本地检查点、配置。
- 同步 chip：冲突/异常/待确认/待处理/已同步；popover 显示中文分项和快捷拉取/推送。
- 右侧新增“本地版本（Git）”：分支/变更数/最近检查点/按钮/“仅本地 commit，不 push”说明。
- 用户可见“远程”改为“平台”；内部状态键不变。
- 响应式：1440/1100/760 三档无横向溢出；760 两行顶栏。
- 计划与评审：`docs/design/v0.2.1/`。

## v0.2.0 — 链接/计划/缺陷/Git（2026-11-17）

### P0 — 平台写语义与 Git 探针（2026-11-16）

- 新增 `scripts/v02-write-probe.js` 与 `docs/design/v0.2.0/evidence/platform-facts-v0.2.*`。
- 关键事实：链接变化不更新 version/updated_at；计划用例变化不更新 plan.updated_at；`unlink` 未关联 404；`create_plan` 默认 active/regression；计划字段 null 被忽略（用 `""`/`{rules:[]}`）；缺陷关联无法用 null 清空；缺陷无 `allowed_transitions`；`list_plan_cases` 101 条分页正常；Git repo-root/hooks 可检测/禁用。
- 设计 01–08 按独立审核 B1–B11 修订；评审 v2 通过（有条件）。

### P1 — 需求-用例链接同步（2026-11-17）

- 新增 `server/links.js`：链接缓存（complete/failed）、有效链接视图、基线差异、`linksArmed`、suppressedUnlinks、缓存增量 patch。
- 拉取：完整快照才写 `baseRequirementIds`；缓存不可用时保留本地链接，绝不把 `get_case` 空值写回。
- 推送：link/unlink/link-baseline；链接变化时强制重建缓存；`unlink` 404 视为已解除；apply 成功后更新基线/缓存。
- 工具/UI：`tmsync_links`（status/refresh/adopt）、详情链接状态、推送弹窗 suppressed 分组。
- 修复：`## 关联需求` 正文可编辑（正文优先）；链接 ID 去重排序。
- 真机：项目 11 用例 30 ↔ 需求 12 新增/删除关联均回读一致；单测 21 项通过。

### P2a — 测试计划写回（2026-11-17）

- 计划 hash 排除 order；空 qualityGate 归一；计划字段/状态/归档；计划用例 add/deps/remove。
- `list_plan_cases` 全量分页；`planCases` 三态；旧工作区子集只增/缺项阻断；`tmsync_plan_cases` 刷新。
- 配置 `editableKinds` 自动升级四类；`tmsync_validate` 工具补齐。
- 真机：新建计划 13 → 加用例 29 → 依赖 30→29 → 归档 → 删除 30，平台回读一致；101 条计划用例分页验证。
- 单测新增 plan 5 项，共 26 项通过。
- 限制：计划顺序只读；字段清空用 `""`/`{rules:[]}`；删除计划用例会丢执行历史。

### P2b — 测试缺陷写回（2026-11-17）

- 缺陷字段/状态/statusComment/关联；rejected/reopened 必须 comment；关联清空阻断；指派人只读 warning。
- 拉取写 assignee 基线；详情显示只读指派人；推送弹窗显示状态/comment。
- 真机：创建缺陷 14（关联 case/plan/req）→ confirmed → 更新 → fixing/fixed/closed → reopened(comment)；新建缺陷 15 → rejected(comment)；关联清空 blocked。
- 单测新增 defect 5 项，共 31 项通过。
- 限制：指派人/评论/关联清空不支持；缺陷删除不支持。

### P3 — Git 检查点与收尾（2026-11-17）

- `server/git.js`：`gitInfo`（repoRoot/branch/head/dirty/preview/checkpoints）+ `gitCheckpoint`。
- 安全：repoRoot==workspaceRoot；排除 `.tmsync/` 与 dataDir；禁用 hooks/GPG；`GIT_TERMINAL_PROMPT=0`；`diff --cached` 非 0/1 视为错误；消息清洗。
- API/工具/UI：`GET /git`、`POST /git/checkpoint`、`tmsync_git_checkpoint`、顶栏 Git 状态与检查点弹窗（文件预览/冲突提示）。
- 工具补齐 `tmsync_validate`；`npm run check:links` 文档链接检查。
- 真机：host 工作区 init → checkpoint `cce9b92`（5 files，排除 .tmsync）→ 无变更 no-op。
- 单测新增 git 4 项；总计 35 项通过（含 codec/files/links/mcp-pool/plan/defect/push/status/audit）。
- 清理 v0.1 历史文档示例（planKind、defect status、requirementIds 平台 ID）。
- 版本号 0.2.0。

## v0.1.1 — 同步性能优化（2026-11-16）

- 新增 `createMcpClient` 会话池：一次操作内复用 MCP 会话，按 `workbench.concurrency` 有界并行；传输失败自动丢弃会话重建。
- 适配器 `TestCaseGen` 新增 `withClient`（AsyncLocalStorage 下传），`status`/`pull`/`push plan`/`push`/`conflict` 全程复用会话。
- `computeStatus` 并行读取目录/五类列表与本地 state；目录路径映射只构建一次；拉取详情有界并行。
- 拉取/推送计划只扫描一次本地文件（原来每条实体重复扫描）。
- `workbench.concurrency` 默认改为 2（实测平台近似串行，2 个性价比最高）；配置上限仍为 8。
- 实测（项目 10，8 条资产）：首次拉取 2340→726 ms；status refresh 957→约 320 ms；pull dry-run 775→约 330 ms；推送 apply 约 220 ms。
- 单元测试新增 MCP 会话池 2 项（会话复用/并发上限）；共 15 项通过。

## v0.1.0

### P0 — 平台事实与探针（2026-11-16）

- 新增 `scripts/platform-probe.js`：读取 tmsync/dsh-testcat 配置，只读采集项目、工具 schema、字段形状与能力。
- 新增 `docs/design/v0.1/evidence/platform-probe.json`：脱敏探针结果（无 token、无测试数据正文）。
- 完成 P0 只读结论：96 工具；项目 `public_id` 字符串；`page_size ≤ 50`；实体支持 `catalog_id` 移动；删除/归档/报告更新不支持。
- 设计审核 v2 通过；按 P 阶段提交计划执行。

### P1 — 本地镜像 + 状态 + 拉取（2026-11-16）

- 新增 DSH 插件骨架：`tmsync` bundle patch、`preset/tmsync`、Slots 侧边栏/主面板 iframe、`tmsync/tools`。
- 新增配置/凭据：`~/.dsh/tmsync/config.json`（0600）、从 `dsh-testcat` 导入、测试连接。
- 新增平台适配器：项目 `public_id` 字符串 ↔ MCP 数字 `project_id`；目录/五类列表/详情。
- 新增文件 codec：JSON front matter + Markdown；需求/用例/计划/缺陷/报告；语义 hash。
- 新增工作区：`.tmsync/` 状态/基线、两轴状态、远程新增/修改、手工拉取、写前本地 hash 复核。
- 新增工作台：项目切换、六菜单、目录树/状态徽标、内容/差异/信息、配置、拉取、最近操作。
- 新增 preset 工具：`tmsync_status/show/pull/validate`；技能：workflow/requirement/case/conflict。
- 真机验证：真实项目 `public_id=prj_9d60...` 拉取 8 条，状态回到 8 条一致；本地改标题显示 `M`；DSH 0.2.2-rc.1 侧边栏/iframe/发起会话通过。
- 单元测试：codec/files/status 共 10 项通过。

### P2 — 手工推送 + 冲突（2026-11-16）

- 新增平台写适配器：需求/用例 create/update/status；计划/缺陷预留；需求-用例 link/unlink。
- 新增 `server/push.js`：推送 plan（只读）、apply（逐条复核 version）、创建后回写 ID/路径、状态变更、部分失败。
- 新增工作台「推送」按钮/计划弹窗/确认执行；详情冲突「保留本地/采用远程」。
- 新增 preset 工具：`tmsync_push_plan`、`tmsync_push`、`tmsync_conflicts`。
- 修复状态引擎：需求/用例优先比较 `version`（P0 发现 `updated_at` 可能不更新）；标题修改不再移动文件路径。
- 真机写测试（专用项目 `TMSYNC_P0`）：新建需求/用例 → plan → apply → 平台回读 → 4 条一致；更新/状态/冲突本地解决后推送均通过。
- 单元测试：新增 push create/update 2 项，共 12 项通过。
- 限制：需求-用例链接不自动推送；删除/归档/目录改名仍不支持。

### P3 — 日志、自动刷新、Git 检测（2026-11-16）

- 新增 `server/audit.js`：`~/.dsh/tmsync/logs/YYYY-MM.jsonl` 同步日志；pull/push/conflict 摘要；不含 token/字段值。
- 工作台「最近操作」读取日志；每 60 秒/窗口聚焦自动刷新状态（只用缓存，不自动 pull/push）。
- 新增 `server/git.js`：检测工作区 `.git`；配置页显示 Git 标记；不执行 git/commit。
- 单元测试：新增 audit 1 项，共 13 项通过。
- 说明：平台未提供 `updated_since`，P3 仍是“全量列表 + version/hash 变化检测”，未做真正增量接口。
- DSH 实机：从工作台发起 preset `tmsync` 会话，模型真实调用 `tmsync_status` 并返回 4 条一致（G3 通过）。



