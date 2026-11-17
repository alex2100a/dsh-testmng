import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity } from '../../server/codec.js'
import { initWorkspace, pullWorkspace, readState, workspacePaths } from '../../server/workspace.js'
import { createTmsyncService } from '../../server/service.js'
import { writeConfig } from '../../server/config.js'
import { detectLegacy, readLegacyCache } from '../../server/legacy.js'

function remoteRequirement(description = 'a\n\n\nb') {
  const entity = canonicalEntity('requirement', {
    id: '11', projectId: 'prj_test', catalogId: '14', code: 'REQ-0011', title: 'Legacy',
    description, acceptanceCriteria: 'ok', priority: 'P2', status: 'draft',
    updatedAt: '2026-11-16T00:00:00Z', version: 1,
  })
  entity.remote = { updatedAt: entity.updatedAt, version: '1' }
  return entity
}

function fakeAdapter(entity) {
  return {
    async listCatalogs(projectId, kind) { return kind === 'requirement' ? [{ id: '14', name: '认证', parentId: null }] : [] },
    async listEntities(projectId, kind) { return kind === 'requirement' ? { items: [entity], total: 1, complete: true } : { items: [], total: 0, complete: true } },
    async getEntity() { return entity },
  }
}

async function setupService({ description = 'a\n\n\nb' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-legacy-'))
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-legacy-data-'))
  const entity = remoteRequirement(description)
  const adapter = fakeAdapter(entity)
  await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
  await writeConfig(dataDir, {
    platform: { mcpUrl: 'http://127.0.0.1:9/mcp', token: 'test-token' },
    sync: { pullKinds: ['requirement'] },
    projects: { prj_test: { name: 'Test', localRoot: root, platformKind: 'testcasegen', linkedAt: new Date().toISOString() } },
  })
  const service = createTmsyncService({ dataDir })
  service.adapter.listCatalogs = adapter.listCatalogs
  service.adapter.listEntities = adapter.listEntities
  service.adapter.getEntity = adapter.getEntity
  await pullWorkspace({ root, adapter: service.adapter, projectId: 'prj_test', editableKinds: ['requirement'], pullKinds: ['requirement'], linkSync: false })
  return { root, dataDir, service, entity }
}

test('detectLegacy: 压缩空行/截断 ## 被识别', () => {
  assert.equal(detectLegacy('requirement', { description: 'a\n\n\nb' }, { description: 'a\n\nb' }).legacy, true)
  assert.equal(detectLegacy('requirement', { description: 'line1\n## 验收标准\nline3' }, { description: 'line1' }).legacy, true)
  assert.equal(detectLegacy('requirement', { description: 'same' }, { description: 'same' }).legacy, false)
})

test('legacy: status 标记、push 阻断、单实体 rebase 恢复', async () => {
  const { root, dataDir, service } = await setupService()
  try {
    const status = await service.status('prj_test')
    const file = path.join(root, status.entries[0].path)
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, text.replace('a\n\n\nb', 'a\n\nb'), 'utf8')

    const marked = await service.status('prj_test', { refresh: true })
    const entry = marked.entries.find((item) => item.id === '11')
    assert.equal(entry.status, 'local-modified')
    assert.equal(entry.legacy, true)
    assert.equal(entry.legacyReason, 'legacy-format-diff')
    const cache = await readLegacyCache(root, { projectId: 'prj_test' })
    assert.equal(cache.byId['11'].legacy, true)

    const plan = await service.pushPlan('prj_test')
    assert.ok(plan.blocked.some((item) => item.reason === 'legacy-format-diff'))
    assert.equal(plan.operations.length, 0)

    const rebased = await service.rebase('prj_test', { kind: 'requirement', id: '11', confirm: true })
    assert.equal(rebased.ok, true)
    const after = await service.status('prj_test', { refresh: true })
    assert.equal(after.entries.find((item) => item.id === '11').status, 'same')
    const restored = await fs.readFile(file, 'utf8')
    assert.match(restored, /a\n\n\nb/)
    const cache2 = await readLegacyCache(root, { projectId: 'prj_test' })
    assert.equal(cache2?.byId?.['11']?.legacy, undefined)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('rebase all: state 缺失时从 baseline 重建', async () => {
  const { root, dataDir, service } = await setupService()
  try {
    const stateFile = path.join(workspacePaths(root).stateDir, 'requirement.json')
    await fs.unlink(stateFile)
    const result = await service.rebase('prj_test', { all: true, confirm: true })
    assert.equal(result.ok, true)
    assert.equal(result.counts.rewritten, 1)
    const state = await readState(root, 'requirement')
    assert.ok(state.entities['11'])
    const status = await service.status('prj_test', { refresh: true })
    assert.equal(status.entries.find((item) => item.id === '11').status, 'same')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
