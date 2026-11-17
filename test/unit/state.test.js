import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initWorkspace, loadState, readState, readWorkspace, workspacePaths, writeState } from '../../server/workspace.js'
import { writeAtomic } from '../../server/files.js'

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-state-'))
}

async function markPulled(root) {
  const paths = workspacePaths(root)
  const workspace = await readWorkspace(root)
  workspace.lastPullAt = new Date().toISOString()
  await writeAtomic(paths.workspace, `${JSON.stringify(workspace, null, 2)}\n`)
}

test('readState: 首次使用缺少 state 返回空状态', async () => {
  const root = await tempRoot()
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    const state = await readState(root, 'requirement')
    assert.deepEqual(state.entities, {})
    assert.equal(state.kind, 'requirement')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readState: 曾 pull 后 state 缺失必须 state_missing', async () => {
  const root = await tempRoot()
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    await markPulled(root)
    await assert.rejects(
      () => loadState(root, 'requirement'),
      (error) => error.code === 'state_missing',
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readState: JSON 损坏是 state_corrupt', async () => {
  const root = await tempRoot()
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    await fs.writeFile(path.join(workspacePaths(root).stateDir, 'requirement.json'), '{bad json', 'utf8')
    await assert.rejects(
      () => readState(root, 'requirement'),
      (error) => error.code === 'state_corrupt',
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readState: schema/kind 不匹配是 state_schema', async () => {
  const root = await tempRoot()
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    const file = path.join(workspacePaths(root).stateDir, 'requirement.json')
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 99, kind: 'requirement', entities: {} }), 'utf8')
    await assert.rejects(() => readState(root, 'requirement'), (error) => error.code === 'state_schema')
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, kind: 'testcase', entities: {} }), 'utf8')
    await assert.rejects(() => readState(root, 'requirement'), (error) => error.code === 'state_schema')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readState: entities 结构异常是 state_corrupt', async () => {
  const root = await tempRoot()
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    const file = path.join(workspacePaths(root).stateDir, 'requirement.json')
    for (const entities of [[], undefined, { 1: null }, { 1: [] }]) {
      const raw = { schemaVersion: 1, kind: 'requirement', ...(entities === undefined ? {} : { entities }) }
      await fs.writeFile(file, JSON.stringify(raw), 'utf8')
      await assert.rejects(() => readState(root, 'requirement'), (error) => error.code === 'state_corrupt')
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readState: 没有 workspace 且 .tmsync 存在时不 fail-open', async () => {
  const root = await tempRoot()
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    await fs.unlink(workspacePaths(root).workspace)
    await assert.rejects(
      () => readState(root, 'requirement'),
      (error) => error.code === 'workspace_corrupt',
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('writeState: 正常读写并保留 .bak', async () => {
  const root = await tempRoot()
  try {
    await initWorkspace(root, { projectId: 'prj_test', projectName: 'Test' })
    await writeState(root, 'requirement', { schemaVersion: 1, kind: 'requirement', lastFullScanAt: null, entities: { 1: { id: '1', baseHash: 'a' } } })
    await writeState(root, 'requirement', { schemaVersion: 1, kind: 'requirement', lastFullScanAt: null, entities: { 1: { id: '1', baseHash: 'b' } } })
    const state = await readState(root, 'requirement')
    assert.equal(state.entities['1'].baseHash, 'b')
    const backup = JSON.parse(await fs.readFile(path.join(workspacePaths(root).stateDir, 'requirement.json.bak'), 'utf8'))
    assert.equal(backup.entities['1'].baseHash, 'a')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
