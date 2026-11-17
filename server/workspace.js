/**
 * 本地工作区：.tmsync 状态/基线、扫描、两轴状态、拉取。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  canonicalHash,
  ensureDir,
  fileStem,
  lstatSafe,
  mapLimit,
  normalizeNewlines,
  readTextFile,
  safeId,
  safeJoin,
  slugify,
  writeAtomic,
} from './files.js'
import { buildLinkCache, effectiveRequirementIds, normalizeIds, readLinkCache } from './links.js'
import { patchLegacyCache } from './legacy.js'
import {
  contentHash,
  isEditableKind,
  KIND_META,
  KINDS,
  parseFile,
  renderFile,
  relativePathFor,
  titleOf,
} from './codec.js'

const WORKSPACE_FILE = 'workspace.json'
const STATE_VERSION = 1
const README_MARKER = '<!-- tmsync:workspace-readme v3 -->'
const README_MARKER_V2 = '<!-- tmsync:workspace-readme v2 -->'
const LEGACY_PROJECT_LINE = /^- 项目：.*（prj_[0-9a-z]+）$/m

export class StateError extends Error {
  constructor(message, { code = 'state_error', path: filePath, hint } = {}) {
    super(message)
    this.name = 'StateError'
    this.code = code
    this.path = filePath
    this.hint = hint
  }
}

export function workspacePaths(root) {
  const base = path.resolve(root)
  const meta = path.join(base, '.tmsync')
  return {
    root: base,
    meta,
    workspace: path.join(meta, WORKSPACE_FILE),
    stateDir: path.join(meta, 'state'),
    baselineDir: path.join(meta, 'baseline'),
    conflictsDir: path.join(meta, 'conflicts'),
    logsDir: path.join(meta, 'logs'),
    cacheDir: path.join(meta, 'cache'),
    lock: path.join(meta, 'lock'),
    readme: path.join(base, 'README.md'),
  }
}

export async function readWorkspace(root) {
  const paths = workspacePaths(root)
  try {
    const raw = JSON.parse(await fs.readFile(paths.workspace, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    if (raw.generator !== 'tmsync') return null
    if (Number(raw.schemaVersion) !== 1) return null
    if (typeof raw.projectId !== 'string' || !raw.projectId) return null
    return raw
  } catch {
    return null
  }
}

export async function initWorkspace(root, info) {
  const paths = workspacePaths(root)
  await ensureDir(paths.meta)
  await ensureDir(paths.stateDir)
  await ensureDir(paths.baselineDir)
  await ensureDir(paths.conflictsDir)
  await ensureDir(paths.logsDir)
  await ensureDir(paths.cacheDir)
  for (const kind of KINDS) await ensureDir(path.join(paths.root, KIND_META[kind].dir))
  const existing = await readWorkspace(root)
  if (existing && existing.projectId !== String(info.projectId)) {
    throw new Error(`目录已绑定项目 ${existing.projectId}，不能绑定 ${info.projectId}`)
  }
  const workspace = {
    schemaVersion: 1,
    generator: 'tmsync',
    projectId: String(info.projectId),
    projectName: String(info.projectName || ''),
    projectCode: String(info.projectCode || existing?.projectCode || ''),
    platformKind: String(info.platformKind || 'testcasegen'),
    platformUrl: String(info.platformUrl || ''),
    createdAt: existing?.createdAt || new Date().toISOString(),
    lastPullAt: existing?.lastPullAt || null,
    lastStatusAt: existing?.lastStatusAt || null,
    layoutVersion: 1,
  }
  await writeAtomic(paths.workspace, `${JSON.stringify(workspace, null, 2)}\n`)
  await writeAtomic(path.join(paths.meta, '.gitignore'), '*\n')
  await ensureWorkspaceReadme(root, workspace)
  return workspace
}

/**
 * 工作区 README 是给人和 Agent 的说明，不写平台内部 ID（projectId）；
 * 内部 ID 只留在 .tmsync/workspace.json。旧模板只替换项目行，保留用户备注。
 */
