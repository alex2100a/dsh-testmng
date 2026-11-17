import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity, renderFile, relativePathFor } from '../../server/codec.js'
import { initWorkspace } from '../../server/workspace.js'
import { createTmsyncService } from '../../server/service.js'
import { writeConfig } from '../../server/config.js'
import { safeJoin, writeAtomic } from '../../server/files.js'

test('service.push: 计划先认领，失败后不可重放且快照失效', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-service-push-'))
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-service-push-data-'))
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    const local = canonicalEntity('requirement', { id: null, localId: 'local-1', projectId: 'prj_test', catalogId: '14', title: 'New', description: 'd', status: 'draft' })
    await writeAtomic(safeJoin(root, relativePathFor('requirement', local, { catalogPath: '14-认证' })), renderFile('requirement', local))
    await writeConfig(dataDir, {
      platform: { mcpUrl: 'http://127.0.0.1:9/mcp', token: 'test-token' },
      sync: { pullKinds: ['requirement'] },
      projects: { prj_test: { name: 'Test', localRoot: root, platformKind: 'testcasegen', linkedAt: new Date().toISOString() } },
    })
    let listCalls = 0
    const service = createTmsyncService({ dataDir })
    service.adapter.listCatalogs = async () => [{ id: '14', name: '认证', parentId: null }]
    service.adapter.listEntities = async () => { listCalls += 1; return { items: [], total: 0, complete: true } }
    service.adapter.createEntity = async () => { throw new Error('simulated create failure') }

    await service.status('prj_test')
    const before = listCalls
    const plan = await service.pushPlan('prj_test')
    const result = await service.push('prj_test', { planId: plan.planId, confirm: true })
    assert.equal(result.partial, true)
    assert.ok(result.errors.length >= 1)
    await assert.rejects(
      () => service.push('prj_test', { planId: plan.planId, confirm: true }),
      /不存在或已使用/,
    )
    await service.status('prj_test')
    assert.ok(listCalls > before)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
