/**
 * 需求-用例链接：项目级缓存、渲染视图、基线差异。
 *
 * 关键不变量（v0.2 独立审核 B1/B2）：
 * - get_case 不返回链接；不能用它的空值清空本地 requirementIds。
 * - baseRequirementIds 只来自完整快照（complete=true）。
 * - base=null 时只增不删；删除必须 linksArmed=true。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { mapLimit, writeAtomic } from './files.js'

const CACHE_FILE = 'links.json'

export function normalizeIds(ids) {
  return Array.from(new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))).sort()
}

export function sameIds(a, b) {
  const left = normalizeIds(a)
  const right = normalizeIds(b)
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function subtractIds(a, b) {
  const exclude = new Set(normalizeIds(b))
  return normalizeIds(a).filter((value) => !exclude.has(value))
}

export function unionIds(a, b) {
  return normalizeIds([...(a || []), ...(b || [])])
}

export function linkCachePath(root) {
  return path.join(path.resolve(root), '.tmsync', 'cache', CACHE_FILE)
}

export async function readLinkCache(root, { projectId, maxAgeMs = null } = {}) {
  try {
    const raw = JSON.parse(await fs.readFile(linkCachePath(root), 'utf8'))
    if (!raw || Number(raw.schemaVersion) !== 1) return null
    if (projectId && String(raw.projectId) !== String(projectId)) return null
    if (!raw.byCase || typeof raw.byCase !== 'object') return null
    if (maxAgeMs !== null) {
      const at = Date.parse(raw.fetchedAt || '')
      if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) return null
    }
    return raw
  } catch {
    return null
  }
}

export async function writeLinkCache(root, cache) {
  await writeAtomic(linkCachePath(root), `${JSON.stringify(cache, null, 2)}\n`)
}

export async function patchLinkCache(root, { projectId, changes = [] } = {}) {
  const cache = await readLinkCache(root, { projectId })
  if (!cache || cache.complete !== true) return null
  for (const change of changes) {
    const requirementId = String(change.requirementId)
    const caseId = String(change.caseId)
    if (!cache.byRequirement[requirementId]) cache.byRequirement[requirementId] = []
    if (!cache.byCase[caseId]) cache.byCase[caseId] = []
    if (change.action === 'link') {
      if (!cache.byRequirement[requirementId].includes(caseId)) cache.byRequirement[requirementId].push(caseId)
      if (!cache.byCase[caseId].includes(requirementId)) cache.byCase[caseId].push(requirementId)
    } else {
      cache.byRequirement[requirementId] = cache.byRequirement[requirementId].filter((id) => id !== caseId)
      cache.byCase[caseId] = cache.byCase[caseId].filter((id) => id !== requirementId)
    }
    cache.byRequirement[requirementId] = normalizeIds(cache.byRequirement[requirementId])
    cache.byCase[caseId] = normalizeIds(cache.byCase[caseId])
  }
  cache.patchedAt = new Date().toISOString()
  await writeLinkCache(root, cache)
  return cache
}

export function cacheUsable(cache, { projectId, maxAgeMs = 300_000 } = {}) {
  if (!cache || cache.complete !== true) return false
  if (projectId && String(cache.projectId) !== String(projectId)) return false
  const at = Date.parse(cache.fetchedAt || '')
  if (!Number.isFinite(at)) return false
  return Date.now() - at <= maxAgeMs
}

export async function buildLinkCache({ root, adapter, projectId, concurrency = 2, log = () => {} }) {
  const requirementIds = await adapter.listRequirementIds(projectId)
  const failed = []
  const byRequirement = {}
  const byCase = {}
  await mapLimit(requirementIds, concurrency, async (reqId) => {
    try {
      const data = await adapter.getRequirementCases(projectId, reqId)
      if (data.complete === false) {
        failed.push({ requirementId: String(reqId), reason: 'incomplete' })
        return
      }
      byRequirement[String(reqId)] = normalizeIds((data.items || []).map((item) => item.case_id))
      for (const caseId of byRequirement[String(reqId)]) {
        if (!byCase[caseId]) byCase[caseId] = []
        byCase[caseId].push(String(reqId))
      }
    } catch (error) {
      failed.push({ requirementId: String(reqId), reason: error?.message || String(error) })
    }
  })
  for (const caseId of Object.keys(byCase)) byCase[caseId] = normalizeIds(byCase[caseId])
  const cache = {
    schemaVersion: 1,
    projectId: String(projectId),
    fetchedAt: new Date().toISOString(),
    complete: failed.length === 0,
    requirements: requirementIds.length,
    failed,
    byRequirement,
    byCase,
  }
  await writeLinkCache(root, cache)
  if (failed.length) log(`[tmsync] 链接缓存不完整：${failed.length}/${requirementIds.length}`)
  return cache
}

/**
 * 有效链接视图：完整快照 > 本地已有值 > 空 + unknown。
 * `caseId` 为空（新建）时只使用本地值。
 */
