import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity } from '../../server/codec.js'
import { initWorkspace, pullWorkspace } from '../../server/workspace.js'
import { applyPush, planPush } from '../../server/push.js'
import { safeJoin } from '../../server/files.js'

function defectEntity(overrides = {}) {
  const entity = canonicalEntity('defect', {
    id: 7,
    projectId: 'prj_test',
    code: 'BUG-0001',
    title: 'Defect',
    description: 'desc',
    status: 'new',
    severity: 'major',
    priority: 'P2',
    caseId: '29',
    planId: null,
    requirementId: '12',
    assigneeId: '5',
    assigneeName: 'Tester',
    updatedAt: '2026-11-17T00:00:00Z',
    ...overrides,
  })
  entity.remote = { updatedAt: entity.updatedAt, version: null }
  return entity
}

function fakeDefectAdapter({ defect = defectEntity() } = {}) {
  const map = new Map([[String(defect.id), defect]])
  let nextId = 100
  return {
    map,
    async listCatalogs() { return [] },
    async listEntities(projectId, kind) {
      if (kind === 'defect') return { items: [...map.values()], total: map.size, complete: true }
      return { items: [], total: 0, complete: true }
    },
    async getEntity(projectId, kind, id) {
      const item = map.get(String(id))
      if (!item) throw new Error('not found')
      return item
    },
    async createEntity(projectId, kind, local) {
      const id = String(nextId++)
      const created = defectEntity({
        id,
        title: local.title,
        description: local.description,
        severity: local.severity,
        priority: local.priority,
        status: 'new',
        caseId: local.caseId,
        planId: null,
        requirementId: local.requirementId,
        assigneeId: null,
        assigneeName: '',
      })
      map.set(id, created)
      if (local.planId) {
        created.planId = String(local.planId)
      }
      if (local.status && local.status !== 'new') {
        created.status = local.status
        created.remote = { updatedAt: new Date().toISOString(), version: null }
      }
      return created
    },
    async updateEntity(projectId, kind, id, patch) {
      const current = map.get(String(id))
      const next = { ...current, ...patch }
      next.remote = { updatedAt: new Date().toISOString(), version: null }
      map.set(String(id), next)
      return next
    },
    async updateStatus(projectId, kind, id, status, extra = {}) {
      const current = map.get(String(id))
      const next = { ...current, status, statusComment: extra.comment || '' }
      next.remote = { updatedAt: new Date().toISOString(), version: null }
      map.set(String(id), next)
      return next
    },
    async listRequirementIds() { return [] },
    async getRequirementCases() { return { items: [], complete: true } },
    async linkCases() { return {} },
    async unlinkCase() { return {} },
  }
}

async function setup(adapter) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-defect-'))
  await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
  await pullWorkspace({ root, adapter, projectId: 'prj_test', editableKinds: ['defect'], pullKinds: ['defect'], linkSync: false })
  const files = await fs.readdir(safeJoin(root, 'defects'))
  const file = safeJoin(root, path.posix.join('defects', files[0]))
  return { root, file }
}

test('defect assignee is display-only and hash ignores it', async () => {
  const adapter = fakeDefectAdapter()
  const { root, file } = await setup(adapter)
  try {
    let text = await fs.readFile(file, 'utf8')
    assert.match(text, /"assigneeId": "5"/)
    text = text.replace('# Defect', '# Defect updated')
    text = text.replace('"assigneeId": "5"', '"assigneeId": "9"')
    await fs.writeFile(file, text)
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['defect'], linkSync: false })
    assert.equal(plan.summary.update, 1)
    assert.ok(plan.warnings.some((item) => item.reason === 'assignee-readonly'))
    await fs.writeFile(file, text.replace('"assigneeId": "9"', '"assigneeId": "5"'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('defect status transition requires comment and sends it', async () => {
  const adapter = fakeDefectAdapter()
  const { root, file } = await setup(adapter)
  try {
    let text = await fs.readFile(file, 'utf8')
    text = text.replace('"status": "new"', '"status": "rejected"')
    await fs.writeFile(file, text)
    const blocked = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['defect'], linkSync: false })
    assert.ok(blocked.blocked.some((item) => item.reason === 'status-comment-required'))

    text = text.replace('"status": "rejected"', '"status": "rejected",\n  "statusComment": "not reproducible"')
    await fs.writeFile(file, text)
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['defect'], linkSync: false })
    assert.equal(plan.summary.update, 1)
    const applied = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(applied.errors.length, 0)
    assert.equal(adapter.map.get('7').status, 'rejected')
    assert.equal(adapter.map.get('7').statusComment, 'not reproducible')
    const after = await fs.readFile(file, 'utf8')
    assert.doesNotMatch(after, /statusComment/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('defect association clearing is blocked', async () => {
  const adapter = fakeDefectAdapter()
  const { root, file } = await setup(adapter)
  try {
    let text = await fs.readFile(file, 'utf8')
    text = text.replace('"caseId": "29"', '"caseId": null')
    await fs.writeFile(file, text)
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['defect'], linkSync: false })
    assert.ok(plan.blocked.some((item) => item.reason === 'association-clear-unsupported'))
    assert.equal(plan.operations.length, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('defect field update and plan association', async () => {
  const adapter = fakeDefectAdapter()
  const { root, file } = await setup(adapter)
  try {
    let text = await fs.readFile(file, 'utf8')
    text = text.replace('# Defect', '# Defect updated')
    text = text.replace('"severity": "major"', '"severity": "critical"')
    text = text.replace('"planId": null', '"planId": "10"')
    await fs.writeFile(file, text)
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['defect'], linkSync: false })
    assert.equal(plan.summary.update, 1)
    const applied = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(applied.errors.length, 0)
    const remote = adapter.map.get('7')
    assert.equal(remote.title, 'Defect updated')
    assert.equal(remote.severity, 'critical')
    assert.equal(remote.planId, '10')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('new defect with status and plan', async () => {
  const adapter = fakeDefectAdapter({ defect: defectEntity() })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-defect-new-'))
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    const local = canonicalEntity('defect', {
      id: null,
      localId: 'local-defect-1',
      projectId: 'prj_test',
      title: 'New defect',
      description: 'new',
      severity: 'major',
      priority: 'P1',
      status: 'confirmed',
      caseId: null,
      planId: null,
      requirementId: null,
    })
    const text = `---\n${JSON.stringify({ tmsync: 1, kind: 'defect', id: null, localId: local.localId, projectId: 'prj_test', catalogId: null, code: '', severity: 'major', priority: 'P1', status: 'confirmed' }, null, 2)}\n---\n# New defect\n\n## 描述\n\nnew\n`
    await fs.writeFile(safeJoin(root, 'defects/local-defect-1-new-defect.md'), text)
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['defect'], linkSync: false })
    assert.equal(plan.summary.create, 1)
    const applied = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(applied.errors.length, 0)
    assert.equal(adapter.map.get('100').status, 'confirmed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
