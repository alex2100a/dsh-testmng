/**
 * TestCaseGen 平台适配器。
 *
 * 本地项目 ID = public_id 字符串；MCP 的 project_id = 数字 id。
 * 实体 ID 本地字符串；MCP 使用数字 ID。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { canonicalEntity, KIND_META } from '../codec.js'
import { createMcpClient } from '../mcp.js'
import { BoundedMap } from '../bounded.js'

const LIST_TOOLS = {
  requirement: 'list_requirements',
  testcase: 'list_cases',
  'test-plan': 'list_plans',
  defect: 'list_defects',
  'test-report': 'list_reports',
}

const DETAIL_TOOLS = {
  requirement: 'get_requirement',
  testcase: 'get_case',
  'test-plan': 'get_plan',
  defect: 'get_defect',
  'test-report': 'get_report',
}

const ID_PARAMS = {
  requirement: 'req_id',
  testcase: 'case_id',
  'test-plan': 'plan_id',
  defect: 'defect_id',
  'test-report': 'report_id',
}

function str(value) {
  return value === null || value === undefined ? '' : String(value)
}

export class CreatePartialError extends Error {
  constructor(message, { kind, createdId, created, cause, completedSteps = [] } = {}) {
    super(message)
    this.name = 'CreatePartialError'
    this.code = 'create_partial'
    this.kind = kind
    this.createdId = createdId
    this.created = created
    this.cause = cause
    this.completedSteps = completedSteps
  }
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  if (!/^\d+$/.test(text)) return null
  return Number(text)
}

function normalizeCatalog(item) {
  return {
    id: str(item?.id),
    name: str(item?.name),
    parentId: item?.parent_id === null || item?.parent_id === undefined ? null : str(item.parent_id),
    itemCount: Number.isInteger(item?.item_count) ? item.item_count : null,
  }
}

function flattenCatalogs(items, out = []) {
  for (const item of Array.isArray(items) ? items : []) {
    out.push(normalizeCatalog(item))
    if (Array.isArray(item?.children)) flattenCatalogs(item.children, out)
  }
  return out
}

function projectView(item) {
  const publicId = str(item?.public_id) || str(item?.id)
  return {
    id: publicId,
    publicId,
    platformId: str(item?.id),
    code: str(item?.code),
    name: str(item?.name),
    status: str(item?.status),
    description: str(item?.description),
    updatedAt: str(item?.updated_at),
  }
}

export function createTestCaseGenAdapter({ readConfig, callTool, log = () => {} }) {
  const projectCache = new BoundedMap({ maxEntries: 1000, ttlMs: () => 10 * 60_000 })
  const clientStorage = new AsyncLocalStorage()
  let projectsCache = null
  let projectsCachedAt = 0

  async function config() {
    const cfg = await readConfig()
    if (!cfg?.platform?.mcpUrl) throw new Error('未配置 MCP 地址')
    if (!cfg.platform.token) throw new Error('未配置访问令牌（PAT）')
    return cfg
  }

  async function call(name, args, { timeoutMs } = {}) {
    const active = clientStorage.getStore()
    if (active) return active(name, args, { timeoutMs })
    const cfg = await config()
    return callTool({ mcpUrl: cfg.platform.mcpUrl, token: cfg.platform.token, name, args, ...(timeoutMs ? { timeoutMs } : {}) })
  }

  /**
   * 在一次同步操作内复用 MCP 会话，并按 concurrency 并行。
   * 通过 AsyncLocalStorage 下传，调用方（workspace/push）无需改签名。
   */
  async function withClient(fn, { concurrency = 2 } = {}) {
    const cfg = await config()
    const client = createMcpClient({
      mcpUrl: cfg.platform.mcpUrl,
      token: cfg.platform.token,
      concurrency,
      onEvent: (event) => log(`[tmsync] mcp ${event.type} sessions=${event.sessions}`),
    })
    try {
      return await clientStorage.run((name, args, opts) => client.call(name, args, opts), fn)
    } finally {
      await client.close()
    }
  }

  async function listProjects({ refresh = false } = {}) {
    if (!refresh && projectsCache && Date.now() - projectsCachedAt < 60_000) return projectsCache
    const items = []
    for (let page = 1; page <= 20; page += 1) {
      const data = await call('list_projects', { page, page_size: 50 })
      const batch = Array.isArray(data?.items) ? data.items : []
      items.push(...batch)
      if (batch.length < 50 || items.length >= Number(data?.total ?? items.length)) break
    }
    const projects = items.map(projectView)
    projectsCache = projects
    projectsCachedAt = Date.now()
    for (const project of projects) projectCache.set(project.id, project)
    return projects
  }

  async function resolveProject(projectId) {
    const key = str(projectId)
    if (!key) throw new Error('项目 ID 不能为空')
    const cached = projectCache.get(key)
    if (cached) return cached
    const known = Array.isArray(projectsCache)
      ? projectsCache.find((item) => item.id === key || item.publicId === key || item.code === key)
      : undefined
    if (known) {
      projectCache.set(key, known)
      return known
    }
    const projects = await listProjects({ refresh: true })
    const found = projects.find((item) => item.id === key || item.publicId === key || item.code === key)
    if (!found) throw new Error(`未找到项目：${key}`)
    projectCache.set(key, found)
    return found
  }

  async function numericProjectId(projectId) {
    const project = await resolveProject(projectId)
    const numeric = intOrNull(project.platformId)
    if (numeric === null) throw new Error(`项目 ${projectId} 的平台 ID 不是数字，TestCaseGen adapter 不支持`)
    return numeric
  }

  async function listCatalogs(projectId, kind) {
    const pid = await numericProjectId(projectId)
    if (kind === 'requirement') {
      const data = await call('get_requirement_catalog_tree', { project_id: pid })
      return flattenCatalogs(data?.items ?? data?.tree ?? [])
    }
    if (kind === 'testcase') {
      const data = await call('list_case_catalogs', { project_id: pid })
      return flattenCatalogs(data?.items ?? data?.tree ?? [])
    }
    return []
  }

  function normalizeEntity(kind, item, projectId) {
    const base = canonicalEntity(kind, {
      id: item?.id,
      projectId,
      catalogId: item?.catalog_id,
      code: item?.code,
      title: item?.title,
      name: item?.name,
      description: item?.description,
      acceptanceCriteria: item?.acceptance_criteria,
      priority: item?.priority,
      status: item?.status,
      precondition: item?.precondition,
      steps: item?.steps,
      type: item?.type,
      requirementIds: item?.requirement_ids,
      testData: item?.test_data,
      executableSpec: item?.executable_spec,
      planKind: item?.kind,
      executorType: item?.executor_type,
      environment: item?.environment,
      qualityGate: item?.quality_gate,
      entryCriteria: item?.entry_criteria,
      exitCriteria: item?.exit_criteria,
      severity: item?.severity,
      assigneeId: item?.assignee_id,
      assigneeName: item?.assignee_name,
      statusComment: item?.status_comment,
      caseId: item?.case_id,
      planId: item?.plan_id,
      requirementId: item?.requirement_id,
      reportType: item?.report_type,
      content: item?.content,
      updatedAt: item?.updated_at,
      version: item?.version,
    })
    base.remote = {
      updatedAt: str(item?.updated_at),
      version: item?.version === undefined ? null : str(item.version),
      contentHash: str(item?.content_hash),
      reviewStatus: str(item?.review_status),
      allowedTransitions: Array.isArray(item?.allowed_transitions) ? item.allowed_transitions : [],
      caseCount: Number.isInteger(item?.case_count) ? item.case_count : null,
      runId: item?.run_id === undefined ? null : str(item.run_id),
      planId: item?.plan_id === undefined ? null : str(item.plan_id),
      planName: str(item?.plan_name),
      lastRun: item?.last_run ?? null,
      filePath: str(item?.file_path),
    }
    return base
  }

  async function listEntities(projectId, kind, { page = 1, pageSize = 50 } = {}) {
    const pid = await numericProjectId(projectId)
    const tool = LIST_TOOLS[kind]
    if (!tool) throw new Error(`不支持的资产类型：${kind}`)
    const size = Math.min(Math.max(1, Number(pageSize) || 50), 50)
    const data = await call(tool, { project_id: pid, page, page_size: size })
    return {
      items: (Array.isArray(data?.items) ? data.items : []).map((item) => normalizeEntity(kind, item, projectId)),
      total: Number.isInteger(data?.total) ? data.total : null,
      page,
      pageSize: size,
      complete: (Array.isArray(data?.items) ? data.items.length : 0) < size || !Number.isInteger(data?.total) || page * size >= data.total,
    }
  }

  async function listRequirementIds(projectId) {
    const ids = []
    let page = 1
    for (;;) {
      const data = await listEntities(projectId, 'requirement', { page, pageSize: 50 })
      for (const item of data.items) ids.push(String(item.id))
      if (data.complete || data.items.length < 50 || page >= 200) break
      page += 1
    }
    return ids
  }

  async function getRequirementCases(projectId, requirementId, { pageSize = 100 } = {}) {
    const pid = await numericProjectId(projectId)
    const reqId = intOrNull(requirementId)
    const limit = Math.min(Math.max(1, Number(pageSize) || 100), 100)
    const items = []
    let offset = 0
    let complete = true
    let total = null
    for (;;) {
      const data = await call('get_requirement_cases', { project_id: pid, req_id: reqId, offset, limit })
      const batch = Array.isArray(data?.items) ? data.items : []
      items.push(...batch)
      if (Number.isInteger(data?.total)) total = data.total
      if (data?.truncated === false || batch.length < limit || offset + batch.length >= (total ?? Infinity)) break
      offset += batch.length
      if (offset >= 10000) { complete = false; break }
    }
    return { items, total, complete, offset }
  }

  async function linkCases(projectId, requirementId, caseIds = []) {
    const pid = await numericProjectId(projectId)
    const ids = caseIds.map(intOrNull)
    if (ids.some((id) => id === null)) throw new Error('用例 ID 必须是平台整数 ID')
    if (!ids.length) return { linked: 0, skipped: 0 }
    return call('link_requirement_cases', { project_id: pid, req_id: intOrNull(requirementId), case_ids: ids })
  }

  async function unlinkCase(projectId, requirementId, caseId) {
    const pid = await numericProjectId(projectId)
    try {
      return await call('unlink_requirement_case', { project_id: pid, req_id: intOrNull(requirementId), case_id: intOrNull(caseId) })
    } catch (error) {
      // 平台对“未关联”返回 404；视为已解除（幂等）
      if (String(error?.message || '').includes('关联不存在')) return { deleted: 0, alreadyAbsent: true }
      throw error
    }
  }

  async function listPlanCases(projectId, planId) {
    const pid = await numericProjectId(projectId)
    const items = []
    let offset = 0
    for (let page = 0; page < 200; page += 1) {
      const data = await call('list_plan_cases', { project_id: pid, plan_id: intOrNull(planId), offset, limit: 100 })
      const batch = Array.isArray(data?.items) ? data.items : []
      items.push(...batch)
      if (data?.truncated === false || batch.length < 100) break
      offset += batch.length
    }
    return items
  }

  async function addPlanCases(projectId, planId, caseIds = []) {
    const pid = await numericProjectId(projectId)
    return call('add_plan_cases', { project_id: pid, plan_id: intOrNull(planId), case_ids: caseIds.map(intOrNull) })
  }

  async function removePlanCase(projectId, planId, planCaseId) {
    const pid = await numericProjectId(projectId)
    try {
      return await call('remove_plan_case', { project_id: pid, plan_id: intOrNull(planId), plan_case_id: intOrNull(planCaseId) })
    } catch (error) {
      if (String(error?.message || '').includes('计划用例不存在')) return { deleted: 0, alreadyAbsent: true }
      throw error
    }
  }

  async function updatePlanCaseDeps(projectId, planId, planCaseId, dependsOn) {
    const pid = await numericProjectId(projectId)
    return call('update_plan_case', {
      project_id: pid,
      plan_id: intOrNull(planId),
      plan_case_id: intOrNull(planCaseId),
      depends_on: (dependsOn || []).map(intOrNull),
    })
  }

  async function getEntity(projectId, kind, id) {
    const pid = await numericProjectId(projectId)
    const tool = DETAIL_TOOLS[kind]
    if (!tool) throw new Error(`不支持的资产类型：${kind}`)
    const param = ID_PARAMS[kind]
    const data = await call(tool, { project_id: pid, [param]: intOrNull(id) })
    const entity = normalizeEntity(kind, data, projectId)
    if (kind === 'test-plan') {
      const items = []
      let offset = 0
      let complete = true
      for (let page = 0; page < 200; page += 1) {
        const cases = await call('list_plan_cases', { project_id: pid, plan_id: intOrNull(id), offset, limit: 100 })
        const batch = Array.isArray(cases?.items) ? cases.items : []
        items.push(...batch)
        if (cases?.truncated === false || batch.length < 100) break
        offset += batch.length
        if (page === 199) complete = false
      }
      entity.planCases = items.map((item, index) => ({
        planCaseId: str(item?.plan_case_id ?? item?.id),
        caseId: str(item?.case_id),
        sortOrder: Number.isInteger(item?.sort_order) ? item.sort_order : index + 1,
        dependsOn: Array.isArray(item?.depends_on) ? item.depends_on.map(String) : [],
        executorType: item?.executor_type === undefined ? null : item.executor_type,
      }))
      entity.planCasesComplete = complete
      entity.caseRefs = entity.planCases.map((item) => ({
        order: item.sortOrder,
        caseId: item.caseId,
        dependsOn: item.dependsOn,
      }))
    }
    return entity
  }

  function requireCatalog(entity) {
    const value = intOrNull(entity?.catalogId)
    if (value === null) throw new Error('catalogId 必须是平台整数目录 ID')
    return value
  }

  function optionalText(value) {
    return value === undefined ? undefined : (value === null ? null : String(value))
  }

  async function createEntity(projectId, kind, entity) {
    const pid = await numericProjectId(projectId)
    if (kind === 'requirement') {
      const created = await call('create_requirement', {
        project_id: pid,
        catalog_id: requireCatalog(entity),
        title: entity.title || '未命名需求',
        description: optionalText(entity.description) || null,
        priority: entity.priority || 'P2',
      })
      const createdId = str(created?.id)
      if (!createdId) throw new Error('create_requirement 未返回 id')
      let merged = { ...created }
      const completedSteps = []
      try {
        if (entity.acceptanceCriteria) {
          const updated = await call('update_requirement', {
            project_id: pid,
            req_id: intOrNull(createdId),
            acceptance_criteria: String(entity.acceptanceCriteria),
          })
          merged = { ...merged, ...(updated || {}) }
          completedSteps.push('acceptance_criteria')
        }
        return await getEntity(projectId, kind, createdId)
      } catch (error) {
        throw new CreatePartialError('需求已创建，但后处理失败', {
          kind,
          createdId,
          created: normalizeEntity(kind, merged, projectId),
          cause: error,
          completedSteps,
        })
      }
    }
    if (kind === 'testcase') {
      const created = await call('create_case', {
        project_id: pid,
        catalog_id: requireCatalog(entity),
        title: entity.title || '未命名用例',
        type: entity.type || 'functional',
        priority: entity.priority || 'P2',
        precondition: optionalText(entity.precondition) ?? null,
        steps: Array.isArray(entity.steps) && entity.steps.length ? entity.steps : null,
        executable_spec: entity.executableSpec ?? null,
        test_data: entity.testData ?? null,
      })
      const createdId = str(created?.id)
      if (!createdId) throw new Error('create_case 未返回 id')
      try {
        return await getEntity(projectId, kind, createdId)
      } catch (error) {
        throw new CreatePartialError('用例已创建，但回读失败', {
          kind,
          createdId,
          created: normalizeEntity(kind, created, projectId),
          cause: error,
        })
      }
    }
    if (kind === 'test-plan') {
      const created = await call('create_plan', {
        project_id: pid,
        name: entity.name || '未命名计划',
        description: optionalText(entity.description) ?? null,
        executor_type: entity.executorType || 'manual',
        environment: optionalText(entity.environment) ?? null,
      })
      const createdId = str(created?.id)
      if (!createdId) throw new Error('create_plan 未返回 id')
      let merged = { ...created }
      const completedSteps = []
      try {
        const patch = {}
        if (entity.planKind) patch.kind = entity.planKind
        if (entity.qualityGate) patch.quality_gate = entity.qualityGate
        if (entity.entryCriteria) patch.entry_criteria = String(entity.entryCriteria)
        if (entity.exitCriteria) patch.exit_criteria = String(entity.exitCriteria)
        if (entity.status) patch.status = String(entity.status)
        if (Object.keys(patch).length) {
          const updated = await call('update_plan', { project_id: pid, plan_id: intOrNull(createdId), ...patch })
          merged = { ...merged, ...(updated || {}) }
          completedSteps.push('plan_fields')
        }
        return await getEntity(projectId, kind, createdId)
      } catch (error) {
        throw new CreatePartialError('计划已创建，但后处理失败', {
          kind,
          createdId,
          created: normalizeEntity(kind, merged, projectId),
          cause: error,
          completedSteps,
        })
      }
    }
    if (kind === 'defect') {
      const created = await call('create_defect', {
        project_id: pid,
        title: entity.title || '未命名缺陷',
        description: optionalText(entity.description) ?? null,
        severity: entity.severity || 'general',
        priority: entity.priority || 'P2',
        case_id: intOrNull(entity.caseId),
        requirement_id: intOrNull(entity.requirementId),
      })
      const createdId = str(created?.id)
      if (!createdId) throw new Error('create_defect 未返回 id')
      let merged = { ...created }
      const completedSteps = []
      try {
        const patch = {}
        if (entity.planId) patch.plan_id = intOrNull(entity.planId)
        if (Object.keys(patch).length) {
          const updated = await call('update_defect', { project_id: pid, defect_id: intOrNull(createdId), ...patch })
          merged = { ...merged, ...(updated || {}) }
          completedSteps.push('plan_id')
        }
        if (entity.status && String(entity.status) !== String(created.status || 'new')) {
          const updated = await call('update_defect_status', {
            project_id: pid,
            defect_id: intOrNull(createdId),
            status: String(entity.status),
            ...(entity.statusComment ? { comment: String(entity.statusComment) } : {}),
          })
          merged = { ...merged, ...(updated || {}) }
          completedSteps.push('status')
        }
        return await getEntity(projectId, kind, createdId)
      } catch (error) {
        throw new CreatePartialError('缺陷已创建，但后处理失败', {
          kind,
          createdId,
          created: normalizeEntity(kind, merged, projectId),
          cause: error,
          completedSteps,
        })
      }
    }
    throw new Error(`不支持的创建类型：${kind}`)
  }

  async function updateEntity(projectId, kind, id, patch = {}) {
    const pid = await numericProjectId(projectId)
    if (kind === 'requirement') {
      const args = { project_id: pid, req_id: intOrNull(id) }
      if (patch.title !== undefined) args.title = String(patch.title)
      if (patch.description !== undefined) args.description = String(patch.description)
      if (patch.acceptanceCriteria !== undefined) args.acceptance_criteria = String(patch.acceptanceCriteria)
      if (patch.priority !== undefined) args.priority = String(patch.priority)
      if (patch.catalogId !== undefined) args.catalog_id = requireCatalog(patch)
      if (Object.keys(args).length > 2) await call('update_requirement', args)
      return getEntity(projectId, kind, id)
    }
    if (kind === 'testcase') {
      const args = { project_id: pid, case_id: intOrNull(id) }
      if (patch.title !== undefined) args.title = String(patch.title)
      if (patch.type !== undefined) args.type = String(patch.type)
      if (patch.priority !== undefined) args.priority = String(patch.priority)
      if (patch.precondition !== undefined) args.precondition = String(patch.precondition)
      if (patch.steps !== undefined) args.steps = patch.steps
      if (patch.executableSpec !== undefined) args.executable_spec = patch.executableSpec
      if (patch.testData !== undefined) args.test_data = patch.testData
      if (patch.catalogId !== undefined) args.catalog_id = requireCatalog(patch)
      if (Object.keys(args).length > 2) await call('update_case', args)
      return getEntity(projectId, kind, id)
    }
    if (kind === 'test-plan') {
      const args = { project_id: pid, plan_id: intOrNull(id) }
      if (patch.name !== undefined) args.name = String(patch.name)
      if (patch.description !== undefined) args.description = String(patch.description)
      if (patch.executorType !== undefined && patch.executorType !== '') args.executor_type = String(patch.executorType)
      if (patch.environment !== undefined) args.environment = String(patch.environment)
      if (patch.status !== undefined) args.status = String(patch.status)
      if (patch.planKind !== undefined && patch.planKind !== '') args.kind = String(patch.planKind)
      if (patch.qualityGate !== undefined) args.quality_gate = patch.qualityGate === null ? { rules: [] } : patch.qualityGate
      if (patch.entryCriteria !== undefined) args.entry_criteria = String(patch.entryCriteria)
      if (patch.exitCriteria !== undefined) args.exit_criteria = String(patch.exitCriteria)
      if (Object.keys(args).length > 2) await call('update_plan', args)
      return getEntity(projectId, kind, id)
    }
    if (kind === 'defect') {
      const args = { project_id: pid, defect_id: intOrNull(id) }
      if (patch.title !== undefined) args.title = String(patch.title)
      if (patch.description !== undefined) args.description = String(patch.description)
      if (patch.severity !== undefined) args.severity = String(patch.severity)
      if (patch.priority !== undefined) args.priority = String(patch.priority)
      if (patch.caseId !== undefined) args.case_id = intOrNull(patch.caseId)
      if (patch.planId !== undefined) args.plan_id = intOrNull(patch.planId)
      if (patch.requirementId !== undefined) args.requirement_id = intOrNull(patch.requirementId)
      if (Object.keys(args).length > 2) await call('update_defect', args)
      return getEntity(projectId, kind, id)
    }
    throw new Error(`不支持的更新类型：${kind}`)
  }

  async function updateStatus(projectId, kind, id, status, extra = {}) {
    const pid = await numericProjectId(projectId)
    if (kind === 'requirement') {
      await call('update_requirement_status', { project_id: pid, req_id: intOrNull(id), status: String(status), ...(extra.remark ? { remark: String(extra.remark) } : {}) })
      return getEntity(projectId, kind, id)
    }
    if (kind === 'testcase') {
      await call('update_case_status', { project_id: pid, case_id: intOrNull(id), status: String(status) })
      return getEntity(projectId, kind, id)
    }
    if (kind === 'test-plan') {
      await call('update_plan', { project_id: pid, plan_id: intOrNull(id), status: String(status) })
      return getEntity(projectId, kind, id)
    }
    if (kind === 'defect') {
      await call('update_defect_status', { project_id: pid, defect_id: intOrNull(id), status: String(status), ...(extra.comment ? { comment: String(extra.comment) } : {}) })
      return getEntity(projectId, kind, id)
    }
    throw new Error(`不支持的状态更新类型：${kind}`)
  }

  async function linkRequirementCases(projectId, requirementId, caseIds) {
    const pid = await numericProjectId(projectId)
    const ids = caseIds.map(intOrNull).filter((id) => id !== null)
    if (!ids.length) return
    await call('link_requirement_cases', { project_id: pid, req_id: intOrNull(requirementId), case_ids: ids })
  }

  async function unlinkRequirementCase(projectId, requirementId, caseId) {
    const pid = await numericProjectId(projectId)
    await call('unlink_requirement_case', { project_id: pid, req_id: intOrNull(requirementId), case_id: intOrNull(caseId) })
  }

  async function listCaseRequirementIds(projectId) {
    const pid = await numericProjectId(projectId)
    const map = new Map()
    let page = 1
    for (;;) {
      const data = await call('list_requirements', { project_id: pid, page, page_size: 50 })
      const items = Array.isArray(data?.items) ? data.items : []
      for (const item of items) {
        const links = await call('get_requirement_cases', { project_id: pid, req_id: item.id, offset: 0, limit: 100 })
        for (const link of Array.isArray(links?.items) ? links.items : []) {
          const caseId = str(link.case_id ?? link.id)
          if (!map.has(caseId)) map.set(caseId, new Set())
          map.get(caseId).add(str(item.id))
        }
      }
      if (items.length < 50) break
      page += 1
    }
    return map
  }

  function dispose() {
    projectCache.clear('dispose')
    projectsCache = null
    projectsCachedAt = 0
  }

  return {
    kind: 'testcasegen',
    displayName: 'TestCaseGen',
    capabilities: {
      create: new Set(['requirement', 'testcase', 'test-plan', 'defect']),
      update: new Set(['requirement', 'testcase', 'test-plan', 'defect']),
      status: new Set(['requirement', 'testcase', 'test-plan', 'defect']),
      delete: new Set(),
      archive: new Set(),
      catalogCreate: new Set(['requirement', 'testcase']),
      catalogMove: new Set(['requirement', 'testcase']),
      catalogRenameOrDelete: false,
      reportUpdate: false,
      updatedAt: true,
      incremental: false,
      optimisticConcurrency: false,
      idempotencyKey: false,
      links: true,
      comments: true,
    },
    listProjects,
    resolveProject,
    withClient,
    dispose,
    projectCacheStats: () => projectCache.stats(),
    listCatalogs,
    listEntities,
    listRequirementIds,
    getRequirementCases,
    linkCases,
    unlinkCase,
    listPlanCases,
    addPlanCases,
    removePlanCase,
    updatePlanCaseDeps,
    getEntity,
    createEntity,
    updateEntity,
    updateStatus,
    linkRequirementCases,
    unlinkRequirementCase,
    listCaseRequirementIds,
    listProjectEntities: listEntities,
    normalizeEntity,
  }
}

export { KIND_META }
