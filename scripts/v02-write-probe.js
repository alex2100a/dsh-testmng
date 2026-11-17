#!/usr/bin/env node
/**
 * tmsync v0.2 P0 写语义探针。
 *
 * 只使用专用测试项目（默认 TMSYNC_P0 / id 11），不碰生产/E2E 数据。
 * 覆盖：链接、计划、缺陷、状态流转、分页、Git 安全检查。
 *
 * 用法：
 *   node scripts/v02-write-probe.js [--deep] [--out <file>]
 *
 * 注意：会创建真实测试数据（计划/缺陷/链接；--deep 会创建 101 条用例和分页计划）。
 * 平台无 delete 工具，测试数据会保留在专用项目。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createMcpClient } from '../server/mcp.js'
import { mapLimit } from '../server/files.js'

const execFileAsync = promisify(execFile)
const HOME = process.env.USERPROFILE || process.env.HOME || ''
const CONFIG_CANDIDATES = [
  process.env.TMSYNC_CONFIG,
  path.join(HOME, '.dsh', 'tmsync', 'config.json'),
  path.join(HOME, '.dsh', 'dsh-testcat', 'config.json'),
].filter(Boolean)

const PROJECT_CODE = 'TMSYNC_P0'
const PAGE_CODE = 'TMSYNC_PAGE'

function parseArgs(argv) {
  const out = { deep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--deep') out.deep = true
    else if (arg === '--out') out.out = argv[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

async function loadConfig() {
  for (const file of CONFIG_CANDIDATES) {
    if (!file) continue
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'))
      const platform = raw.platform && typeof raw.platform === 'object' ? raw.platform : raw
      return {
        source: file,
        mcpUrl: process.env.TMSYNC_MCP_URL || platform.mcpUrl || raw.mcpUrl,
        token: process.env.TMSYNC_MCP_TOKEN || platform.token || raw.token,
      }
    } catch {
      // next
    }
  }
  throw new Error('未找到连接配置')
}

function ms(started) {
  return Date.now() - started
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]))
}

export async function runProbe({ deep = false, call, log = () => {} } = {}) {
  const facts = {
    generatedAt: new Date().toISOString(),
    deep,
    project: null,
    links: {},
    plans: {},
    defects: {},
    pagination: {},
    git: {},
    errors: [],
  }

  async function attempt(scope, label, fn) {
    const started = Date.now()
    try {
      const data = await fn()
      const entry = { ok: true, elapsedMs: ms(started), data }
      log(`  ✓ ${scope}/${label} (${entry.elapsedMs}ms)`)
      return entry
    } catch (error) {
      const entry = {
        ok: false,
        elapsedMs: ms(started),
        error: { message: error?.message || String(error), status: error?.status, code: error?.code, hint: error?.hint },
      }
      log(`  ✗ ${scope}/${label}: ${entry.error.message}`)
      facts.errors.push({ scope, label, ...entry.error })
      return entry
    }
  }

  // ---------- setup ----------
  log('setup: projects/catalogs')
  const projectsPage = await call('list_projects', { page: 1, page_size: 50 })
  const projects = Array.isArray(projectsPage?.items) ? projectsPage.items : []
  let project = projects.find((item) => item.code === PROJECT_CODE)
  if (!project) {
    project = await call('create_project', {
      name: 'TMSYNC P0 本地同步验证',
      code: PROJECT_CODE,
      description: 'tmsync write probe; safe to keep',
    })
  }
  const pid = project.id
  facts.project = { id: pid, public_id: project.public_id, code: project.code, name: project.name }

  const reqTree = await call('get_requirement_catalog_tree', { project_id: pid })
  let reqCatalog = (reqTree.items || []).find((item) => item.name === 'tmsync需求')
  if (!reqCatalog) reqCatalog = await call('create_requirement_catalog', { project_id: pid, name: 'tmsync需求' })
  const caseCatalogs = await call('list_case_catalogs', { project_id: pid })
  let caseCatalog = (caseCatalogs.items || []).find((item) => item.name === 'tmsync用例')
  if (!caseCatalog) caseCatalog = await call('create_case_catalog', { project_id: pid, name: 'tmsync用例' })

  const reqPage = await call('list_requirements', { project_id: pid, page: 1, page_size: 50 })
  const requirements = Array.isArray(reqPage?.items) ? reqPage.items : []
  const casePage = await call('list_cases', { project_id: pid, page: 1, page_size: 50 })
  const cases = Array.isArray(casePage?.items) ? casePage.items : []
  const reqA = requirements.find((item) => item.code === 'REQ-0002') || requirements[0]
  const reqB = requirements.find((item) => item.code === 'REQ-0001' && item.id !== reqA?.id) || requirements[1] || reqA
  const caseA = cases.find((item) => item.code === 'TC-0001') || cases[0]
  const caseB = cases.find((item) => item.code === 'TC-0002' && item.id !== caseA?.id) || cases[1] || caseA
  if (!reqA || !caseA) throw new Error('项目缺少需求/用例，无法做写探针')
  facts.project.requirementA = { id: reqA.id, code: reqA.code }
  facts.project.requirementB = { id: reqB.id, code: reqB.code }
  facts.project.caseA = { id: caseA.id, code: caseA.code }
  facts.project.caseB = { id: caseB.id, code: caseB.code }

  // ---------- links ----------
  log('links: read/link/unlink/idempotency')
  const links = facts.links
  links.before = await call('get_requirement_cases', { project_id: pid, req_id: reqA.id, offset: 0, limit: 100 })
  links.caseA_before = pick(await call('get_case', { project_id: pid, case_id: caseA.id }), ['id', 'code', 'version', 'updated_at'])
  links.reqA_before = pick(await call('get_requirement', { project_id: pid, req_id: reqA.id }), ['id', 'code', 'version', 'updated_at'])

  links.linkA = await attempt('links', 'link A→reqA (1st)', () => call('link_requirement_cases', { project_id: pid, req_id: reqA.id, case_ids: [caseA.id] }))
  links.linkAAgain = await attempt('links', 'link A→reqA (2nd/idempotent)', () => call('link_requirement_cases', { project_id: pid, req_id: reqA.id, case_ids: [caseA.id] }))
  links.unlinkNotLinked = await attempt('links', 'unlink A from reqB (not linked)', () => call('unlink_requirement_case', { project_id: pid, req_id: reqB.id, case_id: caseA.id }))

  const reqBCases = await call('get_requirement_cases', { project_id: pid, req_id: reqB.id, offset: 0, limit: 100 })
  const reqBLinked = new Set((reqBCases.items || []).map((item) => String(item.case_id)))
  const unlinkedCandidate = [caseA, caseB, ...cases].find((item) => !reqBLinked.has(String(item.id)))
  links.trueUnlinkNotLinked = unlinkedCandidate
    ? await attempt('links', `unlink ${unlinkedCandidate.code} from reqB (verified not linked)`, () => call('unlink_requirement_case', { project_id: pid, req_id: reqB.id, case_id: unlinkedCandidate.id }))
    : { skipped: true, reason: 'no unlinked candidate' }

  links.after = await call('get_requirement_cases', { project_id: pid, req_id: reqA.id, offset: 0, limit: 100 })
  links.caseA_after = pick(await call('get_case', { project_id: pid, case_id: caseA.id }), ['id', 'code', 'version', 'updated_at'])
  links.reqA_after = pick(await call('get_requirement', { project_id: pid, req_id: reqA.id }), ['id', 'code', 'version', 'updated_at'])
  links.schema = await call('get_requirement_cases', { project_id: pid, req_id: reqA.id, offset: 0, limit: 1 })
  links.pageShape = pick(links.schema, ['total', 'page', 'page_size', 'truncated', 'next_offset'])
  facts.links.requirementCasesPagination = {
    offsetLimitSupported: true,
    total: links.schema?.total,
    returned: Array.isArray(links.schema?.items) ? links.schema.items.length : null,
  }

  // ---------- plans ----------
  log('plans: create/update/status/cases/deps/archive')
  const plans = facts.plans
  const planName = `tmsync v0.2 写探针计划 ${Date.now()}`
  plans.created = await attempt('plans', 'create', () => call('create_plan', {
    project_id: pid,
    name: planName,
    description: 'v0.2 write probe',
    executor_type: 'manual',
    environment: 'test',
  }))
  if (!plans.created.ok) throw new Error('create_plan 失败，后续计划探针中止')
  const planId = plans.created.data.id
  plans.planId = planId
  plans.createResponse = pick(plans.created.data, ['id', 'name', 'status', 'kind', 'updated_at'])
  plans.defaults = pick(await call('get_plan', { project_id: pid, plan_id: planId }), ['id', 'name', 'status', 'kind', 'executor_type', 'environment', 'quality_gate', 'entry_criteria', 'exit_criteria', 'updated_at'])

  const updateFields = {}
  updateFields.update1 = await attempt('plans', 'update fields', async () => {
    await call('update_plan', {
      project_id: pid,
      plan_id: planId,
      name: `${planName}（更新）`,
      description: 'updated description',
      kind: 'regression',
      quality_gate: { rules: [{ metric: 'pass_rate', operator: '>=', value: 95 }] },
      entry_criteria: '冒烟通过',
      exit_criteria: '无 P0/P1 缺陷',
    })
    return pick(await call('get_plan', { project_id: pid, plan_id: planId }), ['name', 'description', 'kind', 'quality_gate', 'entry_criteria', 'exit_criteria', 'status', 'updated_at'])
  })
  plans.update1 = updateFields.update1

  plans.status = {}
  for (const status of ['active', 'archived', 'active']) {
    plans.status[status] = await attempt('plans', `status→${status}`, async () => {
      await call('update_plan', { project_id: pid, plan_id: planId, status })
      return pick(await call('get_plan', { project_id: pid, plan_id: planId }), ['status', 'updated_at'])
    })
  }

  plans.addCases = await attempt('plans', 'add cases [A,B]', () => call('add_plan_cases', { project_id: pid, plan_id: planId, case_ids: [caseA.id, caseB.id] }))
  plans.listAfterAdd = await attempt('plans', 'list cases', () => call('list_plan_cases', { project_id: pid, plan_id: planId, offset: 0, limit: 100 }))
  plans.afterAddPlan = pick(await call('get_plan', { project_id: pid, plan_id: planId }), ['case_count', 'updated_at'])
  plans.duplicateAdd = await attempt('plans', 'add same cases again', () => call('add_plan_cases', { project_id: pid, plan_id: planId, case_ids: [caseA.id, caseB.id] }))
  plans.listAfterDuplicate = await attempt('plans', 'list cases after duplicate add', () => call('list_plan_cases', { project_id: pid, plan_id: planId, offset: 0, limit: 100 }))

  const planCases = Array.isArray(plans.listAfterAdd.data?.items) ? plans.listAfterAdd.data.items : []
  const planCaseA = planCases.find((item) => String(item.case_id) === String(caseA.id))
  const planCaseB = planCases.find((item) => String(item.case_id) === String(caseB.id))
  plans.planCaseA = planCaseA ? pick(planCaseA, ['plan_case_id', 'case_id', 'sort_order', 'depends_on', 'executor_type']) : null
  plans.planCaseB = planCaseB ? pick(planCaseB, ['plan_case_id', 'case_id', 'sort_order', 'depends_on', 'executor_type']) : null

  if (planCaseB) {
    plans.depsSet = await attempt('plans', 'set deps B→[A]', async () => {
      await call('update_plan_case', { project_id: pid, plan_id: planId, plan_case_id: planCaseB.plan_case_id, depends_on: [caseA.id] })
      return (await call('list_plan_cases', { project_id: pid, plan_id: planId, offset: 0, limit: 100 })).items.find((item) => String(item.case_id) === String(caseB.id))?.depends_on
    })
    plans.depsClear = await attempt('plans', 'clear deps B', async () => {
      await call('update_plan_case', { project_id: pid, plan_id: planId, plan_case_id: planCaseB.plan_case_id, depends_on: [] })
      return (await call('list_plan_cases', { project_id: pid, plan_id: planId, offset: 0, limit: 100 })).items.find((item) => String(item.case_id) === String(caseB.id))?.depends_on
    })
    plans.removeB = await attempt('plans', 'remove plan case B', async () => {
      await call('remove_plan_case', { project_id: pid, plan_id: planId, plan_case_id: planCaseB.plan_case_id })
      return (await call('list_plan_cases', { project_id: pid, plan_id: planId, offset: 0, limit: 100 })).items.map((item) => item.case_id)
    })
    plans.removeAgain = await attempt('plans', 'remove plan case B again', () => call('remove_plan_case', { project_id: pid, plan_id: planId, plan_case_id: planCaseB.plan_case_id }))
    plans.reAddB = await attempt('plans', 're-add case B', () => call('add_plan_cases', { project_id: pid, plan_id: planId, case_ids: [caseB.id] }))
  }

  plans.page1 = await attempt('plans', 'list cases offset=0 limit=1', () => call('list_plan_cases', { project_id: pid, plan_id: planId, offset: 0, limit: 1 }))
  plans.page2 = await attempt('plans', 'list cases offset=1 limit=1', () => call('list_plan_cases', { project_id: pid, plan_id: planId, offset: 1, limit: 1 }))
  plans.pageShape = {
    page1: pick(plans.page1.data || {}, ['total', 'truncated', 'next_offset']),
    page1Count: plans.page1.data?.items?.length,
    page2Count: plans.page2.data?.items?.length,
  }

  plans.archivedVisibility = await (async () => {
    await call('update_plan', { project_id: pid, plan_id: planId, status: 'archived' })
    const found = []
    for (let page = 1; page <= 5; page += 1) {
      const data = await call('list_plans', { project_id: pid, page, page_size: 50 })
      const items = Array.isArray(data?.items) ? data.items : []
      if (items.some((item) => item.id === planId)) found.push(page)
      if (items.length < 50) break
    }
    await call('update_plan', { project_id: pid, plan_id: planId, status: 'active' })
    return { foundInPages: found, listedWhenArchived: found.length > 0 }
  })()
  plans.unarchive = await attempt('plans', 'archived→active', () => call('update_plan', { project_id: pid, plan_id: planId, status: 'active' }))

  // ---------- deep pagination (separate project) ----------
  if (deep) {
    log('pagination: 101 plan cases (separate project)')
    const pageProject = projects.find((item) => item.code === PAGE_CODE)
      || await call('create_project', { name: 'TMSYNC PAGE 分页验证', code: PAGE_CODE, description: 'tmsync pagination probe; safe to keep' })
    const pagePid = pageProject.id
    facts.pagination.project = { id: pagePid, public_id: pageProject.public_id, code: pageProject.code }
    const pageCatalogs = await call('list_case_catalogs', { project_id: pagePid })
    let pageCatalog = (pageCatalogs.items || []).find((item) => item.name === 'pagination')
    if (!pageCatalog) pageCatalog = await call('create_case_catalog', { project_id: pagePid, name: 'pagination' })

    const caseIds = []
    const created = await mapLimit(Array.from({ length: 101 }, (_, i) => i + 1), 2, async (index) => {
      const item = await attempt('pagination', `create case ${index}`, () => call('create_case', {
        project_id: pagePid,
        catalog_id: pageCatalog.id,
        title: `PAGE-${String(index).padStart(3, '0')}`,
        type: 'functional',
        priority: 'P2',
      }))
      if (item.ok) caseIds.push(item.data.id)
      return item.ok
    })
    facts.pagination.casesCreated = caseIds.length
    facts.pagination.caseFailures = created.filter((ok) => !ok).length

    const pagePlan = await call('create_plan', { project_id: pagePid, name: `分页探针计划 ${Date.now()}`, executor_type: 'manual' })
    facts.pagination.planId = pagePlan.id
    facts.pagination.addBatch = await attempt('pagination', 'add 101 cases in one batch', () => call('add_plan_cases', { project_id: pagePid, plan_id: pagePlan.id, case_ids: caseIds }))
    if (!facts.pagination.addBatch.ok && caseIds.length) {
      facts.pagination.addChunks = []
      for (let i = 0; i < caseIds.length; i += 50) {
        facts.pagination.addChunks.push(await attempt('pagination', `add chunk ${i}`, () => call('add_plan_cases', { project_id: pagePid, plan_id: pagePlan.id, case_ids: caseIds.slice(i, i + 50) })))
      }
    }
    const page0 = await call('list_plan_cases', { project_id: pagePid, plan_id: pagePlan.id, offset: 0, limit: 100 })
    const page100 = await call('list_plan_cases', { project_id: pagePid, plan_id: pagePlan.id, offset: 100, limit: 100 })
    facts.pagination.page0 = { count: page0?.items?.length, total: page0?.total, truncated: page0?.truncated, next_offset: page0?.next_offset }
    facts.pagination.page100 = { count: page100?.items?.length, total: page100?.total, truncated: page100?.truncated, next_offset: page100?.next_offset }
    facts.pagination.idsUnique = new Set([...(page0?.items || []), ...(page100?.items || [])].map((item) => item.plan_case_id)).size

    // link pagination: one requirement linked to 101 cases
    const pageReqTree = await call('get_requirement_catalog_tree', { project_id: pagePid })
    let pageReqCatalog = (pageReqTree.items || []).find((item) => item.name === 'pagination')
    if (!pageReqCatalog) pageReqCatalog = await call('create_requirement_catalog', { project_id: pagePid, name: 'pagination' })
    let pageReq = (await call('list_requirements', { project_id: pagePid, page: 1, page_size: 50 })).items?.find((item) => item.title === 'PAGE-REQ')
    if (!pageReq) pageReq = await call('create_requirement', { project_id: pagePid, catalog_id: pageReqCatalog.id, title: 'PAGE-REQ', description: 'pagination', priority: 'P2' })
    facts.pagination.requirementId = pageReq.id
    if (caseIds.length) {
      facts.pagination.linkAll = await attempt('pagination', `link ${caseIds.length} cases to requirement`, () => call('link_requirement_cases', { project_id: pagePid, req_id: pageReq.id, case_ids: caseIds }))
      const linkPage0 = await call('get_requirement_cases', { project_id: pagePid, req_id: pageReq.id, offset: 0, limit: 100 })
      const linkPage100 = await call('get_requirement_cases', { project_id: pagePid, req_id: pageReq.id, offset: 100, limit: 100 })
      facts.pagination.linksPage0 = { count: linkPage0?.items?.length, total: linkPage0?.total, truncated: linkPage0?.truncated, next_offset: linkPage0?.next_offset }
      facts.pagination.linksPage100 = { count: linkPage100?.items?.length, total: linkPage100?.total, truncated: linkPage100?.truncated, next_offset: linkPage100?.next_offset }
    }
  }

  // ---------- defects ----------
  log('defects: create/update/status/reopen/rejected/associations')
  const defects = facts.defects
  const defectName = `tmsync v0.2 写探针缺陷 ${Date.now()}`
  defects.created = await attempt('defects', 'create', () => call('create_defect', {
    project_id: pid,
    title: defectName,
    description: 'v0.2 write probe',
    severity: 'major',
    priority: 'P2',
    case_id: caseA.id,
    requirement_id: reqA.id,
  }))
  if (!defects.created.ok) throw new Error('create_defect 失败，后续缺陷探针中止')
  const defectId = defects.created.data.id
  defects.defectId = defectId
  defects.createResponse = pick(defects.created.data, ['id', 'code', 'status', 'severity', 'priority', 'updated_at'])
  defects.defaults = pick(await call('get_defect', { project_id: pid, defect_id: defectId }), ['id', 'code', 'status', 'severity', 'priority', 'assignee_id', 'assignee_name', 'case_id', 'plan_id', 'requirement_id', 'updated_at'])
  defects.hasAllowedTransitions = Object.prototype.hasOwnProperty.call(await call('get_defect', { project_id: pid, defect_id: defectId }), 'allowed_transitions')

  defects.update1 = await attempt('defects', 'update fields + plan_id', async () => {
    await call('update_defect', {
      project_id: pid,
      defect_id: defectId,
      title: `${defectName}（更新）`,
      description: 'updated description',
      severity: 'critical',
      priority: 'P1',
      plan_id: planId,
    })
    return pick(await call('get_defect', { project_id: pid, defect_id: defectId }), ['title', 'description', 'severity', 'priority', 'plan_id', 'updated_at'])
  })

  defects.status = {}
  for (const status of ['confirmed', 'fixing', 'fixed', 'closed']) {
    defects.status[status] = await attempt('defects', `status→${status}`, async () => {
      await call('update_defect_status', { project_id: pid, defect_id: defectId, status })
      return pick(await call('get_defect', { project_id: pid, defect_id: defectId }), ['status', 'updated_at'])
    })
  }
  defects.reopen = await attempt('defects', 'closed→reopened (comment)', async () => {
    await call('update_defect_status', { project_id: pid, defect_id: defectId, status: 'reopened', comment: 'v0.2 probe reopen' })
    return pick(await call('get_defect', { project_id: pid, defect_id: defectId }), ['status', 'updated_at'])
  })

  defects.rejectedNoComment = await attempt('defects', 'rejected without comment', async () => {
    await call('update_defect_status', { project_id: pid, defect_id: defectId, status: 'rejected' })
    return pick(await call('get_defect', { project_id: pid, defect_id: defectId }), ['status', 'updated_at'])
  })
  defects.rejectedWithComment = await attempt('defects', 'rejected with comment', async () => {
    await call('update_defect_status', { project_id: pid, defect_id: defectId, status: 'rejected', comment: 'v0.2 probe reject' })
    return pick(await call('get_defect', { project_id: pid, defect_id: defectId }), ['status', 'updated_at'])
  })

  // second defect: rejected from new/confirmed + association clearing
  const defect2Name = `tmsync v0.2 驳回探针缺陷 ${Date.now()}`
  defects.created2 = await attempt('defects', 'create defect2', () => call('create_defect', {
    project_id: pid,
    title: defect2Name,
    description: 'rejected probe',
    severity: 'minor',
    priority: 'P3',
    case_id: caseB.id,
    requirement_id: reqB.id,
  }))
  let defect2Id = defects.created2.ok ? defects.created2.data.id : null
  defects.defect2Id = defect2Id
  if (defect2Id) {
    defects.rejectedNoCommentNew = await attempt('defects', 'defect2 rejected without comment (new)', () => call('update_defect_status', { project_id: pid, defect_id: defect2Id, status: 'rejected' }))
    defects.rejectedWithCommentNew = await attempt('defects', 'defect2 rejected with comment (new)', () => call('update_defect_status', { project_id: pid, defect_id: defect2Id, status: 'rejected', comment: 'v0.2 reject probe' }))
    if (!defects.rejectedWithCommentNew.ok) {
      defects.confirmThenReject = await attempt('defects', 'defect2 confirmed then rejected', async () => {
        await call('update_defect_status', { project_id: pid, defect_id: defect2Id, status: 'confirmed' })
        await call('update_defect_status', { project_id: pid, defect_id: defect2Id, status: 'rejected', comment: 'v0.2 reject probe' })
        return pick(await call('get_defect', { project_id: pid, defect_id: defect2Id }), ['status', 'updated_at'])
      })
    }
    const current = await call('get_defect', { project_id: pid, defect_id: defect2Id })
    defects.clearCase = await attempt('defects', 'clear case_id', async () => {
      await call('update_defect', { project_id: pid, defect_id: defect2Id, title: current.title, case_id: null })
      return pick(await call('get_defect', { project_id: pid, defect_id: defect2Id }), ['case_id', 'plan_id', 'requirement_id', 'updated_at'])
    })
    defects.clearPlan = await attempt('defects', 'clear plan_id', async () => {
      await call('update_defect', { project_id: pid, defect_id: defect2Id, title: current.title, plan_id: null })
      return pick(await call('get_defect', { project_id: pid, defect_id: defect2Id }), ['case_id', 'plan_id', 'requirement_id', 'updated_at'])
    })
    defects.clearRequirement = await attempt('defects', 'clear requirement_id', async () => {
      await call('update_defect', { project_id: pid, defect_id: defect2Id, title: current.title, requirement_id: null })
      return pick(await call('get_defect', { project_id: pid, defect_id: defect2Id }), ['case_id', 'plan_id', 'requirement_id', 'updated_at'])
    })
  }

  defects.listStatuses = await (async () => {
    const found = []
    for (let page = 1; page <= 5; page += 1) {
      const data = await call('list_defects', { project_id: pid, page, page_size: 50 })
      const items = Array.isArray(data?.items) ? data.items : []
      for (const item of items) {
        if ([defectId, defect2Id].filter(Boolean).includes(item.id)) found.push({ page, id: item.id, status: item.status })
      }
      if (items.length < 50) break
    }
    return { found, totalPagesScanned: 5 }
  })()

  return facts
}

async function probeGit(facts, log) {
  const root = path.join('Z:/TEMP/opencode', `tmsync-git-probe-${Date.now()}`)
  await fs.mkdir(root, { recursive: true })
  const run = async (args, cwd = root, env = {}) => {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: 20000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } })
      return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() }
    } catch (error) {
      return { ok: false, code: error?.code, stdout: String(error?.stdout || '').trim(), stderr: String(error?.stderr || '').trim(), message: error?.message }
    }
  }
  const git = {}
  git.version = await run(['--version'], root)
  await run(['init'])
  await run(['config', 'user.name', 'tmsync probe'])
  await run(['config', 'user.email', 'probe@tmsync.local'])
  await fs.writeFile(path.join(root, 'README.md'), '# probe\n', 'utf8')
  git.add1 = await run(['add', '-A'])
  git.commit1 = await run(['commit', '-m', 'probe: first'])
  git.head1 = await run(['rev-parse', '--short', 'HEAD'])
  git.noChangeDiff = await run(['diff', '--cached', '--quiet'])
  await fs.writeFile(path.join(root, 'README.md'), '# probe updated\n', 'utf8')
  await run(['add', '-A'])
  git.commit2 = await run(['commit', '-m', 'probe: second'])
  git.head2 = await run(['rev-parse', '--short', 'HEAD'])

  // subdir of a parent repo
  const parent = path.join('Z:/TEMP/opencode', `tmsync-git-parent-${Date.now()}`)
  const sub = path.join(parent, 'workspace')
  await fs.mkdir(sub, { recursive: true })
  await run(['init'], parent)
  git.subdirTop = await run(['rev-parse', '--show-toplevel'], sub)

  // hooks disabled
  const hookFile = path.join(root, '.git', 'hooks', 'pre-commit')
  const marker = path.join(root, 'hook-ran.txt')
  await fs.writeFile(hookFile, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { encoding: 'utf8', mode: 0o755 })
  await fs.writeFile(path.join(root, 'hook.txt'), 'hook probe\n', 'utf8')
  await run(['add', '-A'])
  git.commitHooksDisabled = await run(['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '-m', 'probe: hooks disabled'])
  git.hookMarkerExists = await fs.stat(marker).then(() => true).catch(() => false)

  facts.git = git
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/v02-write-probe.js [--deep] [--out <file>]')
    return
  }
  const cfg = await loadConfig()
  if (!cfg.mcpUrl || !cfg.token) throw new Error('配置缺少 mcpUrl/token')
  const client = createMcpClient({ mcpUrl: cfg.mcpUrl, token: cfg.token, concurrency: 2 })
  const log = (message) => console.log(message)
  try {
    const facts = await runProbe({ deep: args.deep, call: (name, callArgs) => client.call(name, callArgs), log })
    log('git: safety probe')
    await probeGit(facts, log)
    const text = JSON.stringify(facts, null, 2)
    const outFile = path.resolve(args.out || 'docs/design/v0.2.0/evidence/platform-facts-v0.2.json')
    await fs.mkdir(path.dirname(outFile), { recursive: true })
    await fs.writeFile(outFile, `${text}\n`, 'utf8')
    log(`written ${outFile}`)
    log(`errors: ${facts.errors.length}`)
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error?.message || error}`)
  if (error?.hint) console.error(`hint: ${error.hint}`)
  process.exitCode = 1
})
