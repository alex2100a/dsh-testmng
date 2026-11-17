import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalEntity, contentHash, renderFile, relativePathFor } from '../../server/codec.js'
import { initWorkspace, readState, writeBaseline, writeState } from '../../server/workspace.js'
import { applyPush } from '../../server/push.js'
import { safeJoin, writeAtomic } from '../../server/files.js'

function remoteCase() {
  const entity = canonicalEntity('testcase', {
    id: '100', projectId: 'prj_test', catalogId: '13', code: 'TC-0100', title: 'Remote', type: 'api', priority: 'P2', status: 'active', version: 1,
    requirementIds: ['11'],
  })
  entity.remote = { updatedAt: '2026-11-16T00:00:00Z', version: '1' }
  return entity
}

function fakeAdapter({ failUpdate = false, failLink = false } = {}) {
  const remote = remoteCase()
  const calls = { link: 0 }
  return {
    calls,
    remote,
    async listCatalogs() { return [{ id: '13', name: 'AI', parentId: null }] },
    async getEntity() { return remote },
    async updateEntity() {
      if (failUpdate) throw new Error('simulated update failure')
      return { ...remote, title: 'Updated', version: 2, remote: { updatedAt: '2026-11-16T01:00:00Z', version: '2' } }
    },
    async updateStatus() { return remote },
    async linkCases() { calls.link += 1; if (failLink) throw new Error('simulated link failure') },
    async unlinkCase() {},
  }
}

async function setup(adapter) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-partial-'))
  await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
  const remote = adapter.remote
  const relative = relativePathFor('testcase', remote, { catalogPath: '13-ai' })
  const local = canonicalEntity('testcase', { ...remote, title: 'Local' })
  await writeAtomic(safeJoin(root, relative), renderFile('testcase', local))
  await writeBaseline(root, 'testcase', '100', remote)
  const state = await readState(root, 'testcase')
  state.entities['100'] = {
    id: '100', path: relative, catalogId: '13',
    baseHash: contentHash('testcase', remote), baseRevision: remote.remote.updatedAt, baseVersion: '1',
    baseRequirementIds: ['11'], linksArmed: true, linksUnknown: false,
  }
  await writeState(root, 'testcase', state)
  return { root, relative, localHash: contentHash('testcase', local) }
}

function planFor(relative, localHash) {
  return {
    planId: 'plan-test',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    operations: [
      {
        action: 'update', kind: 'testcase', id: '100', path: relative, catalogId: '13',
        title: 'Local', patch: { title: 'Local' }, statusChange: null,
        baseVersion: '1', baseRevision: '2026-11-16T00:00:00Z', baseHash: null, localHash,
      },
      { action: 'link', kind: 'testcase', id: '100', caseId: '100', requirementId: '12' },
      { action: 'link-baseline', kind: 'testcase', id: '100', path: relative, requirementIds: ['11', '12'], armed: true },
    ],
  }
}

test('applyPush: 同实体 update 失败后跳过 link，结果 partial', async () => {
  const adapter = fakeAdapter({ failUpdate: true })
  const { root, relative, localHash } = await setup(adapter)
  try {
    const result = await applyPush({ root, adapter, projectId: 'prj_test', plan: planFor(relative, localHash) })
    assert.equal(result.partial, true)
    assert.ok(result.errors.some((item) => item.message.includes('simulated update failure')))
    assert.ok(result.skipped.some((item) => item.action === 'link'))
    assert.equal(adapter.calls.link, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('applyPush: 链接失败时 linksArmed=false/linksUnknown=true 并记录冲突', async () => {
  const adapter = fakeAdapter({ failLink: true })
  const { root, relative, localHash } = await setup(adapter)
  try {
    const result = await applyPush({ root, adapter, projectId: 'prj_test', plan: planFor(relative, localHash) })
    assert.equal(result.partial, true)
    assert.ok(result.applyConflicts.some((item) => item.reason === 'link-apply-failed'))
    const state = await readState(root, 'testcase')
    assert.equal(state.entities['100'].linksArmed, false)
    assert.equal(state.entities['100'].linksUnknown, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
