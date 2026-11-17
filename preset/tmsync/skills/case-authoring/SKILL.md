---
name: case-authoring
description: Use when editing a tmsync test case Markdown file: steps table, precondition, type, priority, status, requirement links. 适用于 tmsync 用例文件的结构与质量规范。
---

# 用例文件规范

## 文件结构

```markdown
---
{
  "tmsync": 1,
  "kind": "testcase",
  "id": "23",
  "localId": null,
  "projectId": "prj_...",
  "catalogId": "13",
  "code": "TC-0001",
  "type": "api",
  "priority": "P2",
  "status": "active",
  "requirementIds": ["11"]
}
---
# 标题

## 前置条件
...

## 步骤
| # | 操作 | 预期 |
|---|------|------|
| 1 | ... | ... |

## 关联需求
- 11
```

## 编辑规则

- 步骤表必须三列；`#` 可省略（自动编号）；最多 200 行。
- 类型：functional/api/ui/performance/security/compatibility/boundary/exception。
- 优先级：P0/P1/P2/P3；状态：active/deprecated。
- `requirementIds` 是关联需求的**平台数字 ID**（如 `12`），不是本地 slug/文件名；需求-用例链接见 `link-sync` 技能。
- 测试数据默认不落盘；需要时使用 fenced JSON，并注意敏感信息。

## 质量检查

- 每条步骤都可执行、可判定；预期要具体。
- 覆盖正向、异常、边界；按风险排序。
- 与需求关联或明确标注为缺口。
