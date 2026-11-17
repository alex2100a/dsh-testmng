import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity, renderFile } from '../../server/codec.js'
import { initWorkspace, pullWorkspace, readState, writeState } from '../../server/workspace.js'
import { applyPush, planPush } from '../../server/push.js'
import { safeJoin, writeAtomic } from '../../server/files.js'

function planEntity({ id = 9, name = 'Plan', caseRefs = [{ order: 1, caseId: '23', dependsOn: [] }, { order: 2, caseId: '24', dependsOn: [] }] } = {}) {
  const entity = canonicalEntity('test-plan', {
    id,
    projectId: 'prj_test',
    name,
    description: 'plan desc',
    status: 'active',
    executorType: 'manual',
    planKind: 'smoke',
    environment: 'test',
    caseRefs,
    updatedAt: '2026-11-17T00:00:00Z',
  })
  entity.planCases = (caseRefs || []).map((ref, index) => ({
    planCaseId: String(19 + index),
    caseId: String(ref.caseId),
    sortOrder: ref.order ?? index + 1,
    dependsOn: ref.dependsOn || [],
    executorType: null,
  }))
  entity.planCasesComplete = true
  entity.remote = { updatedAt: entity.updatedAt, version: null }
  return entity
}

function fakePlanAdapter({ plans = [planEntity()] } = {}) {
  const map = new Map(plans.map((item) => [String(item.id), item]))
  let nextPlanId = 100
  let nextPlanCaseId = 500
  return {
    map,
    async listCatalogs() { return [] },
    async listEntities(projectId, kind) {
      if (kind === 'test-plan') {
        return { items: [...map.values()].map((item) => ({ ...item, caseRefs: item.caseRefs?.map((ref) => ({ ...ref })) })), total: map.size, complete: true }
      }
      if (kind === 'testcase') {
        const items = ['23', '24', '25'].map((id) => canonicalEntity('testcase', { id, projectId: 'prj_test', catalogId: '13', code: `TC-${id}`, title: `Case ${id}` }))
        return { items, total: items.length, complete: true }
      }
      return { items: [], total: 0, complete: true }
    },
    async getEntity(projectId, kind, id) {
      const item = map.get(String(id))
      if (!item) throw new Error('not found')
      return { ...item, planCases: item.planCases?.map((ref) => ({ ...ref, dependsOn: [...(ref.dependsOn || [])] })), caseRefs: item.caseRefs?.map((ref) => ({ ...ref, dependsOn: [...(ref.dependsOn || [])] })) }
    },
    async createEntity(projectId, kind, local) {
      const id = String(nextPlanId++)
      const created = planEntity({ id, name: local.name, caseRefs: [] })
      created.caseRefs = []
      created.planCases = []
      map.set(id, created)
      return created
    },
    async updateEntity(projectId, kind, id, patch) {
      const current = map.get(String(id))
      const next = { ...current, ...patch }
      next.remote = { updatedAt: new Date().toISOString(), version: null }
      map.set(String(id), next)
      return next
    },
    async updateStatus(projectId, kind, id, status) {
      return this.updateEntity(projectId, kind, id, { status })
    },
    async addPlanCases(projectId, planId, caseIds) {
      const current = map.get(String(planId))
      for (const caseId of caseIds) {
        if (current.planCases.some((ref) => String(ref.caseId) === String(caseId))) continue
        const planCaseId = String(nextPlanCaseId++)
        const order = current.planCases.length + 1
        current.planCases.push({ planCaseId, caseId: String(caseId), sortOrder: order, dependsOn: [], executorType: null })
        current.caseRefs.push({ order, caseId: String(caseId), dependsOn: [] })
      }
      return { added: caseIds.length }
    },
    async removePlanCase(projectId, planId, planCaseId) {
      const current = map.get(String(planId))
      const target = current.planCases.find((ref) => String(ref.planCaseId) === String(planCaseId))
      current.planCases = current.planCases.filter((ref) => String(ref.planCaseId) !== String(planCaseId))
      current.caseRefs = current.caseRefs.filter((ref) => String(ref.caseId) !== String(target?.caseId))
      return { deleted: 1 }
    },
    async updatePlanCaseDeps(projectId, planId, planCaseId, dependsOn) {
      const current = map.get(String(planId))
      const target = current.planCases.find((ref) => String(ref.planCaseId) === String(planCaseId))
      if (target) target.dependsOn = (dependsOn || []).map(String)
      const ref = current.caseRefs.find((item) => String(item.caseId) === String(target?.caseId))
      if (ref) ref.dependsOn = (dependsOn || []).map(String)
      return { ok: true }
    },
    async listRequirementIds() { return [] },
    async getRequirementCases() { return { items: [], complete: true } },
    async linkCases() { return {} },
    async unlinkCase() { return {} },
  }
}

async function setup(adapter) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-plan-'))
  await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
  await pullWorkspace({ root, adapter, projectId: 'prj_test', editableKinds: ['test-plan'], pullKinds: ['test-plan'], linkSync: false })
  const files = await fs.readdir(safeJoin(root, 'plans'))
  const file = safeJoin(root, path.posix.join('plans', files[0]))
  return { root, file }
}

