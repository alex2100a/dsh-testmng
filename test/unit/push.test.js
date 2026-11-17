import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity, renderFile, relativePathFor } from '../../server/codec.js'
import { initWorkspace, readState } from '../../server/workspace.js'
import { computeStatus } from '../../server/workspace.js'
import { planPush, applyPush, resolveConflict } from '../../server/push.js'
import { safeJoin, writeAtomic, canonicalHash } from '../../server/files.js'

function remoteEntity(overrides = {}) {
  const entity = canonicalEntity('requirement', {
    id: '100', projectId: 'prj_test', catalogId: '14', code: 'REQ-0100',
    title: 'Remote', description: '', acceptanceCriteria: '', priority: 'P2', status: 'draft',
    updatedAt: '2026-11-16T00:00:00Z', version: 1,
    ...overrides,
  })
  entity.remote = { updatedAt: entity.updatedAt, version: String(entity.version ?? '1') }
  return entity
}

function fakeAdapter({ failStatus = false } = {}) {
  const entities = new Map()
  return {
    entities,
    async listCatalogs() { return [{ id: '14', name: '认证', parentId: null }] },
    async listEntities() { return { items: [...entities.values()], total: entities.size, complete: true } },
    async getEntity(projectId, kind, id) {
      const item = entities.get(String(id))
      if (!item) throw new Error('not found')
      return item
    },
    async createEntity(projectId, kind, local) {
      const item = remoteEntity({ id: '100', title: local.title, description: local.description, acceptanceCriteria: local.acceptanceCriteria, priority: local.priority, status: 'draft', version: 1 })
      entities.set('100', item)
      return item
    },
    async updateEntity(projectId, kind, id, patch) {
      const current = entities.get(String(id))
      const next = { ...current, ...patch, version: Number(current.version || 1) + 1, updatedAt: new Date().toISOString() }
      next.remote = { updatedAt: next.updatedAt, version: String(next.version) }
      entities.set(String(id), next)
      return next
    },
    async updateStatus(projectId, kind, id, status) {
      if (failStatus) throw new Error('simulated status failure')
      const current = entities.get(String(id))
      const next = { ...current, status, version: Number(current.version || 1) + 1, updatedAt: new Date().toISOString() }
      next.remote = { updatedAt: next.updatedAt, version: String(next.version) }
      entities.set(String(id), next)
      return next
    },
  }
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-push-'))
  await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
  return root
}

test('create plan/apply', async () => {
  const root = await setup()
  const adapter = fakeAdapter()
  const local = canonicalEntity('requirement', { id: null, localId: 'local-1', projectId: 'prj_test', catalogId: '14', title: 'Local new', description: 'd', acceptanceCriteria: 'a', priority: 'P1', status: 'draft' })
  const rel = relativePathFor('requirement', local, { catalogPath: '14-认证' })
  await writeAtomic(safeJoin(root, rel), renderFile('requirement', local))
  const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'] })
  assert.equal(plan.summary.create, 1)
  const result = await applyPush({ root, adapter, projectId: 'prj_test', plan })
  assert.equal(result.created.length, 1)
  assert.equal(adapter.entities.get('100').title, 'Local new')
  await fs.rm(root, { recursive: true, force: true })
})

test('update plan/apply increments version', async () => {
  const root = await setup()
  const adapter = fakeAdapter()
  const remote = remoteEntity()
  adapter.entities.set('100', remote)
  // Pull one entity by writing baseline + file directly through a plan is unnecessary;
  // use resolveConflict remote to seed baseline/file.
  const fsMod = await import('node:fs/promises')
  const rel = relativePathFor('requirement', remote, { catalogPath: '14-认证' })
  await writeAtomic(safeJoin(root, rel), renderFile('requirement', remote))
  const { writeBaseline, readState, writeState } = await import('../../server/workspace.js')
  const state = await readState(root, 'requirement')
  state.entities['100'] = { id: '100', path: rel, catalogId: '14', baseHash: canonicalHash({ kind: 'requirement' }), baseRevision: remote.remote.updatedAt, baseVersion: '1' }
  await writeState(root, 'requirement', state)
  await writeBaseline(root, 'requirement', '100', remote)
  // Recompute baseline content hash correctly.
  const { contentHash } = await import('../../server/codec.js')
  state.entities['100'].baseHash = contentHash('requirement', remote)
  await writeState(root, 'requirement', state)

  const file = safeJoin(root, rel)
  let text = await fsMod.readFile(file, 'utf8')
  await fsMod.writeFile(file, text.replace('# Remote', '# Remote updated'))
  const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'] })
  assert.equal(plan.summary.update, 1)
  const result = await applyPush({ root, adapter, projectId: 'prj_test', plan })
  assert.equal(result.updated.length, 1)
  assert.equal(adapter.entities.get('100').title, 'Remote updated')
  assert.equal(String(adapter.entities.get('100').version), '2')
  await fs.rm(root, { recursive: true, force: true })
})

