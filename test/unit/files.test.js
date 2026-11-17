import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import crypto from 'node:crypto'
import { safeId, safeJoin, slugify, canonicalHash, stableStringify } from '../../server/files.js'

test('safeId preserves opaque string IDs and avoids path characters', () => {
  assert.equal(safeId('00123'), '00123')
  assert.equal(safeId('prj_9d60e448e15a44b6e860cdba'), 'prj_9d60e448e15a44b6e860cdba')
  assert.equal(safeId('a/b:c'), 'a_b_c-' + crypto.createHash('sha256').update('a/b:c').digest('hex').slice(0, 8))
})

test('safeJoin rejects traversal', () => {
  const root = path.resolve('Z:/TEMP/opencode/tmsync-test-root')
  assert.equal(safeJoin(root, 'a/b.md'), path.join(root, 'a/b.md'))
  assert.throws(() => safeJoin(root, '../outside.md'))
})

test('slugify is readable and stable', () => {
  assert.equal(slugify('Login（正向）'), 'login-正向')
  assert.equal(slugify(''), 'item')
})

test('canonical hash ignores key order', () => {
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }))
  assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}')
})