test('plan order-only edit is not a local change', async () => {
  const adapter = fakePlanAdapter()
  const { root, file } = await setup(adapter)
  try {
    const state = await readState(root, 'test-plan')
    assert.equal(state.entities['9'].planCases.length, 2)
    let text = await fs.readFile(file, 'utf8')
    text = text.replace('| 1 | 23 | — |\n| 2 | 24 | — |', '| 2 | 23 | — |\n| 1 | 24 | — |')
    await fs.writeFile(file, text)
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['test-plan'], linkSync: false })
    assert.equal(plan.summary.update, 0)
    assert.equal(plan.summary.planCaseAdd, 0)
    assert.equal(plan.operations.length, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('plan dependency change produces only plan-case-deps', async () => {
  const adapter = fakePlanAdapter()
  const { root, file } = await setup(adapter)
  try {
    let text = await fs.readFile(file, 'utf8')
    text = text.replace('| 2 | 24 | — |', '| 2 | 24 | 23 |')
    await fs.writeFile(file, text)
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['test-plan'], linkSync: false })
    assert.equal(plan.summary.update, 0)
    assert.equal(plan.summary.planCaseDeps, 1)
    const applied = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(applied.errors.length, 0)
    const remote = adapter.map.get('9')
    assert.deepEqual(remote.planCases.find((ref) => ref.caseId === '24').dependsOn, ['23'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('plan case add and remove round-trip', async () => {
  const adapter = fakePlanAdapter()
  const { root, file } = await setup(adapter)
  try {
    let text = await fs.readFile(file, 'utf8')
    text = text.replace('| 2 | 24 | — |', '| 2 | 25 | — |')
    await fs.writeFile(file, text)
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['test-plan'], linkSync: false })
    assert.equal(plan.summary.planCaseAdd, 1)
    assert.equal(plan.summary.planCaseRemove, 1)
    const applied = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(applied.errors.length, 0)
    const remote = adapter.map.get('9')
    assert.deepEqual(remote.planCases.map((ref) => ref.caseId).sort(), ['23', '25'])
    const state = await readState(root, 'test-plan')
    assert.deepEqual(state.entities['9'].planCases.map((ref) => ref.caseId).sort(), ['23', '25'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('missing planCases blocks inferred removal', async () => {
  const adapter = fakePlanAdapter()
  const { root, file } = await setup(adapter)
  try {
    const state = await readState(root, 'test-plan')
    state.entities['9'].planCases = null
    state.entities['9'].planCasesComplete = false
    await writeState(root, 'test-plan', state)
    let text = await fs.readFile(file, 'utf8')
    text = text.replace('| 1 | 23 | — |\n| 2 | 24 | — |', '| 1 | 23 | — |')
    await fs.writeFile(file, text)
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['test-plan'], linkSync: false })
    assert.equal(plan.summary.planCaseRemove, 0)
    assert.ok(plan.blocked.some((item) => item.reason === 'plan-cases-baseline-missing'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('new plan create + add cases', async () => {
  const adapter = fakePlanAdapter({ plans: [] })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-plan-new-'))
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    const local = canonicalEntity('test-plan', {
      id: null,
      localId: 'local-plan-1',
      projectId: 'prj_test',
      name: 'New plan',
      status: 'active',
      executorType: 'manual',
      planKind: 'smoke',
      caseRefs: [{ order: 1, caseId: '23', dependsOn: [] }, { order: 2, caseId: '24', dependsOn: ['23'] }],
    })
    await writeAtomic(safeJoin(root, 'plans/local-plan-1-new-plan.md'), renderFile('test-plan', local))
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['test-plan'], linkSync: false })
    assert.equal(plan.summary.create, 1)
    assert.equal(plan.summary.planCaseAdd, 1)
    assert.equal(plan.summary.planCaseDeps, 1)
    const applied = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(applied.errors.length, 0)
    const created = applied.created[0]
    assert.ok(created)
    const remotePlan = adapter.map.get(String(created.id))
    assert.deepEqual(remotePlan.planCases.map((ref) => ref.caseId), ['23', '24'])
    assert.deepEqual(remotePlan.planCases.find((ref) => ref.caseId === '24').dependsOn, ['23'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('new plan deps failure keeps local caseRefs and does not refresh', async () => {
  const adapter = fakePlanAdapter({ plans: [] })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-plan-new-fail-'))
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    const local = canonicalEntity('test-plan', {
      id: null,
      localId: 'local-plan-2',
      projectId: 'prj_test',
      name: 'New plan fail',
      status: 'active',
      executorType: 'manual',
      planKind: 'smoke',
      caseRefs: [{ order: 1, caseId: '23', dependsOn: [] }, { order: 2, caseId: '24', dependsOn: ['23'] }],
    })
    const file = safeJoin(root, 'plans/local-plan-2-new-plan-fail.md')
    await writeAtomic(file, renderFile('test-plan', local))
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['test-plan'], linkSync: false })
    adapter.updatePlanCaseDeps = async () => { throw new Error('simulated deps failure') }
    const applied = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.ok(applied.errors.length >= 1)
    assert.ok(applied.conflicts.some((item) => item.reason === 'plan-case-partial'))
    const created = applied.created[0]
    assert.ok(created)
    const text = await fs.readFile(safeJoin(root, created.path), 'utf8')
    assert.match(text, /\| 2 \| 24 \| 23 \|/)
    const next = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['test-plan'], linkSync: false })
    assert.equal(next.operations.some((op) => op.action === 'create'), false)
    assert.equal(next.operations.some((op) => op.action === 'unlink'), false)
    assert.equal(next.summary.planCaseDeps, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
