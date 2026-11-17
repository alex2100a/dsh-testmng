---
name: requirement-authoring
description: Use when editing a tmsync requirement Markdown file: title, description, acceptance criteria, priority, status, catalog. 适用于 tmsync 需求文件的结构与质量规范。
---

# 需求文件规范

## 文件结构

```markdown
---
{
  "tmsync": 1,
  "kind": "requirement",
  "id": "11",
  "localId": null,
  "projectId": "prj_...",
  "catalogId": "14",
  "code": "REQ-0001",
  "priority": "P2",
  "status": "draft"
}
---
# 标题

## 描述
...

## 验收标准
- ...
```

## 编辑规则

- 只改标题、描述、验收标准、`priority`、`status`、`catalogId`（新建/移动）。
- 不改 `id`、`localId`、`projectId`、`code`。
- 状态枚举：`draft/approved/developing/implemented/cancelled`；流转受平台限制。
- 优先级：`P0/P1/P2/P3`。
- 验收标准必须可判定；避免“正常/友好”等模糊词。

## 质量检查

- 标题能独立说明需求。
- 描述说明背景、范围、约束。
- 验收标准覆盖正向、异常/边界（如适用）。
- 与用例的关联由用例侧维护；不要在需求文件里编造用例 ID。
