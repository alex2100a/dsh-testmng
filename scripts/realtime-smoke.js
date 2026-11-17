#!/usr/bin/env node
/**
 * 本地实时链路冒烟：不启动 DSH，直接用 service + HTTP + SSE。
 * 验证：status(watch) -> 写受管 .md -> SSE 收到 local 事件。
 */
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initWorkspace } from '../server/workspace.js'
import { createTmsyncService } from '../server/service.js'
import { writeConfig } from '../server/config.js'

function fakeAdapter() {
  return {
    async withClient(fn) { return fn() },
    async listCatalogs() { return [] },
    async listEntities() { return { items: [], total: 0, complete: true } },
    async getEntity() { return null },
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-realtime-root-'))
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-realtime-data-'))
let service = null
let server = null
try {
  await initWorkspace(root, { projectId: 'prj_test', projectName: 'Realtime' })
  await writeConfig(dataDir, {
    platform: { mcpUrl: 'http://127.0.0.1:9/mcp', token: 'test-token' },
    sync: { pullKinds: ['requirement'] },
    workbench: { realtime: true, watchDebounceMs: 100 },
    projects: {
      prj_test: { name: 'Realtime', localRoot: root, platformKind: 'testcasegen', linkedAt: new Date().toISOString() },
    },
  })
  service = createTmsyncService({ dataDir })
  const adapter = fakeAdapter()
  service.adapter.listCatalogs = adapter.listCatalogs
  service.adapter.listEntities = adapter.listEntities
  service.adapter.getEntity = adapter.getEntity
  service.adapter.withClient = adapter.withClient
  await service.status('prj_test', { watch: true })

  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/events')) return service.openEvents(req, res)
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const started = Date.now()
  const received = await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let text = ''
      const timer = setTimeout(() => reject(new Error(`timeout: ${text.slice(0, 500)}`)), 5000)
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
        if (text.includes('"kind":"local"') && text.includes('requirements/live.md')) {
          clearTimeout(timer)
          res.destroy()
          resolve({ text, elapsed: Date.now() - started })
        }
      })
      res.on('error', (error) => { clearTimeout(timer); reject(error) })
    })
    request.on('error', reject)
    setTimeout(() => {
      fs.writeFile(path.join(root, 'requirements', 'live.md'), '# live\n', 'utf8').catch(reject)
    }, 200)
  })
  if (!received.text.includes('event: hello')) throw new Error('missing hello')
  console.log(`[ok] SSE local event in ${received.elapsed}ms`)
} finally {
  try { service?.dispose() } catch { /* ignore */ }
  if (server) await new Promise((resolve) => server.close(resolve))
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(dataDir, { recursive: true, force: true })
}