export async function ensureWorkspaceReadme(root, workspace, { projectCode = '' } = {}) {
  const paths = workspacePaths(root)
  const info = {
    ...workspace,
    projectName: String(workspace.projectName || ''),
    projectCode: String(workspace.projectCode || projectCode || ''),
  }
  const existing = await readTextFile(paths.readme, null)
  if (existing === null) {
    await writeAtomic(paths.readme, renderWorkspaceReadme(info))
    return { written: true, reason: 'missing' }
  }
  if (existing.includes(README_MARKER)) return { written: false, reason: 'current' }

  const name = info.projectName.trim() || '未命名项目'
  const codeLine = info.projectCode ? `\n- 项目编号：${info.projectCode}` : ''
  let migrated = existing
  let reason = null
  if (migrated.includes(README_MARKER_V2)) {
    migrated = migrateGeneratedReadme(migrated)
    if (migrated === existing) return { written: false, reason: 'custom' }
    migrated = migrated.replace(README_MARKER_V2, README_MARKER)
    reason = 'v2'
  } else if (LEGACY_PROJECT_LINE.test(migrated)) {
    migrated = migrated.replace(LEGACY_PROJECT_LINE, () => `- 项目：${name}${codeLine}`)
    migrated = migrateGeneratedReadme(migrated)
    reason = 'legacy'
  } else {
    return { written: false, reason: 'custom' }
  }
  if (migrated === existing) return { written: false, reason: 'custom' }
  await writeAtomic(paths.readme, migrated)
  return { written: true, reason }
}

function migrateGeneratedReadme(text) {
  return text
    .replace('- `plans/` 测试计划（v0.1 只读）', '- `plans/` 测试计划')
    .replace('- `defects/` 测试缺陷（v0.1 只读）', '- `defects/` 测试缺陷')
    .replace('3. 报告永远只读；计划/缺陷在 v0.1 只读。', '3. 报告永远只读；计划/缺陷可编辑。\n4. 正文行首 `## ` 要写成 `\\## `；legacy 文件用 `tmsync_rebase` 修复。')
    .replace('4. 改完运行 `tmsync_validate` 与 `tmsync_status`。', '5. 改完运行 `tmsync_validate` 与 `tmsync_status`。')
    .replace('5. 推送前必须生成 plan 并得到用户确认；不要自动推送。', '6. 推送前必须生成 plan 并得到用户确认；不要自动推送。')
    .replace('6. 冲突要展示 base/local/remote，由用户决定，不要自行覆盖。', '7. 冲突要展示 base/local/remote，由用户决定，不要自行覆盖。')
    .replace('7. 平台暂不支持需求/用例/计划/缺陷的删除/归档；本地删除会被阻断。', '8. 平台暂不支持需求/用例/计划/缺陷的删除；计划归档用 status=archived；本地删除会被阻断。')
}

