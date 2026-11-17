/**
 * 文件安全与原子写：路径 containment、symlink、保留名、slug、hash。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])($|\.)/i

export async function mapLimit(items, limit, fn) {
  const list = Array.from(items)
  const results = new Array(list.length)
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1))
  let next = 0
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= list.length) return
      results[index] = await fn(list[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

export function safeJoin(base, relative) {
  const root = path.resolve(base)
  const target = path.resolve(root, relative)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${relative}`)
  }
  return target
}

export async function lstatSafe(file) {
  try { return await fs.lstat(file) } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

export function isSymlink(info) {
  return Boolean(info && typeof info.isSymbolicLink === 'function' && info.isSymbolicLink())
}

export async function assertDirectoryChain(base, relative) {
  const root = path.resolve(base)
  const parts = String(relative).split(/[\\/]+/).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const info = await lstatSafe(current)
    if (!info) return current
    if (isSymlink(info)) throw new Error(`不允许 symlink：${current}`)
    if (!info.isDirectory()) throw new Error(`路径不是目录：${current}`)
  }
  return current
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function writeAtomic(file, content, { mode = 0o600 } = {}) {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, content, { mode })
  await fs.rename(temp, file)
  try { await fs.chmod(file, mode) } catch { /* Windows 尽力而为 */ }
}

export async function readTextFile(file, fallback = '') {
  try { return await fs.readFile(file, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return fallback; throw error }
}

export async function pathExists(file) {
  return Boolean(await lstatSafe(file))
}

export async function removeFile(file) {
  try { await fs.unlink(file) } catch (error) { if (error?.code !== 'ENOENT') throw error }
}

export function slugify(value, fallback = 'item', max = 48) {
  const text = String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return text || fallback
}

export function safeId(value, max = 64) {
  const raw = String(value ?? '').normalize('NFC')
  const replaced = raw
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, max)
  const text = replaced || 'id'
  const changed = text !== raw
  const reserved = WINDOWS_RESERVED.test(text)
  const final = reserved ? `_${text}` : text
  return changed || reserved ? `${final}-${sha256(raw).slice(0, 8)}` : final
}

export function fileStem(id, title) {
  return `${safeId(id)}-${slugify(title || 'item')}`
}

export function pathDepth(relative) {
  return String(relative).split(/[\\/]+/).filter(Boolean).length
}

export function normalizeNewlines(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

export function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—'
}

export function unescapeCell(value) {
  return String(value ?? '').replace(/\\\|/g, '|').trim()
}

export function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]))
  }
  return value
}

export function stableStringify(value) {
  return JSON.stringify(sortObject(value))
}

export function canonicalHash(value) {
  return `sha256:${sha256(stableStringify(value))}`
}
