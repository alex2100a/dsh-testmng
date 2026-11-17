#!/usr/bin/env node
/**
 * tmsync P0 平台只读探针。
 *
 * 读取 tmsync 或 dsh-testcat 的连接配置（token 不输出），调用 MCP：
 * list_projects → get_project → catalogs/lists/details，输出脱敏后的平台事实 JSON。
 *
 * 用法：
 *   node scripts/platform-probe.js [--project <public_id|code|name>] [--project-id <numeric>] [--out <file>]
 */

import fs from 'node:fs'
import path from 'node:path'
import { callTool, listTools } from '../server/mcp.js'

const HOME = process.env.USERPROFILE || process.env.HOME || ''
const CONFIG_CANDIDATES = [
  process.env.TMSYNC_CONFIG,
  path.join(HOME, '.dsh', 'tmsync', 'config.json'),
  path.join(HOME, '.dsh', 'dsh-testcat', 'config.json'),
].filter(Boolean)

const KEY_TOOLS = [
  'list_projects', 'get_project',
  'get_requirement_catalog_tree', 'list_requirements', 'get_requirement', 'create_requirement', 'update_requirement', 'update_requirement_status',
  'list_case_catalogs', 'list_cases', 'get_case', 'create_case', 'update_case', 'update_case_status',
  'list_plans', 'get_plan', 'create_plan', 'update_plan', 'list_plan_cases', 'add_plan_cases', 'remove_plan_case', 'update_plan_case',
  'list_defects', 'get_defect', 'create_defect', 'update_defect', 'update_defect_status', 'assign_defect', 'add_defect_comment',
  'list_reports', 'get_report', 'create_report',
  'create_requirement_catalog', 'create_case_catalog',
  'link_requirement_cases', 'unlink_requirement_case',
]

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--project') out.project = argv[++i]
    else if (arg === '--project-id') out.projectId = argv[++i]
    else if (arg === '--out') out.out = argv[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

function loadConfig() {
  for (const file of CONFIG_CANDIDATES) {
    if (!file || !fs.existsSync(file)) continue
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return {
        source: file,
        mcpUrl: process.env.TMSYNC_MCP_URL || process.env.TESTCASEGEN_MCP_URL || raw.mcpUrl,
        token: process.env.TMSYNC_MCP_TOKEN || process.env.TESTCASEGEN_MCP_TOKEN || raw.token,
        platformUrl: process.env.TMSYNC_PLATFORM_URL || process.env.TESTCASEGEN_PLATFORM_URL || raw.platformUrl || '',
      }
    } catch {
      // 继续尝试下一个
    }
  }
  throw new Error('未找到连接配置：请设置 TMSYNC_CONFIG，或先运行 dsh-testcat/tmsync 配置')
}

function projectView(item) {
  return item && {
    id: item.id,
    public_id: item.public_id,
    code: item.code,
    name: item.name,
    status: item.status,
  }
}

function keysOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : []
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function fieldShape(value) {
  return Object.fromEntries(keysOf(value).map((key) => [key, typeOf(value[key])]))
}

