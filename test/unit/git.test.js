import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitCheckpoint, gitInfo, normalizePath } from '../../server/git.js'

const execFileAsync = promisify(execFile)

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return String(stdout).trim()
}

async function hasGit() {
  try { await git(['--version'], process.cwd()); return true } catch { return false }
}

async function initRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmsync-git-'))
  await git(['init'], root)
  await git(['config', 'user.name', 'tmsync test'], root)
  await git(['config', 'user.email', 'test@tmsync.local'], root)
  return root
}

test('git checkpoint: init, commit, no-op, dataDir exclusion', async (t) => {
  if (!(await hasGit())) return t.skip('git unavailable')
  const root = await initRepo()
  try {
    await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8')
    await fs.mkdir(path.join(root, 'data'), { recursive: true })
    await fs.writeFile(path.join(root, 'data', 'config.json'), '{"token":"secret"}\n', 'utf8')
    const info = await gitInfo(root, { cacheMs: 0 })
    assert.equal(info.isRepo, true)
    assert.equal(info.repoRootMatches, true)

    const first = await gitCheckpoint({ root, confirm: true, message: 'first\ncheckpoint', dataDir: path.join(root, 'data'), projectId: 'prj_test' })
    assert.equal(first.created, true)
    assert.equal(first.files, 1)
    const files = await git(['show', '--name-only', '--format=', 'HEAD'], root)
    assert.match(files, /README\.md/)
    assert.doesNotMatch(files, /data\/config\.json/)
    assert.doesNotMatch(files, /\.tmsync/)

    const second = await gitCheckpoint({ root, confirm: true, dataDir: path.join(root, 'data') })
    assert.equal(second.created, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('git checkpoint: repo root mismatch is rejected', async (t) => {
  if (!(await hasGit())) return t.skip('git unavailable')
  const root = await initRepo()
  try {
    const sub = path.join(root, 'workspace')
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(path.join(sub, 'a.txt'), 'a\n', 'utf8')
    const info = await gitInfo(sub, { cacheMs: 0 })
    assert.equal(info.isRepo, true)
    assert.equal(info.repoRootMatches, false)
    await assert.rejects(
      () => gitCheckpoint({ root: sub, confirm: true }),
      (error) => error.code === 'repo-root-mismatch',
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('git checkpoint: hooks are disabled', async (t) => {
  if (!(await hasGit())) return t.skip('git unavailable')
  const root = await initRepo()
  try {
    const marker = path.join(root, 'hook-ran.txt')
    const hook = path.join(root, '.git', 'hooks', 'pre-commit')
    await fs.writeFile(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { encoding: 'utf8', mode: 0o755 })
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n', 'utf8')
    const result = await gitCheckpoint({ root, confirm: true })
    assert.equal(result.created, true)
    await assert.rejects(() => fs.stat(marker))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('git checkpoint: confirm is required', async () => {
  await assert.rejects(
    () => gitCheckpoint({ root: os.tmpdir(), confirm: false }),
    (error) => error.code === 'confirm-required',
  )
})

test('normalizePath: Linux 大小写敏感，Windows 不敏感', () => {
  assert.notEqual(normalizePath('/A', { caseInsensitive: false }), normalizePath('/a', { caseInsensitive: false }))
  assert.equal(normalizePath('/A', { caseInsensitive: true }), normalizePath('/a', { caseInsensitive: true }))
})

test('git checkpoint: GIT_DIR 环境变量不会切到别的仓库', async (t) => {
  if (!(await hasGit())) return t.skip('git unavailable')
  const root = await initRepo()
  const other = await initRepo()
  const saved = process.env.GIT_DIR
  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n', 'utf8')
    await fs.writeFile(path.join(other, 'b.txt'), 'b\n', 'utf8')
    process.env.GIT_DIR = path.join(other, '.git')
    const result = await gitCheckpoint({ root, confirm: true })
    assert.equal(result.created, true)
    delete process.env.GIT_DIR
    const files = await git(['show', '--name-only', '--format=', 'HEAD'], root)
    assert.match(files, /a\.txt/)
    await assert.rejects(() => git(['rev-parse', '--verify', 'HEAD'], other))
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = saved
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(other, { recursive: true, force: true })
  }
})