test('new requirement approved status is applied after create', async () => {
  const root = await setup()
  const adapter = fakeAdapter()
  try {
    const local = canonicalEntity('requirement', { id: null, localId: 'local-status', projectId: 'prj_test', catalogId: '14', title: 'Local approved', description: 'd', acceptanceCriteria: 'a', priority: 'P1', status: 'approved' })
    const rel = relativePathFor('requirement', local, { catalogPath: '14-认证' })
    await writeAtomic(safeJoin(root, rel), renderFile('requirement', local))
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'] })
    assert.equal(plan.operations.find((op) => op.action === 'create').localStatus, 'approved')
    const result = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(result.created.length, 1)
    assert.equal(adapter.entities.get('100').status, 'approved')
    const text = await fs.readFile(safeJoin(root, result.created[0].path), 'utf8')
    assert.match(text, /"status": "approved"/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('create status failure keeps local status and needsFollowup', async () => {
  const root = await setup()
  const adapter = fakeAdapter({ failStatus: true })
  try {
    const local = canonicalEntity('requirement', { id: null, localId: 'local-fail', projectId: 'prj_test', catalogId: '14', title: 'Local fail', description: 'd', acceptanceCriteria: 'a', priority: 'P1', status: 'approved' })
    const rel = relativePathFor('requirement', local, { catalogPath: '14-认证' })
    await writeAtomic(safeJoin(root, rel), renderFile('requirement', local))
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'] })
    const result = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(result.created.length, 1)
    assert.equal(result.errors.length, 1)
    assert.equal(adapter.entities.get('100').status, 'draft')
    const text = await fs.readFile(safeJoin(root, result.created[0].path), 'utf8')
    assert.match(text, /"status": "approved"/)
    const state = await readState(root, 'requirement')
    assert.equal(state.entities['100'].needsFollowup, true)
    const status = await computeStatus({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'], pullKinds: ['requirement'] })
    assert.equal(status.entries.find((entry) => entry.id === '100').status, 'local-modified')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('CreatePartialError records createdId and avoids duplicate create', async () => {
  const root = await setup()
  const adapter = fakeAdapter()
  try {
    const local = canonicalEntity('requirement', { id: null, localId: 'local-partial', projectId: 'prj_test', catalogId: '14', title: 'Local partial', description: 'd', acceptanceCriteria: 'a', priority: 'P1', status: 'approved' })
    const rel = relativePathFor('requirement', local, { catalogPath: '14-认证' })
    await writeAtomic(safeJoin(root, rel), renderFile('requirement', local))
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'] })
    adapter.createEntity = async () => {
      const error = new Error('simulated post-create failure')
      error.code = 'create_partial'
      error.createdId = '100'
      error.created = remoteEntity({ id: '100', title: 'Local partial', status: 'draft', version: 1 })
      adapter.entities.set('100', error.created)
      throw error
    }
    const result = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(result.created.length, 1)
    assert.equal(result.errors.length, 1)
    const text = await fs.readFile(safeJoin(root, result.created[0].path), 'utf8')
    assert.match(text, /"id": "100"/)
    assert.match(text, /"status": "approved"/)
    const state = await readState(root, 'requirement')
    assert.equal(state.entities['100'].needsFollowup, true)
    const nextPlan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['requirement'] })
    assert.equal(nextPlan.operations.some((op) => op.action === 'create'), false)
    assert.equal(nextPlan.operations.some((op) => op.action === 'update'), true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