function pickProject(items, wanted, wantedId) {
  if (wantedId !== undefined) return items.find((item) => String(item.id) === String(wantedId))
  if (wanted) {
    return items.find((item) => [item.public_id, item.code, item.name, String(item.id)].includes(wanted))
  }
  return items[0]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/platform-probe.js [--project <public_id|code|name>] [--project-id <numeric>] [--out <file>]')
    return
  }
  const config = loadConfig()
  if (!config.mcpUrl) throw new Error('缺少 mcpUrl')
  if (!config.token) throw new Error('缺少 PAT')

  const toolSet = await listTools({ mcpUrl: config.mcpUrl, token: config.token, refresh: true })
  const tools = toolSet.tools ?? []
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]))

  const projectsPage = await callTool({
    mcpUrl: config.mcpUrl,
    token: config.token,
    name: 'list_projects',
    args: { page: 1, page_size: 50 },
  })
  const projects = Array.isArray(projectsPage?.items) ? projectsPage.items : []
  const project = pickProject(projects, args.project, args.projectId)
  if (!project) throw new Error('未找到项目：' + (args.project || args.projectId || '(first)'))

  const projectId = project.id
  const calls = [
    ['get_project', { project_id: projectId }],
    ['get_requirement_catalog_tree', { project_id: projectId }],
    ['list_case_catalogs', { project_id: projectId }],
    ['list_requirements', { project_id: projectId, page: 1, page_size: 5 }],
    ['list_cases', { project_id: projectId, page: 1, page_size: 5 }],
    ['list_plans', { project_id: projectId, page: 1, page_size: 5 }],
    ['list_defects', { project_id: projectId, page: 1, page_size: 5 }],
    ['list_reports', { project_id: projectId, page: 1, page_size: 5 }],
  ]
  const results = {}
  for (const [name, callArgs] of calls) {
    try {
      results[name] = await callTool({ mcpUrl: config.mcpUrl, token: config.token, name, args: callArgs })
    } catch (error) {
      results[name] = { __error: error?.message || String(error), hint: error?.hint }
    }
  }

  const first = (name) => Array.isArray(results[name]?.items) ? results[name].items[0] : null
  const detailCalls = []
  const requirement = first('list_requirements')
  const testcase = first('list_cases')
  const plan = first('list_plans')
  const defect = first('list_defects')
  const report = first('list_reports')
  if (requirement) detailCalls.push(['get_requirement', { project_id: projectId, req_id: requirement.id }])
  if (testcase) detailCalls.push(['get_case', { project_id: projectId, case_id: testcase.id }])
  if (plan) detailCalls.push(['get_plan', { project_id: projectId, plan_id: plan.id }])
  if (plan) detailCalls.push(['list_plan_cases', { project_id: projectId, plan_id: plan.id, offset: 0, limit: 10 }])
  if (defect) detailCalls.push(['get_defect', { project_id: projectId, defect_id: defect.id }])
  if (report) detailCalls.push(['get_report', { project_id: projectId, report_id: report.id }])
  const details = {}
  for (const [name, callArgs] of detailCalls) {
    try {
      details[name] = await callTool({ mcpUrl: config.mcpUrl, token: config.token, name, args: callArgs })
    } catch (error) {
      details[name] = { __error: error?.message || String(error), hint: error?.hint }
    }
  }

  const selectedTools = {}
  for (const name of KEY_TOOLS) {
    const tool = toolByName.get(name)
    if (!tool) {
      selectedTools[name] = { missing: true }
      continue
    }
    selectedTools[name] = {
      inputSchema: tool.inputSchema ?? tool.input_schema ?? null,
      annotationKeys: keysOf(tool.annotations),
    }
  }

  const updateRequirement = toolByName.get('update_requirement')?.inputSchema?.properties ?? {}
  const updateCase = toolByName.get('update_case')?.inputSchema?.properties ?? {}
  const facts = {
    generatedAt: new Date().toISOString(),
    source: path.basename(path.dirname(config.source)),
    mcpUrl: config.mcpUrl,
    platformUrl: config.platformUrl,
    toolCount: tools.length,
    project: projectView(project),
    projectCount: projects.length,
    catalogs: {
      requirement: results.get_requirement_catalog_tree?.items ?? results.get_requirement_catalog_tree?.__error,
      testcase: results.list_case_catalogs?.items ?? results.list_case_catalogs?.__error,
    },
    kinds: {
      requirement: {
        count: results.list_requirements?.total ?? null,
        listKeys: keysOf(requirement),
        detailKeys: keysOf(details.get_requirement),
        first: requirement ? { id: requirement.id, code: requirement.code, status: requirement.status } : null,
      },
      testcase: {
        count: results.list_cases?.total ?? null,
        listKeys: keysOf(testcase),
        detailKeys: keysOf(details.get_case),
        first: testcase ? { id: testcase.id, code: testcase.code, status: testcase.status } : null,
      },
      plan: {
        count: results.list_plans?.total ?? null,
        listKeys: keysOf(plan),
        detailKeys: keysOf(details.get_plan),
        first: plan ? { id: plan.id, name: plan.name, status: plan.status } : null,
        planCaseKeys: keysOf(Array.isArray(details.list_plan_cases?.items) ? details.list_plan_cases.items[0] : null),
      },
      defect: {
        count: results.list_defects?.total ?? null,
        listKeys: keysOf(defect),
        detailKeys: keysOf(details.get_defect),
        first: defect ? { id: defect.id, code: defect.code, status: defect.status } : null,
      },
      report: {
        count: results.list_reports?.total ?? null,
        listKeys: keysOf(report),
        detailKeys: keysOf(details.get_report),
        contentKeys: keysOf(details.get_report?.content),
        first: report ? { id: report.id, name: report.name, status: report.status } : null,
      },
    },
    capabilities: {
      delete: false,
      archive: false,
      entityMove: Boolean(updateRequirement.catalog_id && updateCase.catalog_id),
      catalogCreate: Boolean(toolByName.get('create_requirement_catalog') && toolByName.get('create_case_catalog')),
      catalogRenameOrDelete: false,
      reportUpdate: false,
      optimisticConcurrency: false,
      idempotencyKey: false,
      incrementalList: false,
    },
    shapes: {
      requirement: fieldShape(details.get_requirement),
      testcase: fieldShape(details.get_case),
      plan: fieldShape(details.get_plan),
      defect: fieldShape(details.get_defect),
      report: fieldShape(details.get_report),
    },
    tools: selectedTools,
    errors: Object.fromEntries(Object.entries(results).filter(([, value]) => value?.__error).map(([key, value]) => [key, value.__error])),
    notes: [
      '本报告不含 token、Authorization、测试数据正文。',
      '项目身份：public_id 字符串；MCP project_id 为数字。',
      'list_* page_size 上限 50；list_plan_cases limit 上限 100。',
      '写语义尚未测试；create/update 行为需专用项目。',
    ],
  }

  const text = JSON.stringify(facts, null, 2)
  if (args.out) {
    const outFile = path.resolve(args.out)
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, `${text}\n`, 'utf8')
    console.log(`written ${outFile}`)
  } else {
    console.log(text)
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error?.message || error}`)
  if (error?.hint) console.error(`hint: ${error.hint}`)
  process.exitCode = 1
})
