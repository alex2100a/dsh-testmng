/**
 * tmsync MCP 轻客户端（零依赖）。
 *
 * 仅使用 initialize → notifications/initialized → tools/list / tools/call，
 * 每次调用序列结束显式 DELETE 终止会话（平台为 stateful）。
 * 参考 dsh-testcat/server/mcp.js 的协议处理，按 tmsync 需要精简。
 */

import { VERSION } from './version.js'

export const PROTOCOL_VERSION = '2025-06-18'
export const CLIENT_INFO = { name: 'tmsync', version: VERSION }

const TIMEOUTS = { initialize: 3000, toolsList: 10000, call: 20000 }
const TOOLS_CACHE_TTL_MS = 60_000

const HINTS = {
  401: '凭据无效或已过期：请在平台「访问令牌」页创建/更新 PAT 后重试',
  403: '请求被拒绝：请把访问域名加入平台允许列表并重启后端',
  404: '端点不存在：请确认 MCP 地址包含 /mcp 且平台 MCP 已启用',
}

export class McpError extends Error {
  constructor(message, { status = 0, code = 'mcp_error', hint, details, stage = 'transport' } = {}) {
    super(message)
    this.name = 'McpError'
    this.status = status
    this.code = code
    this.hint = hint
    this.details = details
    this.stage = stage
  }
}

export function parseToolError(text) {
  const raw = String(text ?? '').trim()
  const match = /^HTTP\s+(\d{3})(?:\s+\[([^\]]+)\])?:\s*([\s\S]*)$/.exec(raw)
  if (!match) return { status: 0, code: 'tool_error', message: raw || '工具执行失败' }
  return { status: Number(match[1]), code: match[2] || 'tool_error', message: match[3] || raw }
}

export function normalizeError(error) {
  if (error instanceof McpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      hint: error.hint,
      ...(error.details !== undefined ? { details: error.details } : {}),
      stage: error.stage,
    }
  }
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.stage) {
    return {
      status: Number.isInteger(error.status) ? error.status : 0,
      code: String(error.code ?? 'internal'),
      message: error.message,
      hint: error.hint,
      ...(error.details !== undefined ? { details: error.details } : {}),
      stage: error.stage,
    }
  }
  return { status: 0, code: 'internal', message: String(error?.message ?? error), stage: 'transport' }
}

let requestId = 0
let toolsCache = null
let inflight = null

export function clearToolsCache() {
  toolsCache = null
}

export function toolsCacheStats() {
  return {
    tools: toolsCache === null ? 0 : 1,
    cachedAt: toolsCache?.at ?? null,
    inflight: inflight === null ? 0 : 1,
    ttlMs: TOOLS_CACHE_TTL_MS,
  }
}

function authHeaders(token) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function parseSse(text) {
  const messages = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    try {
      messages.push(JSON.parse(data))
    } catch {
      // 忽略无法解析的事件
    }
  }
  if (messages.length === 0) throw new McpError('SSE 响应不包含有效数据事件', { code: 'parse_error', stage: 'http' })
  return messages.find((message) => message?.result !== undefined || message?.error !== undefined) ?? messages.at(-1)
}

async function readPayload(res) {
  const type = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (type.includes('text/event-stream')) return parseSse(text)
  try {
    return JSON.parse(text)
  } catch {
    throw new McpError(`响应不是有效 JSON（HTTP ${res.status}）`, { status: res.status, code: 'parse_error', stage: 'http' })
  }
}

function wrapTransportError(error) {
  if (error instanceof McpError) return error
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new McpError('请求超时：平台未在时限内响应', { status: 408, code: 'timeout', hint: '检查网络/平台负载后重试' })
  }
  const cause = error?.cause?.code ?? error?.code
  if (cause === 'ECONNREFUSED' || cause === 'ENOTFOUND' || cause === 'EHOSTUNREACH') {
    return new McpError('无法连接 MCP 端点', { status: 0, code: 'connect_error', hint: '确认平台已启动且 MCP 地址正确', stage: 'transport' })
  }
  return new McpError(`请求失败：${error?.message ?? error}`, { status: 0, code: 'transport_error', stage: 'transport' })
}

