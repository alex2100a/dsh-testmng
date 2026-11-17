import test from 'node:test'
import assert from 'node:assert/strict'
import { BoundedMap, approxJsonBytes } from '../../server/bounded.js'

test('bounded: maxEntries LRU trim and reasons', () => {
  const evicted = []
  const map = new BoundedMap({ maxEntries: 2, onEvict: (value, key, reason) => evicted.push({ value, key, reason }) })
  map.set('a', 1)
  map.set('b', 2)
  assert.equal(map.get('a'), 1)
  map.set('c', 3)
  assert.equal(map.has('b'), false)
  assert.equal(map.get('a'), 1)
  assert.equal(map.get('c'), 3)
  assert.equal(evicted.some((item) => item.key === 'b' && item.reason === 'trim'), true)
  assert.equal(map.stats().size, 2)
})

test('bounded: TTL from insert, get does not extend, has checks TTL', () => {
  let now = 1000
  const evicted = []
  const map = new BoundedMap({ maxEntries: 4, ttlMs: 100, now: () => now, onEvict: (_value, key, reason) => evicted.push({ key, reason }) })
  map.set('a', 1)
  now = 1050
  assert.equal(map.get('a'), 1)
  now = 1101
  assert.equal(map.get('a'), undefined)
  assert.equal(map.has('a'), false)
  assert.equal(evicted.at(-1).reason, 'ttl')
})

test('bounded: maxBytes and sizeOf', () => {
  const map = new BoundedMap({ maxEntries: 10, maxBytes: 8, sizeOf: (value) => approxJsonBytes(value) })
  map.set('a', '12345')
  map.set('b', '12345')
  assert.equal(map.size, 1)
  assert.equal(map.has('b'), true)
  assert.equal(map.stats().maxBytes, 8)
  assert.ok(map.stats().bytes <= 8)
})

test('bounded: clear/dispose reasons, stats and expired sweep', () => {
  let now = 0
  const reasons = []
  const map = new BoundedMap({ maxEntries: 4, ttlMs: 10, now: () => now, onEvict: (_value, _key, reason) => reasons.push(reason) })
  map.set('a', 1)
  now = 11
  assert.equal(map.sweep(), 1)
  map.set('b', 2)
  map.clear('dispose')
  assert.equal(map.size, 0)
  assert.equal(reasons.includes('ttl'), true)
  assert.equal(reasons.includes('dispose'), true)
  assert.equal(map.stats().reasons.dispose, 1)
})
