import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity, renderFile, relativePathFor } from '../../server/codec.js'
import { diffLinks, effectiveRequirementIds, normalizeIds } from '../../server/links.js'
import { initWorkspace, pullWorkspace, readState, writeState } from '../../server/workspace.js'
import { applyPush, planPush } from '../../server/push.js'
import { safeJoin, writeAtomic } from '../../server/files.js'

function remoteCase({ id = 23, title = 'Login', version = 1, updatedAt = '2026-11-16T00:00:00Z' } = {}) {
  const entity = canonicalEntity('testcase', {
    id,
    projectId: 'prj_test',
    catalogId: '13',
    code: 'TC-0001',
    title,
    type: 'api',
    priority: 'P2',
    status: 'active',
    steps: [{ no: 1, action: 'call', expected: '200' }],
    version,
    updatedAt,
  })
  entity.remote = { updatedAt, version: String(version) }
  return entity
}

function fakeAdapter({ cases = [remoteCase()], links = {} } = {}) {
  const caseMap = new Map(cases.map((item) => [String(item.id), item]))
  const linkMap = new Map(Object.entries(links).map(([req, caseIds]) => [String(req), new Set(caseIds.map(String))]))
  return {
    caseMap,
    linkMap,
    async listCatalogs() { return [{ id: '13', name: 'AI', parentId: null }] },
    async listEntities(projectId, kind) {
      if (kind === 'testcase') return { items: [...caseMap.values()], total: caseMap.size, complete: true }
      return { items: [], total: 0, complete: true }
    },
    async getEntity(projectId, kind, id) {
      const item = caseMap.get(String(id))
      if (!item) throw new Error('not found')
      return item
    },
    async createEntity(projectId, kind, local) {
      const created = remoteCase({ id: 100, title: local.title })
      caseMap.set('100', created)
      return created
    },
    async updateEntity(projectId, kind, id, patch) {
      const current = caseMap.get(String(id))
      const next = { ...current, ...patch, version: Number(current.version || 1) + 1 }
      next.remote = { updatedAt: new Date().toISOString(), version: String(next.version) }
      caseMap.set(String(id), next)
      return next
    },
    async updateStatus(projectId, kind, id, status) {
      return this.updateEntity(projectId, kind, id, { status })
    },
    async listRequirementIds() { return [...linkMap.keys()] },
    async getRequirementCases(projectId, reqId) {
      return { items: [...(linkMap.get(String(reqId)) || [])].map((caseId) => ({ case_id: Number(caseId) })), complete: true }
    },
    async linkCases(projectId, reqId, caseIds) {
      if (!linkMap.has(String(reqId))) linkMap.set(String(reqId), new Set())
      for (const id of caseIds) linkMap.get(String(reqId)).add(String(id))
      return { linked: caseIds.length }
    },
    async unlinkCase(projectId, reqId, caseId) {
      linkMap.get(String(reqId))?.delete(String(caseId))
      return { deleted: 1 }
    },
  }
}

async function setup(adapter, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-links-'))
  await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
  await pullWorkspace({
    root,
    adapter,
    projectId: 'prj_test',
    editableKinds: ['testcase'],
    pullKinds: ['testcase'],
    linkSync: true,
    ...options,
  })
  return root
}

function linkedCase() {
  return remoteCase()
}

test('diffLinks: base unknown only adds, never unlinks', () => {
  const result = diffLinks({ localIds: ['11'], baseIds: null, remoteIds: ['11', '12'], armed: false })
  assert.deepEqual(result.links, [])
  assert.deepEqual(result.unlinks, [])
  assert.equal(result.suppressed.length, 1)
  assert.equal(result.suppressed[0].requirementId, '12')
  assert.deepEqual(result.baselineAfter, ['11', '12'])
  assert.equal(result.armedAfter, false)
})

test('diffLinks: changed remote and local is conflict', () => {
  const result = diffLinks({ localIds: ['11', '13'], baseIds: ['11'], remoteIds: ['11', '12'], armed: true })
  assert.equal(result.conflict, true)
})

test('diffLinks: unlinks require armed', () => {
  const result = diffLinks({ localIds: ['11'], baseIds: ['11', '12'], remoteIds: ['11', '12'], armed: false })
  assert.deepEqual(result.unlinks, [])
  assert.equal(result.suppressed[0].requirementId, '12')
  const armed = diffLinks({ localIds: ['11'], baseIds: ['11', '12'], remoteIds: ['11', '12'], armed: true })
  assert.deepEqual(armed.unlinks, ['12'])
})

test('effective view preserves local links when cache unavailable', () => {
  const view = effectiveRequirementIds({
    kind: 'testcase',
    remote: { id: '23' },
    cache: null,
    local: { requirementIds: ['11'], linksUnknown: false },
  })
  assert.deepEqual(view.requirementIds, ['11'])
  assert.equal(view.linksUnknown, false)
})

test('pull writes link baseline and survives title-only push', async () => {
  const adapter = fakeAdapter({ links: { 11: [23] } })
  const root = await setup(adapter)
  try {
    const state = await readState(root, 'testcase')
    const entry = state.entities['23']
    assert.deepEqual(entry.baseRequirementIds, ['11'])
    assert.equal(entry.linksArmed, true)

    const file = safeJoin(root, 'cases/13-ai/23-login.md')
    const files = await fs.readdir(safeJoin(root, 'cases/13-ai'))
    const actual = safeJoin(root, path.posix.join('cases/13-ai', files[0]))
    let text = await fs.readFile(actual, 'utf8')
    assert.match(text, /- 11/)
    text = text.replace('# Login', '# Login updated')
    await fs.writeFile(actual, text)

    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['testcase'], linkSync: true })
    assert.equal(plan.summary.update, 1)
    assert.equal(plan.summary.unlink, 0)
    const applied = await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(applied.errors.length, 0)
    const after = await fs.readFile(actual, 'utf8')
    assert.match(after, /- 11/)
    assert.equal(adapter.linkMap.get('11').has('23'), true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('local link removal is suppressed until armed, then unlinked', async () => {
  const adapter = fakeAdapter({ links: { 11: [23], 12: [23] } })
  const root = await setup(adapter)
  try {
    const state = await readState(root, 'testcase')
    state.entities['23'].baseRequirementIds = ['11', '12']
    state.entities['23'].linksArmed = false
    await writeState(root, 'testcase', state)

    const files = await fs.readdir(safeJoin(root, 'cases/13-ai'))
    const actual = safeJoin(root, path.posix.join('cases/13-ai', files[0]))
    let text = await fs.readFile(actual, 'utf8')
    text = text.replace('- 11\n- 12', '- 11')
    await fs.writeFile(actual, text)

    const plan = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['testcase'], linkSync: true })
    assert.equal(plan.summary.unlink, 0)
    assert.equal(plan.suppressedUnlinks.length, 1)
    assert.equal(plan.suppressedUnlinks[0].requirementId, '12')
    await applyPush({ root, adapter, projectId: 'prj_test', plan })
    assert.equal(adapter.linkMap.get('12').has('23'), true)

    const state2 = await readState(root, 'testcase')
    assert.equal(state2.entities['23'].linksArmed, false)
    state2.entities['23'].linksArmed = true
    await writeState(root, 'testcase', state2)
    const plan2 = await planPush({ root, adapter, projectId: 'prj_test', editableKinds: ['testcase'], linkSync: true })
    assert.equal(plan2.summary.unlink, 1)
    await applyPush({ root, adapter, projectId: 'prj_test', plan: plan2 })
    assert.equal(adapter.linkMap.get('12').has('23'), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
