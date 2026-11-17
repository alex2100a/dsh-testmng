import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventHub } from '../../server/events.js'

function collector() {
  const events = []
  return { events, send: (event) => { events.push(event); return true } }
}

test('event hub: publish assigns instance/seq/at and buffers', () => {
  const hub = createEventHub({ bufferSize: 8, now: () => 1000 })
  assert.match(hub.instanceId, /^[0-9a-f-]{36}$/)
  const first = hub.publish({ kind: 'local', projectId: '10' })
  const second = hub.publish({ kind: 'status', projectId: '10' })
  assert.equal(first.v, 1)
  assert.equal(first.seq, 1)
  assert.equal(second.seq, 2)
  assert.equal(first.instanceId, hub.instanceId)
  assert.equal(first.at, new Date(1000).toISOString())
  assert.equal(hub.stats().buffered, 2)
  hub.dispose()
})

test('event hub: replay after lastEventId, instance mismatch and old buffer resync', () => {
  const hub = createEventHub({ bufferSize: 8 })
  for (let index = 0; index < 10; index += 1) hub.publish({ kind: 'status', projectId: '10' })
  const client = collector()
  const subscription = hub.subscribe(client.send, { lastEventId: `${hub.instanceId}:8` })
  assert.ok(subscription)
  assert.deepEqual(client.events.map((event) => event.seq), [9, 10])
  subscription.close()

  const mismatch = collector()
  const other = hub.subscribe(mismatch.send, { lastEventId: 'other:10' })
  assert.ok(other)
  assert.equal(mismatch.events.at(-1).kind, 'resync')
  assert.equal(mismatch.events.at(-1).reason, 'instance-changed')
  other.close()

  const stale = collector()
  const old = hub.subscribe(stale.send, { lastEventId: `${hub.instanceId}:1` })
  assert.ok(old)
  assert.equal(stale.events.at(-1).kind, 'resync')
  assert.equal(stale.events.at(-1).reason, 'buffer-miss')
  old.close()
  hub.dispose()
})

test('event hub: max clients, configure, failing client isolation and dispose', () => {
  const hub = createEventHub({ bufferSize: 8, maxClients: 2 })
  const ok = collector()
  const first = hub.subscribe(ok.send)
  const extra = hub.subscribe(() => true)
  assert.ok(first)
  assert.ok(extra)
  assert.equal(hub.subscribe(() => true), null)
  first.close()
  extra.close()

  const broken = hub.subscribe(() => { throw new Error('broken') })
  const healthy = collector()
  const second = hub.subscribe(healthy.send)
  assert.ok(broken)
  assert.ok(second)
  hub.publish({ kind: 'status', projectId: '10' })
  assert.equal(healthy.events.length, 1)
  assert.equal(hub.stats().dropped, 1)

  hub.configure({ bufferSize: 8, maxClients: 2 })
  assert.equal(hub.stats().bufferSize, 8)
  assert.equal(hub.stats().maxClients, 2)
  hub.publish({ kind: 'status', projectId: '10' })
  hub.publish({ kind: 'status', projectId: '10' })
  assert.ok(hub.stats().buffered <= 8)
  hub.dispose()
  assert.equal(hub.stats().clients, 0)
  assert.equal(hub.publish({ kind: 'status' }), undefined)
})
