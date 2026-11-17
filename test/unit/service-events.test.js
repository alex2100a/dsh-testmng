import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initWorkspace } from '../../server/workspace.js'
import { createTmsyncService } from '../../server/service.js'
import { writeConfig } from '../../server/config.js'

function fakeAdapter() {
  return {
    async withClient(fn) { return fn() },
    async listCatalogs() { return [] },
    async listEntities() { return { items: [], total: 0, complete: true } },
    async getEntity() { return null },
  }
}

test('service events: status revision/realtime, config event and dispose', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-events-root-'))
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-events-data-'))
  let service = null
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    await writeConfig(dataDir, {
      platform: { mcpUrl: 'http://127.0.0.1:9/mcp', token: 'test-token' },
      sync: { pullKinds: ['requirement'] },
      projects: {
        prj_test: { name: 'Test', localRoot: root, platformKind: 'testcasegen', linkedAt: new Date().toISOString() },
      },
    })
    service = createTmsyncService({ dataDir, dshVersion: '0.2.2-rc.1' })
    const adapter = fakeAdapter()
    service.adapter.listCatalogs = adapter.listCatalogs
    service.adapter.listEntities = adapter.listEntities
    service.adapter.getEntity = adapter.getEntity
    service.adapter.withClient = adapter.withClient

    const events = []
    const off = service.subscribeEvents((event) => { events.push(event); return true })
    assert.ok(off)

    const value = await service.status('prj_test', { watch: true })
    assert.equal(value.realtime, true)
    assert.equal(typeof value.revision, 'number')

    await service.saveConfig({ workbench: { realtime: false } })
    assert.equal(events.some((event) => event.kind === 'config'), true)
    const info = await service.info()
    assert.equal(info.realtime, false)
    assert.equal(info.events.clients, 1)
    assert.equal(info.compatibility.status, 'supported')

    off.close()
    service.dispose()
    const after = await service.info()
    assert.equal(after.events.clients, 0)
  } finally {
    try { service?.dispose() } catch { /* ignore */ }
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
