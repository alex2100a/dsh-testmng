/**
 * tmsync 服务门面：配置、项目、工作区、状态、树、实体、拉取、校验。
 * 宿主路由与 preset 工具共用这一层。
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { checkConnection } from './mcp.js'
import { callTool, clearToolsCache, listTools, toolsCacheStats } from './mcp.js'
import { maskToken, maskedConfig, readConfig, writeConfig } from './config.js'
import { createTestCaseGenAdapter } from './platform/testcasegen.js'
import {
  computeRemoteSnapshot,
  computeStatus,
  ensureWorkspaceReadme,
  initWorkspace,
  loadState,
  pullWorkspace,
  readBaseline,
  readState,
  readWorkspace,
  scanLocal,
  workspacePaths,
  writeState,
} from './workspace.js'
import { contentHash, isEditableKind, KIND_META, KINDS, validateEntity, renderFile, relativePathFor } from './codec.js'
import { safeJoin, writeAtomic } from './files.js'
import { applyPush, planPush, resolveConflict } from './push.js'
import { appendLog, readLogs } from './audit.js'
import { gitCacheStats, gitCheckpoint, gitInfo, resetGitCache } from './git.js'
import { buildLinkCache, cacheUsable, normalizeIds, readLinkCache } from './links.js'
import { detectLegacy, patchLegacyCache, writeLegacyCache } from './legacy.js'
import { createEventHub, createSseResponder, DEFAULT_EVENTS } from './events.js'
import { createWorkspaceWatcher } from './watcher.js'
import { classifyDshVersion } from './compat.js'
import { BoundedMap, approxJsonBytes } from './bounded.js'
import { VERSION } from './version.js'

function statusRank(status) {
  return {
    conflict: 100, invalid: 90, 'local-deleted': 80, 'remote-deleted': 75,
    'readonly-modified': 70, 'local-modified': 60, 'remote-modified': 50,
    'local-added': 40, 'remote-new': 30, untracked: 20, 'remote-unknown': 10, same: 0,
  }[status] ?? 0
}

function folderNode(key, name, extra = {}) {
  return { key, type: 'folder', name, status: 'same', counts: {}, children: [], ...extra }
}

function addCounts(node, entry) {
  node.counts[entry.status] = (node.counts[entry.status] || 0) + 1
  if (statusRank(entry.status) > statusRank(node.status)) node.status = entry.status
}

function aggregateCounts(node) {
  if (!node || node.type === 'entity') return
  node.counts = {}
  node.status = 'same'
  for (const child of node.children) {
    if (child.type === 'entity') addCounts(node, child.entry)
    else {
      aggregateCounts(child)
      for (const [status, count] of Object.entries(child.counts)) node.counts[status] = (node.counts[status] || 0) + count
      if (statusRank(child.status) > statusRank(node.status)) node.status = child.status
    }
  }
}

export function diffEntities(kind, base, local, remote) {
  const fields = new Set([...Object.keys(base || {}), ...Object.keys(local || {}), ...Object.keys(remote || {})])
  const out = []
  const excluded = new Set([
    'file', 'localHash', 'remote', 'kind', 'planCases', 'planCasesComplete',
    'baseRequirementIds', 'linksArmed', 'linksUnknown', 'linksUpdatedAt',
    'assigneeId', 'assigneeName', 'statusComment', 'sectionWarnings', 'parseWarnings',
    'legacy', 'legacyReason', 'needsFollowup', 'requirementIds',
  ])
  for (const field of [...fields].sort()) {
    if (excluded.has(field)) continue
    const b = base?.[field]
    const l = local?.[field]
    const r = remote?.[field]
    const same = JSON.stringify(b) === JSON.stringify(l) && JSON.stringify(b) === JSON.stringify(r)
    if (same) continue
    out.push({ field, base: b, local: l, remote: r, state: JSON.stringify(l) === JSON.stringify(b) ? 'remote' : JSON.stringify(r) === JSON.stringify(b) ? 'local' : 'conflict' })
  }
  return out
}

function buildTree(status, kind) {
  const entries = status.entries.filter((entry) => entry.kind === kind)
  if (kind === 'requirement' || kind === 'testcase') {
    const catalogs = status.catalogs[kind] ?? []
    const nodes = new Map()
    const roots = []
    for (const item of catalogs) {
      const node = folderNode(`catalog:${item.id}`, item.name, { catalogId: String(item.id), path: item.name })
      nodes.set(String(item.id), node)
    }
    for (const item of catalogs) {
      const node = nodes.get(String(item.id))
      const parent = item.parentId === null || item.parentId === undefined ? null : nodes.get(String(item.parentId))
      if (parent) { parent.children.push(node); node.path = `${parent.path}/${node.name}` } else roots.push(node)
    }
    const uncategorized = folderNode('catalog:_uncategorized', '未分类', { catalogId: null, path: '_uncategorized' })
    for (const entry of entries) {
      const node = entry.catalogId ? nodes.get(String(entry.catalogId)) : null
      const target = node ?? uncategorized
      const entityNode = { key: `entity:${kind}:${entry.id ?? entry.localId ?? entry.path}`, type: 'entity', name: `${entry.code ? entry.code + ' ' : ''}${entry.title || entry.path}`, entry }
      target.children.push(entityNode)
    }
    if (uncategorized.children.length) roots.push(uncategorized)
    for (const node of nodes.values()) {
      node.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
    }
    for (const node of [...nodes.values(), uncategorized]) aggregateCounts(node)
    roots.sort((a, b) => a.name.localeCompare(b.name))
    return roots
  }
  const groups = new Map()
  for (const entry of entries) {
    const key = entry.status === 'invalid' ? '无效/未跟踪' : entry.status === 'same' ? '一致' : entry.status
    if (!groups.has(key)) groups.set(key, folderNode(`group:${key}`, key))
    groups.get(key).children.push({ key: `entity:${kind}:${entry.id ?? entry.localId ?? entry.path}`, type: 'entity', name: `${entry.code ? entry.code + ' ' : ''}${entry.title || entry.path}`, entry })
    addCounts(groups.get(key), entry)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const DEFAULT_CACHE_LIMITS = {
  statusEntries: 32,
  statusBytes: 8 * 1024 * 1024,
  inflightEntries: 16,
  planEntries: 32,
  planBytes: 4 * 1024 * 1024,
  planTtlMs: 600_000,
  watcherEntries: 8,
  watcherTtlMs: 1_800_000,
  revisionEntries: 256,
}

export function createTmsyncService({ dataDir, log = () => {}, dshVersion, cacheLimits } = {}) {
  const compatibility = classifyDshVersion(dshVersion, { pluginVersion: VERSION })
  let configCache = null
  let configAt = 0
  let lastConfig = null
  let statusEpoch = 0
  let statusTtlMs = 300_000
  let disposed = false
  let liveCacheLimits = { ...DEFAULT_CACHE_LIMITS, ...(cacheLimits || {}) }
  const statusSnapshots = new BoundedMap({
    maxEntries: () => liveCacheLimits.statusEntries,
    maxBytes: () => liveCacheLimits.statusBytes,
    sizeOf: (value) => approxJsonBytes(value),
    ttlMs: () => statusTtlMs,
  })
  const statusInflight = new BoundedMap({ maxEntries: () => liveCacheLimits.inflightEntries })
  const plans = new BoundedMap({
    maxEntries: () => liveCacheLimits.planEntries,
    maxBytes: () => liveCacheLimits.planBytes,
    sizeOf: (value) => approxJsonBytes(value),
    ttlMs: () => liveCacheLimits.planTtlMs,
    onEvict: (_value, _key, reason) => log(`[tmsync] push plan evicted (${reason})`),
  })
  const projectRevisions = new BoundedMap({ maxEntries: () => liveCacheLimits.revisionEntries })
  const watchers = new BoundedMap({
    maxEntries: () => liveCacheLimits.watcherEntries,
    onEvict: (watcher) => { try { watcher.close() } catch { /* ignore */ } },
  })
  const watcherAccess = new Map()

  const hub = createEventHub({ ...DEFAULT_EVENTS, log })

  async function config() {
    if (configCache && Date.now() - configAt < 5_000) return configCache
    configCache = await readConfig(dataDir, { log })
    configAt = Date.now()
    lastConfig = configCache
    liveCacheLimits = { ...DEFAULT_CACHE_LIMITS, ...(configCache.workbench?.cache || {}) }
    statusTtlMs = configCache.workbench?.statusTtlMs || statusTtlMs
    try {
      hub.configure({
        bufferSize: configCache.workbench?.events?.bufferSize,
        maxClients: configCache.workbench?.events?.maxClients,
      })
    } catch { /* ignore */ }
    return configCache
  }

  const adapter = createTestCaseGenAdapter({ readConfig: config, callTool, log })

  function bumpRevision(projectId) {
    const key = String(projectId)
    const next = (projectRevisions.get(key) || 0) + 1
    projectRevisions.set(key, next)
    return next
  }

  function publish(kind, { projectId, reason, paths } = {}) {
    const id = projectId === undefined ? undefined : String(projectId)
    return hub.publish({
      kind,
      ...(id === undefined ? {} : { projectId: id }),
      ...(reason === undefined ? {} : { reason }),
      ...(paths === undefined ? {} : { paths }),
      ...(id === undefined ? {} : { revision: projectRevisions.get(id) || 0 }),
    })
  }

  function ensureWatcher(projectId, root) {
    if (disposed || lastConfig?.workbench?.realtime === false) return
    const key = String(projectId)
    if (watchers.has(key)) {
      watcherAccess.set(key, Date.now())
      return
    }
    const watcher = createWorkspaceWatcher({
      root,
      projectId: key,
      debounceMs: lastConfig?.workbench?.watchDebounceMs ?? 300,
      log,
      onEvent: ({ paths }) => {
        bumpRevision(key)
        publish('local', { projectId: key, reason: 'watch', paths })
      },
      onError: (error, where) => {
        publish('watch-error', {
          projectId: key,
          reason: `${where || 'watch'}:${String(error?.message || error).slice(0, 160)}`,
        })
      },
    })
    watchers.set(key, watcher)
    watcherAccess.set(key, Date.now())
    sweepWatchers()
  }

  function sweepWatchers() {
    const now = Date.now()
    const ttl = liveCacheLimits.watcherTtlMs
    for (const key of watchers.keys()) {
      const last = watcherAccess.get(key) || 0
      if (now - last <= ttl) continue
      watcherAccess.delete(key)
      watchers.delete(key)
    }
  }

  function pauseWatcher(projectId) {
    try { watchers.get(String(projectId))?.pause() } catch { /* ignore */ }
  }

  function resumeWatcher(projectId) {
    try { watchers.get(String(projectId))?.resume({ graceMs: 300 }) } catch { /* ignore */ }
  }

  function closeWatcher(projectId) {
    const key = String(projectId)
    watcherAccess.delete(key)
    watchers.delete(key)
  }

  function setRealtime(enabled) {
    if (enabled) return
    watcherAccess.clear()
    watchers.clear('realtime-off')
  }

  function eventsConfig() {
    const events = lastConfig?.workbench?.events || {}
    return { ...DEFAULT_EVENTS, ...events }
  }

  function openEvents(req, res) {
    return createSseResponder({ hub, eventsConfig, log })(req, res)
  }

  function subscribeEvents(send, options = {}) {
    return hub.subscribe(send, options)
  }

  function invalidate(projectId, reason) {
    configCache = null
    statusEpoch += 1
    if (projectId === undefined) {
      statusSnapshots.clear()
      statusInflight.clear()
      publish('config', { reason: reason || 'config' })
      return
    }
    const id = String(projectId)
    statusSnapshots.delete(id)
    statusInflight.delete(id)
    bumpRevision(id)
    publish('status', { projectId: id, reason: reason || 'status' })
  }

  function cacheStats() {
    sweepWatchers()
    return {
      statusSnapshots: statusSnapshots.stats(),
      statusInflight: statusInflight.stats(),
      plans: plans.stats(),
      watchers: watchers.stats(),
      projectRevisions: projectRevisions.stats(),
      projects: adapter.projectCacheStats?.() ?? null,
      git: gitCacheStats(),
      mcp: toolsCacheStats(),
    }
  }

  async function info() {
    try {
      const cfg = await config()
      const projects = Object.keys(cfg.projects || {})
      return {
        ok: true,
        version: VERSION,
        dataDir,
        platform: { kind: cfg.platform.kind, platformUrl: cfg.platform.platformUrl, mcpUrl: cfg.platform.mcpUrl, hasToken: Boolean(cfg.platform.token) },
        projectCount: projects.length,
        workspaceCount: projects.filter((id) => cfg.projects[id]?.localRoot).length,
        realtime: cfg.workbench.realtime !== false,
        compatibility,
        events: hub.stats(),
        watchers: watchers.size,
        cache: cacheStats(),
      }
    } catch (error) {
      if (String(error?.code || '').startsWith('config_')) {
        return {
          ok: false,
          version: VERSION,
          dataDir,
          configError: { code: error.code, message: error.message, hint: error.hint },
          platform: null,
          projectCount: 0,
          workspaceCount: 0,
          realtime: false,
          compatibility,
          events: hub.stats(),
          watchers: watchers.size,
          cache: cacheStats(),
        }
      }
      throw error
    }
  }

  async function overview() {
    const infoValue = await info()
    const configValue = await getConfig()
    const projects = configValue.projects || {}
    return {
      info: infoValue,
      config: configValue,
      counts: {
        projects: Object.keys(projects).length,
        workspaces: Object.values(projects).filter((project) => project?.localRoot).length,
      },
      configError: infoValue.configError ?? configValue.configError ?? null,
    }
  }

  async function getConfig() {
    try {
      return maskedConfig(await config())
    } catch (error) {
      if (!String(error?.code || '').startsWith('config_')) throw error
      return {
        schemaVersion: 1,
        platform: { kind: 'testcasegen', platformUrl: '', mcpUrl: '', token: '', hasToken: false },
        workbench: {},
        sync: {},
        projects: {},
        configError: { code: error.code, message: error.message, hint: error.hint },
      }
    }
  }

  async function saveConfig(patch) {
    const cfg = await writeConfig(dataDir, patch)
    lastConfig = cfg
    liveCacheLimits = { ...DEFAULT_CACHE_LIMITS, ...(cfg.workbench?.cache || {}) }
    statusTtlMs = cfg.workbench?.statusTtlMs || statusTtlMs
    clearToolsCache()
    try {
      hub.configure({
        bufferSize: cfg.workbench.events?.bufferSize,
        maxClients: cfg.workbench.events?.maxClients,
      })
    } catch { /* ignore */ }
    setRealtime(cfg.workbench.realtime !== false)
    invalidate(undefined, 'config')
    return maskedConfig(cfg)
  }

  async function testConnection() {
    const cfg = await config()
    if (!cfg.platform.mcpUrl) return { ok: false, error: { message: '未配置 MCP 地址' } }
    clearToolsCache()
    const result = await checkConnection({ mcpUrl: cfg.platform.mcpUrl, token: cfg.platform.token })
    clearToolsCache()
    return result
  }

  async function listProjects() {
    const cfg = await config()
    const projects = await adapter.listProjects({ refresh: true })
    return projects.map((project) => {
      const mapping = cfg.projects?.[project.id]
      return {
        ...project,
        workspace: mapping ? { localRoot: mapping.localRoot, linkedAt: mapping.linkedAt } : null,
      }
    })
  }

  async function listWorkspaces() {
    const cfg = await config()
    const out = []
    for (const [projectId, mapping] of Object.entries(cfg.projects || {})) {
      let workspace = null
      let exists = false
      try {
        workspace = await readWorkspace(mapping.localRoot)
        exists = Boolean(workspace)
      } catch { /* ignore */ }
      out.push({ projectId, ...mapping, exists, workspace, git: mapping.localRoot ? await gitInfo(mapping.localRoot) : { isRepo: false } })
    }
    return out
  }

  async function linkWorkspace({ projectId, root }) {
    const id = String(projectId || '')
    if (!id) throw new Error('projectId 不能为空')
    if (!path.isAbsolute(String(root || ''))) throw new Error('本地目录必须是绝对路径')
    const resolved = path.resolve(root)
    const info = await fs.stat(resolved).catch(() => null)
    if (info && !info.isDirectory()) throw new Error('本地路径不是目录')
    if (!info) await fs.mkdir(resolved, { recursive: true })
    const project = await adapter.resolveProject(id)
    const cfg = await config()
    const owner = Object.entries(cfg.projects || {}).find(([pid, mapping]) => pid !== id && path.resolve(mapping.localRoot) === resolved)
    if (owner) throw new Error(`目录已绑定项目 ${owner[0]}`)
    const workspace = await initWorkspace(resolved, {
      projectId: project.id,
      projectName: project.name,
      projectCode: project.code,
      platformKind: 'testcasegen',
      platformUrl: cfg.platform.platformUrl,
    })
    await writeConfig(dataDir, {
      projects: {
        ...cfg.projects,
        [project.id]: {
          name: project.name,
          code: project.code,
          localRoot: resolved,
          platformKind: 'testcasegen',
          linkedAt: new Date().toISOString(),
        },
      },
    })
    invalidate(project.id, 'workspace')
    publish('config', { reason: 'workspace' })
    return { project, workspace, root: resolved }
  }

  async function unlinkWorkspace(projectId) {
    const id = String(projectId || '')
    const cfg = await config()
    if (!cfg.projects?.[id]) return { ok: true, removed: false }
    const projects = { ...cfg.projects }
    delete projects[id]
    await writeConfig(dataDir, { projects })
    closeWatcher(id)
    invalidate(id, 'workspace')
    publish('config', { reason: 'workspace' })
    return { ok: true, removed: true, root: cfg.projects[id].localRoot }
  }

  async function workspaceForCwd(cwd) {
    let current = path.resolve(cwd)
    for (let i = 0; i < 4; i += 1) {
      const workspace = await readWorkspace(current)
      if (workspace) {
        const cfg = await config()
        const mapping = cfg.projects?.[workspace.projectId]
        if (!mapping) throw new Error(`工作区项目 ${workspace.projectId} 未在配置中关联`)
        try {
          // 旧工作区 README 里的平台内部 ID 在首次会话时就地清理；不阻塞会话。
          await ensureWorkspaceReadme(current, workspace, { projectCode: mapping.code })
        } catch (error) {
          log(`[tmsync] README 迁移失败 ${current}: ${error.message}`)
        }
        return { root: current, workspace, projectId: workspace.projectId, mapping, config: cfg }
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return null
  }

  async function fetchRemoteSnapshot(id, cfg) {
    const epoch = statusEpoch
    const existing = statusInflight.get(id)
    if (existing && existing.epoch === epoch) return { snapshot: await existing.promise, epoch }
    const promise = adapter.withClient(
      () => computeRemoteSnapshot({
        adapter,
        projectId: id,
        pullKinds: cfg.sync.pullKinds,
        concurrency: cfg.workbench.concurrency,
        log,
      }),
      { concurrency: cfg.workbench.concurrency },
    )
    const record = { epoch, promise }
    statusInflight.set(id, record)
    const cleanup = () => { if (statusInflight.get(id) === record) statusInflight.delete(id) }
    promise.then(cleanup, cleanup)
    return { snapshot: await promise, epoch }
  }

  async function snapshotFor(id, cfg, refresh) {
    const cached = statusSnapshots.get(id)
    if (!refresh && cached && cached.epoch === statusEpoch) {
      return cached.value
    }
    const first = await fetchRemoteSnapshot(id, cfg)
    if (first.epoch === statusEpoch) {
      statusSnapshots.set(id, { at: Date.now(), epoch: first.epoch, value: first.snapshot })
      bumpRevision(id)
      return first.snapshot
    }
    // 加载期间配置/项目被 invalidate：丢弃旧结果，用新配置重试一次
    const freshConfig = await config()
    const second = await fetchRemoteSnapshot(id, freshConfig)
    if (second.epoch !== statusEpoch) throw new Error('状态刷新期间配置持续变化，请稍后重试')
    statusSnapshots.set(id, { at: Date.now(), epoch: second.epoch, value: second.snapshot })
    bumpRevision(id)
    return second.snapshot
  }

  async function status(projectId, { refresh = false, watch = false } = {}) {
    const id = String(projectId || '')
    const cfg = await config()
    sweepWatchers()
    const mapping = cfg.projects?.[id]
    if (!mapping?.localRoot) throw new Error(`项目 ${id} 未关联本地工作区`)
    if (watch) ensureWatcher(id, mapping.localRoot)
    const remoteSnapshot = await snapshotFor(id, cfg, refresh)
    const localScan = await scanLocal(mapping.localRoot)
    const value = await computeStatus({
      root: mapping.localRoot,
      adapter,
      projectId: id,
      editableKinds: cfg.sync.editableKinds,
      pullKinds: cfg.sync.pullKinds,
      concurrency: cfg.workbench.concurrency,
      localScan,
      remoteSnapshot,
    })
    await persistLegacy(mapping.localRoot, id, value, localScan)
    return {
      ...value,
      revision: projectRevisions.get(id) || 0,
      realtime: cfg.workbench.realtime !== false,
    }
  }

  async function persistLegacy(root, projectId, value, localScan) {
    try {
      const changes = {}
      for (const entry of value.entries) {
        if (!['local-modified', 'conflict', 'readonly-modified'].includes(entry.status)) continue
        const key = String(entry.id ?? entry.localId ?? '')
        if (!key) continue
        const local = localScan[entry.kind]?.byId.get(key) || null
        if (!local) continue
        const base = await readBaseline(root, entry.kind, key)
        const detection = detectLegacy(entry.kind, base, local)
        entry.legacy = detection.legacy
        entry.legacyReason = detection.reason
        changes[key] = detection.legacy ? { legacy: true, reason: detection.reason } : null
      }
      if (Object.keys(changes).length) await patchLegacyCache(root, { projectId, changes })
    } catch (error) {
      log(`[tmsync] legacy 标记更新失败：${error.message}`)
    }
  }

  async function tree(projectId, kind) {
    const value = await status(projectId, { watch: true })
    if (!KINDS.includes(kind)) throw new Error(`未知类型 ${kind}`)
    return {
      projectId: String(projectId),
      kind,
      nodes: buildTree(value, kind),
      summary: value.summary,
      remoteCheckedAt: value.remoteCheckedAt,
      revision: value.revision,
      realtime: value.realtime,
    }
  }

  async function entity(projectId, kind, id, { view = 'local' } = {}) {
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const root = mapping.localRoot
    const local = (await scanLocal(root))[kind]?.byId.get(String(id)) ?? null
    const base = await readBaseline(root, kind, id)
    let remote = null
    if (view === 'remote' || view === 'diff') {
      try {
        remote = await adapter.withClient(
          () => adapter.getEntity(String(projectId), kind, id),
          { concurrency: 1 },
        )
      } catch (error) {
        remote = { error: error.message }
      }
    }
    const result = { kind, id: String(id), local, base, remote, editable: isEditableKind(kind, cfg.sync.editableKinds), readOnly: Boolean(KIND_META[kind]?.readOnly) }
    if (kind === 'testcase') {
      const ttl = cfg.sync.links?.cacheTtlMs ?? 300_000
      const cache = await readLinkCache(root, { projectId: String(projectId) })
      const state = await loadState(root, 'testcase')
      const entry = state.entities[String(id)] || {}
      const fresh = cacheUsable(cache, { projectId: String(projectId), maxAgeMs: ttl })
      if (remote && !remote.error && cache?.complete === true && fresh) {
        remote.requirementIds = normalizeIds(cache.byCase[String(id)] ?? [])
        remote.linksUnknown = false
      }
      result.links = {
        local: normalizeIds(local?.requirementIds),
        base: entry.baseRequirementIds === undefined || entry.baseRequirementIds === null ? null : normalizeIds(entry.baseRequirementIds),
        remote: cache?.complete === true ? normalizeIds(cache.byCase[String(id)] ?? []) : null,
        armed: entry.linksArmed === true,
        complete: cache?.complete === true,
        fresh,
        fetchedAt: cache?.fetchedAt || null,
        unknown: local?.linksUnknown === true,
      }
    }
    if (kind === 'test-plan') {
      const state = await loadState(root, 'test-plan')
      const entry = state.entities[String(id)] || {}
      result.planCases = entry.planCases === undefined ? null : entry.planCases
      result.planCasesComplete = entry.planCasesComplete !== false
    }
    if (view === 'diff') {
      result.diff = diffEntities(kind, base, local, remote)
    }
    return result
  }

  async function pull(projectId, { kind, ids, dryRun = true } = {}, onEvent = () => {}) {
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const concurrency = cfg.workbench.concurrency
    pauseWatcher(projectId)
    try {
      const result = await adapter.withClient(() => pullWorkspace({
        root: mapping.localRoot,
        adapter,
        projectId: String(projectId),
        editableKinds: cfg.sync.editableKinds,
        pullKinds: cfg.sync.pullKinds,
        scope: { kind, ids },
        dryRun,
        concurrency,
        linkSync: cfg.sync.links?.enabled !== false,
        linkCacheTtlMs: cfg.sync.links?.cacheTtlMs ?? 300_000,
        onEvent,
      }), { concurrency })
      await appendLog(dataDir, {
        op: 'pull',
        projectId: String(projectId),
        applied: result.applied,
        plan: result.plan,
        written: result.written.length,
        conflicts: result.conflicts.length,
        errors: result.errors.length,
      })
      return result
    } finally {
      resumeWatcher(projectId)
      invalidate(String(projectId), 'pull')
    }
  }

  async function pushPlan(projectId, { kind, ids } = {}) {
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const concurrency = cfg.workbench.concurrency
    const plan = await adapter.withClient(() => planPush({
      root: mapping.localRoot,
      adapter,
      projectId: String(projectId),
      editableKinds: cfg.sync.editableKinds,
      scope: { kind, ids },
      concurrency,
      linkSync: cfg.sync.links?.enabled !== false,
      linkCacheTtlMs: cfg.sync.links?.cacheTtlMs ?? 300_000,
    }), { concurrency })
    plans.set(plan.planId, { ...plan, createdAt: Date.now(), projectId: String(projectId) })
    return plan
  }

  async function push(projectId, { planId, confirm } = {}, onEvent = () => {}) {
    if (confirm !== true) throw new Error('推送必须显式确认（confirm: true）')
    const id = String(planId || '')
    const plan = plans.get(id)
    if (!plan) throw new Error('推送计划不存在或已使用；请重新生成')
    if (plan.projectId !== String(projectId)) throw new Error('推送计划与项目不匹配')
    if (Date.parse(plan.expiresAt) < Date.now()) {
      plans.delete(id)
      throw new Error('推送计划已过期；请重新生成')
    }
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const concurrency = cfg.workbench.concurrency
    plans.delete(id)
    pauseWatcher(projectId)
    try {
      const result = await adapter.withClient(() => applyPush({
        root: mapping.localRoot,
        adapter,
        projectId: String(projectId),
        plan,
        editableKinds: cfg.sync.editableKinds,
        onEvent,
      }), { concurrency })
      await appendLog(dataDir, {
        op: 'push',
        projectId: String(projectId),
        created: result.created.length,
        updated: result.updated.length,
        conflicts: result.conflicts.length,
        errors: result.errors.length,
        partial: result.partial === true,
        planId: id,
      })
      return result
    } catch (error) {
      await appendLog(dataDir, {
        op: 'push-failed',
        projectId: String(projectId),
        planId: id,
        partial: true,
        message: String(error?.message || error).slice(0, 300),
      })
      throw new Error(`推送计划已消费，请重新生成后再试：${error.message}`)
    } finally {
      resumeWatcher(projectId)
      invalidate(String(projectId), 'push')
    }
  }

  async function resolve(projectId, { kind, id, resolution } = {}) {
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const concurrency = cfg.workbench.concurrency
    pauseWatcher(projectId)
    try {
      const result = await adapter.withClient(() => resolveConflict({
        root: mapping.localRoot,
        adapter,
        projectId: String(projectId),
        kind,
        id,
        resolution,
      }), { concurrency })
      await appendLog(dataDir, { op: 'conflict-resolve', projectId: String(projectId), kind, id: String(id), resolution })
      return result
    } finally {
      resumeWatcher(projectId)
      invalidate(String(projectId), 'resolve')
    }
  }

  async function linksStatus(projectId) {
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const root = mapping.localRoot
    const ttl = cfg.sync.links?.cacheTtlMs ?? 300_000
    const cache = await readLinkCache(root, { projectId })
    const local = await scanLocal(root)
    const state = await loadState(root, 'testcase')
    const entries = []
    for (const entity of local.testcase?.byId.values() ?? []) {
      const key = String(entity.id || entity.localId)
      const entry = state.entities[key] || {}
      const base = entry.baseRequirementIds === undefined ? null : entry.baseRequirementIds
      const remote = cache?.complete === true ? normalizeIds(cache.byCase[key] ?? []) : null
      entries.push({
        id: key,
        code: entity.code,
        title: entity.title,
        path: entity.file,
        local: normalizeIds(entity.requirementIds),
        base: base === null ? null : normalizeIds(base),
        remote,
        armed: entry.linksArmed === true,
        linksUnknown: entity.linksUnknown === true || entry.linksUnknown === true,
      })
    }
    return {
      projectId: String(projectId),
      cache: cache
        ? {
            complete: cache.complete === true,
            fetchedAt: cache.fetchedAt,
            requirements: cache.requirements,
            failed: cache.failed || [],
            fresh: cacheUsable(cache, { projectId, maxAgeMs: ttl }),
          }
        : null,
      ttlMs: ttl,
      entries,
    }
  }

  async function linksRefresh(projectId) {
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const concurrency = cfg.workbench.concurrency
    const cache = await adapter.withClient(
      () => buildLinkCache({ root: mapping.localRoot, adapter, projectId: String(projectId), concurrency, log }),
      { concurrency },
    )
    return {
      complete: cache.complete === true,
      fetchedAt: cache.fetchedAt,
      requirements: cache.requirements,
      failed: cache.failed,
      casesLinked: Object.keys(cache.byCase).length,
    }
  }

  async function linksAdopt(projectId, { ids } = {}) {
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const root = mapping.localRoot
    pauseWatcher(projectId)
    try {
      const cache = await readLinkCache(root, { projectId })
      if (!cache || cache.complete !== true) throw new Error('链接缓存不完整，请先刷新链接')
      const localScan = await scanLocal(root)
      const state = await loadState(root, 'testcase')
      const filter = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null
      const adopted = []
      const skipped = []
      for (const entity of localScan.testcase?.byId.values() ?? []) {
        const key = String(entity.id || entity.localId)
        if (filter && !filter.has(key)) continue
        const entry = state.entities[key]
        if (!entry) {
          skipped.push({ id: key, reason: 'no-baseline' })
          continue
        }
        if (entity.localHash && entry.baseHash && entity.localHash !== entry.baseHash) {
          skipped.push({ id: key, reason: 'local-modified' })
          continue
        }
        const base = await readBaseline(root, 'testcase', key)
        const legacy = detectLegacy('testcase', base, entity)
        if (legacy.legacy || (entity.sectionWarnings?.length || 0) > 0) {
          skipped.push({ id: key, reason: 'legacy-section-invalid' })
          continue
        }
        entity.requirementIds = normalizeIds(cache.byCase[key] ?? [])
        entity.linksUnknown = false
        await writeAtomic(safeJoin(root, entity.file), renderFile('testcase', entity))
        entry.baseRequirementIds = normalizeIds(entity.requirementIds)
        entry.linksArmed = true
        entry.linksUnknown = false
        entry.linksUpdatedAt = cache.fetchedAt
        entry.baseHash = contentHash('testcase', entity)
        adopted.push({ id: key, requirementIds: entity.requirementIds })
      }
      await writeState(root, 'testcase', state)
      if (adopted.length) {
        const changes = Object.fromEntries(adopted.map((item) => [String(item.id), null]))
        await patchLegacyCache(root, { projectId: String(projectId), changes })
      }
      return { adopted, skipped, cacheFetchedAt: cache.fetchedAt }
    } finally {
      resumeWatcher(projectId)
      invalidate(String(projectId), 'links')
    }
  }

  async function planCasesRefresh(projectId, { id } = {}) {
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const concurrency = cfg.workbench.concurrency
    pauseWatcher(projectId)
    try {
      const state = await loadState(mapping.localRoot, 'test-plan')
      const ids = id ? [String(id)] : Object.keys(state.entities)
      const updated = []
      const errors = []
      await adapter.withClient(async () => {
        for (const planId of ids) {
          try {
            const remote = await adapter.getEntity(String(projectId), 'test-plan', planId)
            const entry = state.entities[planId] || { id: planId }
            entry.id = planId
            entry.planCases = remote.planCasesComplete === false ? null : remote.planCases
            entry.planCasesComplete = remote.planCasesComplete !== false
            if (!entry.path) entry.path = relativePathFor('test-plan', remote, { catalogPath: '' })
            state.entities[planId] = entry
            updated.push({ id: planId, planCases: entry.planCases?.length ?? null, complete: entry.planCasesComplete })
          } catch (error) {
            errors.push({ id: planId, message: error.message })
          }
        }
      }, { concurrency })
      await writeState(mapping.localRoot, 'test-plan', state)
      return { updated, errors }
    } finally {
      resumeWatcher(projectId)
      invalidate(String(projectId), 'plan-cases')
    }
  }

  async function rebase(projectId, { kind, id, all = false, confirm, allowLocalOnly = false } = {}) {
    if (confirm !== true) throw new Error('rebase 必须显式确认（confirm: true）')
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const root = mapping.localRoot
    const concurrency = cfg.workbench.concurrency
    pauseWatcher(projectId)
    if (all) {
      try {
        const result = await rebaseAll(root, String(projectId), { allowLocalOnly })
        await appendLog(dataDir, { op: 'rebase-all', projectId: String(projectId), ...result.counts })
        return result
      } finally {
        resumeWatcher(projectId)
        invalidate(String(projectId), 'rebase')
      }
    }
    if (!kind || !KINDS.includes(kind)) throw new Error(`未知类型 ${kind}`)
    if (!id) throw new Error('单实体 rebase 需要 id；state 缺失请使用 all')
    try {
      const current = await status(projectId)
      const key = String(id)
      const entry = current.entries.find((item) => item.kind === kind && String(item.id ?? item.localId) === key)
      if (!entry || (!['local-modified', 'conflict'].includes(entry.status) && !entry.legacy)) {
        throw new Error('该条目当前无需 rebase（仅 local-modified/conflict/legacy）')
      }
      const result = await adapter.withClient(() => resolveConflict({
        root,
        adapter,
        projectId: String(projectId),
        kind,
        id: key,
        resolution: 'remote',
      }), { concurrency })
      await appendLog(dataDir, { op: 'rebase', projectId: String(projectId), kind, id: key })
      return result
    } finally {
      resumeWatcher(projectId)
      invalidate(String(projectId), 'rebase')
    }
  }

  async function rebaseAll(root, projectId, { allowLocalOnly = false } = {}) {
    const paths = workspacePaths(root)
    const localScan = await scanLocal(root)
    const baseline = {}
    let baselineCount = 0
    for (const kind of KINDS) {
      baseline[kind] = new Map()
      let entries = []
      try { entries = await fs.readdir(path.join(paths.baselineDir, kind), { withFileTypes: true }) } catch { entries = [] }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        try {
          const entity = JSON.parse(await fs.readFile(path.join(paths.baselineDir, kind, entry.name), 'utf8'))
          if (!entity?.id) continue
          baseline[kind].set(String(entity.id), entity)
          baselineCount += 1
        } catch {
          // 无法解析的 baseline 不纳入，稍后若影响本地实体则失败
        }
      }
    }
    if (baselineCount === 0) throw new Error('baseline 缺失或为空，无法从 baseline 重建；请从备份恢复 state')

    const localOnly = []
    for (const kind of KINDS) {
      for (const entity of localScan[kind]?.byId.values() ?? []) {
        const id = String(entity.id || '')
        if (!id) continue
        if (!baseline[kind].has(id)) localOnly.push({ kind, id, path: entity.file })
      }
    }
    if (localOnly.length && !allowLocalOnly) {
      throw new Error(`有 ${localOnly.length} 个本地实体缺少 baseline（疑似 state/baseline 丢失）；确认后可用 allowLocalOnly 继续。`)
    }

    const writes = []
    const states = {}
    const now = new Date().toISOString()
    for (const kind of KINDS) {
      const state = { schemaVersion: 1, kind, lastFullScanAt: now, entities: {} }
      for (const [id, entity] of baseline[kind]) {
        const local = localScan[kind]?.byId.get(id)
        let catalogPath = '_uncategorized'
        const relative = local?.file || relativePathFor(kind, entity, { catalogPath })
        writes.push({ kind, relative, entity })
        state.entities[id] = {
          id,
          localId: null,
          path: relative,
          catalogId: entity.catalogId === null || entity.catalogId === undefined ? null : String(entity.catalogId),
          baseHash: contentHash(kind, entity),
          baseRevision: entity.remote?.updatedAt || entity.updatedAt || '',
          baseVersion: entity.version === null || entity.version === undefined ? null : String(entity.version),
          basePulledAt: now,
          lastPushAt: null,
          remoteDeleted: false,
          localOnly: false,
          needsFollowup: false,
          ...(kind === 'testcase'
            ? {
                baseRequirementIds: entity.linksUnknown === true ? null : normalizeIds(entity.requirementIds),
                linksArmed: false,
                linksUnknown: entity.linksUnknown === true,
                linksUpdatedAt: null,
              }
            : {}),
          ...(kind === 'test-plan'
            ? { planCases: entity.planCasesComplete === false ? null : (entity.planCases || []), planCasesComplete: entity.planCasesComplete !== false }
            : {}),
          ...(kind === 'defect' ? { assigneeId: entity.assigneeId, assigneeName: entity.assigneeName } : {}),
        }
      }
      states[kind] = state
    }
    for (const item of writes) await writeAtomic(safeJoin(root, item.relative), renderFile(item.kind, item.entity))
    for (const kind of KINDS) await writeState(root, kind, states[kind])
    await writeLegacyCache(root, { projectId, byId: {} })
    return {
      ok: true,
      all: true,
      counts: { rewritten: writes.length, localOnly: localOnly.length },
      localOnly,
    }
  }

  async function gitStatus(projectId) {
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const info = await gitInfo(mapping.localRoot)
    return { projectId: String(projectId), root: mapping.localRoot, ...info }
  }

  async function gitCheckpointFor(projectId, { message, confirm } = {}) {
    if (confirm !== true) throw new Error('Git 检查点必须显式确认（confirm: true）')
    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const result = await gitCheckpoint({
      root: mapping.localRoot,
      message,
      confirm: true,
      projectId: String(projectId),
      dataDir,
      retention: cfg.sync.checkpointRetention,
    })
    await appendLog(dataDir, {
      op: 'git-checkpoint',
      projectId: String(projectId),
      created: result.created,
      commit: result.commit,
      branch: result.branch,
      files: result.files,
    })
    publish('git', { projectId: String(projectId), reason: 'checkpoint' })
    return result
  }

  async function validate(projectId, { kind } = {}) {    const cfg = await config()
    const mapping = cfg.projects?.[String(projectId)]
    if (!mapping?.localRoot) throw new Error(`项目 ${projectId} 未关联本地工作区`)
    const local = await scanLocal(mapping.localRoot)
    const errors = []
    const warnings = []
    for (const k of kind ? [kind] : KINDS) {
      for (const entity of local[k]?.byId.values() ?? []) {
        const result = validateEntity(k, entity, { file: entity.file, editableKinds: cfg.sync.editableKinds })
        for (const item of result.errors) errors.push({ kind: k, id: entity.id ?? entity.localId, file: entity.file, ...item })
        for (const item of result.warnings) warnings.push({ kind: k, id: entity.id ?? entity.localId, file: entity.file, ...item })
        const base = await readBaseline(mapping.localRoot, k, entity.id ?? entity.localId)
        const legacy = detectLegacy(k, base, entity)
        if (legacy.legacy) warnings.push({ kind: k, id: entity.id ?? entity.localId, file: entity.file, field: 'legacy', message: `legacy 内容（${legacy.reason}）：请用 tmsync_rebase 修复，不要直接 push` })
      }
      for (const item of local[k]?.invalid ?? []) errors.push({ kind: k, file: item.path, message: item.error })
    }
    return { ok: errors.length === 0, errors, warnings }
  }

  async function logs(limit = 50) {
    return readLogs(dataDir, limit)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    watcherAccess.clear()
    watchers.clear('dispose')
    try { hub.dispose() } catch { /* ignore */ }
    statusSnapshots.clear('dispose')
    statusInflight.clear('dispose')
    plans.clear('dispose')
    projectRevisions.clear('dispose')
    configCache = null
    lastConfig = null
    try { resetGitCache() } catch { /* ignore */ }
    try { clearToolsCache() } catch { /* ignore */ }
    try { adapter.dispose?.() } catch { /* ignore */ }
  }

  return {
    info,
    overview,
    getConfig,
    saveConfig,
    testConnection,
    listProjects,
    listWorkspaces,
    linkWorkspace,
    unlinkWorkspace,
    workspaceForCwd,
    status,
    tree,
    entity,
    pull,
    pushPlan,
    push,
    resolve,
    linksStatus,
    linksRefresh,
    linksAdopt,
    planCasesRefresh,
    rebase,
    gitStatus,
    gitCheckpoint: gitCheckpointFor,
    validate,
    logs,
    openEvents,
    subscribeEvents,
    cacheStats,
    dispose,
    adapter,
    dataDir,
    renderFile,
    relativePathFor,
    contentHash,
    safeJoin,
    maskToken,
  }
}
