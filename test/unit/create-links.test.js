import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity, renderFile } from '../../server/codec.js'
import { initWorkspace, readState, readWorkspace } from '../../server/workspace.js'
import { applyPush, planPush } from '../../server/push.js'
import { safeJoin, writeAtomic } from '../../server/files.js'

function requirement() {
  const entity = canonicalEntity('requirement', {
    id: '11', projectId: 'prj_test', catalogId: '14', code: 'REQ-0011', title: 'Req 11', status: 'draft', version: 1,
  })
  entity.remote = { updatedAt: '2026-11-16T00:00:00Z', version: '1' }
  return entity
}

function caseEntity(overrides = {}) {
  const entity = canonicalEntity('testcase', {
    id: '100', projectId: 'prj_test', catalogId: '13', code: 'TC-0100', title: 'New case', type: 'api', priority: 'P2', status: 'active', version: 1,
    ...overrides,
  })
  entity.remote = { updatedAt: '2026-11-16T00:00:00Z', version: '1' }
  return entity
}

function fakeAdapter() {
  const cases = new Map()
  const links = new Map([['11', new Set()]])
  return {
    cases,
    links,
    async listCatalogs(projectId, kind) { return kind === 'testcase' ? [{ id: '13', name: 'AI', parentId: null }] : [{ id: '14', name: '认证', parentId: null }] },
    async listEntities(projectId, kind) {
      if (kind === 'requirement') return { items: [requirement()], total: 1, complete: true }
      if (kind === 'testcase') return { items: [...cases.values()], total: cases.size, complete: true }
      return { items: [], total: 0, complete: true }
    },
    async listRequirementIds() { return ['11'] },
    async getRequirementCases(projectId, reqId) {
      return { items: [...(links.get(String(reqId)) || [])].map((caseId) => ({ case_id: Number(caseId) })), complete: true }
    },
    async getEntity(projectId, kind, id) {
      const item = cases.get(String(id))
      if (!item) throw new Error('not found')
      return { ...item }
    },
    async createEntity(projectId, kind, local) {
      const created = caseEntity({ id: '100', title: local.title, status: 'active' })
      cases.set('100', created)
      return { ...created }
    },
    async updateStatus(projectId, kind, id, status) {
      const next = { ...cases.get(String(id)), status, version: 2 }
      next.remote = { updatedAt: new Date().toISOString(), version: '2' }
      cases.set(String(id), next)
      return { ...next }
    },
    async linkCases(projectId, reqId, caseIds) {
      for (const caseId of caseIds) links.get(String(reqId)).add(String(caseId))
    },
    async unlinkCase(projectId, reqId, caseId) {
      links.get(String(reqId))?.delete(String(caseId))
    },
  }
}

test('new testcase status + links survive create status update', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-create-links-'))
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    const local = canonicalEntity('testcase', {
      id: null, localId: 'local-case-1', projectId: 'prj_test', catalogId: '13', title: 'New case',
      type: 'api', priority: 'P2', status: 'deprecated', requirementIds: ['11'],
      steps: [{ no: 1, action: 'call', expected: '200' }],
    })
    const rel = 'cases/13-ai/local-case-1-new-case.md'
    await writeAtomic(safeJoin(root, rel), renderFile('testcase', local))
    const adapter = fakeAdapter()
    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['testcase'] })
    assert.equal(plan.summary.create, 1)
    const applied = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(applied.errors.length, 0)
    assert.equal(adapter.cases.get('100').status, 'deprecated')
    const text = await fs.readFile(safeJoin(root, applied.created[0].path), 'utf8')
    assert.match(text, /"status": "deprecated"/)
    assert.match(text, /- 11/)
    const state = await readState(root, 'testcase')
    assert.deepEqual(state.entities['100'].baseRequirementIds, ['11'])
    assert.equal(state.entities['100'].linksArmed, true)
    assert.ok(adapter.links.get('11').has('100'))

    const next = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['testcase'] })
    assert.equal(next.operations.some((op) => op.action === 'unlink'), false)
    assert.equal(next.operations.length, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
