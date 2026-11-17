/**
 * tmsync 工作区 watcher：只监听受管目录，防抖后发布相对路径。
 *
 * - 优先递归 fs.watch；不支持时退化为逐子目录非递归 watch（上限 256）。
 * - pause/resume 用于服务端批量写（pull/push/rebase）期间抑制事件。
 */
import fs from 'node:fs'
import path from 'node:path'

export const MANAGED_DIRS = ['requirements', 'cases', 'plans', 'defects', 'reports']

const IGNORED_SEGMENTS = new Set(['.tmsync', '.git', 'node_modules'])
const MAX_FALLBACK_DIRS = 256

function normalizeRelative(value) {
  return String(value).replace(/\\/g, '/').replace(/^\/+/, '')
}

function ignored(relative) {
  const segments = normalizeRelative(relative).split('/')
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return true
  const name = segments.at(-1) || ''
  if (name === '.DS_Store') return true
  if (name.startsWith('~$')) return true
  if (name.endsWith('.swp') || name.endsWith('.tmp')) return true
  return false
}

function accept(relative) {
  const normalized = normalizeRelative(relative)
  if (normalized === '' || ignored(normalized)) return false
  return normalized.toLowerCase().endsWith('.md')
}

function walkDirs(root, limit = MAX_FALLBACK_DIRS) {
  const out = []
  const stack = [root]
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop()
    out.push(current)
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (IGNORED_SEGMENTS.has(entry.name)) continue
      stack.push(path.join(current, entry.name))
      if (out.length + stack.length >= limit) break
    }
  }
  return out
}

export function createWorkspaceWatcher({
  root,
  projectId,
  debounceMs = 300,
  onEvent = () => {},
  onError = () => {},
  log = () => {},
  watch = fs.watch,
  now = () => Date.now(),
} = {}) {
  const workspace = path.resolve(root)
  const watchers = []
  const pending = new Set()
  let timer = null
  let closed = false
  let paused = false
  let suppressUntil = 0
  let errorReported = false
  let timerHandle = null

  const delay = Math.max(100, Math.min(2000, Number(debounceMs) || 300))

  function reportError(error, where) {
    if (errorReported) return
    errorReported = true
    try {
      log(`[tmsync] watcher ${where} failed: ${error?.message || error}`)
      onError(error, where)
    } catch { /* ignore */ }
  }

  function flush() {
    timer = null
    timerHandle = null
    if (closed) return
    if (paused || now() < suppressUntil) {
      pending.clear()
      return
    }
    const paths = [...pending].slice(0, 20)
    pending.clear()
    if (paths.length === 0) return
    try {
      onEvent({ projectId: String(projectId), paths })
    } catch (error) {
      log(`[tmsync] watcher event handler failed: ${error?.message || error}`)
    }
  }

  function queue(relative) {
    if (closed || paused || now() < suppressUntil) return
    const normalized = normalizeRelative(relative)
    if (!accept(normalized)) return
    if (pending.size >= 200) pending.delete(pending.values().next().value)
    pending.add(normalized)
    if (timer !== null) return
    timer = setTimeout(flush, delay)
    timerHandle = timer
    timer.unref?.()
  }

  function watchOne(directory, prefix, recursive) {
    let watcher
    try {
      watcher = watch(directory, { recursive }, (_event, filename) => {
        if (closed || filename === null || filename === undefined) return
        const name = normalizeRelative(String(filename))
        if (name === '') return
        const relative = prefix ? `${prefix}/${name}` : name
        if (normalizeRelative(relative).split('/').some((segment) => IGNORED_SEGMENTS.has(segment))) return
        queue(relative)
      })
    } catch (error) {
      return false
    }
    watcher.on?.('error', (error) => {
      reportError(error, 'runtime')
      try { watcher.close() } catch { /* ignore */ }
    })
    watchers.push(watcher)
    return true
  }

  function startDir(directory, prefix) {
    if (watchOne(directory, prefix, true)) return
    const fallback = walkDirs(directory)
    if (fallback.length === 0) {
      reportError(new Error(`cannot watch ${directory}`), 'start')
      return
    }
    let ok = 0
    for (const sub of fallback) {
      const relative = normalizeRelative(path.relative(workspace, sub))
      if (watchOne(sub, relative, false)) ok += 1
    }
    if (ok === 0) reportError(new Error(`cannot watch ${directory}`), 'start')
    else if (ok < fallback.length) reportError(new Error(`partial watch ${directory}`), 'start')
  }

  for (const dir of MANAGED_DIRS) {
    const full = path.join(workspace, dir)
    try {
      if (!fs.statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    startDir(full, dir)
  }

  function pause() {
    paused = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    timerHandle = null
    pending.clear()
  }

  function resume({ graceMs = 300 } = {}) {
    paused = false
    const grace = Math.max(0, Math.min(5000, Number(graceMs) || 0))
    suppressUntil = now() + grace
  }

  function close() {
    if (closed) return
    closed = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    timerHandle = null
    pending.clear()
    for (const watcher of watchers.splice(0)) {
      try { watcher.close() } catch { /* ignore */ }
    }
  }

  function stats() {
    return { watchers: watchers.length, pending: pending.size, paused, closed }
  }

  return { pause, resume, close, stats, hasTimer: () => timerHandle !== null }
}
