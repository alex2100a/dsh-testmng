import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity } from '../../server/codec.js'
import { initWorkspace, pullWorkspace } from '../../server/workspace.js'
import { createTmsyncService } from '../../server/service.js'
import { writeConfig } from '../../server/config.js'

function remoteRequirement(overrides = {}) {
  const entity = canonicalEntity('requirement', {
    id: '11',
    projectId: 'prj_test',
    catalogId: '14',
    code: 'REQ-0001',
    title: 'Login',
    description: '登录接口',
    acceptanceCriteria: '- 空用户名提示',
    priority: 'P2',
    status: 'draft',
    updatedAt: '2026-11-16T00:00:00Z',
    version: 1,
    ...overrides,
  })
  entity.remote = { updatedAt: entity.updatedAt, version: '1' }
  return entity
}

function fakeAdapter(entity) {
  let listCalls = 0
  return {
    get listCalls() { return listCalls },
    async listCatalogs(projectId, kind) { return kind === 'requirement' ? [{ id: '14', name: '认证', parentId: null }] : [] },
    async listEntities(projectId, kind) {
      if (kind !== 'requirement') return { items: [], total: 0, complete: true }
      listCalls += 1
      return { items: [entity], total: 1, complete: true }
    },
    async getEntity() { return entity },
  }
}

test('service.status: 本地编辑立即可见，远程快照 TTL 内不重复请求/不建会话', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-status-cache-'))
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-status-data-'))
  try {
    const entity = remoteRequirement()
    const adapter = fakeAdapter(entity)
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    await writeConfig(dataDir, {
      platform: { mcpUrl: 'http://127.0.0.1:9/mcp', token: 'test-token' },
      sync: { pullKinds: ['requirement'] },
      projects: {
        prj_test: { name: 'Test', localRoot: root, platformKind: 'testcasegen', linkedAt: new Date().toISOString() },
      },
    })
    const service = createTmsyncService({ dataDir })
    service.adapter.listCatalogs = adapter.listCatalogs
    service.adapter.listEntities = adapter.listEntities
    service.adapter.getEntity = adapter.getEntity

    await pullWorkspace({
      root,
      adapter: service.adapter,
      projectId: 'prj_test',
      editableKinds: ['requirement'],
      pullKinds: ['requirement'],
      linkSync: false,
    })

    const baseCalls = adapter.listCalls
    const first = await service.status('prj_test')
    assert.equal(first.summary.same, 1)
    assert.equal(adapter.listCalls, baseCalls + 1)
    const checkedAt = first.remoteCheckedAt

    const file = path.join(root, first.entries[0].path)
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, text.replace('# Login', '# Login changed'), 'utf8')

    const originalWithClient = service.adapter.withClient
    service.adapter.withClient = async () => { throw new Error('快照命中不应创建 MCP 会话') }
    const second = await service.status('prj_test')
    assert.equal(second.summary['local-modified'], 1)
    assert.equal(second.remoteCheckedAt, checkedAt)
    assert.equal(adapter.listCalls, baseCalls + 1)
    service.adapter.withClient = originalWithClient

    const refreshed = await service.status('prj_test', { refresh: true })
    assert.ok(Date.parse(refreshed.remoteCheckedAt) >= Date.parse(checkedAt))
    assert.equal(adapter.listCalls, baseCalls + 2)

    await service.saveConfig({ platform: { platformUrl: 'http://new.example' } })
    await service.status('prj_test')
    assert.equal(adapter.listCalls, baseCalls + 3)

    const planState = path.join(root, '.tmsync', 'state', 'test-plan.json')
    await fs.unlink(planState)
    await assert.rejects(
      () => service.planCasesRefresh('prj_test'),
      (error) => error.code === 'state_missing',
    )
    await assert.rejects(() => fs.stat(planState))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
