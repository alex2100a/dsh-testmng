---
name: link-sync
description: Use when editing or syncing requirement-case links in a tmsync workspace: requirementIds, link cache, adopt, suppressed unlinks, conflicts. 适用于需求-用例链接的编辑、刷新、采用与冲突处理。
---

# 需求-用例链接

## 编辑

- 只改用例文件 `## 关联需求` 列表（或 front matter `requirementIds`，二者以正文列表为准）。
- ID 是**平台数字 ID**（如 `12`），不是本地 slug/文件名。
- 空关联写 `—`。
- 不要改 `.tmsync/`。

## 同步

1. `tmsync_links({ action: "status" })` 看本地/基线/远程。
2. 需要最新远程链接时 `tmsync_links({ action: "refresh" })`；stale 缓存不作为权威。
3. 推送走 `tmsync_push_plan` → 用户确认 → `tmsync_push`。
4. 删除关联需要 `linksArmed=true`；未启用时推送计划会列出 `suppressedUnlinks`，不要声称已删除。
5. 采用远程链接：`tmsync_links({ action: "adopt", ids })`；只对未修改用例生效，只改本地。

## 冲突

- `links-changed-remotely`：远程链接集合与基线不同，且本地也改了；不要替用户选择。
- 展示本地/基线/远程三组 ID，让用户决定：采用远程、保留本地、或手动合并。

## 禁止

- 不静默删除远程关联。
- 不编造需求 ID。
- 不在链接缓存不完整时推送链接。
