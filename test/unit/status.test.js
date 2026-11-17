import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity } from '../../server/codec.js'
import { computeStatus, initWorkspace, pullWorkspace } from '../../server/workspace.js'

function remoteRequirement() {
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
    updatedAt: '2026-10-11T10:42:10.274490+00:00',
  })
  entity.remote = { updatedAt: '2026-10-11T10:42:10.274490+00:00', version: '1' }
  return entity
}

function fakeAdapter(entity) {
  return {
    kind: 'fake',
    version: 1,
    async listCatalogs() { return [{ id: '14', name: '认证', parentId: null, itemCount: 1 }] },
    async listEntities() { return { items: [entity], total: 1, complete: true } },
    async getEntity() { return entity },
  }
}

test('remote-new → pull → same; local edit → local-modified', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-status-'))
  const entity = remoteRequirement()
  const adapter = fakeAdapter(entity)
  await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })

  const before = await computeStatus({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'], pullKinds: ['requirement'] })
  assert.equal(before.summary['remote-new'], 1)
  assert.equal(before.entries[0].status, 'remote-new')

  const pulled = await pullWorkspace({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'], pullKinds: ['requirement'], dryRun: false })
  assert.equal(pulled.written.length, 1)

  const after = await computeStatus({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'], pullKinds: ['requirement'] })
  assert.equal(after.summary.same, 1)
  assert.equal(after.entries[0].status, 'same')

  const file = path.join(root, after.entries[0].path)
  const text = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, text.replace('# Login', '# Login changed'))

  const modified = await computeStatus({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'], pullKinds: ['requirement'] })
  assert.equal(modified.summary['local-modified'], 1)
  assert.equal(modified.entries[0].status, 'local-modified')

  await fs.rm(root, { recursive: true, force: true })
})
