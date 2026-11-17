import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWorkspaceWatcher } from '../../server/watcher.js'

async function waitFor(predicate, timeout = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-watch-'))
  for (const dir of ['requirements', 'cases', 'plans', 'defects', 'reports']) {
    await fs.mkdir(path.join(root, dir, 'sub'), { recursive: true })
  }
  return root
}

test('watcher: .md changes are debounced and relative to workspace', async () => {
  const root = await makeWorkspace()
  const events = []
  const watcher = createWorkspaceWatcher({ root, projectId: '10', debounceMs: 50, onEvent: (event) => events.push(event) })
  try {
    await fs.writeFile(path.join(root, 'cases', 'sub', 'a.md'), '# a\n')
    assert.equal(await waitFor(() => events.length > 0), true)
    assert.equal(events[0].projectId, '10')
    assert.deepEqual(events[0].paths, ['cases/sub/a.md'])
    const before = events.length
    await fs.writeFile(path.join(root, 'cases', 'sub', 'b.txt'), 'ignore\n')
    await fs.mkdir(path.join(root, '.tmsync'), { recursive: true })
    await fs.writeFile(path.join(root, '.tmsync', 'x.md'), 'ignore\n')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(events.length, before)
  } finally {
    watcher.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('watcher: pause/resume suppresses and resumes', async () => {
  const root = await makeWorkspace()
  const events = []
  const watcher = createWorkspaceWatcher({ root, projectId: '10', debounceMs: 50, onEvent: (event) => events.push(event) })
  try {
    watcher.pause()
    await fs.writeFile(path.join(root, 'requirements', 'a.md'), '# a\n')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(events.length, 0)
    watcher.resume({ graceMs: 0 })
    await fs.writeFile(path.join(root, 'requirements', 'b.md'), '# b\n')
    assert.equal(await waitFor(() => events.length > 0), true)
  } finally {
    watcher.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('watcher: startup failure invokes onError and close stops events', async () => {
  const root = await makeWorkspace()
  const errors = []
  const events = []
  const watcher = createWorkspaceWatcher({
    root,
    projectId: '10',
    debounceMs: 50,
    watch: () => { throw new Error('no watch') },
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  })
  try {
    assert.equal(errors.length > 0, true)
    assert.ok(String(errors[0].message || errors[0]))
  } finally {
    watcher.close()
    await fs.rm(root, { recursive: true, force: true })
  }
  assert.equal(events.length, 0)
})