export function renderWorkspaceReadme(workspace) {
  const name = String(workspace.projectName || '').trim() || '未命名项目'
  const code = String(workspace.projectCode || '').trim()
  return `${README_MARKER}
# tmsync 测试资产工作区

- 项目：${name}${code ? `\n- 项目编号：${code}` : ''}
- 平台：${workspace.platformKind} ${workspace.platformUrl}
- 元数据：\`.tmsync/workspace.json\`（含平台项目 ID，供工具定位）
- 说明：本地是工作副本，平台是上游；先 status/拉取，再编辑；推送需要 plan + 确认。

## 目录

- \`requirements/\` 测试需求
- \`cases/\` 测试用例
- \`plans/\` 测试计划
- \`defects/\` 测试缺陷
- \`reports/\` 测试报告（只读）
- \`.tmsync/\` 同步元数据，**不要编辑**

## 编辑规则

1. 保留 front matter 的 \`id/kind/projectId\`；不要改 \`.tmsync/\`。
2. 不要重命名/移动文件；目录结构来自平台。
3. 报告永远只读；计划/缺陷可编辑。
4. 正文行首 \`## \` 要写成 \`\\## \`；legacy 文件用 \`tmsync_rebase\` 修复。
5. 改完运行 \`tmsync_validate\` 与 \`tmsync_status\`。
6. 推送前必须生成 plan 并得到用户确认；不要自动推送。
7. 冲突要展示 base/local/remote，由用户决定，不要自行覆盖。
8. 平台暂不支持需求/用例/计划/缺陷的删除；计划归档用 status=archived；本地删除会被阻断。

## 状态

\`✓ 一致\`、\`M 本地修改\`、\`A 本地新增\`、\`D 本地删除（阻断）\`、\`↓ 平台更新\`、\`+ 平台新增（未拉取）\`、\`! 冲突\`、\`? 未跟踪/无效\`。
`
}

export async function readState(root, kind, { workspace, requireExisting } = {}) {
  const paths = workspacePaths(root)
  const file = path.join(paths.stateDir, `${kind}.json`)
  let ws = workspace
  if (ws === undefined) {
    ws = await readWorkspace(root)
    if (!ws) {
      const meta = await lstatSafe(paths.meta)
      if (meta) {
        throw new StateError('workspace.json 缺失或损坏，无法安全读取 state', {
          code: 'workspace_corrupt',
          path: paths.workspace,
          hint: '请从备份恢复 .tmsync/workspace.json；不要直接 push。',
        })
      }
    }
  }
  const mustExist = requireExisting === undefined ? Boolean(ws?.lastPullAt) : Boolean(requireExisting)
  let raw
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (mustExist) {
        throw new StateError(`状态文件缺失：${path.relative(root, file)}`, {
          code: 'state_missing',
          path: file,
          hint: `请从 ${path.relative(root, file)}.bak 或备份恢复；没有备份时不要 push。工作区级重建请用 tmsync_rebase 的 all 模式。`,
        })
      }
      return emptyState(kind)
    }
    throw new StateError(`状态文件损坏：${path.relative(root, file)}`, {
      code: 'state_corrupt',
      path: file,
      hint: `JSON 解析失败：${error.message}。请从 .bak 或备份恢复；不要直接 push。`,
    })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StateError(`状态文件结构无效：${path.relative(root, file)}`, {
      code: 'state_corrupt',
      path: file,
      hint: 'state 顶层必须是对象。',
    })
  }
  if (Number(raw.schemaVersion) !== STATE_VERSION || raw.kind !== kind) {
    throw new StateError(`状态文件版本/类型不匹配：${path.relative(root, file)}`, {
      code: 'state_schema',
      path: file,
      hint: `期望 schemaVersion=${STATE_VERSION}、kind=${kind}；实际 ${raw.schemaVersion}/${raw.kind}。请升级 tmsync 或恢复备份。`,
    })
  }
  if (!raw.entities || typeof raw.entities !== 'object' || Array.isArray(raw.entities)) {
    throw new StateError(`状态文件 entities 无效：${path.relative(root, file)}`, {
      code: 'state_corrupt',
      path: file,
      hint: 'entities 必须是普通对象（不能是数组/null）。',
    })
  }
  for (const [key, entry] of Object.entries(raw.entities)) {
    if (!key || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new StateError(`状态文件 entry 无效：${path.relative(root, file)}#${key}`, {
        code: 'state_corrupt',
        path: file,
        hint: '每个 entity entry 必须是非空 key 的普通对象。',
      })
    }
  }
  return { ...emptyState(kind), ...raw, entities: raw.entities }
}

/** 唯一推荐的 state 读取入口：自动根据 workspace.lastPullAt fail-closed。 */
export async function loadState(root, kind, { workspace } = {}) {
  return readState(root, kind, { workspace })
}

