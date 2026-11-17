/**
 * Markdown codec：本地文件 ↔ canonical entity。
 *
 * 约定：
 * - JSON front matter（YAML 1.2 兼容，零依赖 JSON.parse）
 * - 一级标题是 title/name
 * - 固定小节；用例步骤用三列表格
 * - 同步元数据不放在内容文件里
 */
import {
  canonicalHash,
  escapeCell,
  fileStem,
  normalizeNewlines,
  unescapeCell,
} from './files.js'

export const KINDS = ['requirement', 'testcase', 'test-plan', 'defect', 'test-report']

export const KIND_META = {
  requirement: {
    dir: 'requirements',
    label: '测试需求',
    editable: true,
    titleKey: 'title',
    idPrefix: 'REQ',
  },
  testcase: {
    dir: 'cases',
    label: '测试用例',
    editable: true,
    titleKey: 'title',
    idPrefix: 'CASE',
  },
  'test-plan': {
    dir: 'plans',
    label: '测试计划',
    editable: true,
    titleKey: 'name',
    idPrefix: 'PLAN',
  },
  defect: {
    dir: 'defects',
    label: '测试缺陷',
    editable: true,
    titleKey: 'title',
    idPrefix: 'BUG',
  },
  'test-report': {
    dir: 'reports',
    label: '测试报告',
    editable: false,
    readOnly: true,
    titleKey: 'name',
    idPrefix: 'RPT',
  },
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3']
const CASE_TYPES = ['functional', 'api', 'ui', 'performance', 'security', 'compatibility', 'boundary', 'exception']
const CASE_STATUS = ['active', 'deprecated']
const REQUIREMENT_STATUS = ['draft', 'approved', 'developing', 'implemented', 'cancelled']
const PLAN_STATUS = ['draft', 'active', 'archived']
const PLAN_KINDS = ['smoke', 'regression', 'full']
const EXECUTOR_TYPES = ['manual', 'internal_http', 'internal_playwright', 'harness']
const QUALITY_OPERATORS = ['>=', '>', '<=', '<', '==', '!=']
const DEFECT_STATUS = ['new', 'confirmed', 'fixing', 'fixed', 'closed', 'rejected', 'reopened']
const DEFECT_SEVERITY = ['blocker', 'critical', 'major', 'general', 'minor']

function text(value, max = 200) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function multiline(value) {
  return normalizeNewlines(String(value ?? '')).trim()
}

export function escapeSectionLines(value) {
  return String(value ?? '').replace(/^(\\*)##(?=\s)/gm, (_match, slashes) => `${slashes}\\##`)
}

export function unescapeSectionLines(value) {
  return String(value ?? '').replace(/^(\\+)##(?=\s)/gm, (_match, slashes) => `${slashes.slice(1)}##`)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function normalizeQualityGate(value) {
  const object = asObject(value)
  if (!object) return null
  const rules = asArray(object.rules).filter((rule) => rule && typeof rule === 'object')
  return rules.length ? { rules } : null
}

export function kindDir(kind) {
  const meta = KIND_META[kind]
  if (!meta) throw new Error(`未知资产类型：${kind}`)
  return meta.dir
}

export function isEditableKind(kind, editableKinds = []) {
  return Boolean(KIND_META[kind]?.editable && editableKinds.includes(kind))
}

export function titleOf(kind, entity) {
  return text(entity?.[KIND_META[kind]?.titleKey] ?? entity?.title ?? entity?.name, 500)
}

export function parseFrontMatter(content) {
  const raw = normalizeNewlines(content)
  if (!raw.startsWith('---\n')) throw new Error('缺少 front matter（文件必须以 --- 开头）')
  const end = raw.indexOf('\n---', 4)
  if (end < 0) throw new Error('front matter 未闭合')
  const block = raw.slice(4, end).trim()
  let meta
  try {
    meta = JSON.parse(block)
  } catch (error) {
    throw new Error(`front matter 不是合法 JSON：${error.message}`)
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('front matter 必须是 JSON 对象')
  let body = raw.slice(end + 4)
  if (body.startsWith('\n')) body = body.slice(1)
  return { meta, body }
}

export function extractTitle(body) {
  const match = /^#\s+(.+?)\s*$/m.exec(body)
  return match ? match[1].trim() : ''
}

export const ALLOWED_SECTIONS = {
  requirement: new Set(['描述', '验收标准']),
  testcase: new Set(['前置条件', '步骤', '测试数据', '可执行规格', '关联需求']),
  'test-plan': new Set(['描述', '用例编排', '质量门禁', '准入标准', '准出标准']),
  defect: new Set(['描述']),
  'test-report': new Set(['摘要', '内容']),
}

export function splitSections(body, allowed = null) {
  const sections = new Map()
  const counts = new Map()
  const lines = normalizeNewlines(body).split('\n')
  let current = null
  let buffer = []
  const flush = () => {
    if (current !== null) sections.set(current, buffer.join('\n').trim())
    buffer = []
  }
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) {
      flush()
      current = match[1].trim()
      counts.set(current, (counts.get(current) || 0) + 1)
    } else if (current !== null) {
      buffer.push(line)
    }
  }
  flush()
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name)
  const unknown = allowed ? [...sections.keys()].filter((name) => !allowed.has(name)) : []
  return { sections, duplicates, unknown }
}

function parseSteps(section) {
  if (!section) return []
  const lines = section.split('\n').map((line) => line.trim()).filter(Boolean)
  const rows = lines.filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|?$/.test(line))
  if (rows.length === 0) return []
  const body = rows.slice(1)
  return body.map((row) => {
    const cells = row.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(unescapeCell)
    return {
      no: Number(cells[0]) || undefined,
      action: cells[1] ?? '',
      expected: cells[2] ?? '',
    }
  }).filter((step) => step.action || step.expected)
}

