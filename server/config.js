/**
 * tmsync 配置：~/.dsh/tmsync/config.json（0600）。
 * 环境变量优先；PAT 不写入 preset/工作区/日志。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeAtomic } from './files.js'

export const CONFIG_FILENAME = 'config.json'
export const DATA_DIR_ENV = 'TMSYNC_DATA_DIR'

export class ConfigError extends Error {
  constructor(message, { code = 'config_error', path: filePath, hint } = {}) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.path = filePath
    this.hint = hint
  }
}

export const DEFAULTS = {
  schemaVersion: 1,
  platform: {
    kind: 'testcasegen',
    platformUrl: 'http://localhost:3000',
    mcpUrl: 'http://localhost:8000/mcp',
    token: '',
  },
  workbench: {
    enabled: true,
    statusTtlMs: 300_000,
    pageSize: 50,
    concurrency: 2,
    announceToAgent: true,
    realtime: true,
    watchDebounceMs: 300,
    events: {
      bufferSize: 64,
      heartbeatMs: 15_000,
      maxClients: 8,
      clientQueue: 32,
    },
    cache: {
      statusEntries: 32,
      statusBytes: 8 * 1024 * 1024,
      inflightEntries: 16,
      planEntries: 32,
      planBytes: 4 * 1024 * 1024,
      planTtlMs: 600_000,
      watcherEntries: 8,
      watcherTtlMs: 1_800_000,
      revisionEntries: 256,
    },
  },
  sync: {
    editableKinds: ['requirement', 'testcase', 'test-plan', 'defect'],
    pullKinds: ['requirement', 'testcase', 'test-plan', 'defect', 'test-report'],
    includeTestData: false,
    includeReports: true,
    checkpointRetention: 5,
    links: {
      enabled: true,
      cacheTtlMs: 300_000,
    },
  },
  projects: {},
}

export function resolveDataDir(env = process.env, override) {
  const value = override || env[DATA_DIR_ENV]
  if (value && path.isAbsolute(value)) return path.resolve(value)
  const home = env.USERPROFILE || env.HOME
  if (!home) throw new Error('无法确定用户目录：请设置 TMSYNC_DATA_DIR')
  return path.join(home, '.dsh', 'tmsync')
}

export function configPath(dataDir) {
  return path.join(dataDir, CONFIG_FILENAME)
}

function definedOnly(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
    : {}
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function normalize(raw = {}) {
  const platform = { ...DEFAULTS.platform, ...definedOnly(raw.platform) }
  const workbench = { ...DEFAULTS.workbench, ...definedOnly(raw.workbench) }
  const sync = { ...DEFAULTS.sync, ...definedOnly(raw.sync) }
  const events = { ...DEFAULTS.workbench.events, ...definedOnly(workbench.events) }
  const cache = { ...DEFAULTS.workbench.cache, ...definedOnly(workbench.cache) }
  const pageSize = Number(workbench.pageSize)
  workbench.pageSize = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 50) : 50
  if (!Array.isArray(sync.editableKinds)) sync.editableKinds = [...DEFAULTS.sync.editableKinds]
  // v0.1 默认只有需求/用例；v0.2 自动升级到四类（可在 UI 再关闭）
  if (sync.editableKinds.length === 2 && sync.editableKinds.includes('requirement') && sync.editableKinds.includes('testcase')) {
    sync.editableKinds = [...DEFAULTS.sync.editableKinds]
  }
  if (!Array.isArray(sync.pullKinds)) sync.pullKinds = [...DEFAULTS.sync.pullKinds]
  const projects = raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? raw.projects : {}
  return {
    schemaVersion: 1,
    platform: {
      kind: String(platform.kind || 'testcasegen'),
      platformUrl: String(platform.platformUrl || ''),
      mcpUrl: String(platform.mcpUrl || ''),
      token: String(platform.token || ''),
    },
    workbench: {
      enabled: workbench.enabled !== false,
      statusTtlMs: Number.isFinite(Number(workbench.statusTtlMs)) ? Math.max(10_000, Number(workbench.statusTtlMs)) : 300_000,
      pageSize: workbench.pageSize,
      concurrency: Math.max(1, Math.min(8, Number(workbench.concurrency) || 2)),
      announceToAgent: workbench.announceToAgent !== false,
      realtime: workbench.realtime !== false,
      watchDebounceMs: clampInt(workbench.watchDebounceMs, 100, 2000, 300),
      events: {
        bufferSize: clampInt(events.bufferSize, 8, 256, 64),
        heartbeatMs: clampInt(events.heartbeatMs, 5000, 60_000, 15_000),
        maxClients: clampInt(events.maxClients, 1, 32, 8),
        clientQueue: clampInt(events.clientQueue, 8, 128, 32),
      },
      cache: {
        statusEntries: clampInt(cache.statusEntries, 4, 256, 32),
        statusBytes: clampInt(cache.statusBytes, 1024, 64 * 1024 * 1024, 8 * 1024 * 1024),
        inflightEntries: clampInt(cache.inflightEntries, 2, 64, 16),
        planEntries: clampInt(cache.planEntries, 4, 256, 32),
        planBytes: clampInt(cache.planBytes, 1024, 32 * 1024 * 1024, 4 * 1024 * 1024),
        planTtlMs: clampInt(cache.planTtlMs, 60_000, 86_400_000, 600_000),
        watcherEntries: clampInt(cache.watcherEntries, 1, 32, 8),
        watcherTtlMs: clampInt(cache.watcherTtlMs, 60_000, 86_400_000, 1_800_000),
        revisionEntries: clampInt(cache.revisionEntries, 32, 1024, 256),
      },
    },
    sync: {
      editableKinds: sync.editableKinds.map(String),
      pullKinds: sync.pullKinds.map(String),
      includeTestData: sync.includeTestData === true,
      includeReports: sync.includeReports !== false,
      checkpointRetention: Math.max(0, Math.min(20, Number(sync.checkpointRetention) || 5)),
      links: {
        enabled: sync.links?.enabled !== false,
        cacheTtlMs: Math.max(10_000, Math.min(3_600_000, Number(sync.links?.cacheTtlMs) || 300_000)),
      },
    },
    projects: Object.fromEntries(Object.entries(projects).map(([id, entry]) => [String(id), {
      name: String(entry?.name || ''),
      code: String(entry?.code || ''),
      localRoot: String(entry?.localRoot || ''),
      platformKind: String(entry?.platformKind || platform.kind || 'testcasegen'),
      platformId: entry?.platformId === undefined ? null : String(entry.platformId),
      linkedAt: String(entry?.linkedAt || ''),
    }])),
  }
}

export async function readConfigFile(dataDir, { log, strict = false } = {}) {
  const file = configPath(dataDir)
  let raw = {}
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      raw = {}
    } else {
      const configError = new ConfigError(`配置文件损坏：${file}`, {
        code: 'config_corrupt',
        path: file,
        hint: `JSON 解析失败：${error.message}。请先备份并修复配置；不要直接保存覆盖。`,
      })
      if (strict) throw configError
      log?.(`[tmsync] 配置读取失败：${error.message}`)
      throw configError
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const configError = new ConfigError(`配置文件结构无效：${file}`, {
      code: 'config_schema',
      path: file,
      hint: '配置文件顶层必须是 JSON 对象。',
    })
    if (strict) throw configError
    log?.(`[tmsync] 配置结构无效：${file}`)
    throw configError
  }
  return normalize(raw)
}

export async function readConfig(dataDir, { log } = {}) {
  const config = await readConfigFile(dataDir, { log })
  const env = process.env
  if (env.TMSYNC_PLATFORM_KIND) config.platform.kind = env.TMSYNC_PLATFORM_KIND
  if (env.TMSYNC_PLATFORM_URL) config.platform.platformUrl = env.TMSYNC_PLATFORM_URL
  if (env.TMSYNC_MCP_URL) config.platform.mcpUrl = env.TMSYNC_MCP_URL
  if (env.TMSYNC_MCP_TOKEN) config.platform.token = env.TMSYNC_MCP_TOKEN
  return config
}

async function backupConfigFile(file) {
  try {
    const content = await fs.readFile(file)
    await writeAtomic(`${file}.bak`, content, { mode: 0o600 })
  } catch {
    // 备份是 best-effort；损坏/不存在时不阻塞“拒绝覆盖”
  }
}

export async function writeConfig(dataDir, patch = {}) {
  const current = await readConfigFile(dataDir, { strict: true })
  const next = normalize({
    ...current,
    ...definedOnly(patch),
    platform: { ...current.platform, ...definedOnly(patch.platform) },
    workbench: { ...current.workbench, ...definedOnly(patch.workbench) },
    sync: { ...current.sync, ...definedOnly(patch.sync) },
    projects: patch.projects === undefined ? current.projects : patch.projects,
  })
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const file = configPath(dataDir)
  await backupConfigFile(file)
  await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

export function maskToken(token) {
  if (!token) return ''
  return '****'
}

export function maskedConfig(config) {
  return {
    schemaVersion: config.schemaVersion,
    platform: {
      kind: config.platform.kind,
      platformUrl: config.platform.platformUrl,
      mcpUrl: config.platform.mcpUrl,
      token: maskToken(config.platform.token),
      hasToken: Boolean(config.platform.token),
    },
    workbench: config.workbench,
    sync: config.sync,
    projects: config.projects,
  }
}

export function redact(value) {
  return String(value ?? '')
    .replace(/mcp_[A-Za-z0-9_-]{8,}/g, 'mcp_****')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ****')
    .replace(/Authorization["']?\s*[:=]\s*["']?[^"',}\s]+/gi, 'Authorization: ****')
}