export function emptyState(kind) {
  return { schemaVersion: STATE_VERSION, kind, lastFullScanAt: null, entities: {} }
}

async function backupStateFile(file) {
  try {
    const content = await fs.readFile(file)
    await writeAtomic(`${file}.bak`, content, { mode: 0o600 })
  } catch {
    // 备份是 best-effort；失败不阻塞主写入
  }
}

export async function writeState(root, kind, state) {
  const file = path.join(workspacePaths(root).stateDir, `${kind}.json`)
  await backupStateFile(file)
  await writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
}

export function baselinePath(root, kind, key) {
  return path.join(workspacePaths(root).baselineDir, kind, `${safeId(key)}.json`)
}

export async function readBaseline(root, kind, key) {
  try {
    return JSON.parse(await fs.readFile(baselinePath(root, kind, key), 'utf8'))
  } catch {
    return null
  }
}

export async function writeBaseline(root, kind, key, entity) {
  await writeAtomic(baselinePath(root, kind, key), `${JSON.stringify(entity, null, 2)}\n`)
}

async function walkMarkdown(dir, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return out
    throw error
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await walkMarkdown(full, out)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

export async function scanLocal(root) {
  const paths = workspacePaths(root)
  const result = {}
  for (const kind of KINDS) {
    const dir = path.join(paths.root, KIND_META[kind].dir)
    const files = await walkMarkdown(dir)
    const byId = new Map()
    const invalid = []
    for (const file of files) {
      const relative = path.relative(paths.root, file).split(path.sep).join('/')
      const raw = await readTextFile(file)
      try {
        const entity = parseFile(kind, raw, relative)
        entity.file = relative
        entity.localHash = contentHash(kind, entity)
        const key = entity.id || entity.localId
        if (!key) throw new Error('缺少 id/localId')
        if (byId.has(key)) {
          invalid.push({ kind, path: relative, id: key, error: '重复 ID' })
          continue
        }
        byId.set(key, entity)
      } catch (error) {
        invalid.push({ kind, path: relative, id: null, error: error.message })
      }
    }
    result[kind] = { byId, invalid, files }
  }
  return result
}

export function catalogPathMap(catalogs) {
  const byId = new Map()
  for (const item of catalogs ?? []) byId.set(String(item.id), item)
  return byId
}

export function catalogPathOf(byId, catalogId) {
  const parts = []
  let current = catalogId === null || catalogId === undefined ? null : byId.get(String(catalogId))
  const seen = new Set()
  while (current && !seen.has(String(current.id))) {
    seen.add(String(current.id))
    parts.unshift(`${safeId(current.id)}-${slugify(current.name || 'catalog')}`)
    current = current.parentId === null || current.parentId === undefined ? null : byId.get(String(current.parentId))
  }
  return parts.length ? parts.join('/') : '_uncategorized'
}

export async function ensureCatalogDirs(root, kind, catalogs) {
  if (kind !== 'requirement' && kind !== 'testcase') return
  const byId = catalogPathMap(catalogs)
  for (const item of catalogs ?? []) {
    const relative = catalogPathOf(byId, item.id)
    await ensureDir(safeJoin(workspacePaths(root).root, path.posix.join(KIND_META[kind].dir, relative)))
  }
}

function remoteSummaryKey(kind, entity) {
  return entity.id || entity.localId
}

function sameRevision(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb
}

function combineStatus(localState, remoteState, kind, editableKinds) {
  if (localState === 'invalid') return 'invalid'
  if (localState === 'untracked') return remoteState === 'new' ? 'remote-new' : 'untracked'
  if (localState === 'deleted' && remoteState === 'deleted') return 'same'
  if (localState === 'deleted') return remoteState === 'modified' ? 'conflict' : 'local-deleted'
  if (remoteState === 'deleted') return localState === 'same' ? 'remote-deleted' : 'conflict'
  if (localState === 'added') return remoteState === 'same' ? 'conflict' : 'local-added'
  if (localState === 'modified' && remoteState === 'modified') return 'conflict'
  if (localState === 'modified') return KIND_META[kind]?.editable && !isEditableKind(kind, editableKinds) ? 'readonly-modified' : 'local-modified'
  if (remoteState === 'modified') return 'remote-modified'
  if (remoteState === 'new') return 'remote-new'
  if (remoteState === 'unknown') return 'remote-unknown'
  return 'same'
}

export async function computeRemoteSnapshot({
  adapter,
  projectId,
  pullKinds = KINDS,
  concurrency = 2,
  log = () => {},
}) {
  const catalogs = { requirement: [], testcase: [] }
  await mapLimit(['requirement', 'testcase'], 2, async (kind) => {
    try { catalogs[kind] = await adapter.listCatalogs(projectId, kind) } catch (error) { log(`[tmsync] 目录读取失败 ${kind}: ${error.message}`) }
  })
  const remote = {}
  const remoteComplete = {}
  await mapLimit(pullKinds, concurrency, async (kind) => {
    const byId = new Map()
    let complete = true
    let page = 1
    try {
      for (;;) {
        const data = await adapter.listEntities(projectId, kind, { page, pageSize: 50 })
        for (const item of data.items) byId.set(remoteSummaryKey(kind, item), item)
        if (data.complete || data.items.length < 50 || page >= 200) {
          if (!data.complete && page >= 200) complete = false
          break
        }
        page += 1
      }
    } catch (error) {
      complete = false
      log(`[tmsync] 远程列表失败 ${kind}: ${error.message}`)
    }
    remote[kind] = byId
    remoteComplete[kind] = complete
  })
  return {
    catalogs,
    catalogMaps: {
      requirement: catalogPathMap(catalogs.requirement),
      testcase: catalogPathMap(catalogs.testcase),
    },
    remote,
    remoteComplete,
    remoteCheckedAt: new Date().toISOString(),
  }
}

export async function computeStatus({
  root,
  adapter,
  projectId,
  editableKinds = [],
  pullKinds = KINDS,
  concurrency = 2,
  localScan,
  remoteSnapshot,
  log = () => {},
}) {
  const paths = workspacePaths(root)
  const workspace = await readWorkspace(root)
  if (!workspace) throw new Error('不是 tmsync 工作区')
  if (workspace.projectId !== String(projectId)) throw new Error(`工作区属于项目 ${workspace.projectId}，不是 ${projectId}`)
  const local = localScan || await scanLocal(root)
  const states = {}
  await mapLimit(KINDS, 5, async (kind) => { states[kind] = await readState(root, kind, { workspace }) })
  const snapshot = remoteSnapshot || await computeRemoteSnapshot({ adapter, projectId, pullKinds, concurrency, log })
  const catalogs = snapshot.catalogs
  const catalogMaps = snapshot.catalogMaps || {
    requirement: catalogPathMap(catalogs.requirement),
    testcase: catalogPathMap(catalogs.testcase),
  }
  const remote = snapshot.remote
  const remoteComplete = snapshot.remoteComplete
  const remoteCheckedAt = snapshot.remoteCheckedAt

  const entries = []
  const summary = {
    same: 0, 'local-modified': 0, 'local-added': 0, 'local-deleted': 0,
    'remote-modified': 0, 'remote-new': 0, 'remote-deleted': 0,
    conflict: 0, untracked: 0, invalid: 0, 'readonly-modified': 0, 'remote-unknown': 0,
  }
  const errors = []

  function remoteIsSame(remoteEntity, base) {
    if (!remoteEntity || !base) return false
    const remoteVersion = remoteEntity.version === null || remoteEntity.version === undefined ? null : String(remoteEntity.version)
    const baseVersion = base.baseVersion === null || base.baseVersion === undefined ? null : String(base.baseVersion)
    if (remoteVersion !== null && baseVersion !== null) return remoteVersion === baseVersion
    return sameRevision(remoteEntity.updatedAt, base.baseRevision)
  }

  for (const kind of KINDS) {
    const state = states[kind]
    const localBy = local[kind].byId
    const remoteBy = remote[kind] ?? new Map()
    const ids = new Set([...localBy.keys(), ...remoteBy.keys(), ...Object.keys(state.entities)])
    for (const id of ids) {
      const localEntity = localBy.get(id) ?? null
      const remoteEntity = remoteBy.get(id) ?? null
      const base = state.entities[id] ?? null
      let localState = 'same'
      if (localEntity) {
        localState = base ? (localEntity.localHash === base.baseHash ? 'same' : 'modified') : 'added'
        if (base?.needsFollowup) localState = 'modified'
      } else if (base) {
        localState = 'deleted'
      } else {
        localState = 'untracked'
      }
      let remoteState = 'unknown'
      if (remoteBy.size > 0 || remoteComplete[kind]) {
        if (remoteEntity && base) {
          remoteState = remoteIsSame(remoteEntity, base) ? 'same' : 'modified'
        } else if (remoteEntity) {
          remoteState = 'new'
        } else if (base && remoteComplete[kind]) {
          remoteState = 'deleted'
        } else {
          remoteState = 'unknown'
        }
      }
      const combined = combineStatus(localState, remoteState, kind, editableKinds)
      summary[combined] = (summary[combined] ?? 0) + 1
      const catalogId = localEntity?.catalogId ?? remoteEntity?.catalogId ?? base?.catalogId ?? null
      const catalogBy = catalogMaps[kind] || new Map()
      const catalogPath = catalogId ? catalogPathOf(catalogBy, catalogId) : '_uncategorized'
      const path = localEntity?.file ?? base?.path ?? (remoteEntity ? relativePathFor(kind, remoteEntity, { catalogPath }) : '')
      entries.push({
        kind,
        id: localEntity?.id ?? remoteEntity?.id ?? base?.id ?? null,
        localId: localEntity?.localId ?? base?.localId ?? null,
        code: localEntity?.code || remoteEntity?.code || base?.code || '',
        title: titleOf(kind, localEntity || remoteEntity || base || {}),
        path,
        catalogId: catalogId === null ? null : String(catalogId),
        catalogPath,
        localState,
        remoteState,
        status: combined,
        existsLocal: Boolean(localEntity),
        existsRemote: Boolean(remoteEntity),
        editable: isEditableKind(kind, editableKinds),
        readOnly: Boolean(KIND_META[kind]?.readOnly) || !isEditableKind(kind, editableKinds),
        remoteUpdatedAt: remoteEntity?.updatedAt || base?.baseRevision || '',
        remoteVersion: remoteEntity?.version === undefined ? null : String(remoteEntity.version),
        localHash: localEntity?.localHash || null,
        baseHash: base?.baseHash || null,
        baseVersion: base?.baseVersion === undefined ? null : String(base.baseVersion),
      })
    }
    for (const bad of local[kind].invalid) {
      summary.invalid += 1
      entries.push({ kind, id: null, code: '', title: path.basename(bad.path), path: bad.path, status: 'invalid', localState: 'invalid', remoteState: 'unknown', existsLocal: true, existsRemote: false, editable: false, readOnly: true, error: bad.error })
      errors.push({ kind, path: bad.path, message: bad.error })
    }
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)
    if (a.catalogPath !== b.catalogPath) return a.catalogPath.localeCompare(b.catalogPath)
    return `${a.code} ${a.title}`.localeCompare(`${b.code} ${b.title}`)
  })
  return {
    projectId: String(projectId),
    projectName: workspace.projectName,
    workspace,
    root: paths.root,
    catalogs,
    entries,
    summary,
    errors,
    remoteComplete,
    remoteCheckedAt,
  }
}

