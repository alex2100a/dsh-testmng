/**
 * tmsync 实时事件：SSE 事件 hub + 响应器。
 *
 * 事件 id 使用 `<instanceId>:<seq>`；DSH 重启后 instanceId 变化，
 * 客户端收到 resync，避免旧 seq 在新进程中错误命中。
 */
import crypto from 'node:crypto'

export const EVENT_VERSION = 1

export const DEFAULT_EVENTS = {
  bufferSize: 64,
  heartbeatMs: 15_000,
  maxClients: 8,
  clientQueue: 32,
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function iso(now) {
  return new Date(now()).toISOString()
}

function parseLastEventId(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  const text = raw.trim()
  const index = text.lastIndexOf(':')
  if (index <= 0) return { instanceId: '', seq: Number(text) }
  return { instanceId: text.slice(0, index), seq: Number(text.slice(index + 1)) }
}

export function createEventHub({
  bufferSize = DEFAULT_EVENTS.bufferSize,
  maxClients = DEFAULT_EVENTS.maxClients,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const instanceId = crypto.randomUUID()
  let seq = 0
  let limit = clampInt(bufferSize, 8, 256, DEFAULT_EVENTS.bufferSize)
  let clientLimit = clampInt(maxClients, 1, 32, DEFAULT_EVENTS.maxClients)
  let buffer = []
  let disposed = false
  let dropped = 0
  const clients = new Map()

  function publish(input = {}) {
    if (disposed) return undefined
    const event = {
      ...input,
      v: EVENT_VERSION,
      instanceId,
      seq: ++seq,
      at: input.at || iso(now),
    }
    buffer.push(event)
    while (buffer.length > limit) buffer.shift()
    for (const client of [...clients.values()]) {
      try {
        if (client.send(event) === false) dropped += 1
      } catch (error) {
        dropped += 1
        log(`[tmsync] sse client failed: ${error?.message || error}`)
        client.close()
      }
    }
    return event
  }

  function sendResync(client, reason) {
    try {
      client.send({
        v: EVENT_VERSION,
        instanceId,
        seq,
        at: iso(now),
        kind: 'resync',
        resync: true,
        reason,
      })
    } catch (error) {
      log(`[tmsync] sse resync failed: ${error?.message || error}`)
    }
  }

  function replay(client, lastEventId) {
    if (lastEventId === undefined) return
    const parsed = parseLastEventId(lastEventId)
    if (parsed === undefined || !Number.isInteger(parsed.seq) || parsed.seq < 0) {
      sendResync(client, 'bad-last-event-id')
      return
    }
    if (parsed.instanceId !== instanceId || parsed.seq > seq) {
      sendResync(client, 'instance-changed')
      return
    }
    if (parsed.seq === seq) return
    const first = buffer[0]?.seq
    if (first === undefined) {
      sendResync(client, 'buffer-miss')
      return
    }
    if (parsed.seq < first - 1) {
      sendResync(client, 'buffer-miss')
      return
    }
    for (const event of buffer) {
      if (event.seq <= parsed.seq) continue
      try {
        client.send(event)
      } catch (error) {
        log(`[tmsync] sse replay failed: ${error?.message || error}`)
        return
      }
    }
  }

  function subscribe(send, { lastEventId } = {}) {
    if (disposed) return null
    if (clients.size >= clientLimit) return null
    const id = crypto.randomUUID()
    const client = {
      id,
      send,
      close() {
        clients.delete(id)
      },
    }
    clients.set(id, client)
    replay(client, lastEventId)
    return client
  }

  function configure(options = {}) {
    if (options.bufferSize !== undefined) {
      limit = clampInt(options.bufferSize, 8, 256, limit)
      while (buffer.length > limit) buffer.shift()
    }
    if (options.maxClients !== undefined) {
      clientLimit = clampInt(options.maxClients, 1, 32, clientLimit)
    }
  }

  function stats() {
    return {
      instanceId,
      seq,
      buffered: buffer.length,
      bufferSize: limit,
      clients: clients.size,
      maxClients: clientLimit,
      dropped,
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const client of [...clients.values()]) {
      try { client.close() } catch { /* ignore */ }
    }
    clients.clear()
    buffer = []
  }

  return { instanceId, publish, subscribe, configure, stats, dispose }
}

function sseFrame(event) {
  const lines = []
  if (!event.resync && event.instanceId !== undefined && event.seq !== undefined) {
    lines.push(`id: ${event.instanceId}:${event.seq}`)
  }
  lines.push('event: tmsync')
  lines.push(`data: ${JSON.stringify(event)}`)
  return `${lines.join('\n')}\n\n`
}

function helloFrame(hub) {
  const stats = hub.stats()
  const hello = {
    v: EVENT_VERSION,
    serverTime: new Date().toISOString(),
    instanceId: stats.instanceId,
    bufferSize: stats.bufferSize,
  }
  return `event: hello\ndata: ${JSON.stringify(hello)}\n\n`
}

function lastEventIdOf(req) {
  const header = req.headers?.['last-event-id']
  if (typeof header === 'string' && header !== '') return header
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    return url.searchParams.get('lastEventId') || undefined
  } catch {
    return undefined
  }
}

export function createSseResponder({ hub, eventsConfig = () => ({}), log = () => {} }) {
  return function open(req, res) {
    const config = { ...DEFAULT_EVENTS, ...eventsConfig() }
    const stats = hub.stats()
    if (stats.clients >= config.maxClients) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30', 'Cache-Control': 'no-store' })
      res.end('too many sse clients')
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    try {
      req.socket?.setNoDelay?.(true)
      req.socket?.setTimeout?.(0)
    } catch { /* ignore */ }
    res.write('retry: 3000\n\n')
    res.write(helloFrame(hub))

    let closed = false
    let blocked = false
    let dropped = 0
    const queue = []
    let heartbeat = null
    let client = null

    const close = () => {
      if (closed) return
      closed = true
      if (heartbeat !== null) clearInterval(heartbeat)
      heartbeat = null
      try { client?.close() } catch { /* ignore */ }
      try { res.end() } catch { /* ignore */ }
    }

    const flush = () => {
      blocked = false
      while (queue.length > 0 && !blocked) {
        const event = queue.shift()
        write(event)
      }
      if (dropped > 0) {
        const count = dropped
        dropped = 0
        send({ v: EVENT_VERSION, instanceId: hub.stats().instanceId, seq: hub.stats().seq, kind: 'resync', resync: true, reason: `client-queue-overflow:${count}` })
      }
    }

    const write = (event) => {
      if (closed) return false
      try {
        blocked = res.write(sseFrame(event)) === false
        if (blocked) res.once('drain', flush)
        return !blocked
      } catch (error) {
        log(`[tmsync] sse write failed: ${error?.message || error}`)
        close()
        return false
      }
    }

    function send(event) {
      if (closed) return false
      if (blocked) {
        if (queue.length < config.clientQueue) queue.push(event)
        else dropped += 1
        return false
      }
      return write(event)
    }

    try {
      client = hub.subscribe(send, { lastEventId: lastEventIdOf(req) })
    } catch (error) {
      log(`[tmsync] sse subscribe failed: ${error?.message || error}`)
    }
    if (client === null) {
      close()
      return
    }

    heartbeat = setInterval(() => {
      if (closed || blocked) return
      try { res.write(': ping\n\n') } catch { close() }
    }, config.heartbeatMs)
    heartbeat.unref?.()

    req.on('close', close)
    res.on('close', close)
    res.on('error', close)
  }
}