async function rpc({ mcpUrl, token, method, params, timeoutMs, sessionId, notify = false }) {
  const headers = authHeaders(token)
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const id = notify ? undefined : ++requestId
  const body = JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, ...(params ? { params } : {}) })

  let res
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw wrapTransportError(error)
  }

  const nextSessionId = res.headers.get('mcp-session-id') ?? sessionId
  if (!res.ok) {
    throw new McpError(`HTTP ${res.status}：MCP 请求被拒绝`, {
      status: res.status,
      code: `http_${res.status}`,
      hint: HINTS[res.status],
      stage: 'http',
    })
  }
  if (notify) {
    await res.text()
    return { sessionId: nextSessionId }
  }
  const payload = await readPayload(res)
  if (payload?.error) {
    throw new McpError(`[${payload.error.code}] ${payload.error.message}`, { code: `rpc_${payload.error.code}`, stage: 'http' })
  }
  return { result: payload?.result, sessionId: nextSessionId }
}

export async function openSession({ mcpUrl, token, timeoutMs = TIMEOUTS.initialize }) {
  const { sessionId } = await rpc({
    mcpUrl,
    token,
    method: 'initialize',
    timeoutMs,
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  })
  if (sessionId) await rpc({ mcpUrl, token, method: 'notifications/initialized', timeoutMs, sessionId, notify: true })
  return { sessionId }
}