function shouldWriteLocal(entry) {
  return entry.status === 'remote-new' || entry.status === 'remote-modified'
}

export async function pullWorkspace({
  root,
  adapter,
  projectId,
  editableKinds = [],
  pullKinds = KINDS,
  scope = {},
  dryRun = false,
  concurrency = 2,
  linkSync = true,
  linkCacheTtlMs = 300_000,
  onEvent = () => {},
}) {
  const localScan = await scanLocal(root)
  const status = await computeStatus({ root, adapter, projectId, editableKinds, pullKinds, concurrency, localScan })
  const kindFilter = scope.kind ? new Set([scope.kind]) : null
  const idFilter = Array.isArray(scope.ids) && scope.ids.length ? new Set(scope.ids.map(String)) : null
  const plan = []
  for (const entry of status.entries) {
    if (kindFilter && !kindFilter.has(entry.kind)) continue
    if (idFilter && !idFilter.has(String(entry.id ?? entry.localId))) continue
    if (shouldWriteLocal(entry)) plan.push({ action: 'write', entry })
    else if (entry.status === 'conflict') plan.push({ action: 'conflict', entry })
    else if (entry.status === 'remote-deleted') plan.push({ action: 'remote-deleted', entry })
    else plan.push({ action: 'skip', entry })
  }
  const result = {
    plan: {
      write: plan.filter((item) => item.action === 'write').length,
      conflict: plan.filter((item) => item.action === 'conflict').length,
      skip: plan.filter((item) => item.action === 'skip').length,
      remoteDeleted: plan.filter((item) => item.action === 'remote-deleted').length,
    },
    applied: false,
    written: [],
    conflicts: plan.filter((item) => item.action === 'conflict').map((item) => ({ kind: item.entry.kind, id: item.entry.id, path: item.entry.path, reason: 'local-and-remote-changed' })),
    errors: [],
  }
  if (dryRun) return result

  const writes = plan.filter((item) => item.action === 'write')
  let linkCache = null
  if (linkSync && writes.some((item) => item.entry.kind === 'testcase')) {
    linkCache = await readLinkCache(root, { projectId })
    try {
      // 显式拉取时重建链接快照，避免 TTL 内的旧链接被写成本地值
      linkCache = await buildLinkCache({ root, adapter, projectId, concurrency, log: onEvent })
    } catch (error) {
      result.errors.push({ kind: 'testcase', id: null, message: `链接缓存构建失败：${error.message}` })
      linkCache = null
    }
  }

  const workspace = await readWorkspace(root)
  const states = {}
  await mapLimit(KINDS, 5, async (kind) => { states[kind] = await readState(root, kind, { workspace }) })
  const catalogByKind = {}
  await mapLimit(['requirement', 'testcase'], 2, async (kind) => {
    catalogByKind[kind] = catalogPathMap(status.catalogs[kind] ?? [])
    await ensureCatalogDirs(root, kind, status.catalogs[kind] ?? [])
  })

  const outcomes = await mapLimit(writes, concurrency, async (item, index) => {
    const entry = item.entry
    onEvent({ phase: 'pull', kind: entry.kind, id: entry.id, done: index + 1, total: writes.length })
    try {
      const remote = await adapter.getEntity(projectId, entry.kind, entry.id)
      const local = localScan[entry.kind]?.byId.get(String(entry.id)) ?? null
      if (entry.existsLocal && entry.localState === 'modified') {
        return { conflict: { kind: entry.kind, id: entry.id, path: entry.path, reason: 'local-modified' } }
      }
      if (entry.existsLocal && (!local || local.localHash !== entry.localHash)) {
        return { conflict: { kind: entry.kind, id: entry.id, path: entry.path, reason: 'local-changed-during-pull' } }
      }
      if (entry.kind === 'testcase') {
        const effective = effectiveRequirementIds({ kind: 'testcase', remote, cache: linkCache, local })
        remote.requirementIds = effective.requirementIds
        remote.linksUnknown = effective.linksUnknown
      }
      if (entry.kind === 'test-plan') {
        remote.planCases = Array.isArray(remote.planCases) ? remote.planCases : []
        remote.planCasesComplete = remote.planCasesComplete !== false
      }
      const catalogPath = entry.catalogId ? catalogPathOf(catalogByKind[entry.kind] ?? new Map(), entry.catalogId) : '_uncategorized'
      const stateEntry = states[entry.kind].entities[String(entry.id)]
      const preservePath = entry.existsLocal && entry.path && (!stateEntry || String(stateEntry.catalogId) === String(entry.catalogId))
      const relative = preservePath ? entry.path : relativePathFor(entry.kind, remote, { catalogPath })
      await writeAtomic(safeJoin(root, relative), renderFile(entry.kind, remote))
      if (entry.path && entry.path !== relative && entry.existsLocal) {
        await fs.unlink(safeJoin(root, entry.path)).catch(() => {})
      }
      return { written: { kind: entry.kind, id: entry.id, path: relative }, entry, remote, relative }
    } catch (error) {
      return { error: { kind: entry.kind, id: entry.id, message: error.message } }
    }
  })

  for (const outcome of outcomes) {
    if (outcome.conflict) {
      result.conflicts.push(outcome.conflict)
      continue
    }
    if (outcome.error) {
      result.errors.push(outcome.error)
      continue
    }
    if (!outcome.written) continue
    const { entry, remote, relative } = outcome
    const key = String(entry.id)
    states[entry.kind].entities[key] = {
      id: key,
      localId: null,
      path: relative,
      catalogId: entry.catalogId,
      baseHash: contentHash(entry.kind, remote),
      baseRevision: remote.remote?.updatedAt || remote.updatedAt || '',
      baseVersion: remote.version === null || remote.version === undefined ? null : String(remote.version),
      basePulledAt: new Date().toISOString(),
      lastPushAt: null,
      remoteDeleted: false,
      localOnly: false,
      ...(entry.kind === 'testcase'
        ? {
            baseRequirementIds: linkCache?.complete === true ? normalizeIds(linkCache.byCase[String(entry.id)] ?? []) : null,
            linksArmed: linkCache?.complete === true,
            linksUnknown: remote.linksUnknown === true,
            linksUpdatedAt: linkCache?.fetchedAt || null,
          }
        : {}),
      ...(entry.kind === 'test-plan'
        ? {
            planCases: remote.planCasesComplete === false ? null : remote.planCases,
            planCasesComplete: remote.planCasesComplete !== false,
          }
        : {}),
      ...(entry.kind === 'defect'
        ? {
            assigneeId: remote.assigneeId,
            assigneeName: remote.assigneeName,
            remoteConfidence: 'normal',
          }
        : {}),
    }
    await writeBaseline(root, entry.kind, key, remote)
    result.written.push(outcome.written)
  }
  await mapLimit(KINDS, 5, async (kind) => {
    states[kind].lastFullScanAt = new Date().toISOString()
    await writeState(root, kind, states[kind])
  })
  if (result.written.length) {
    const changes = Object.fromEntries(result.written.map((item) => [String(item.id), null]))
    await patchLegacyCache(root, { projectId: String(projectId), changes })
  }
  if (workspace) {
    workspace.lastPullAt = new Date().toISOString()
    await writeAtomic(path.join(workspacePaths(root).meta, WORKSPACE_FILE), `${JSON.stringify(workspace, null, 2)}\n`)
  }
  result.applied = true
  return result
}

export async function localEntity(root, kind, id) {
  const data = await scanLocal(root)
  return data[kind]?.byId.get(String(id)) ?? null
}

export async function readEntityView(root, kind, id) {
  const entity = await localEntity(root, kind, id)
  const base = await readBaseline(root, kind, id)
  return { local: entity, base }
}

export { canonicalHash, fileStem }
