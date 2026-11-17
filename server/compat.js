/**
 * DSH 运行时版本探测与兼容分类（零依赖 semver 子集）。
 *
 * 与 DSH app-boot 的检查保持一致：范围比较包含 prerelease。
 * `0.2.1-rc.*` 低于下界；`0.3.0-rc.*` 低于上界（在范围内但未测）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const SUPPORT_RANGE = '>=0.2.1 <0.3.0'
export const MIN_DSH = '0.2.1'
export const MAX_DSH = '0.3.0'
export const TESTED_DSH = ['0.2.2-rc.1', '0.2.2-rc.3']

const PROBE_PACKAGES = ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh']

let cachedVersion

export function parseVersion(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim().replace(/^[vV]/, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (!match) return undefined
  const pre = match[4] === undefined ? [] : match[4].split('.')
  if (pre.some((part) => part === '')) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre,
    raw: text.split('+')[0],
  }
}

function compareIdentifier(left, right) {
  const leftNumber = /^\d+$/.test(left)
  const rightNumber = /^\d+$/.test(right)
  if (leftNumber && rightNumber) return Math.sign(Number(left) - Number(right))
  if (leftNumber) return -1
  if (rightNumber) return 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function compareVersions(leftRaw, rightRaw) {
  const left = typeof leftRaw === 'string' ? parseVersion(leftRaw) : leftRaw
  const right = typeof rightRaw === 'string' ? parseVersion(rightRaw) : rightRaw
  if (left === undefined || right === undefined) return undefined
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key])
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    if (left.pre[index] === undefined) return -1
    if (right.pre[index] === undefined) return 1
    const result = compareIdentifier(left.pre[index], right.pre[index])
    if (result !== 0) return result
  }
  return 0
}

export function inSupportRange(version) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version
  if (parsed === undefined) return false
  const min = parseVersion(MIN_DSH)
  const max = parseVersion(MAX_DSH)
  return compareVersions(parsed, min) >= 0 && compareVersions(parsed, max) < 0
}

function formatTested() {
  return TESTED_DSH.join('/')
}

export function classifyDshVersion(version, { pluginVersion = '0.2.2' } = {}) {
  if (typeof version !== 'string' || version.trim() === '') {
    return {
      status: 'unknown',
      version: version ?? null,
      range: SUPPORT_RANGE,
      tested: [...TESTED_DSH],
      reason: 'unknown-version',
      message: `无法检测 DSH 版本；如界面异常请确认 DSH ${SUPPORT_RANGE}。`,
    }
  }
  const parsed = parseVersion(version)
  if (parsed === undefined) {
    return {
      status: 'unknown',
      version,
      range: SUPPORT_RANGE,
      tested: [...TESTED_DSH],
      reason: 'invalid-version',
      message: `DSH 版本格式无法识别：${version}；请确认 DSH ${SUPPORT_RANGE}。`,
    }
  }
  const normalized = parsed.raw
  if (!inSupportRange(parsed)) {
    return {
      status: 'incompatible',
      version: normalized,
      range: SUPPORT_RANGE,
      tested: [...TESTED_DSH],
      reason: 'out-of-range',
      message: `DSH ${normalized} 超出 tmsync v${pluginVersion} 支持范围 ${SUPPORT_RANGE}。DSH 安装门禁通常会拒绝加载；若你已安装/豁免，界面与同步可能异常。`,
    }
  }
  const tested = TESTED_DSH.find((item) => compareVersions(item, parsed) === 0) !== undefined
  if (tested) {
    return {
      status: 'supported',
      version: normalized,
      range: SUPPORT_RANGE,
      tested: [...TESTED_DSH],
      reason: 'tested-version',
      message: `DSH ${normalized} 已测试。`,
    }
  }
  return {
    status: 'untested',
    version: normalized,
    range: SUPPORT_RANGE,
    tested: [...TESTED_DSH],
    reason: 'untested-version',
    message: `DSH ${normalized} 在支持范围内但未在 tmsync v${pluginVersion} 测试矩阵（${formatTested()}）；如遇异常请切换 DSH 或反馈。`,
  }
}

function readPackageFile(file, expectedName) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (expectedName !== undefined && raw?.name !== expectedName) return undefined
    return typeof raw?.version === 'string' ? raw.version : undefined
  } catch {
    return undefined
  }
}

function resolveFile(specifier, resolve) {
  try {
    const result = resolve(specifier)
    if (typeof result !== 'string') return undefined
    if (result.startsWith('file:')) return fileURLToPath(result)
    return result
  } catch {
    return undefined
  }
}

export function detectDshVersion({
  env = process.env,
  resolve = (specifier) => import.meta.resolve(specifier),
  argv1 = process.argv[1],
  cwd = process.cwd(),
  readPackage = readPackageFile,
  useCache = true,
} = {}) {
  const override = env?.TMSYNC_DSH_VERSION
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  if (useCache && cachedVersion !== undefined) return cachedVersion

  const lookups = []
  lookups.push((name) => {
    const file = resolveFile(`${name}/package.json`, resolve)
    return file === undefined ? undefined : readPackage(file, name)
  })
  if (argv1) {
    try {
      const req = createRequire(argv1)
      lookups.push((name) => {
        try { return readPackage(req.resolve(`${name}/package.json`), name) } catch { return undefined }
      })
    } catch { /* ignore */ }
  }
  try {
    const req = createRequire(path.join(cwd, 'package.json'))
    lookups.push((name) => {
      try { return readPackage(req.resolve(`${name}/package.json`), name) } catch { return undefined }
    })
  } catch { /* ignore */ }

  for (const lookup of lookups) {
    for (const name of PROBE_PACKAGES) {
      const version = lookup(name)
      if (typeof version === 'string' && parseVersion(version) !== undefined) {
        if (useCache) cachedVersion = version
        return version
      }
    }
  }
  return undefined
}

export function resetDshVersionCache() {
  cachedVersion = undefined
}
