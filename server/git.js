/** Git 检测与检查点：repo-root 门禁、排除插件数据、文件预览、禁用 hooks/GPG。 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BoundedMap } from './bounded.js'

const execFileAsync = promisify(execFile)
const CACHE_MS = 5_000
const infoCache = new BoundedMap({ maxEntries: 32, ttlMs: () => CACHE_MS })

export function gitCacheStats() {
  return infoCache.stats()
}

export function resetGitCache() {
  infoCache.clear('dispose')
}

export class GitError extends Error {
  constructor(message, { code = 'git-error', hint, detail } = {}) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.hint = hint
    this.detail = detail
  }
}

export function normalizePath(value, { caseInsensitive = process.platform === 'win32' } = {}) {
  const normalized = path.resolve(String(value || '')).replace(/[\\/]+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

const GIT_ENV_DROP = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
]

async function runGit(args, cwd, { timeout = 20_000 } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const key of GIT_ENV_DROP) delete env[key]
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env,
    })
    return { ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
      message: error?.message || String(error),
    }
  }
}

function parseStatus(text) {
  const records = String(text || '').split('\0').filter(Boolean)
  const stagedFiles = []
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const record of records) {
    if (record.length < 3) continue
    const code = record.slice(0, 2)
    const file = record.slice(3)
    if (code === '??') {
      untracked += 1
      continue
    }
    if (code[0] !== ' ') {
      staged += 1
      if (stagedFiles.length < 200) stagedFiles.push({ status: code[0], path: file })
    }
    if (code[1] !== ' ') unstaged += 1
  }
  return { staged, unstaged, untracked, stagedFiles }
}

function sanitizeMessage(message, projectId) {
  const fallback = `tmsync checkpoint: ${projectId || 'workspace'} ${new Date().toISOString()}`
  const text = String(message || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return text || fallback
}

function cacheFile(root) {
  return path.join(path.resolve(root), '.tmsync', 'cache', 'git.json')
}

async function readCheckpoints(root) {
  try {
    const raw = JSON.parse(await fs.readFile(cacheFile(root), 'utf8'))
    return Array.isArray(raw?.checkpoints) ? raw.checkpoints : []
  } catch {
    return []
  }
}

async function writeCheckpoint(root, entry, retention = 5) {
  try {
    const checkpoints = [entry, ...(await readCheckpoints(root))].slice(0, Math.max(1, retention))
    await fs.mkdir(path.dirname(cacheFile(root)), { recursive: true })
    await fs.writeFile(cacheFile(root), `${JSON.stringify({ schemaVersion: 1, checkpoints }, null, 2)}\n`, 'utf8')
  } catch {
    // 检查点缓存失败不影响提交
  }
}

export async function gitInfo(root, { cacheMs = CACHE_MS } = {}) {
  const workspace = path.resolve(root)
  const cached = cacheMs > 0 ? infoCache.get(workspace) : undefined
  if (cached && Date.now() - cached.at < cacheMs) return cached.value

  const base = {
    isRepo: false,
    repoRoot: null,
    repoRootMatches: false,
    branch: null,
    detached: false,
    head: null,
    dirty: null,
    stagedFiles: [],
    lastCommitAt: null,
    checkpoints: [],
    error: null,
  }
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], workspace)
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    const value = { ...base, checkpoints: await readCheckpoints(workspace), error: { code: 'not-a-repo', message: '不是 Git 仓库' } }
    infoCache.set(workspace, { at: Date.now(), value })
    return value
  }
  const top = await runGit(['rev-parse', '--show-toplevel'], workspace)
  const repoRoot = top.ok ? top.stdout.trim() : ''
  const matches = Boolean(repoRoot) && normalizePath(repoRoot) === normalizePath(workspace)
  const branchResult = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspace)
  const headResult = await runGit(['rev-parse', '--short', 'HEAD'], workspace)
  const statusResult = await runGit(['status', '--porcelain=v1', '-z'], workspace)
  const logResult = await runGit(['log', '-1', '--format=%cI'], workspace)
  const dirty = statusResult.ok ? parseStatus(statusResult.stdout) : null
  const value = {
    isRepo: true,
    repoRoot: repoRoot ? path.normalize(repoRoot) : null,
    repoRootMatches: matches,
    branch: branchResult.ok ? branchResult.stdout.trim() : null,
    detached: !branchResult.ok,
    head: headResult.ok ? headResult.stdout.trim() : null,
    dirty,
    stagedFiles: dirty?.stagedFiles || [],
    lastCommitAt: logResult.ok ? logResult.stdout.trim() || null : null,
    checkpoints: await readCheckpoints(workspace),
    error: matches ? null : { code: 'repo-root-mismatch', message: '仓库根与工作区根不一致' },
  }
  infoCache.set(workspace, { at: Date.now(), value })
  return value
}

export async function gitCheckpoint({ root, message, confirm, projectId, dataDir: dataDirOption, retention = 5 } = {}) {
  if (confirm !== true) throw new GitError('Git 检查点必须显式确认（confirm: true）', { code: 'confirm-required' })
  const workspace = path.resolve(root)
  const info = await gitInfo(workspace, { cacheMs: 0 })
  if (!info.isRepo) throw new GitError('不是 Git 仓库', { code: 'not-a-repo', hint: '请先在工作区 git init' })
  if (!info.repoRootMatches) {
    throw new GitError('仓库根与工作区根不一致，拒绝提交', {
      code: 'repo-root-mismatch',
      hint: `仓库根：${info.repoRoot || '未知'}；工作区：${workspace}`,
    })
  }

  const args = ['-c', 'core.hooksPath=', 'add', '-A', '--', '.', ':(exclude).tmsync']
  const dataDir = dataDirOption ? path.resolve(dataDirOption) : (process.env.TMSYNC_DATA_DIR ? path.resolve(process.env.TMSYNC_DATA_DIR) : null)
  if (dataDir) {
    const relative = path.relative(workspace, dataDir)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      args.push(`:(exclude)${relative.split(path.sep).join('/')}`)
    }
  }
  const add = await runGit(args, workspace)
  if (!add.ok) throw new GitError('git add 失败', { code: 'git-add-failed', detail: add.stderr || add.message })

  const status = await runGit(['status', '--porcelain=v1', '-z'], workspace)
  const staged = status.ok ? parseStatus(status.stdout) : null
  const diff = await runGit(['diff', '--cached', '--quiet'], workspace)
  if (diff.ok) {
    return { ok: true, created: false, commit: null, branch: info.branch, files: 0, preview: [], message: '没有可提交的变更' }
  }
  if (diff.code !== 1) {
    throw new GitError('git diff --cached 失败', { code: 'git-diff-failed', detail: diff.stderr || diff.message })
  }

  const text = sanitizeMessage(message, projectId)
  const commit = await runGit(
    ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '-m', text],
    workspace,
  )
  if (!commit.ok) {
    throw new GitError('git commit 失败', {
      code: 'git-commit-failed',
      hint: /user\.name|user\.email|identity/i.test(commit.stderr || commit.message || '')
        ? '请先配置 git user.name / user.email'
        : undefined,
      detail: (commit.stderr || commit.message || '').trim(),
    })
  }
  const head = await runGit(['rev-parse', '--short', 'HEAD'], workspace)
  const sha = head.ok ? head.stdout.trim() : null
  const entry = {
    at: new Date().toISOString(),
    commit: sha,
    branch: info.branch,
    files: staged?.staged || 0,
    message: text,
  }
  await writeCheckpoint(workspace, entry, retention)
  infoCache.delete(workspace)
  return {
    ok: true,
    created: true,
    commit: sha,
    branch: info.branch,
    files: staged?.staged || 0,
    preview: staged?.stagedFiles || [],
    message: text,
  }
}
