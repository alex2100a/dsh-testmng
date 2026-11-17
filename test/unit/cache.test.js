import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initWorkspace } from '../../server/workspace.js'
import { createTmsyncService } from '../../server/service.js'
import { writeConfig } from '../../server/config.js'
import { gitCacheStats, gitInfo, resetGitCache } from '../../server/git.js'
import { clearToolsCache, toolsCacheStats } from '../../server/mcp.js'
import { createTestCaseGenAdapter } from '../../server/platform/testcasegen.js'

function fakeAdapter() {
  return {
    async withClient(fn) { return fn() },
    async listCatalogs() { return [] },
    async listEntities() { return { items: [], total: 0, complete: true } },
    async getEntity() { return null },
  }
}

test('cache: service honors cacheLimits and dispose clears maps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-cache-root-'))
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-cache-data-'))
  let service = null
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    await writeConfig(dataDir, {
      platform: { mcpUrl: 'http://127.0.0.1:9/mcp', token: 'test-token' },
      sync: { pullKinds: ['requirement'] },
      workbench: { cache: { statusEntries: 4, statusBytes: 1024, planEntries: 4, planBytes: 1024, revisionEntries: 32 } },
      projects: { prj_test: { name: 'Test', localRoot: root, platformKind: 'testcasegen', linkedAt: new Date().toISOString() } },
    })
    service = createTmsyncService({
      dataDir,
      cacheLimits: { statusEntries: 4, statusBytes: 1024, planEntries: 4, planBytes: 1024, revisionEntries: 32 },
    })
    const adapter = fakeAdapter()
    service.adapter.listCatalogs = adapter.listCatalogs
    service.adapter.listEntities = adapter.listEntities
    service.adapter.getEntity = adapter.getEntity
    service.adapter.withClient = adapter.withClient
    await service.status('prj_test', { watch: true })
    const stats = service.cacheStats()
    assert.equal(stats.statusSnapshots.maxEntries, 4)
    assert.equal(stats.statusSnapshots.maxBytes, 1024)
    assert.equal(stats.plans.maxEntries, 4)
    assert.equal(stats.watchers.size >= 1, true)
    service.dispose()
    const after = service.cacheStats()
    assert.equal(after.statusSnapshots.size, 0)
    assert.equal(after.plans.size, 0)
    assert.equal(after.watchers.size, 0)
    service = null
  } finally {
    try { service?.dispose() } catch { /* ignore */ }
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('cache: git cache stats/reset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-git-cache-'))
  try {
    resetGitCache()
    await gitInfo(root, { cacheMs: 0 })
    assert.equal(gitCacheStats().size, 1)
    assert.equal(gitCacheStats().maxEntries, 32)
    resetGitCache()
    assert.equal(gitCacheStats().size, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('cache: testcasegen project cache caps and dispose', async () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    id: String(100 + index),
    public_id: `prj_${index}`,
    code: `P${index}`,
    name: `Project ${index}`,
  }))
  const adapter = createTestCaseGenAdapter({
    readConfig: async () => ({ platform: { mcpUrl: 'http://127.0.0.1:9/mcp', token: 't' } }),
    callTool: async () => ({ items, total: items.length }),
    log: () => {},
  })
  await adapter.listProjects({ refresh: true })
  assert.equal(adapter.projectCacheStats().size, 3)
  const resolved = await adapter.resolveProject('prj_1')
  assert.equal(resolved.id, 'prj_1')
  adapter.dispose()
  assert.equal(adapter.projectCacheStats().size, 0)
})

test('cache: mcp tools cache stats and clear', () => {
  clearToolsCache()
  assert.equal(toolsCacheStats().tools, 0)
  assert.equal(toolsCacheStats().ttlMs > 0, true)
})
