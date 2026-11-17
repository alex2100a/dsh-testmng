import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createMcpClient } from '../../server/mcp.js'

function startMockMcp() {
  const state = { initialize: 0, calls: 0, active: 0, maxActive: 0, sessionSeq: 0 }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      if (req.method === 'DELETE') {
        res.writeHead(200)
        res.end()
        return
      }
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch { /* ignore */ }
      const method = payload.method
      if (method === 'initialize') {
        state.initialize += 1
        state.sessionSeq += 1
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': `s${state.sessionSeq}` })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock' } } }))
        return
      }
      if (method === 'notifications/initialized') {
        res.writeHead(200)
        res.end()
        return
      }
      if (method === 'tools/call') {
        state.calls += 1
        state.active += 1
        state.maxActive = Math.max(state.maxActive, state.active)
        await new Promise((resolve) => setTimeout(resolve, 40))
        state.active -= 1
        const args = payload.params?.arguments ?? {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ echo: args.n, session: req.headers['mcp-session-id'] }) }] },
        }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: {} }))
    })
  })
  return { server, state }
}

test('client reuses sessions and caps concurrency', async () => {
  const { server, state } = startMockMcp()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const client = createMcpClient({ mcpUrl: `http://127.0.0.1:${port}/mcp`, token: 'test', concurrency: 2 })
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => client.call('echo', { n: i })))
    assert.deepEqual(results.map((item) => item.echo), [0, 1, 2, 3, 4, 5])
    assert.equal(state.calls, 6)
    assert.ok(state.initialize <= 2, `expected at most 2 sessions, got ${state.initialize}`)
    assert.ok(state.maxActive <= 2, `expected concurrency <= 2, got ${state.maxActive}`)

    state.initialize = 0
    await client.call('echo', { n: 10 })
    await client.call('echo', { n: 11 })
    assert.equal(state.initialize, 0, 'sequential calls must reuse the open session')
  } finally {
    await client.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('client serializes calls within one worker', async () => {
  const { server, state } = startMockMcp()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const client = createMcpClient({ mcpUrl: `http://127.0.0.1:${port}/mcp`, token: 'test', concurrency: 1 })
  try {
    await Promise.all(Array.from({ length: 4 }, (_, i) => client.call('echo', { n: i })))
    assert.equal(state.initialize, 1)
    assert.equal(state.maxActive, 1)
  } finally {
    await client.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
