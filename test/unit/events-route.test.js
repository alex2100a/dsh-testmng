import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createEventHub, createSseResponder } from '../../server/events.js'

function fakePair({ headers = {}, url = '/' } = {}) {
  const req = new EventEmitter()
  req.headers = headers
  req.url = url
  req.socket = { setNoDelay() {}, setTimeout() {} }
  const res = new EventEmitter()
  res.status = 0
  res.headers = {}
  res.chunks = []
  res.ended = false
  res.flushHeaders = () => {}
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {} }
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true }
  res.end = () => { res.ended = true; res.emit('close') }
  return { req, res }
}

test('sse responder: hello, event forwarding, last-event-id replay and cleanup', () => {
  const hub = createEventHub({ bufferSize: 16 })
  hub.publish({ kind: 'status', projectId: '10' })
  hub.publish({ kind: 'status', projectId: '10' })
  const responder = createSseResponder({ hub, eventsConfig: () => ({ heartbeatMs: 60_000 }) })
  const { req, res } = fakePair({ headers: { 'last-event-id': `${hub.instanceId}:1` } })
  responder(req, res)
  const text = res.chunks.join('')
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /text\/event-stream/)
  assert.match(text, /event: hello/)
  assert.match(text, new RegExp(`id: ${hub.instanceId}:2`))
  assert.equal(hub.stats().clients, 1)
  hub.publish({ kind: 'local', projectId: '10', paths: ['cases/a.md'] })
  assert.match(res.chunks.join(''), /cases\/a\.md/)
  req.emit('close')
  assert.equal(hub.stats().clients, 0)
  assert.equal(res.ended, true)
  hub.dispose()
})

test('sse responder: max clients returns 503 without writing hello', () => {
  const hub = createEventHub({ maxClients: 1 })
  const responder = createSseResponder({ hub, eventsConfig: () => ({ heartbeatMs: 60_000, maxClients: 1 }) })
  const first = fakePair()
  responder(first.req, first.res)
  const second = fakePair()
  responder(second.req, second.res)
  assert.equal(second.res.status, 503)
  assert.equal(second.res.chunks.length, 0)
  first.req.emit('close')
  hub.dispose()
})