export function effectiveRequirementIds({ kind, remote, cache, local, caseId } = {}) {
  const remoteIds = normalizeIds(remote?.requirementIds)
  if (kind !== 'testcase') return { requirementIds: remoteIds, linksUnknown: false }
  const id = caseId === undefined || caseId === null ? remote?.id : caseId
  if (cache && cache.complete === true) {
    if (id !== undefined && id !== null && Object.prototype.hasOwnProperty.call(cache.byCase, String(id))) {
      return { requirementIds: normalizeIds(cache.byCase[String(id)]), linksUnknown: false }
    }
    if (id !== undefined && id !== null) return { requirementIds: [], linksUnknown: false }
  }
  if (local && Array.isArray(local.requirementIds)) {
    return { requirementIds: normalizeIds(local.requirementIds), linksUnknown: local.linksUnknown === true }
  }
  return { requirementIds: remoteIds, linksUnknown: remote?.linksUnknown === true }
}

/**
 * 链接差异。
 * @returns {{links:string[], unlinks:string[], suppressed:Array, conflict:boolean, baselineAfter:string[], armedAfter:boolean, adopt:boolean}}
 */
export function diffLinks({ localIds, baseIds, remoteIds, armed = false }) {
  const local = normalizeIds(localIds)
  const remote = normalizeIds(remoteIds)
  const base = baseIds === null || baseIds === undefined ? null : normalizeIds(baseIds)
  const suppressed = []

  if (base === null) {
    if (sameIds(local, remote)) {
      return { links: [], unlinks: [], suppressed, conflict: false, baselineAfter: remote, armedAfter: true, adopt: true }
    }
    const links = subtractIds(local, remote)
    for (const requirementId of subtractIds(remote, local)) {
      suppressed.push({ requirementId, reason: 'links-baseline-unknown' })
    }
    return {
      links,
      unlinks: [],
      suppressed,
      conflict: false,
      baselineAfter: unionIds(remote, local),
      armedAfter: false,
      adopt: false,
    }
  }

  if (!sameIds(remote, base) && !sameIds(local, base)) {
    return { links: [], unlinks: [], suppressed, conflict: true, baselineAfter: base, armedAfter: armed, adopt: false }
  }
  if (sameIds(local, base)) {
    return { links: [], unlinks: [], suppressed, conflict: false, baselineAfter: base, armedAfter: armed, adopt: false }
  }

  const links = subtractIds(local, base).filter((id) => !remote.includes(id))
  const removeCandidates = subtractIds(base, local).filter((id) => remote.includes(id))
  const unlinks = []
  for (const requirementId of removeCandidates) {
    if (armed) unlinks.push(requirementId)
    else suppressed.push({ requirementId, reason: 'links-not-armed' })
  }
  const baselineAfter = armed && unlinks.length === removeCandidates.length ? local : remote
  return {
    links,
    unlinks,
    suppressed,
    conflict: false,
    baselineAfter,
    armedAfter: armed && suppressed.length === 0,
    adopt: false,
  }
}
