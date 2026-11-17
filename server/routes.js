/**
 * tmsync HTTP API + 静态工作台。
 * 路由由宿主半注册到 DSH Web Server；本模块只处理请求。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './config.js'
import { safeJoin } from './files.js'
import { KINDS } from './codec.js'

const PUBLIC_ROOT = fileURLToPath(new URL('../public/', import.meta.url))
const API_PREFIX = '/api/tmsync/api'
const INFO_PATH = '/api/tmsync/info'
const WORKBENCH_PREFIX = '/api/tmsync/workbench'
const MAX_BODY_BYTES = 64 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function writeJson(res, status, payload) {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function ok(res, payload) { writeJson(res, 200, payload) }
function fail(res, status, code, message, hint) {
  writeJson(res, status, { ok: false, error: { code, message: redact(message), ...(hint ? { hint: redact(hint) } : {}) } })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体超过 64KB'), { code: 'too_large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        const value = JSON.parse(text)
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      } catch {
        reject(Object.assign(new Error('请求体不是有效 JSON'), { code: 'bad_json' }))
      }
    })
    req.on('error', reject)
  })
}

async function serveStatic(req, res, pathname) {
  let relative = pathname.slice(WORKBENCH_PREFIX.length) || '/'
  if (relative === '/' || relative === '') relative = '/index.html'
  const file = safeJoin(PUBLIC_ROOT, relative.replace(/^\/+/, ''))
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error('not file')
    const ext = path.extname(file).toLowerCase()
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()
    res.end(await fs.readFile(file))
  } catch {
    fail(res, 404, 'not_found', '工作台资源不存在')
  }
}

function queryProject(url) {
  return String(url.searchParams.get('projectId') || '').trim()
}

export function createApi({ service, log = () => {} }) {
  async function handleApi(req, res, url, pathname) {
    const method = req.method || 'GET'
    const route = pathname.slice(API_PREFIX.length) || '/'

    if (route === '/status' && method === 'GET') {
      const info = await service.info()
      const config = await service.getConfig()
      const workspaces = await service.listWorkspaces()
      return ok(res, { ok: true, info, config, workspaces })
    }
    if (route === '/overview' && method === 'GET') return ok(res, { ok: true, ...(await service.overview()) })
    if (route === '/config' && method === 'GET') return ok(res, { ok: true, config: await service.getConfig() })
    if (route === '/config' && method === 'PUT') {
      const body = await readBody(req)
      return ok(res, { ok: true, config: await service.saveConfig(body) })
    }
    if (route === '/test-connection' && method === 'POST') {
      return ok(res, { ok: true, result: await service.testConnection() })
    }
    if (route === '/projects' && method === 'GET') {
      return ok(res, { ok: true, projects: await service.listProjects() })
    }
    if (route === '/workspaces' && method === 'GET') {
      return ok(res, { ok: true, workspaces: await service.listWorkspaces() })
    }
    if (route === '/workspaces/link' && method === 'POST') {
      const body = await readBody(req)
      return ok(res, { ok: true, ...(await service.linkWorkspace({ projectId: body.projectId, root: body.root })) })
    }
    if (route === '/workspaces/unlink' && method === 'POST') {
      const body = await readBody(req)
      return ok(res, { ok: true, ...(await service.unlinkWorkspace(body.projectId)) })
    }
    if (route === '/tree' && method === 'GET') {
      const projectId = queryProject(url)
      const kind = String(url.searchParams.get('kind') || 'requirement')
      if (!KINDS.includes(kind)) return fail(res, 400, 'validation', `未知类型 ${kind}`)
      return ok(res, { ok: true, ...(await service.tree(projectId, kind)) })
    }
    if (route === '/entity' && method === 'GET') {
      const projectId = queryProject(url)
      const kind = String(url.searchParams.get('kind') || '')
      const id = String(url.searchParams.get('id') || '')
      const view = String(url.searchParams.get('view') || 'local')
      if (!KINDS.includes(kind)) return fail(res, 400, 'validation', `未知类型 ${kind}`)
      return ok(res, { ok: true, ...(await service.entity(projectId, kind, id, { view })) })
    }
    if (route === '/status/refresh' && method === 'POST') {
      const body = await readBody(req)
      const projectId = String(body.projectId || '')
      const value = await service.status(projectId, { refresh: true, watch: true })
      return ok(res, { ok: true, summary: value.summary, entries: value.entries, remoteCheckedAt: value.remoteCheckedAt, errors: value.errors, revision: value.revision, realtime: value.realtime })
    }
    if (route === '/pull' && method === 'POST') {
      const body = await readBody(req)
      const projectId = String(body.projectId || '')
      const result = await service.pull(projectId, {
        kind: body.kind ? String(body.kind) : undefined,
        ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
        dryRun: body.dryRun !== false,
      })
      return ok(res, { ok: true, result })
    }
    if (route === '/push/plan' && method === 'POST') {
      const body = await readBody(req)
      const plan = await service.pushPlan(String(body.projectId || ''), {
        kind: body.kind ? String(body.kind) : undefined,
        ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
      })
      return ok(res, { ok: true, plan })
    }
    if (route === '/push' && method === 'POST') {
      const body = await readBody(req)
      const result = await service.push(String(body.projectId || ''), {
        planId: body.planId,
        confirm: body.confirm === true,
      })
      return ok(res, { ok: true, result })
    }
    if (route === '/conflict/resolve' && method === 'POST') {
      const body = await readBody(req)
      const result = await service.resolve(String(body.projectId || ''), {
        kind: String(body.kind || ''),
        id: String(body.id || ''),
        resolution: String(body.resolution || ''),
      })
      return ok(res, { ok: true, result })
    }
    if (route === '/rebase' && method === 'POST') {
      const body = await readBody(req)
      const result = await service.rebase(String(body.projectId || ''), {
        kind: body.kind ? String(body.kind) : undefined,
        id: body.id ? String(body.id) : undefined,
        all: body.all === true,
        confirm: body.confirm === true,
        allowLocalOnly: body.allowLocalOnly === true,
      })
      return ok(res, { ok: true, result })
    }
    if (route === '/links' && method === 'GET') {
      const projectId = queryProject(url)
      return ok(res, { ok: true, ...(await service.linksStatus(projectId)) })
    }
    if (route === '/links/refresh' && method === 'POST') {
      const body = await readBody(req)
      return ok(res, { ok: true, result: await service.linksRefresh(String(body.projectId || '')) })
    }
    if (route === '/links/adopt' && method === 'POST') {
      const body = await readBody(req)
      const result = await service.linksAdopt(String(body.projectId || ''), {
        ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
      })
      return ok(res, { ok: true, result })
    }
    if (route === '/plan-cases/refresh' && method === 'POST') {
      const body = await readBody(req)
      const result = await service.planCasesRefresh(String(body.projectId || ''), { id: body.id ? String(body.id) : undefined })
      return ok(res, { ok: true, result })
    }
    if (route === '/git' && method === 'GET') {
      const projectId = queryProject(url)
      return ok(res, { ok: true, ...(await service.gitStatus(projectId)) })
    }
    if (route === '/git/checkpoint' && method === 'POST') {
      const body = await readBody(req)
      const result = await service.gitCheckpoint(String(body.projectId || ''), {
        message: body.message,
        confirm: body.confirm === true,
      })
      return ok(res, { ok: true, result })
    }
    if (route === '/validate' && method === 'POST') {
      const body = await readBody(req)
      const projectId = String(body.projectId || '')
      return ok(res, { ok: true, ...(await service.validate(projectId, { kind: body.kind ? String(body.kind) : undefined })) })
    }
    if (route === '/logs' && method === 'GET') {
      return ok(res, { ok: true, logs: await service.logs(Number(url.searchParams.get('limit')) || 50) })
    }
    if (route === '/events' && method === 'GET') {
      return service.openEvents(req, res)
    }
    return fail(res, 404, 'not_found', `未知 API：${route}`)
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname
    if (pathname === INFO_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      return ok(res, await service.info())
    }
    if (pathname === WORKBENCH_PREFIX) {
      res.writeHead(302, { Location: `${WORKBENCH_PREFIX}/` })
      res.end()
      return
    }
    if (pathname.startsWith(WORKBENCH_PREFIX + '/')) {
      return serveStatic(req, res, pathname)
    }
    if (pathname.startsWith(API_PREFIX)) {
      try {
        return await handleApi(req, res, url, pathname)
      } catch (error) {
        log(`[tmsync] API 失败 ${req.method} ${pathname}: ${error?.message || error}`)
        return fail(res, error?.status || 500, error?.code || 'internal', error?.message || '请求失败', error?.hint)
      }
    }
    return fail(res, 404, 'not_found', '未知路径')
  }

  return { handle, serveStatic }
}
