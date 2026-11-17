---
name: conflict-resolution
description: Use when tmsync reports a conflict between local and remote test assets: compare base/local/remote, propose field-level resolution, and never overwrite silently. 适用于 tmsync 冲突的三方分析与解决。
---

# 冲突处理

## 原则

- 冲突是“两边都改了同一字段/同一段”；不要用一个整文件覆盖另一个。
- 先展示 base/local/remote；再让用户选择。
- 非重叠字段应自动合并；只有重叠字段需要人工决定。

## 步骤

1. 运行 `tmsync_show`（view: `diff`）或打开工作台冲突详情。
2. 按字段/小节列出：
   - 只有本地改：采用本地。
   - 只有远程改：采用远程。
   - 两边改且相同：一致。
   - 两边改且不同：冲突，请用户选择/手动合并。
3. 用户选择后：
   - 采用远程：用远程内容覆盖本地，baseline 更新。
   - 采用本地：baseline 更新为远程，本地保留，状态变为“本地修改”。
   - 手动合并：用户编辑本地文件，保存后 baseline 更新为远程。
4. 再次 `tmsync_validate` 与 `tmsync_status`。
5. 不要写入 Git 冲突标记；base 在 `.tmsync/baseline/`，平台当前值通过 `tmsync_show`/`tmsync_conflicts show` 读取。
6. legacy 内容（压缩空行/`##` 截断）用 `tmsync_rebase`（单实体或 all）修复；rebase 会丢弃本地修改，必须先确认。

## 禁止

- 不自动选择本地/远程。
- 不删除本地文件来“解决”冲突。
- 不把冲突状态说成已解决。
