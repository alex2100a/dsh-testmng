---
name: plan-authoring
description: Use when editing a tmsync test plan Markdown file: fields, status/archive, case orchestration, dependencies, quality gate. 适用于 tmsync 计划文件的结构、编排与推送规范。
---

# 计划文件规范

## 可编辑字段

- front matter：`name` 由一级标题维护；`status`、`executorType`、`planKind`、`environment`。
- 正文：描述、用例编排（顺序/用例 ID/依赖）、质量门禁、准入/准出。
- 计划文件示例：

```json
{
  "tmsync": 1,
  "kind": "test-plan",
  "id": null,
  "localId": "local-plan-1",
  "projectId": "prj_...",
  "catalogId": null,
  "status": "draft",
  "executorType": "manual",
  "planKind": "smoke",
  "environment": "test"
}
```

## 用例编排

```markdown
| 顺序 | 用例 ID | 依赖 |
|------|---------|------|
| 1 | 29 | — |
| 2 | 30 | 29 |
```

- 用例 ID 是**平台数字 ID**；本地未推送的用例不能加入计划（先推用例）。
- 依赖是 case ID 列表，逗号分隔；不能依赖自身。
- **顺序只读**：平台没有 reorder 接口；改顺序不会推送，也不应通过“删除再加”来排序。
- 删除被其他用例依赖的 case 会被阻断。

## 状态

- `draft` / `active` / `archived`；`archived` 是归档，不是删除。
- 本地删除计划仍不支持（平台无 delete）。

## 同步

1. 旧工作区若计划用例基线缺失，先 `tmsync_plan_cases({ action: "refresh" })`。
2. `tmsync_push_plan` 查看 create/update/plan-case-add/deps/remove。
3. 用户确认后 `tmsync_push({ planId, confirm: true })`；`partial:true` 时检查 skipped/conflicts，不要声称全部成功。
4. 推送后本地顺序会按平台 `sort_order` 回写，属于正常现象。
5. 新建计划也会写回依赖；add 成功但 deps 失败时保留本地编排，下一次计划会重试。

## 禁止

- 不要用 null 清空计划字段；空文本用 `""`，质量门禁用空 rules。
- 不要伪造 order/plan_case_id。
- 不要自动推送或自动归档。
