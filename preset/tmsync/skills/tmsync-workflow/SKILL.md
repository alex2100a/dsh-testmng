---
name: tmsync-workflow
description: Use when working in a tmsync local test-asset workspace: checking local vs remote status, pulling updates, editing requirement/case Markdown, validating files, and preparing a push plan. 适用于 tmsync 工作区的日常同步、编辑、校验与推送准备。
---

# tmsync 工作区流程

## 1. 先定位状态

1. 运行 `tmsync_status`（需要最新远程状态时 `includeRemote: true`）。
2. 看汇总：`local-modified` / `local-added` / `remote-modified` / `remote-new` / `conflict`。
3. 只处理用户要求范围内的文件；不要顺手改无关文件。

## 2. 拉取

- 需要远程更新时运行 `tmsync_pull`（默认 dry-run；`apply: true` 才写）。
- 拉取只覆盖“本地未改”的条目；本地有修改时跳过或冲突。
- 不要手工复制平台内容覆盖本地文件；用 `tmsync_pull`。

## 3. 编辑

- 需求：`requirements/.../<id>-<slug>.md`；用例：`cases/.../`。
- 保留 front matter 的 `id`/`kind`/`projectId`/`catalogId`；不要改 `.tmsync/`。
- 不要重命名/移动文件；目录由平台决定。
- 用例步骤使用三列表格；测试数据只在明确需要时保留。
- 报告只读；计划/缺陷可编辑。

## 4. 校验与汇报

1. `tmsync_validate`；有错先修，不要推送 invalid 文件。
2. `tmsync_status` 确认 `A`/`M`。
3. 向用户汇报：文件路径、ID/编号、变更摘要、冲突/阻断项。

## 5. 冲突

- 不自行决定本地/远程；展示 base/local/remote 的差异。
- 用户选择后，再按 `conflict-resolution` 技能处理。
- 命中 legacy（压缩空行/`##` 截断）时先 `tmsync_rebase`，不要直接 push。

## 6. 禁止

- 不自动推送；不伪造成功。
- 不删除远程实体；平台暂不支持删除/归档。
- 不编辑 `.tmsync/`、不绕过工具直接改 state。