function jsonSection(section) {
  if (!section) return null
  const match = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(section)
  const raw = (match ? match[1] : section).trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function parseIdList(section) {
  if (section === undefined || section === null) return null
  const raw = String(section).trim()
  if (!raw || raw === '—') return []
  const ids = []
  for (const line of raw.split('\n')) {
    const match = /^\s*[-*]\s+([^\s#]+)/.exec(line)
    if (match) ids.push(match[1])
  }
  return ids
}

function parsePlanCases(section) {
  if (!section) return []
  const lines = section.split('\n').map((line) => line.trim()).filter(Boolean)
  const rows = lines.filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|?$/.test(line))
  return rows.slice(1).map((row) => {
    const cells = row.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(unescapeCell)
    return {
      order: Number(cells[0]) || undefined,
      caseId: cells[1] || '',
      dependsOn: cells[2] && cells[2] !== '—' ? cells[2].split(',').map((item) => item.trim()).filter(Boolean) : [],
    }
  }).filter((item) => item.caseId)
}

function parseQualityGate(section) {
  if (!section) return null
  const lines = section.split('\n').map((line) => line.trim()).filter(Boolean)
  const rows = lines.filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|?$/.test(line))
  const rules = rows.slice(1).map((row) => {
    const cells = row.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(unescapeCell)
    return { metric: cells[0] || '', operator: cells[1] || '>=', value: Number(cells[2]) }
  }).filter((rule) => rule.metric)
  return rules.length ? { rules } : null
}

function dashToEmpty(value) {
  const text = String(value ?? '').trim()
  return text === '—' || text === '-' ? '' : String(value ?? '')
}

export function parseFile(kind, content, filePath = '') {
  const meta = KIND_META[kind]
  if (!meta) throw new Error(`未知资产类型：${kind}`)
  const { meta: fm, body } = parseFrontMatter(content)
  if (Number(fm.tmsync) !== 1) throw new Error('不支持的 tmsync 版本')
  if (fm.kind !== kind) throw new Error(`kind 不匹配：文件是 ${fm.kind}，期望 ${kind}`)
  const title = extractTitle(body)
  const { sections, duplicates, unknown } = splitSections(body, ALLOWED_SECTIONS[kind])
  const sectionText = (name) => dashToEmpty(unescapeSectionLines(sections.get(name)))
  const entity = canonicalEntity(kind, {
    ...fm,
    id: fm.id === null || fm.id === undefined ? null : String(fm.id),
    localId: fm.localId ? String(fm.localId) : null,
    projectId: fm.projectId === undefined ? '' : String(fm.projectId),
    catalogId: fm.catalogId === null || fm.catalogId === undefined ? null : String(fm.catalogId),
    code: fm.code === undefined ? '' : String(fm.code),
    title: title || text(fm.title, 500),
    name: title || text(fm.name, 500),
    description: sectionText('描述'),
    acceptanceCriteria: sectionText('验收标准'),
    precondition: sectionText('前置条件'),
    steps: parseSteps(sections.get('步骤')),
    testData: jsonSection(sections.get('测试数据')),
    executableSpec: jsonSection(sections.get('可执行规格')),
    caseRefs: parsePlanCases(sections.get('用例编排')),
    qualityGate: parseQualityGate(sections.get('质量门禁')),
    entryCriteria: sectionText('准入标准'),
    exitCriteria: sectionText('准出标准'),
    reportContent: jsonSection(sections.get('内容')),
    linksUnknown: fm.linksUnknown === true,
    requirementIds: parseIdList(sections.get('关联需求')) ?? fm.requirementIds,
  })
  entity.file = filePath
  entity.sectionWarnings = [
    ...duplicates.map((name) => ({ code: 'duplicate-section', section: name })),
    ...unknown.map((name) => ({ code: 'unknown-section', section: name })),
  ]
  return entity
}

export function canonicalEntity(kind, raw = {}) {
  const base = {
    kind,
    id: raw.id === null || raw.id === undefined ? null : String(raw.id),
    localId: raw.localId ? String(raw.localId) : null,
    projectId: raw.projectId === undefined ? '' : String(raw.projectId),
    catalogId: raw.catalogId === null || raw.catalogId === undefined ? null : String(raw.catalogId),
    code: raw.code === undefined ? '' : String(raw.code),
    title: text(raw.title ?? raw.name, 500),
    name: text(raw.name ?? raw.title, 500),
    description: multiline(raw.description),
    acceptanceCriteria: multiline(raw.acceptanceCriteria ?? raw.acceptance_criteria),
    priority: raw.priority === null || raw.priority === undefined ? '' : String(raw.priority),
    status: raw.status === null || raw.status === undefined ? '' : String(raw.status),
    precondition: multiline(raw.precondition),
    steps: asArray(raw.steps).map((step, index) => ({
      no: Number(step?.no) || index + 1,
      action: String(step?.action ?? ''),
      expected: String(step?.expected ?? ''),
    })),
    type: raw.type === undefined ? '' : String(raw.type),
    requirementIds: Array.from(new Set(asArray(raw.requirementIds ?? raw.requirement_ids).map(String))).sort(),
    linksUnknown: raw.linksUnknown === true,
    testData: asObject(raw.testData ?? raw.test_data),
    executableSpec: asObject(raw.executableSpec ?? raw.executable_spec),
    planKind: String(raw.planKind ?? raw.plan_kind ?? ''),
    executorType: raw.executorType === undefined ? '' : String(raw.executorType),
    environment: raw.environment === undefined ? '' : String(raw.environment),
    qualityGate: normalizeQualityGate(raw.qualityGate ?? raw.quality_gate),
    entryCriteria: multiline(raw.entryCriteria ?? raw.entry_criteria),
    exitCriteria: multiline(raw.exitCriteria ?? raw.exit_criteria),
    caseRefs: asArray(raw.caseRefs).map((item) => ({
      order: Number(item?.order) || undefined,
      caseId: String(item?.caseId ?? item?.case_id ?? ''),
      dependsOn: asArray(item?.dependsOn ?? item?.depends_on).map(String),
    })),
    severity: raw.severity === undefined ? '' : String(raw.severity),
    statusComment: String(raw.statusComment ?? raw.status_comment ?? ''),
    assigneeId: raw.assigneeId === null || raw.assigneeId === undefined ? null : String(raw.assigneeId),
    assigneeName: raw.assigneeName === undefined || raw.assigneeName === null ? '' : String(raw.assigneeName),
    caseId: raw.caseId === null || raw.caseId === undefined ? null : String(raw.caseId),
    planId: raw.planId === null || raw.planId === undefined ? null : String(raw.planId),
    requirementId: raw.requirementId === null || raw.requirementId === undefined ? null : String(raw.requirementId),
    reportType: raw.reportType === undefined ? '' : String(raw.reportType),
    reportContent: asObject(raw.reportContent ?? raw.content),
    updatedAt: raw.updatedAt === undefined ? '' : String(raw.updatedAt),
    version: raw.version === undefined ? null : String(raw.version),
    contentHash: raw.contentHash === undefined ? '' : String(raw.contentHash),
    remote: raw.remote && typeof raw.remote === 'object' ? raw.remote : undefined,
  }
  if (kind === 'test-plan') {
    base.name = text(raw.name ?? raw.title, 500)
    base.title = base.name
    base.planKind = String(raw.planKind ?? raw.plan_kind ?? '')
  }
  if (kind === 'test-report') {
    base.name = text(raw.name ?? raw.title, 500)
    base.title = base.name
    base.reportContent = asObject(raw.reportContent ?? raw.content)
  }
  return base
}

export function contentFields(kind) {
  switch (kind) {
    case 'requirement': return ['title', 'description', 'acceptanceCriteria', 'priority', 'status', 'catalogId']
    case 'testcase': return ['title', 'precondition', 'steps', 'type', 'priority', 'status', 'catalogId', 'requirementIds', 'testData', 'executableSpec']
    case 'test-plan': return ['name', 'description', 'status', 'executorType', 'planKind', 'environment', 'qualityGate', 'entryCriteria', 'exitCriteria', 'caseRefs']
    case 'defect': return ['title', 'description', 'severity', 'priority', 'status', 'caseId', 'planId', 'requirementId']
    case 'test-report': return ['name', 'reportType', 'status', 'reportContent']
    default: return []
  }
}

export function contentHash(kind, entity) {
  if (kind === 'test-plan') {
    const fields = contentFields(kind).filter((field) => field !== 'caseRefs')
    return canonicalHash({
      kind,
      ...Object.fromEntries(fields.map((field) => [field, entity?.[field] ?? null])),
      caseRefs: normalizePlanCaseRefs(entity?.caseRefs),
    })
  }
  const fields = contentFields(kind)
  return canonicalHash({ kind, ...Object.fromEntries(fields.map((field) => [field, entity?.[field] ?? null])) })
}

export function normalizePlanCaseRefs(caseRefs) {
  return asArray(caseRefs)
    .map((item) => ({
      caseId: String(item?.caseId ?? item?.case_id ?? ''),
      dependsOn: asArray(item?.dependsOn ?? item?.depends_on).map(String).sort(),
    }))
    .filter((item) => item.caseId)
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
}

function frontMatter(kind, entity) {
  const common = {
    tmsync: 1,
    kind,
    id: entity.id ?? null,
    localId: entity.localId ?? null,
    projectId: entity.projectId ?? '',
    catalogId: entity.catalogId ?? null,
    code: entity.code || '',
  }
  const extra = {
    requirement: { priority: entity.priority, status: entity.status },
    testcase: { type: entity.type, priority: entity.priority, status: entity.status, requirementIds: entity.requirementIds ?? [], ...(entity.linksUnknown ? { linksUnknown: true } : {}) },
    'test-plan': { status: entity.status, executorType: entity.executorType, planKind: entity.planKind, environment: entity.environment },
    defect: {
      severity: entity.severity,
      priority: entity.priority,
      status: entity.status,
      caseId: entity.caseId,
      planId: entity.planId,
      requirementId: entity.requirementId,
      ...(entity.statusComment ? { statusComment: entity.statusComment } : {}),
      ...(entity.assigneeId ? { assigneeId: entity.assigneeId } : {}),
      ...(entity.assigneeName ? { assigneeName: entity.assigneeName } : {}),
    },
    'test-report': { reportType: entity.reportType, status: entity.status, readOnly: true },
  }[kind]
  return { ...common, ...extra }
}

function stepsTable(steps) {
  if (!steps?.length) return '暂无步骤。'
  return [
    '| # | 操作 | 预期 |',
    '|---|------|------|',
    ...steps.map((step, index) => `| ${step.no ?? index + 1} | ${escapeCell(step.action)} | ${escapeCell(step.expected)} |`),
  ].join('\n')
}

function planCasesTable(caseRefs) {
  if (!caseRefs?.length) return '暂无用例。'
  return [
    '| 顺序 | 用例 ID | 依赖 |',
    '|------|---------|------|',
    ...caseRefs.map((item, index) => `| ${item.order ?? index + 1} | ${escapeCell(item.caseId)} | ${escapeCell((item.dependsOn ?? []).join(', ') || '—')} |`),
  ].join('\n')
}

function qualityGateTable(qualityGate) {
  const rules = Array.isArray(qualityGate?.rules) ? qualityGate.rules : []
  if (!rules.length) return '未配置质量门禁。'
  return [
    '| 指标 | 条件 | 阈值 |',
    '|------|------|------|',
    ...rules.map((rule) => `| ${escapeCell(rule.metric)} | ${escapeCell(rule.operator)} | ${escapeCell(rule.value)} |`),
  ].join('\n')
}

function jsonBlock(value) {
  if (value === null || value === undefined) return '—'
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

export function renderFile(kind, entity) {
  const meta = KIND_META[kind]
  if (!meta) throw new Error(`未知资产类型：${kind}`)
  const title = titleOf(kind, entity) || `${meta.idPrefix}-${entity.id ?? entity.localId ?? 'new'}`
  const fm = frontMatter(kind, entity)
  const lines = ['---', JSON.stringify(fm, null, 2), '---', `# ${title}`, '']
  if (kind === 'requirement') {
    lines.push('## 描述', '', escapeSectionLines(entity.description || '—'), '', '## 验收标准', '', escapeSectionLines(entity.acceptanceCriteria || '—'), '')
  } else if (kind === 'testcase') {
    lines.push('## 前置条件', '', escapeSectionLines(entity.precondition || '—'), '', '## 步骤', '', stepsTable(entity.steps), '')
    if (entity.testData !== null && entity.testData !== undefined) lines.push('## 测试数据', '', jsonBlock(entity.testData), '')
    if (entity.executableSpec !== null && entity.executableSpec !== undefined) lines.push('## 可执行规格', '', jsonBlock(entity.executableSpec), '')
    lines.push('## 关联需求', '', entity.requirementIds?.length ? entity.requirementIds.map((id) => `- ${id}`).join('\n') : '—', '')
  } else if (kind === 'test-plan') {
    lines.push('## 描述', '', escapeSectionLines(entity.description || '—'), '', '## 用例编排', '', planCasesTable(entity.caseRefs), '')
    lines.push('## 质量门禁', '', qualityGateTable(entity.qualityGate), '')
    if (entity.entryCriteria || entity.exitCriteria) {
      lines.push('## 准入标准', '', escapeSectionLines(entity.entryCriteria || '—'), '', '## 准出标准', '', escapeSectionLines(entity.exitCriteria || '—'), '')
    }
  } else if (kind === 'defect') {
    lines.push('## 描述', '', escapeSectionLines(entity.description || '—'), '')
  } else if (kind === 'test-report') {
    lines.push('## 摘要', '', `> 平台报告只读；完整报告请在平台查看。`, '')
    if (entity.reportContent) lines.push('## 内容', '', jsonBlock(entity.reportContent), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function validateEntity(kind, entity, { file = '', editableKinds = [] } = {}) {
  const errors = []
  const warnings = []
  const meta = KIND_META[kind]
  if (!meta) return { ok: false, errors: [{ field: 'kind', message: `未知类型 ${kind}` }], warnings }
  if (!entity.projectId) errors.push({ field: 'projectId', message: 'projectId 不能为空' })
  if (!entity.id && !entity.localId) errors.push({ field: 'id', message: '必须提供 id 或 localId' })
  for (const warning of asArray(entity.sectionWarnings)) {
    errors.push({
      field: 'sections',
      message: warning.code === 'duplicate-section'
        ? `重复章节「${warning.section}」；内容可能被覆盖，请合并`
        : `未知章节「${warning.section}」；请改用固定章节或把行首 ## 写成 \\##`,
    })
  }
  if (entity.id && entity.localId) warnings.push({ field: 'localId', message: '同时存在 id 与 localId，按 id 处理' })
  if ((kind === 'requirement' || kind === 'testcase') && !entity.catalogId) errors.push({ field: 'catalogId', message: '需求/用例必须指定 catalogId' })
  if (!titleOf(kind, entity)) errors.push({ field: meta.titleKey, message: '标题不能为空' })
  if (entity.priority && !PRIORITIES.includes(entity.priority)) errors.push({ field: 'priority', message: `priority=${entity.priority} 不在 ${PRIORITIES.join('/')}` })
  if (kind === 'testcase' && entity.type && !CASE_TYPES.includes(entity.type)) errors.push({ field: 'type', message: `type=${entity.type} 不在支持列表` })
  if (kind === 'testcase' && entity.status && !CASE_STATUS.includes(entity.status)) errors.push({ field: 'status', message: `status=${entity.status} 不在 ${CASE_STATUS.join('/')}` })
  if (kind === 'requirement' && entity.status && !REQUIREMENT_STATUS.includes(entity.status)) errors.push({ field: 'status', message: `status=${entity.status} 不在支持列表` })
  if (kind === 'test-plan' && entity.status && !PLAN_STATUS.includes(entity.status)) errors.push({ field: 'status', message: `status=${entity.status} 不在支持列表` })
  if (kind === 'test-plan' && entity.planKind && !PLAN_KINDS.includes(entity.planKind)) errors.push({ field: 'planKind', message: `planKind=${entity.planKind} 不在支持列表` })
  if (kind === 'test-plan' && entity.executorType && !EXECUTOR_TYPES.includes(entity.executorType)) errors.push({ field: 'executorType', message: `executorType=${entity.executorType} 不在支持列表` })
  if (kind === 'test-plan') {
    const seen = new Set()
    for (const ref of asArray(entity.caseRefs)) {
      const caseId = String(ref?.caseId ?? '')
      if (!caseId) errors.push({ field: 'caseRefs', message: '用例 ID 不能为空' })
      else if (seen.has(caseId)) errors.push({ field: 'caseRefs', message: `重复用例 ID：${caseId}` })
      seen.add(caseId)
      for (const dep of asArray(ref?.dependsOn)) {
        if (String(dep) === caseId) errors.push({ field: 'caseRefs', message: `用例 ${caseId} 不能依赖自身` })
      }
    }
    for (const rule of asArray(entity.qualityGate?.rules)) {
      if (!rule?.metric) errors.push({ field: 'qualityGate', message: '质量门禁 metric 不能为空' })
      if (!QUALITY_OPERATORS.includes(String(rule?.operator))) errors.push({ field: 'qualityGate', message: `operator=${rule?.operator} 不支持` })
      if (!Number.isFinite(Number(rule?.value))) errors.push({ field: 'qualityGate', message: `value=${rule?.value} 不是数字` })
    }
  }
  if (kind === 'defect' && entity.status && !DEFECT_STATUS.includes(entity.status)) errors.push({ field: 'status', message: `status=${entity.status} 不在支持列表` })
  if (kind === 'defect' && entity.severity && !DEFECT_SEVERITY.includes(entity.severity)) errors.push({ field: 'severity', message: `severity=${entity.severity} 不在支持列表` })
  if (kind === 'defect' && entity.statusComment && entity.statusComment.length > 2000) errors.push({ field: 'statusComment', message: 'statusComment 不能超过 2000 字符' })
  if (kind === 'defect' && ['rejected', 'reopened'].includes(entity.status) && !entity.statusComment) warnings.push({ field: 'statusComment', message: '当前状态建议填写 statusComment（流转时必须）' })
  if (kind === 'testcase' && entity.steps?.length > 200) errors.push({ field: 'steps', message: '步骤不能超过 200 条' })
  if (kind === 'testcase' && entity.linksUnknown) warnings.push({ field: 'linksUnknown', message: '远程关联未知；推送前请刷新链接' })
  if (meta.readOnly) warnings.push({ field: 'readOnly', message: '报告只读；本地修改不会推送' })
  else if (!isEditableKind(kind, editableKinds)) warnings.push({ field: 'kind', message: `${meta.label} 当前只读（editableKinds 未启用）` })
  return { ok: errors.length === 0, errors, warnings, file }
}

export function relativePathFor(kind, entity, { catalogPath = '' } = {}) {
  const meta = KIND_META[kind]
  const dir = meta.dir
  const idPart = entity.id ?? entity.localId ?? 'new'
  const file = `${fileStem(idPart, titleOf(kind, entity))}.md`
  if ((kind === 'requirement' || kind === 'testcase') && catalogPath) {
    return [dir, catalogPath, file].join('/')
  }
  return [dir, file].join('/')
}

export function emptyEntity(kind, { projectId, catalogId = null, localId = null } = {}) {
  return canonicalEntity(kind, {
    projectId,
    catalogId,
    localId,
    title: '',
    name: '',
    status: kind === 'requirement' ? 'draft' : kind === 'testcase' ? 'active' : '',
    priority: 'P2',
  })
}

export { PRIORITIES, CASE_TYPES, CASE_STATUS, REQUIREMENT_STATUS, PLAN_STATUS, PLAN_KINDS, EXECUTOR_TYPES, DEFECT_STATUS, DEFECT_SEVERITY }
