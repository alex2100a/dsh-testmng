/**
 * legacy 内容检测缓存（v0.2.2）。
 *
 * 不写 state：status/validate 只更新 .tmsync/cache/legacy.json，避免与 pull/apply
 * 的 state 写入互相覆盖。planPush/linksAdopt 读取本缓存 + 当前文件 warnings。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeAtomic } from './files.js'

const CACHE_FILE = 'legacy.json'
const FREE_TEXT_FIELDS = {
  requirement: ['description', 'acceptanceCriteria'],
  testcase: ['precondition'],
  'test-plan': ['description', 'entryCriteria', 'exitCriteria'],
  defect: ['description'],
  'test-report': [],
}

export function legacyCachePath(root) {
  return path.join(path.resolve(root), '.tmsync', 'cache', CACHE_FILE)
}

export async function readLegacyCache(root, { projectId } = {}) {
  try {
    const raw = JSON.parse(await fs.readFile(legacyCachePath(root), 'utf8'))
    if (!raw || Number(raw.schemaVersion) !== 1) return null
    if (projectId && String(raw.projectId) !== String(projectId)) return null
    return raw
  } catch {
    return null
  }
}

export async function writeLegacyCache(root, { projectId, byId = {}, checkedAt = new Date().toISOString() } = {}) {
  const cache = {
    schemaVersion: 1,
    projectId: String(projectId),
    checkedAt,
    byId,
  }
  await writeAtomic(legacyCachePath(root), `${JSON.stringify(cache, null, 2)}\n`)
  return cache
}

export async function patchLegacyCache(root, { projectId, changes = {} } = {}) {
  const current = await readLegacyCache(root, { projectId })
  const byId = { ...(current?.byId || {}) }
  for (const [id, value] of Object.entries(changes)) {
    if (value === null) delete byId[id]
    else byId[id] = value
  }
  return writeLegacyCache(root, { projectId, byId })
}

export function detectLegacy(kind, base, local) {
  if (!local) return { legacy: false, reason: null }
  if (Array.isArray(local.sectionWarnings) && local.sectionWarnings.length > 0) {
    return { legacy: true, reason: 'legacy-section-line' }
  }
  const fields = FREE_TEXT_FIELDS[kind] || []
  for (const field of fields) {
    const b = String(base?.[field] ?? '')
    const l = String(local?.[field] ?? '')
    if (!b || b === l) continue
    if (/\n{3,}/.test(b) && !/\n{3,}/.test(l)) {
      return { legacy: true, reason: 'legacy-format-diff' }
    }
    if (/^##\s/m.test(b) && !/^##\s/m.test(l)) {
      return { legacy: true, reason: 'legacy-section-line' }
    }
    if (b.startsWith(l) && l.length < b.length && l.length > 0 && /\n##\s/.test(b)) {
      return { legacy: true, reason: 'legacy-section-line' }
    }
  }
  return { legacy: false, reason: null }
}

export function freeTextFields(kind) {
  return FREE_TEXT_FIELDS[kind] || []
}