export async function closeSession({ mcpUrl, token, sessionId, timeoutMs = TIMEOUTS.initialize }) {
  if (!sessionId) return
  try {
    const headers = authHeaders(token)
    headers['Mcp-Session-Id'] = sessionId
    await fetch(mcpUrl, { method: 'DELETE', headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    // 会话回收失败不影响用户操作
  }
}

export async function listToolsRaw({ mcpUrl, token, timeoutMs } = {}) {
  const { sessionId } = await openSession({ mcpUrl, token, timeoutMs: timeoutMs ?? TIMEOUTS.initialize })
  try {
    const { result } = await rpc({
      mcpUrl,
      token,
      method: 'tools/list',
      params: {},
      timeoutMs: timeoutMs ?? TIMEOUTS.toolsList,
      sessionId,
    })
    return result?.tools ?? []
  } finally {
    await closeSession({ mcpUrl, token, sessionId })
  }
}

function cacheKey(mcpUrl, token) {
  return `${mcpUrl}::${token ? token.slice(-8) : ''}`
}

export async function listTools({ mcpUrl, token, refresh = false }) {
  const key = cacheKey(mcpUrl, token)
  const now = Date.now()
  if (!refresh && toolsCache && toolsCache.key === key && now - toolsCache.at < TOOLS_CACHE_TTL_MS) {
    return { tools: toolsCache.tools, cachedAt: new Date(toolsCache.at).toISOString(), cached: true }
  }
  const tools = await listToolsRaw({ mcpUrl, token })
  toolsCache = { key, at: Date.now(), tools }
  return { tools, cachedAt: new Date(toolsCache.at).toISOString(), cached: false }
}

export function extractToolData(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = (result?.content ?? [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

export async function callTool({ mcpUrl, token, name, args = {}, timeoutMs = TIMEOUTS.call }) {
  const { sessionId } = await openSession({ mcpUrl, token })
  try {
    const { result } = await rpc({
      mcpUrl,
      token,
      method: 'tools/call',
      params: { name, arguments: args },
      timeoutMs,
      sessionId,
    })
    if (result?.isError) {
      const text = (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join(' ')
      const detail = parseToolError(text)
      throw new McpError(detail.message || `工具 ${name} 执行失败`, {
        status: detail.status,
        code: detail.code,
        stage: 'tool',
      })
    }
    return extractToolData(result)
  } finally {
    await closeSession({ mcpUrl, token, sessionId })
  }
}

/**
 * 会话池：一次同步操作只 initialize 一次/每 worker，后续 tools/call 复用 session。
 * - concurrency 个 worker，每个 worker 串行复用自己的会话；
 * - 不同 worker 并行，总并发 ≤ concurrency；
 * - 传输层失败时丢弃该 worker 的 session，下次调用重建。
 */
export function createMcpClient({
  mcpUrl,
  token,
  concurrency = 2,
  callTimeoutMs = TIMEOUTS.call,
  initTimeoutMs = TIMEOUTS.initialize,
  onEvent = () => {},
} = {}) {
  const size = Math.max(1, Math.min(8, Number(concurrency) || 1))
  const workers = []
  const idle = []
  const waiters = []
  let closed = false
  let sessionCount = 0

  function acquire() {
    if (closed) return Promise.reject(new McpError('MCP 客户端已关闭', { code: 'client_closed' }))
    while (idle.length) {
      const worker = idle.pop()
      if (!worker.busy) {
        worker.busy = true
        return Promise.resolve(worker)
      }
    }
    if (workers.length < size) {
      const worker = { sessionId: undefined, busy: true }
      workers.push(worker)
      return Promise.resolve(worker)
    }
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  }

  function release(worker) {
    worker.busy = false
    const waiter = waiters.shift()
    if (waiter) {
      worker.busy = true
      waiter.resolve(worker)
    } else if (!closed) {
      idle.push(worker)
    }
  }

  async function ensureSession(worker) {
    if (worker.sessionId) return worker.sessionId
    const sessionId = (await openSession({ mcpUrl, token, timeoutMs: initTimeoutMs })).sessionId
    if (closed) {
      await closeSession({ mcpUrl, token, sessionId })
      throw new McpError('MCP 客户端已关闭', { code: 'client_closed' })
    }
    worker.sessionId = sessionId
    sessionCount += 1
    onEvent({ type: 'session-open', sessions: sessionCount })
    return worker.sessionId
  }

  async function resetWorker(worker) {
    const sessionId = worker.sessionId
    worker.sessionId = undefined
    if (sessionId) await closeSession({ mcpUrl, token, sessionId })
  }

  async function call(name, args = {}, { timeoutMs = callTimeoutMs } = {}) {
    const worker = await acquire()
    try {
      const sessionId = await ensureSession(worker)
      try {
        const { result } = await rpc({
          mcpUrl,
          token,
          method: 'tools/call',
          params: { name, arguments: args },
          timeoutMs,
          sessionId,
        })
        if (result?.isError) {
          const text = (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join(' ')
          const detail = parseToolError(text)
          throw new McpError(detail.message || `工具 ${name} 执行失败`, {
            status: detail.status,
            code: detail.code,
            stage: 'tool',
          })
        }
        return extractToolData(result)
      } catch (error) {
        const detail = normalizeError(error)
        if (detail.stage !== 'tool') await resetWorker(worker)
        throw error
      }
    } finally {
      release(worker)
    }
  }

  async function close() {
    closed = true
    for (const waiter of waiters.splice(0)) waiter.reject(new McpError('MCP 客户端已关闭', { code: 'client_closed' }))
    await Promise.allSettled(workers.map((worker) => resetWorker(worker)))
    workers.length = 0
    idle.length = 0
  }

  return {
    call,
    close,
    stats: () => ({ sessions: sessionCount, workers: workers.length, pending: waiters.length }),
  }
}

export async function callTools({ mcpUrl, token, calls = [], timeoutMs = TIMEOUTS.call, totalBudgetMs }) {
  const startedAt = Date.now()
  const deadline = Number.isFinite(totalBudgetMs) ? startedAt + totalBudgetMs : null
  const remaining = () => (deadline === null ? timeoutMs : Math.max(0, Math.min(timeoutMs, deadline - Date.now())))
  const out = []
  let sessionId
  try {
    sessionId = (await openSession({
      mcpUrl,
      token,
      timeoutMs: Math.max(500, Math.min(TIMEOUTS.initialize, remaining() || TIMEOUTS.initialize)),
    })).sessionId
    let stopped = false
    for (const call of calls) {
      if (stopped) {
        out.push({ name: call.name, skipped: true })
        continue
      }
      const budget = remaining()
      if (budget <= 0) {
        out.push({ name: call.name, skipped: true })
        continue
      }
      try {
        const { result } = await rpc({
          mcpUrl,
          token,
          method: 'tools/call',
          params: { name: call.name, arguments: call.args ?? {} },
          timeoutMs: budget,
          sessionId,
        })
        if (result?.isError) {
          const text = (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join(' ')
          const detail = parseToolError(text)
          out.push({ name: call.name, error: { ...detail, stage: 'tool' } })
          continue
        }
        out.push({ name: call.name, data: extractToolData(result) })
      } catch (error) {
        const detail = normalizeError(error)
        out.push({ name: call.name, error: detail })
        if (detail.stage !== 'tool' && (detail.status >= 500 || [401, 403, 404].includes(detail.status)
          || ['connect_error', 'timeout', 'transport_error'].includes(detail.code))) {
          stopped = true
        }
      }
    }
    return out
  } finally {
    await closeSession({ mcpUrl, token, sessionId })
  }
}

export async function checkConnection({ mcpUrl, token, timeoutMs } = {}) {
  const key = cacheKey(mcpUrl, token)
  if (inflight && inflight.key === key) return inflight.promise
  const promise = (async () => {
    const started = Date.now()
    try {
      const tools = await listToolsRaw({ mcpUrl, token, timeoutMs })
      return { ok: true, toolCount: tools.length, elapsedMs: Date.now() - started }
    } catch (error) {
      return { ok: false, toolCount: null, elapsedMs: Date.now() - started, error: normalizeError(error) }
    } finally {
      inflight = null
    }
  })()
  inflight = { key, promise }
  return promise
}

export const TIMEOUTS_PUBLIC = TIMEOUTS
